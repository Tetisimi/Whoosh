/**
 * transfer.js — Ultra-reliable WebRTC binary file transfer engine.
 *
 * Designed for 100% stability across all mobile (iOS Safari/Android) and desktop browsers.
 *
 * Protocol:
 *  - Control messages (JSON strings): transfer-start, transfer-done, transfer-cancel, text-message
 *  - Binary chunks: 36B ASCII UUID + 4B LE Uint32 chunkIndex + payload
 */

import { generateUUID } from './utils/uuid.js';

const CHUNK_SIZE        = 128 * 1024;   // 128 KB — 2× fewer iterations vs 64 KB; safe on all modern browsers
const BUFFER_HIGH       = 1024 * 1024;  // 1 MB pipeline — keeps Direct P2P saturated
const BUFFER_LOW        = 256 * 1024;   // Resume sending when buffer drains to 256 KB
const PREFETCH          = 8;            // 8 × 128 KB = 1 MB parallel disk read-ahead
const PROGRESS_INTERVAL = 80;           // Emit at most 12 UI updates/sec (≈ 60fps equivalent)
const SPEED_WINDOW_MS   = 2000;         // 2-second rolling window for stable speed readings

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Manage sending/receiving transfers for a single peer connection.
 */
export class TransferManager extends EventTarget {
  /** @type {import('./rtc.js').RtcPeer} */
  #peer;

  /** Map<transferId, SendState> */
  #sending = new Map();
  /** Map<transferId, ReceiveState> */
  #receiving = new Map();

  #sendQueue = [];
  #isSending = false;

  constructor(peer) {
    super();
    this.#peer = peer;
    peer.on('data', (data) => this.#handleData(data));
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /**
   * Send one or more files to the remote peer via a sequential queue.
   * @param {File[]} files
   * @returns {Promise<string[]>} Transfer IDs
   */
  async sendFiles(files) {
    const ids = [];
    for (const file of files) {
      const transferId = generateUUID();
      const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

      const state = {
        transferId,
        file,
        chunkCount,
        nextChunk: 0,
        cancelled: false,
        startTime: Date.now(),
        bytesSent: 0,
        speedSamples: [],
      };

      this.#sending.set(transferId, state);
      this.#sendQueue.push(state);
      ids.push(transferId);

      // Announce to receiver immediately — all files show up on both UIs at once
      this.#sendJSON({
        type: 'transfer-start',
        transferId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        chunkCount,
        chunkSize: CHUNK_SIZE,
      });

      this.dispatchEvent(new CustomEvent('send-start', {
        detail: { transferId, fileName: file.name, fileSize: file.size, chunkCount },
      }));
    }

    this.#processQueue();
    return ids;
  }

  async #processQueue() {
    if (this.#isSending) return;
    this.#isSending = true;

    while (this.#sendQueue.length > 0) {
      const state = this.#sendQueue.shift();
      if (!state || state.cancelled) continue;
      await this.#pumpChunks(state);
    }

    this.#isSending = false;
  }

  async #pumpChunks(state) {
    const { transferId, file, chunkCount } = state;

    // Pre-compute the 40-byte packet header ONCE per transfer.
    // This eliminates a 36-iteration char loop from the hot send path.
    const headerTemplate = new Uint8Array(40);
    encoder.encodeInto(transferId.padEnd(36).slice(0, 36), headerTemplate);
    // bytes 36-39 (chunkIndex uint32) are overwritten per-chunk inside packChunk()

    // Bounded read-ahead: start up to PREFETCH slice().arrayBuffer() Promises ahead.
    // By the time we need each chunk, it’s usually already resolved — eliminates disk stalls.
    const reads = new Map();
    const fillReadAhead = () => {
      const limit = Math.min(chunkCount, state.nextChunk + PREFETCH);
      for (let i = state.nextChunk; i < limit; i++) {
        if (!reads.has(i)) {
          const start = i * CHUNK_SIZE;
          reads.set(i, file.slice(start, start + CHUNK_SIZE).arrayBuffer());
        }
      }
    };

    let lastProgressAt = 0;

