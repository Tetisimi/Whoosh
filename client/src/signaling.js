/**
 * signaling.js — WebSocket client for Whoosh signaling server.
 *
 * Handles:
 *  - Connection and reconnection with exponential backoff
 *  - Registering this device with its codename
 *  - Receiving peer discovery events from the server
 *  - Relaying WebRTC signal payloads to/from peers
 *
 * Usage:
 *   const sig = new SignalingClient('ws://localhost:3000', 'Coral Salmon');
 *   sig.on('peer-joined', (peer) => { ... });
 *   sig.send('signal', { to: peerId, payload: sdp });
 */

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class SignalingClient extends EventTarget {
  /** @type {WebSocket | null} */
  #ws = null;
  #url;
  #codename;
  #reconnectDelay = RECONNECT_BASE_MS;
  #reconnectTimer = null;
  #intentionalClose = false;

  /** Assigned by server after registration */
  peerId = null;
  connected = false;

  /**
   * @param {string} url - WebSocket URL e.g. 'ws://localhost:3000'
   * @param {string} codename - This device's codename
   */
  constructor(url, codename) {
    super();
    this.#url = url;
    this.#codename = codename;
    this.#connect();
  }

  #connect() {
    this.#intentionalClose = false;
    const ws = new WebSocket(this.#url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.addEventListener('open', () => {
      console.log('[signaling] Connected');
      this.#reconnectDelay = RECONNECT_BASE_MS;
      // Register immediately on connection
      this.#rawSend({ type: 'register', codename: this.#codename });
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn('[signaling] Non-JSON message received:', event.data);
        return;
      }
      this.#handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('disconnected'));
      if (!this.#intentionalClose) {
        console.log(`[signaling] Disconnected. Reconnecting in ${this.#reconnectDelay}ms…`);
        this.#reconnectTimer = setTimeout(() => this.#connect(), this.#reconnectDelay);
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    });

    ws.addEventListener('error', (err) => {
      console.error('[signaling] WebSocket error:', err);
    });
  }

  #handleMessage(msg) {
    switch (msg.type) {
      case 'registered':
        this.peerId = msg.id;
        this.connected = true;
        this.dispatchEvent(new CustomEvent('registered', { detail: msg }));
        break;

      case 'peer-joined':
        this.dispatchEvent(new CustomEvent('peer-joined', { detail: msg.peer }));
        break;

      case 'peer-left':
        this.dispatchEvent(new CustomEvent('peer-left', { detail: { id: msg.id } }));
        break;

      case 'room-created':
        this.dispatchEvent(new CustomEvent('room-created', { detail: { code: msg.code } }));
        break;

      case 'room-joined':
        this.dispatchEvent(new CustomEvent('room-joined', { detail: msg }));
        break;

      case 'room-error':
        this.dispatchEvent(new CustomEvent('room-error', { detail: { message: msg.message } }));
        break;

      case 'signal':
        this.dispatchEvent(new CustomEvent('signal', { detail: { from: msg.from, payload: msg.payload } }));
        break;

      case 'pong':
        // keepalive acknowledged
        break;

      case 'error':
        console.error('[signaling] Server error:', msg.message);
        this.dispatchEvent(new CustomEvent('server-error', { detail: msg }));
        break;

      default:
        console.warn('[signaling] Unknown message type:', msg.type);
    }
  }

  #rawSend(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  /**
   * Send a typed message to the signaling server.
   * @param {string} type
   * @param {object} payload
   */
  send(type, payload = {}) {
    return this.#rawSend({ type, ...payload });
  }

  /**
   * Relay a WebRTC signal to a specific peer.
   * @param {string} toPeerId
   * @param {object} rtcPayload - SDP or ICE candidate
   */
  signal(toPeerId, rtcPayload) {
    return this.send('signal', { to: toPeerId, payload: rtcPayload });
  }

  /** Create a cross-network room. */
  createRoom() {
    return this.send('create-room');
  }

  /** Join a cross-network room by code. */
  joinRoom(code) {
    return this.send('join-room', { code });
  }

  /** Disconnect and stop reconnecting. */
  close() {
    this.#intentionalClose = true;
    clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
  }

  /**
   * Listen for a typed event.
   * @param {string} type
   * @param {(detail: any) => void} handler
   */
  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
    return this;
  }
}
