/**
 * transfer.js — PairDrop-inspired ultra-fast WebRTC binary transfer engine.
 *
 * Architecture (matches PairDrop & Snapdrop):
 *  - Control messages (JSON strings): transfer-start, transfer-done, transfer-cancel, text-message
 *  - File data (Raw ArrayBuffers): Zero-header raw binary chunks streamed directly over RTCDataChannel.
 *  - Ordered & reliable DataChannel ensures 100% sequential, zero-copy packet arrival.
 *  - Event-driven backpressure flow control prevents SCTP buffer drops.
 */

import { generateUUID } from './utils/uuid.js';

const CHUNK_SIZE        = 64 * 1024;         // 64 KB — standard SCTP chunk size
const SLAB_SIZE         = 2 * 1024 * 1024;   // 2 MB memory slab batch-read from disk
const BUFFER_HIGH       = 8 * 1024 * 1024;   // 8 MB high watermark to maintain throughput on Gigabit LAN
const BUFFER_LOW        = 2 * 1024 * 1024;   // 2 MB low watermark for instant resumption
const PROGRESS_INTERVAL = 100;               // Throttle UI DOM progress updates to 10/sec for smooth DOM rendering
const SPEED_WINDOW_MS   = 1500;              // 1.5s rolling speed window

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
        lastActualSent: 0,
        bytesInWindow: 0,
        speedSamples: [],
      };

      this.#sending.set(transferId, state);
      this.#sendQueue.push(state);
      ids.push(transferId);

      // Announce transfer start metadata
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
    let lastProgressAt = 0;

    // Zero-Latency First Chunk: Instantly read and transmit the first 64KB chunk so transfer starts in 0ms
    if (state.nextChunk === 0 && chunkCount > 0 && !state.cancelled) {
      const firstSlice = await file.slice(0, Math.min(CHUNK_SIZE, file.size)).arrayBuffer();
      const ok = this.#peer.send(firstSlice);
      if (!ok) {
        await sleep(2);
        this.#peer.send(firstSlice);
      }
      state.bytesSent += firstSlice.byteLength;
      state.nextChunk = 1;
      this.#emitSendProgress(state, Date.now());
      lastProgressAt = Date.now();
    }

    // 2 MB Slab Double-Buffering: read large blocks from disk once and slice synchronously in memory
    const chunksPerSlab = Math.floor(SLAB_SIZE / CHUNK_SIZE);
    let slabIdx = Math.floor(state.nextChunk / chunksPerSlab);
    const totalSlabs = Math.ceil(file.size / SLAB_SIZE);

    const fetchSlab = (idx) => {
      if (idx >= totalSlabs) return null;
      const start = idx * SLAB_SIZE;
      const end = Math.min(file.size, start + SLAB_SIZE);
      return file.slice(start, end).arrayBuffer();
    };

    let currentSlabPromise = fetchSlab(slabIdx);
    let nextSlabPromise = fetchSlab(slabIdx + 1);

    while (state.nextChunk < chunkCount && !state.cancelled) {
      if (this.#peer.bufferedAmount > BUFFER_HIGH) {
        await this.#waitForBufferDrain(state);
        if (state.cancelled) break;
      }

      const slab = await currentSlabPromise;
      if (!slab || state.cancelled) break;

      const slabStartChunk = slabIdx * chunksPerSlab;
      const chunksInThisSlab = Math.ceil(slab.byteLength / CHUNK_SIZE);

      for (let i = 0; i < chunksInThisSlab && !state.cancelled; i++) {
        const chunkIndex = slabStartChunk + i;
        if (chunkIndex < state.nextChunk) continue;

        if (this.#peer.bufferedAmount > BUFFER_HIGH) {
          await this.#waitForBufferDrain(state);
          if (state.cancelled) break;
        }

        const offset = i * CHUNK_SIZE;
        const length = Math.min(CHUNK_SIZE, slab.byteLength - offset);
        const chunkBuffer = slab.slice(offset, offset + length);

        const ok = this.#peer.send(chunkBuffer);
        if (!ok) {
          await sleep(2);
          if (!this.#peer.send(chunkBuffer)) {
            await sleep(10);
            this.#peer.send(chunkBuffer);
          }
        }

        state.bytesSent += length;
        state.nextChunk = chunkIndex + 1;

        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_INTERVAL) {
          lastProgressAt = now;
          this.#emitSendProgress(state, now);
        }
      }

      slabIdx++;
      currentSlabPromise = nextSlabPromise;
      nextSlabPromise = fetchSlab(slabIdx + 1);
    }

    if (!state.cancelled) {
      // 1. Wait until all buffered bytes have actually left the sender's network socket
      await this.#waitForBufferEmpty();
      if (!state.cancelled) {
        this.#emitSendProgress(state, Date.now());
        // 2. Notify receiver that all chunks are sent
        this.#sendJSON({ type: 'transfer-done', transferId });
        // 3. Wait for receiver to acknowledge file assembly (with 5s fallback safety cap)
        await this.#waitForAck(transferId);
        this.dispatchEvent(new CustomEvent('send-done', { detail: { transferId, fileName: file.name } }));
      }
    }
    this.#sending.delete(transferId);
  }

  // Wait until local DataChannel buffer is completely empty (0 bytes in flight)
  #waitForBufferEmpty() {
    if (this.#peer.bufferedAmount === 0) return Promise.resolve();
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if (this.#peer.bufferedAmount === 0) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
      setTimeout(() => { clearInterval(poll); resolve(); }, 10000);
    });
  }

  // Wait for transfer-ack from receiver
  #waitForAck(transferId) {
    const state = this.#sending.get(transferId);
    if (!state || state.acked) return Promise.resolve();
    return new Promise(resolve => {
      state.ackResolver = resolve;
      setTimeout(resolve, 5000); // 5s fallback timeout
    });
  }

  #updateSpeed(state, deltaBytes, now = Date.now()) {
    state.bytesInWindow = (state.bytesInWindow || 0) + deltaBytes;
    const samples = state.speedSamples || (state.speedSamples = []);
    // Bucket speed samples by 100ms to eliminate garbage collection pauses at gigabit rates
    if (samples.length > 0 && now - samples[samples.length - 1].t < 100) {
      samples[samples.length - 1].bytes += deltaBytes;
    } else {
      samples.push({ t: now, bytes: deltaBytes });
    }
    while (samples.length > 0 && now - samples[0].t > SPEED_WINDOW_MS) {
      state.bytesInWindow -= samples.shift().bytes;
    }
    return Math.max(0, (state.bytesInWindow / SPEED_WINDOW_MS) * 1000);
  }

  #emitSendProgress(state, now = Date.now()) {
    const actualSent = Math.max(0, state.bytesSent - this.#peer.bufferedAmount);
    const delta = actualSent - state.lastActualSent;
    let speed = 0;
    if (delta > 0) {
      state.lastActualSent = actualSent;
      speed = this.#updateSpeed(state, delta, now);
    } else {
      speed = this.#updateSpeed(state, 0, now);
    }

    this.dispatchEvent(new CustomEvent('send-progress', {
      detail: {
        transferId: state.transferId,
        bytesSent: actualSent,
        totalBytes: state.file.size,
        speedBps: Math.max(0, speed),
      },
    }));
  }

  // Event-driven backpressure drain (PairDrop / Snapdrop strategy)
  #waitForBufferDrain(state) {
    if (this.#peer.bufferedAmount <= BUFFER_LOW) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let lastProgress = 0;

      const done = () => {
        if (!settled) {
          settled = true;
          clearInterval(poll);
          this.#peer.removeEventListener('bufferedamountlow', done);
          resolve();
        }
      };

      this.#peer.addEventListener('bufferedamountlow', done);

      // Micro-poll fallback to ensure instant resume if event is missed
      const poll = setInterval(() => {
        const now = Date.now();
        if (now - lastProgress >= PROGRESS_INTERVAL) {
          lastProgress = now;
          this.#emitSendProgress(state, now);
        }
        if (state.cancelled || this.#peer.bufferedAmount <= BUFFER_LOW) done();
      }, 5);

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

  cancelSend(transferId) {
    const state = this.#sending.get(transferId);
    if (state) {
      state.cancelled = true;
    }
    this.#sending.delete(transferId);
    this.#sendJSON({ type: 'transfer-cancel', transferId });
    this.dispatchEvent(new CustomEvent('send-cancel', { detail: { transferId } }));
  }

  cancelReceive(transferId) {
    const state = this.#receiving.get(transferId);
    if (state) {
      state.cancelled = true;
    }
    this.#receiving.delete(transferId);
    this.#sendJSON({ type: 'transfer-cancel', transferId });
    this.dispatchEvent(new CustomEvent('receive-cancel', { detail: { transferId } }));
  }

  resumeSend(transferId, fromChunk) {
    const state = this.#sending.get(transferId);
    if (!state) return;
    state.nextChunk = fromChunk;
    this.#pumpChunks(state);
  }

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
        case 'transfer-start':  this.#onTransferStart(msg); break;
        case 'transfer-done':   this.#onTransferDone(msg); break;
        case 'transfer-ack':    this.#onTransferAck(msg); break;
        case 'transfer-cancel': this.#onTransferCancel(msg); break;
        case 'text-message':    this.#onTextMessage(msg); break;
        case 'resume-request':  this.#onResumeRequest(msg); break;
        case 'nak':             this.#onNak(msg); break;
      }
      return;
    }

    // PairDrop Direct Receive: Pure raw ArrayBuffer stored zero-copy into active transfer chunks
    if (data instanceof ArrayBuffer) {
      this.#onBinaryChunk(data);
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
      startTime: Date.now(),
      bytesReceived: 0,
      bytesInWindow: 0,
      speedSamples: [],
    };
    this.#receiving.set(msg.transferId, state);

    this.dispatchEvent(new CustomEvent('receive-start', {
      detail: { transferId: msg.transferId, fileName: msg.fileName, fileSize: msg.fileSize },
    }));
  }

  #onBinaryChunk(arrayBuffer) {
    // Find active receiving state (files sent sequentially)
    let state = null;
    if (this.#receiving.size === 1) {
      state = this.#receiving.values().next().value;
    } else {
      for (const s of this.#receiving.values()) {
        if (s.receivedCount < s.chunkCount) {
          state = s;
          break;
        }
      }
    }
    if (!state) return;

    // Zero-copy store raw ArrayBuffer chunk into array
    state.chunks[state.receivedCount] = arrayBuffer;
    state.receivedCount++;
    state.bytesReceived += arrayBuffer.byteLength;

    const now = Date.now();
    const speed = this.#updateSpeed(state, arrayBuffer.byteLength, now);

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

    // PairDrop Blob Assembly
    const blob = new Blob(state.chunks, { type: state.fileType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    // Send bi-directional ACK to sender so sender UI completes synchronously
    this.#sendJSON({ type: 'transfer-ack', transferId: state.transferId });

    this.dispatchEvent(new CustomEvent('receive-done', {
      detail: {
        transferId: state.transferId,
        fileName: state.fileName,
        fileSize: state.fileSize,
        fileType: state.fileType,
        blob,
        url,
      },
    }));

    this.#receiving.delete(state.transferId);
  }

  #onTransferAck(msg) {
    const state = this.#sending.get(msg.transferId);
    if (state) {
      state.acked = true;
      state.ackResolver?.();
    }
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

  #onResumeRequest(msg) {
    this.resumeSend(msg.transferId, msg.fromChunk);
  }

  #onNak(msg) {
    this.dispatchEvent(new CustomEvent('transfer-error', {
      detail: { transferId: msg.transferId, message: msg.message },
    }));
  }

  #sendJSON(obj) {
    this.#peer.send(JSON.stringify(obj));
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
    return this;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
