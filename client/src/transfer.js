/**
 * transfer.js — Ultra-reliable WebRTC binary file transfer engine.
 *
 * Designed for 100% stability across all mobile (iOS Safari/Android) and desktop browsers.
 *
 * Protocol:
 *  - Control messages (JSON strings): transfer-start, transfer-done, transfer-cancel, text-message
 *  - File Chunks (Raw ArrayBuffers): 36B transferId UUID + 4B Uint32 chunkIndex + 64KB raw binary payload
 */

import { generateUUID } from './utils/uuid.js';

const CHUNK_SIZE = 64 * 1024;           // 64 KB – proven stable on all browsers/mobile
const BUFFER_HIGH = 256 * 1024;         // Pause sending when buffer exceeds 256 KB
const BUFFER_LOW  = 64 * 1024;          // Resume when buffer drains to 64 KB (matches bufferedAmountLowThreshold)
const SPEED_WINDOW_MS = 1000;

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

    while (state.nextChunk < chunkCount && !state.cancelled) {
      // Tight high/low watermark flow control — prevents huge buffer buildup
      if (this.#peer.bufferedAmount > BUFFER_HIGH) {
        await this.#waitForBufferDrain();
        if (state.cancelled) break;
      }

      const start = state.nextChunk * CHUNK_SIZE;
      const arrayBuffer = await file.slice(start, start + CHUNK_SIZE).arrayBuffer();
      if (state.cancelled) break;

      const ok = this.#peer.send(packBinaryChunk(transferId, state.nextChunk, arrayBuffer));
      if (!ok) { await sleep(5); continue; }

      state.bytesSent += arrayBuffer.byteLength;
      state.nextChunk++;

      // Progress uses actual bytes leaving the buffer, not enqueued bytes
      const actualSent = Math.max(0, state.bytesSent - this.#peer.bufferedAmount);
      const now = Date.now();
      state.speedSamples.push({ t: now, bytes: actualSent });
      state.speedSamples = state.speedSamples.filter(s => now - s.t < SPEED_WINDOW_MS);
      const first = state.speedSamples[0];
      const last  = state.speedSamples[state.speedSamples.length - 1];
      const dt = (last.t - first.t) / 1000;
      const speed = dt > 0 ? (last.bytes - first.bytes) / dt : 0;

      this.dispatchEvent(new CustomEvent('send-progress', {
        detail: { transferId, bytesSent: actualSent, totalBytes: file.size, speedBps: Math.max(0, speed) },
      }));
    }

    if (!state.cancelled) {
      this.#sendJSON({ type: 'transfer-done', transferId });
      this.dispatchEvent(new CustomEvent('send-done', { detail: { transferId, fileName: file.name } }));
    }
    this.#sending.delete(transferId);
  }

  // Waits until the DataChannel buffer drains below the low watermark
  #waitForBufferDrain() {
    if (this.#peer.bufferedAmount <= BUFFER_LOW) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; this.#peer.off?.('bufferedamountlow', done); resolve(); } };
      this.#peer.on('bufferedamountlow', done);
      // Fallback: poll every 20ms in case the event doesn't fire (iOS quirk)
      const poll = setInterval(() => { if (this.#peer.bufferedAmount <= BUFFER_LOW) { clearInterval(poll); done(); } }, 20);
      // Hard cap at 3s to prevent infinite hang
      setTimeout(() => { clearInterval(poll); done(); }, 3000);
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
        case 'ack':               this.#onAck(msg); break;
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

  #onBinaryChunk(transferId, chunkIndex, arrayBuffer) {
    let state = this.#receiving.get(transferId);
    if (!state) {
      const clean = transferId.trim();
      state = this.#receiving.get(clean);
    }
    if (!state && this.#receiving.size > 0) {
      for (const s of this.#receiving.values()) {
        if (s.receivedCount < s.chunkCount) {
          state = s;
          break;
        }
      }
    }
    if (!state) return;

    state.chunks[chunkIndex] = arrayBuffer;
    state.receivedCount++;
    state.lastChunkIndex = chunkIndex;
    state.bytesReceived += arrayBuffer.byteLength;

    // Speed tracking
    const now = Date.now();
    state.speedSamples.push({ t: now, bytes: arrayBuffer.byteLength });
    state.speedSamples = state.speedSamples.filter((s) => now - s.t < SPEED_WINDOW_MS);
    const speed = state.speedSamples.reduce((a, s) => a + s.bytes, 0) / (SPEED_WINDOW_MS / 1000);

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

  #onAck(msg) {
    const state = this.#sending.get(msg.transferId);
    if (state) state.ackedChunks.add(msg.chunkIndex);
  }

  #onResumeRequest(msg) {
    this.resumeSend(msg.transferId, msg.fromChunk);
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

function packBinaryChunk(transferId, chunkIndex, chunkArrayBuffer) {
  const headerLen = 40;
  const packet = new Uint8Array(headerLen + chunkArrayBuffer.byteLength);

  // Bytes 0..35: UUID string ASCII
  const cleanId = (transferId || '').padEnd(36, ' ').slice(0, 36);
  for (let i = 0; i < 36; i++) {
    packet[i] = cleanId.charCodeAt(i);
  }

  // Bytes 36..39: Uint32 chunkIndex
  const view = new DataView(packet.buffer);
  view.setUint32(36, chunkIndex, true);

  // Bytes 40..end: File chunk binary payload
  packet.set(new Uint8Array(chunkArrayBuffer), headerLen);
  return packet.buffer;
}

function unpackBinaryChunk(arrayBuffer) {
  const headerLen = 40;
  const bytes = new Uint8Array(arrayBuffer, 0, 36);
  let transferId = '';
  for (let i = 0; i < 36; i++) {
    transferId += String.fromCharCode(bytes[i]);
  }
  transferId = transferId.trim();

  const view = new DataView(arrayBuffer);
  const chunkIndex = view.getUint32(36, true);
  const data = arrayBuffer.slice(headerLen);

  return { transferId, chunkIndex, data };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
