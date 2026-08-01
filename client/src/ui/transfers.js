/**
 * transfers.js — Active transfer panel UI.
 * Shows per-file progress bars, speed indicators, ETA, and connection mode badge.
 */

import { formatBytes } from '../utils/storage.js';

export class TransfersUI {
  /** @type {HTMLElement} */
  #panel;
  /** Map<transferId, HTMLElement> */
  #items = new Map();

  constructor(panelEl) {
    this.#panel = panelEl;
    this.#panel.innerHTML = `
      <div class="transfers-header">
        <h3 class="transfers-title">Transfers</h3>
        <div class="transfers-empty" id="transfers-empty">No active transfers</div>
      </div>
      <div class="transfers-list" id="transfers-list"></div>
    `;
  }

  get #list() { return this.#panel.querySelector('#transfers-list'); }
  get #emptyMsg() { return this.#panel.querySelector('#transfers-empty'); }

  #updateEmpty() {
    this.#emptyMsg.style.display = this.#items.size === 0 ? 'block' : 'none';
  }

  /**
   * Create a send transfer item.
   * @param {{ transferId, fileName, fileSize, chunkCount, peerCodename }} opts
   */
  addSend({ transferId, fileName, fileSize, chunkCount, peerCodename }) {
    const el = this.#makeItem({ transferId, fileName, fileSize, direction: 'send', peerCodename });
    this.#list.prepend(el);
    this.#items.set(transferId, el);
    this.#updateEmpty();
  }

  /**
   * Create a receive transfer item.
   */
  addReceive({ transferId, fileName, fileSize, peerCodename }) {
    const el = this.#makeItem({ transferId, fileName, fileSize, direction: 'receive', peerCodename });
    this.#list.prepend(el);
    this.#items.set(transferId, el);
    this.#updateEmpty();
  }

  /**
   * Update progress for an active transfer.
   * @param {{ transferId, bytesTransferred, totalBytes, speedBps }} opts
   */
  updateProgress({ transferId, bytesTransferred, totalBytes, speedBps }) {
    const el = this.#items.get(transferId);
    if (!el) return;

    const pct = totalBytes > 0 ? Math.min((bytesTransferred / totalBytes) * 100, 100) : 0;
    el.querySelector('.transfer-fill').style.width = `${pct.toFixed(1)}%`;
    el.querySelector('.transfer-pct').textContent = `${pct.toFixed(0)}%`;
    el.querySelector('.transfer-transferred').textContent = formatBytes(bytesTransferred);

    const speed = speedBps > 0 ? formatBytes(speedBps) + '/s' : '—';
    el.querySelector('.transfer-speed').textContent = speed;

    if (speedBps > 0 && totalBytes > bytesTransferred) {
      const etaSec = (totalBytes - bytesTransferred) / speedBps;
      el.querySelector('.transfer-eta').textContent = `ETA ${formatEta(etaSec)}`;
    }
  }

  /**
   * Mark a transfer as complete.
   * @param {{ transferId, url?, fileName }} opts
   */
  completeSend({ transferId }) {
    const el = this.#items.get(transferId);
    if (!el) return;
    el.classList.add('transfer-item--done');
    el.querySelector('.transfer-fill').style.width = '100%';
    el.querySelector('.transfer-pct').textContent = '100%';
    el.querySelector('.transfer-speed').textContent = '✓ Sent';
    el.querySelector('.transfer-eta').textContent = '';
    this.#scheduleRemove(transferId, 5000);
  }

  completeReceive({ transferId, url, blob, fileName }) {
    const el = this.#items.get(transferId);
    if (!el) return;
    el.classList.add('transfer-item--done');
    el.querySelector('.transfer-fill').style.width = '100%';
    el.querySelector('.transfer-pct').textContent = '100%';
    el.querySelector('.transfer-speed').textContent = '✓ Received';
    el.querySelector('.transfer-eta').textContent = '';

    const actionsEl = el.querySelector('.transfer-actions');
    actionsEl.innerHTML = '';

    // Native Mobile Share Sheet (iOS / Android)
    if (blob && navigator.canShare) {
      try {
        const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
        if (navigator.canShare({ files: [file] })) {
          const shareBtn = document.createElement('button');
          shareBtn.className = 'btn btn--sm btn--primary transfer-share';
          shareBtn.innerHTML = '📤 Share / Save';
          shareBtn.addEventListener('click', async () => {
            try {
              await navigator.share({ files: [file], title: fileName });
            } catch { /* share cancelled */ }
          });
          actionsEl.appendChild(shareBtn);
        }
      } catch { /* canShare fail */ }
    }

    if (url) {
      const dl = document.createElement('a');
      dl.href = url;
      dl.download = fileName;
      dl.className = 'btn btn--sm btn--ghost transfer-download';
      dl.textContent = '↓ Save File';
      actionsEl.appendChild(dl);
    }
    this.#scheduleRemove(transferId, 30000);
  }


  cancelTransfer(transferId) {
    const el = this.#items.get(transferId);
    if (!el) return;
    el.classList.add('transfer-item--cancelled');
    el.querySelector('.transfer-speed').textContent = 'Cancelled';
    const actions = el.querySelector('.transfer-actions');
    if (actions) actions.innerHTML = '';
    this.#items.delete(transferId);
    this.#scheduleRemove(transferId, 600);
  }

  markInterrupted(transferId) {
    const el = this.#items.get(transferId);
    if (!el) return;
    el.classList.add('transfer-item--cancelled');
    el.querySelector('.transfer-speed').textContent = '⚠️ Disconnected';
    const actions = el.querySelector('.transfer-actions');
    if (actions) {
      actions.innerHTML = `<button class="btn btn--sm btn--danger remove-transfer-btn">🗑️ Clear</button>`;
      actions.querySelector('.remove-transfer-btn')?.addEventListener('click', () => {
        el.remove();
        this.#items.delete(transferId);
        this.#updateEmpty();
      });
    }
  }

  /**
   * Update the connection mode badge for transfers to/from a peer.
   * @param {string} transferId
   * @param {'direct'|'relayed'|'unknown'} mode
   */
  setConnectionMode(transferId, mode) {
    const el = this.#items.get(transferId);
    if (!el) return;
    const badge = el.querySelector('.transfer-mode-badge');
    badge.dataset.mode = mode;
    badge.textContent = mode === 'relayed' ? '⚡ Relayed' : mode === 'direct' ? '⬤ Direct P2P' : '';
    badge.title = mode === 'relayed'
      ? 'Using TURN relay (NAT traversal). Slightly slower.'
      : 'Direct peer-to-peer connection. Maximum speed.';
  }

  #makeItem({ transferId, fileName, fileSize, direction, peerCodename }) {
    const el = document.createElement('div');
    el.className = 'transfer-item';
    el.dataset.transferId = transferId;
    el.innerHTML = `
      <div class="transfer-header">
        <span class="transfer-direction">${direction === 'send' ? '↑' : '↓'}</span>
        <span class="transfer-filename" title="${fileName}">${truncateFilename(fileName)}</span>
        <span class="transfer-size">${formatBytes(fileSize)}</span>
        <span class="transfer-mode-badge" data-mode="unknown"></span>
      </div>
      <div class="transfer-peer">
        ${direction === 'send' ? 'To' : 'From'} <strong>${peerCodename}</strong>
      </div>
      <div class="transfer-progress-wrap">
        <div class="transfer-bar">
          <div class="transfer-fill"></div>
        </div>
        <span class="transfer-pct">0%</span>
      </div>
      <div class="transfer-stats">
        <span class="transfer-transferred">0 B</span>
        <span class="transfer-speed">—</span>
        <span class="transfer-eta"></span>
      </div>
      <div class="transfer-actions">
        <button class="btn btn--sm btn--ghost transfer-cancel-btn" title="Cancel & delete transfer">✕</button>
      </div>
    `;

    el.querySelector('.transfer-cancel-btn')?.addEventListener('click', () => {
      this.cancelTransfer(transferId);
    });

    return el;
  }


  /**
   * Add a text message card with 1-tap copy button into active transfers.
   * @param {{ id: string, text: string, peerCodename: string, direction: 'sent'|'received' }} opts
   */
  addTextMessage({ id = 'txt_' + Date.now(), text, peerCodename, direction }) {
    const el = document.createElement('div');
    el.className = `transfer-item transfer-item--done transfer-item--text`;
    const timeStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    el.innerHTML = `
      <div class="transfer-info" style="flex:1;">
        <div class="transfer-header-row">
          <span class="transfer-name" style="font-weight:600; color:var(--text-primary);">💬 ${escapeHtml(text)}</span>
        </div>
        <div class="transfer-meta" style="margin-top:2px;">
          <span class="transfer-speed" style="color:var(--accent);">${direction === 'received' ? '↓ Received from' : '↑ Sent to'} ${escapeHtml(peerCodename)}</span>
          <span class="transfer-eta">${timeStr}</span>
        </div>
      </div>
      <div class="transfer-actions" style="margin-left:auto;">
        <button class="btn btn--sm btn--primary copy-text-action-btn">📋 Copy</button>
      </div>
    `;

    el.querySelector('.copy-text-action-btn').addEventListener('click', () => {
      copyTextToClipboard(text);
      const btn = el.querySelector('.copy-text-action-btn');
      btn.textContent = '✓ Copied!';
      btn.style.background = 'var(--green)';
      setTimeout(() => {
        btn.textContent = '📋 Copy';
        btn.style.background = '';
      }, 2500);
    });

    this.#list.prepend(el);
    this.#items.set(id, el);
    this.#updateEmpty();
  }

  #scheduleRemove(transferId, delay) {
    setTimeout(() => {
      const el = this.#items.get(transferId);
      if (el) {
        el.classList.add('transfer-item--exiting');
        setTimeout(() => {
          el.remove();
          this.#items.delete(transferId);
          this.#updateEmpty();
        }, 400);
      }
    }, delay);
  }
}

function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
  } else {
    fallbackCopyText(text);
  }
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.top = '0';
  textarea.style.left = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } catch (err) {
    console.warn('Fallback copy failed:', err);
  }
  document.body.removeChild(textarea);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateFilename(name, max = 28) {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf('.');
  if (ext > 0) {
    const base = name.slice(0, ext);
    const suffix = name.slice(ext);
    return base.slice(0, max - suffix.length - 3) + '…' + suffix;
  }
  return name.slice(0, max - 3) + '…';
}

function formatEta(sec) {
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

