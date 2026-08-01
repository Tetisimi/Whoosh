/**
 * rtc.js — WebRTC peer connection manager for Whoosh.
 *
 * One RtcPeer instance per remote peer. Manages:
 *  - ICE negotiation via the signaling server
 *  - RTCDataChannel lifecycle
 *  - Connection mode detection (direct P2P vs TURN relay)
 *  - Reconnection after transient failures
 *
 * The actual file chunking and transfer logic lives in transfer.js.
 * This module provides raw chunk send/receive primitives.
 */

// Fetched once, shared across all peer connections
let iceServersCache = null;

async function getIceServers() {
  if (iceServersCache) return iceServersCache;
  try {
    const { protocol, hostname } = window.location;
    const httpProto = protocol === 'https:' ? 'https' : 'http';
    const signalingBase = import.meta.env.VITE_SIGNALING_URL
      ? import.meta.env.VITE_SIGNALING_URL.replace(/^ws/, 'http')
      : (hostname === 'localhost' || hostname === '127.0.0.1')
        ? 'http://localhost:3000'
        : `${httpProto}://${hostname}:3000`;

    const res = await fetch(`${signalingBase}/ice-config`);
    const { iceServers } = await res.json();
    iceServersCache = iceServers;
  } catch (err) {
    console.warn('[rtc] Failed to fetch ICE config, falling back to public STUN:', err);
    iceServersCache = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
  }
  return iceServersCache;
}


/** @typedef {'new'|'connecting'|'connected'|'disconnected'|'failed'|'closed'} PeerState */
/** @typedef {'unknown'|'direct'|'relayed'} ConnectionMode */

export class RtcPeer extends EventTarget {
  /** @type {RTCPeerConnection} */
  #pc = null;
  /** @type {RTCDataChannel | null} */
  #channel = null;

  #signalingClient;
  #localId;
  #remoteId;
  #isInitiator;
  #makingOffer = false;
  #ignoreOffer = false;

  /** @type {PeerState} */
  state = 'new';
  /** @type {ConnectionMode} */
  connectionMode = 'unknown';

  /**
   * @param {object} opts
   * @param {import('./signaling.js').SignalingClient} opts.signaling
   * @param {string} opts.localId   - Our peer ID
   * @param {string} opts.remoteId  - Their peer ID
   * @param {boolean} opts.initiator - true if we make the offer
   */
  constructor({ signaling, localId, remoteId, initiator }) {
    super();
    this.#signalingClient = signaling;
    this.#localId = localId;
    this.#remoteId = remoteId;
    this.#isInitiator = initiator;
  }

  /** Start the connection. Must call this after construction. */
  async connect() {
    const iceServers = await getIceServers();
    this.#pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

    this.#pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        this.#signalingClient.signal(this.#remoteId, { type: 'ice-candidate', candidate: candidate.toJSON() });
      }
    });

    this.#pc.addEventListener('iceconnectionstatechange', () => {
      this.#detectConnectionMode();
    });

    this.#pc.addEventListener('connectionstatechange', () => {
      const cs = this.#pc.connectionState;
      this.state = cs;
      this.dispatchEvent(new CustomEvent('state-change', { detail: { state: cs } }));
      if (cs === 'failed') {
        this.dispatchEvent(new CustomEvent('failed'));
      }
    });

    // Perfect negotiation pattern — handles re-negotiation gracefully
    this.#pc.addEventListener('negotiationneeded', async () => {
      try {
        this.#makingOffer = true;
        await this.#pc.setLocalDescription();
        this.#signalingClient.signal(this.#remoteId, {
          type: 'sdp',
          sdp: this.#pc.localDescription,
        });
      } catch (err) {
        console.error('[rtc] negotiationneeded error:', err);
      } finally {
        this.#makingOffer = false;
      }
    });

    this.#pc.addEventListener('datachannel', ({ channel }) => {
      this.#setupChannel(channel);
    });

    if (this.#isInitiator) {
      const ch = this.#pc.createDataChannel('whoosh', {
        ordered: true,
        // maxRetransmits: 0 would be unreliable; keep ordered=true for reliable delivery
      });
      this.#setupChannel(ch);
    }
  }

  #setupChannel(channel) {
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 128 * 1024; // 128 KB threshold

    channel.addEventListener('bufferedamountlow', () => {
      this.dispatchEvent(new CustomEvent('bufferedamountlow'));
    });

    channel.addEventListener('open', () => {
      console.log(`[rtc] DataChannel open with ${this.#remoteId}`);
      this.dispatchEvent(new CustomEvent('channel-open'));
    });

    channel.addEventListener('close', () => {
      this.dispatchEvent(new CustomEvent('channel-close'));
    });

    channel.addEventListener('message', ({ data }) => {
      this.dispatchEvent(new CustomEvent('data', { detail: data }));
    });

    channel.addEventListener('error', (err) => {
      console.error('[rtc] DataChannel error:', err);
    });
  }


  /**
   * Handle an incoming signal from the remote peer (via signaling server).
   * Implements the "perfect negotiation" pattern.
   * @param {object} payload
   */
  async handleSignal(payload) {
    if (!this.#pc) return;
    try {
      if (payload.type === 'sdp') {

        const offerCollision =
          payload.sdp.type === 'offer' &&
          (this.#makingOffer || this.#pc.signalingState !== 'stable');

        this.#ignoreOffer = !this.#isInitiator && offerCollision;
        if (this.#ignoreOffer) return;

        await this.#pc.setRemoteDescription(payload.sdp);

        if (payload.sdp.type === 'offer') {
          await this.#pc.setLocalDescription();
          this.#signalingClient.signal(this.#remoteId, {
            type: 'sdp',
            sdp: this.#pc.localDescription,
          });
        }
      } else if (payload.type === 'ice-candidate') {
        try {
          await this.#pc.addIceCandidate(payload.candidate);
        } catch (err) {
          if (!this.#ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('[rtc] handleSignal error:', err);
    }
  }

  /**
   * Send raw data (ArrayBuffer or string) over the data channel.
   * @param {ArrayBuffer | string} data
   */
  send(data) {
    if (this.#channel?.readyState === 'open') {
      try {
        this.#channel.send(data);
        return true;
      } catch (err) {
        console.warn('[rtc] DataChannel send warning:', err);
        return false;
      }
    }
    return false;
  }


  /**
   * Get current buffered amount (bytes waiting to be sent).
   * Use for flow control.
   */
  get bufferedAmount() {
    return this.#channel?.bufferedAmount ?? 0;
  }

  /** Detect if we're using a TURN relay or a direct path. */
  async #detectConnectionMode() {
    if (!this.#pc) return;
    try {
      const stats = await this.#pc.getStats();
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localCand = stats.get(report.localCandidateId);
          const mode = localCand?.candidateType === 'relay' ? 'relayed' : 'direct';
          if (mode !== this.connectionMode) {
            this.connectionMode = mode;
            this.dispatchEvent(new CustomEvent('mode-change', { detail: { mode } }));
          }
          return;
        }
      }
    } catch {
      // Stats not available yet
    }
  }

  /**
   * Listen for a typed event.
   */
  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail ?? e));
    return this;
  }

  /** Close the peer connection. */
  close() {
    this.#channel?.close();
    this.#pc?.close();
    this.state = 'closed';
  }

  get remoteId() { return this.#remoteId; }
  get isOpen() { return this.#channel?.readyState === 'open'; }
}