    while (state.nextChunk < chunkCount && !state.cancelled) {
      fillReadAhead();

      if (this.#peer.bufferedAmount > BUFFER_HIGH) {
        await this.#waitForBufferDrain(state);
        if (state.cancelled) break;
      }

      const arrayBuffer = await reads.get(state.nextChunk);
      reads.delete(state.nextChunk - 1); // evict previous chunk, keep window moving
      if (state.cancelled) break;

      const ok = this.#peer.send(packChunk(headerTemplate, state.nextChunk, arrayBuffer));
      if (!ok) { await sleep(5); continue; }

      state.bytesSent += arrayBuffer.byteLength;
      state.nextChunk++;

      // Throttle progress DOM updates — no more than 12/sec
      const now = Date.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL) {
        lastProgressAt = now;
        this.#emitSendProgress(state, now);
      }
    }

    reads.clear();

    if (!state.cancelled) {
      this.#emitSendProgress(state, Date.now()); // fire final 100% event
      this.#sendJSON({ type: 'transfer-done', transferId });
      this.dispatchEvent(new CustomEvent('send-done', { detail: { transferId, fileName: file.name } }));
    }
    this.#sending.delete(transferId);
  }

  // Compute and dispatch a send-progress event.
  #emitSendProgress(state, now = Date.now()) {
    const actualSent = Math.max(0, state.bytesSent - this.#peer.bufferedAmount);
    state.speedSamples.push({ t: now, bytes: actualSent });
    // Trim old samples from the front — O(1) amortised, no array allocation
    while (state.speedSamples.length > 1 && now - state.speedSamples[0].t > SPEED_WINDOW_MS) {
      state.speedSamples.shift();
    }
    const first = state.speedSamples[0];
    const last  = state.speedSamples[state.speedSamples.length - 1];
    const dt    = (last.t - first.t) / 1000;
    const speed = dt > 0.05 ? (last.bytes - first.bytes) / dt : 0;
    this.dispatchEvent(new CustomEvent('send-progress', {
      detail: { transferId: state.transferId, bytesSent: actualSent, totalBytes: state.file.size, speedBps: Math.max(0, speed) },
    }));
  }

  // Waits until the DataChannel buffer drains below BUFFER_LOW.
  // • Uses the native bufferedamountlow event (no wrapping — so removeEventListener works).
  // • Polls every PROGRESS_INTERVAL ms as iOS fallback AND to emit live progress during drain.
  // • Checks state.cancelled so cancel is acted on within PROGRESS_INTERVAL ms, not 3s.
  // • 3s hard cap prevents infinite hang on dead connections.
  #waitForBufferDrain(state) {
    if (this.#peer.bufferedAmount <= BUFFER_LOW) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          clearInterval(poll);
          this.#peer.removeEventListener('bufferedamountlow', done);
          resolve();
        }
      };
      // Direct addEventListener so the exact same reference can be removed
      this.#peer.addEventListener('bufferedamountlow', done);
      const poll = setInterval(() => {
        this.#emitSendProgress(state); // keep UI alive during drain (critical for TURN relay)
        if (state.cancelled || this.#peer.bufferedAmount <= BUFFER_LOW) done();
      }, PROGRESS_INTERVAL);
      setTimeout(done, 3000);
    });
  }

  cancelAllActive() {
    for (const [id, state] of this.#sending) {
      state.cancelled = true;
      this.dispatchEvent(new CustomEvent('send-cancel', { detail: { transferId: id } }));
    }
    for (const [id] of this.#receiving) {
      this.dispatchEvent(new CustomEvent('receive-cancel', { detail: { transferId: id } }));
    }
    this.#sending.clear();
    this.#receiving.clear();
  }


  /**
   * Cancel an outgoing transfer.
   * @param {string} transferId
   */
  cancelSend(transferId) {
    const state = this.#sending.get(transferId);
    if (state) {
      state.cancelled = true;
      this.#sending.delete(transferId);
      this.#sendJSON({ type: 'transfer-cancel', transferId });
      this.dispatchEvent(new CustomEvent('send-cancel', { detail: { transferId } }));
    }
  }

  /**
   * Cancel an incoming transfer.
   * @param {string} transferId
   */
  cancelReceive(transferId) {
    const state = this.#receiving.get(transferId);
    if (state) {
      this.#receiving.delete(transferId);
      this.#sendJSON({ type: 'transfer-cancel', transferId });
      this.dispatchEvent(new CustomEvent('receive-cancel', { detail: { transferId } }));
    }
  }

  /**
   * Resume an interrupted outgoing transfer from the last chunk.
   * @param {string} transferId
   * @param {number} fromChunk
   */
  resumeSend(transferId, fromChunk) {
    const state = this.#sending.get(transferId);
    if (!state) return;
    state.nextChunk = fromChunk;
    this.#pumpChunks(state);
  }

  /**
   * Send a text message.
   * @param {string} text
   */
  sendText(text) {
    const id = generateUUID();
    this.#sendJSON({ type: 'text-message', id, text });
    return id;
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  #handleData(data) {
    if (typeof data === 'string') {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'transfer-start':    this.#onTransferStart(msg); break;
        case 'transfer-done':     this.#onTransferDone(msg); break;
        case 'transfer-cancel':   this.#onTransferCancel(msg); break;
        case 'text-message':      this.#onTextMessage(msg); break;
        case 'resume-request':    this.#onResumeRequest(msg); break;
        case 'nak':               this.#onNak(msg); break;
      }
      return;
    }

    // Direct binary ArrayBuffer packet
    if (data instanceof ArrayBuffer) {
      const { transferId, chunkIndex, data: chunkData } = unpackBinaryChunk(data);
      this.#onBinaryChunk(transferId, chunkIndex, chunkData);
    }
  }

  #onTransferStart(msg) {
    const state = {
      transferId: msg.transferId,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      fileType: msg.fileType,
      chunkCount: msg.chunkCount,
      chunks: new Array(msg.chunkCount),
      receivedCount: 0,
      lastChunkIndex: -1,
      startTime: Date.now(),
      bytesReceived: 0,
      speedSamples: [],
    };
    this.#receiving.set(msg.transferId, state);

    this.dispatchEvent(new CustomEvent('receive-start', {
      detail: { transferId: msg.transferId, fileName: msg.fileName, fileSize: msg.fileSize },
    }));
  }

  #onBinaryChunk(transferId, chunkIndex, chunkData) {
    let state = this.#receiving.get(transferId);
    if (!state) {
      const clean = transferId.trim();
      state = this.#receiving.get(clean);
    }
    if (!state && this.#receiving.size > 0) {
      for (const s of this.#receiving.values()) {
        if (s.receivedCount < s.chunkCount) { state = s; break; }
      }
    }
    if (!state) return;

    // chunkData is a zero-copy Uint8Array view — no memcopy needed
    state.chunks[chunkIndex] = chunkData;
    state.receivedCount++;
    state.bytesReceived += chunkData.byteLength;

    // Running-window speed: O(1) amortised via shift-from-front
    const now = Date.now();
    state.bytesInWindow = (state.bytesInWindow ?? 0) + chunkData.byteLength;
    state.speedSamples.push({ t: now, bytes: chunkData.byteLength });
    while (state.speedSamples.length > 0 && now - state.speedSamples[0].t > SPEED_WINDOW_MS) {
      state.bytesInWindow -= state.speedSamples.shift().bytes;
    }
    const speed = (state.bytesInWindow ?? 0) / (SPEED_WINDOW_MS / 1000);

    // Throttle receive-progress events — same cap as send side
    if (!state.lastProgressAt || now - state.lastProgressAt >= PROGRESS_INTERVAL) {
      state.lastProgressAt = now;
      this.dispatchEvent(new CustomEvent('receive-progress', {
        detail: {
          transferId: state.transferId,
          bytesReceived: state.bytesReceived,
          totalBytes: state.fileSize,
          receivedCount: state.receivedCount,
          chunkCount: state.chunkCount,
          speedBps: speed,
        },
      }));
    }
  }

  #onTransferDone(msg) {
    let state = this.#receiving.get(msg.transferId);
    if (!state && this.#receiving.size === 1) {
      state = this.#receiving.values().next().value;
    }
    if (!state) return;

    // Assemble all chunks into a Blob
    const blob = new Blob(state.chunks, { type: state.fileType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    this.dispatchEvent(new CustomEvent('receive-done', {
      detail: {
        transferId: state.transferId,
        fileName: state.fileName,
        fileSize: state.fileSize,
        blob,
        url,
      },
    }));

    this.#receiving.delete(state.transferId);
  }

  #onTransferCancel(msg) {
    const sendState = this.#sending.get(msg.transferId);
    if (sendState) {
      sendState.cancelled = true;
      this.#sending.delete(msg.transferId);
      this.dispatchEvent(new CustomEvent('send-cancel', { detail: { transferId: msg.transferId } }));
    }
    const receiveState = this.#receiving.get(msg.transferId);
    if (receiveState) {
      this.#receiving.delete(msg.transferId);
      this.dispatchEvent(new CustomEvent('receive-cancel', { detail: { transferId: msg.transferId } }));
    }
  }

  #onTextMessage(msg) {
    this.dispatchEvent(new CustomEvent('text-message', { detail: { id: msg.id, text: msg.text } }));
  }

  #onNak(msg) {
    this.dispatchEvent(new CustomEvent('transfer-error', {
      detail: { transferId: msg.transferId, message: msg.message },
    }));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #sendJSON(obj) {
    this.#peer.send(JSON.stringify(obj));
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
    return this;
  }
}

// ── Binary Packet Helpers ───────────────────────────────────────────────────

// Pack a chunk using a pre-computed header template (UUID already encoded).
// Only the chunkIndex bytes (36-39) differ per chunk, so we overwrite just those.
function packChunk(headerTemplate, chunkIndex, chunkArrayBuffer) {
  const packet = new Uint8Array(40 + chunkArrayBuffer.byteLength);
  packet.set(headerTemplate, 0);                                    // copy pre-computed UUID
  new DataView(packet.buffer).setUint32(36, chunkIndex, true);      // overwrite bytes 36-39
  packet.set(new Uint8Array(chunkArrayBuffer), 40);
  return packet.buffer;
}

// Unpack a received binary chunk.
// Uses TextDecoder (no char loop) + zero-copy Uint8Array view (no payload memcopy).
function unpackBinaryChunk(arrayBuffer) {
  const transferId = decoder.decode(new Uint8Array(arrayBuffer, 0, 36)).trim();
  const chunkIndex = new DataView(arrayBuffer, 36, 4).getUint32(0, true);
  const data       = new Uint8Array(arrayBuffer, 40); // zero-copy view — saves copying the whole chunk
  return { transferId, chunkIndex, data };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
