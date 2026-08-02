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

const CHUNK_SIZE = 64 * 1024; // 64 KB
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB (high-throughput pipeline)
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

  constructor(peer) {
    super();
    this.#peer = peer;
    peer.on('data', (data) => this.#handleData(data));
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /**
   * Send one or more files to the remote peer.
   * @param {File[]} files
   * @returns {Promise<string[]>} Transfer IDs
   */
  async sendFiles(files) {
    const ids = [];
    for (const file of files) {
      const id = await this.#sendFile(file);
      ids.push(id);
    }
    return ids;
  }

  async #sendFile(file) {
    const transferId = generateUUID();
    const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

    const state = {
      transferId,
      file,
      chunkCount,
      nextChunk: 0,
      ackedChunks: new Set(),
      cancelled: false,
      startTime: Date.now(),
      bytesSent: 0,
      speedSamples: [],
    };
    this.#sending.set(transferId, state);

    // Announce the transfer
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

    await this.#pumpChunks(state);
    return transferId;
  }

  async #pumpChunks(state) {
    const { transferId, file, chunkCount } = state;

    while (state.nextChunk < chunkCount && !state.cancelled) {
      // Zero-latency flow control: if buffer fills up, wait for native C++ 'bufferedamountlow' event
      if (this.#peer.bufferedAmount > BUFFER_THRESHOLD && !state.cancelled) {
        await this.#waitForBufferLow(state);
      }
      if (state.cancelled) break;

      const start = state.nextChunk * CHUNK_SIZE;
      const slice = file.slice(start, start + CHUNK_SIZE);
      const arrayBuffer = await slice.arrayBuffer();

      // Send raw binary packet
      const binaryPacket = packBinaryChunk(transferId, state.nextChunk, arrayBuffer);
      const ok = this.#peer.send(binaryPacket);

      if (!ok) {
        await sleep(10);
        continue;
      }

      state.bytesSent += arrayBuffer.byteLength;
      state.nextChunk++;

      // Track actual wire progress by subtracting current buffer queue
      const buffered = this.#peer.bufferedAmount;
      const actualBytesSent = Math.max(0, state.bytesSent - buffered);

      const now = Date.now();
      state.speedSamples.push({ t: now, bytes: actualBytesSent });
      state.speedSamples = state.speedSamples.filter((s) => now - s.t < SPEED_WINDOW_MS);

      const firstSample = state.speedSamples[0];
      const lastSample = state.speedSamples[state.speedSamples.length - 1];
      const timeDiffSec = (lastSample.t - firstSample.t) / 1000;
      const bytesDiff = lastSample ? lastSample.bytes - (firstSample ? firstSample.bytes : 0) : 0;
      const speed = timeDiffSec > 0 ? bytesDiff / timeDiffSec : 0;

      this.dispatchEvent(new CustomEvent('send-progress', {
        detail: {
          transferId,
          bytesSent: actualBytesSent,
          totalBytes: file.size,
          chunkIndex: state.nextChunk - 1,
          chunkCount,
          speedBps: Math.max(0, speed),
        },
      }));
    }

    if (!state.cancelled) {
      this.#sendJSON({ type: 'transfer-done', transferId });
      this.dispatchEvent(new CustomEvent('send-done', { detail: { transferId, fileName: file.name } }));
    }

    this.#sending.delete(transferId);
  }

  #waitForBufferLow(state) {
    return new Promise((resolve) => {
      const onLow = () => {
        this.#peer.off?.('bufferedamountlow', onLow);
        resolve();
      };
      this.#peer.on('bufferedamountlow', onLow);
      setTimeout(() => {
        this.#peer.off?.('bufferedamountlow', onLow);
        resolve();
      }, 80);
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
    // Robust state matching: try exact UUID, or fallback to single active receiving transfer
    let state = this.#receiving.get(transferId);
    if (!state && this.#receiving.size === 1) {
      state = this.#receiving.values().next().value;
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
  const idBytes = encoder.encode(transferId);
  const packet = new Uint8Array(headerLen + chunkArrayBuffer.byteLength);

  // Bytes 0..35: UUID string
  packet.set(idBytes.subarray(0, 36), 0);

  // Bytes 36..39: Uint32 chunkIndex
  const view = new DataView(packet.buffer);
  view.setUint32(36, chunkIndex, true);

  // Bytes 40..end: File chunk binary payload
  packet.set(new Uint8Array(chunkArrayBuffer), headerLen);
  return packet.buffer;
}

function unpackBinaryChunk(arrayBuffer) {
  const headerLen = 40;
  const view = new DataView(arrayBuffer);
  const idBytes = new Uint8Array(arrayBuffer, 0, 36);
  const transferId = decoder.decode(idBytes);

  const chunkIndex = view.getUint32(36, true);
  const data = arrayBuffer.slice(headerLen);

  return { transferId, chunkIndex, data };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
