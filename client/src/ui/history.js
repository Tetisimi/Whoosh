/**
 * history.js — Transfer history panel matching LocalSend design.
 * Features: file category icons, formatted date/size/peer metadata,
 * item context menu (...), and universal clipboard copy helper for mobile HTTP.
 */

import { loadHistory, removeHistoryEntry, clearHistory, formatBytes } from '../utils/storage.js';

export class HistoryUI {
  #panel;
  #onUpdate;
  #openMenuId = null;

  /**
   * @param {HTMLElement} panelEl
   * @param {() => void} onUpdate - called when history changes (to update badge)
   */
  constructor(panelEl, onUpdate) {
    this.#panel = panelEl;
    this.#onUpdate = onUpdate;
    this.render();
  }

  render() {
    const history = loadHistory();
    this.#panel.innerHTML = `
      <div class="history-header">
        <h3 class="history-title">History</h3>
        ${history.length > 0
          ? `<button class="btn btn--danger btn--sm history-clear-btn" id="history-clear-all">
              🗑️ Delete history
             </button>`
          : ''}
      </div>
      ${history.length === 0
        ? `<div class="history-empty">No transfer history yet</div>`
        : `<div class="history-list" id="history-list">
            ${history.map((entry) => this.#renderEntry(entry)).join('')}
           </div>`}
    `;

    // Clear all history
    this.#panel.querySelector('#history-clear-all')?.addEventListener('click', () => {
      clearHistory();
      this.render();
      this.#onUpdate?.();
    });

    // Item delete / context menu
    this.#panel.querySelectorAll('.history-menu-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        this.#toggleMenu(id);
      });
    });

    // Close menu when clicking outside
    document.addEventListener('click', () => {
      if (this.#openMenuId) {
        this.#closeAllMenus();
      }
    }, { once: true });
  }

  #toggleMenu(id) {
    const menuEl = this.#panel.querySelector(`.history-menu[data-id="${id}"]`);
    const isVisible = menuEl?.classList.contains('history-menu--visible');

    this.#closeAllMenus();

    if (!isVisible && menuEl) {
      menuEl.classList.add('history-menu--visible');
      this.#openMenuId = id;

      // Delete option inside menu
      menuEl.querySelector('.menu-opt-delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        removeHistoryEntry(id);
        this.render();
        this.#onUpdate?.();
      });

      // Copy text option inside menu
      menuEl.querySelector('.menu-opt-copy')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = menuEl.dataset.text;
        if (text) {
          copyTextToClipboard(text);
          showHistoryToast('📋 Copied message!');
        }
        this.#closeAllMenus();
      });
    }
  }

  #closeAllMenus() {
    this.#panel.querySelectorAll('.history-menu').forEach((m) => {
      m.classList.remove('history-menu--visible');
    });
    this.#openMenuId = null;
  }

  #renderEntry(entry) {
    const icon = getFileKindIcon(entry.filename, entry.kind);
    const dateStr = formatHistoryDate(entry.timestamp);
    const sizeStr = entry.sizeBytes > 0 ? `${formatBytes(entry.sizeBytes)}` : '';
    const dirIcon = entry.direction === 'sent' ? '↑ Sent' : '↓ Received';

    const metaParts = [dateStr];
    if (sizeStr) metaParts.push(sizeStr);
    metaParts.push(`${dirIcon} ${escapeHtml(entry.peerCodename)}`);

    const fullMessageText = entry.text || entry.filename;

    return `
      <div class="history-entry" data-id="${entry.id}">
        <div class="history-icon-box">
          <span class="history-icon">${icon}</span>
        </div>
        <div class="history-entry-body">
          <div class="history-entry-name" title="${escapeHtml(fullMessageText)}">
            ${escapeHtml(entry.filename)}
          </div>
          <div class="history-entry-meta">
            ${metaParts.join(' · ')}
          </div>
        </div>
        <div class="history-actions-wrap">
          <button class="history-menu-btn" data-id="${entry.id}" aria-label="Options">•••</button>
          <div class="history-menu" data-id="${entry.id}" data-text="${escapeHtml(fullMessageText)}">
            ${entry.kind === 'text' ? `<button class="history-menu-opt menu-opt-copy">📋 Copy Message</button>` : ''}
            <button class="history-menu-opt menu-opt-delete">🗑️ Delete from history</button>
          </div>
        </div>
      </div>
    `;
  }
}

// ── Universal Copy Helper (Works on Desktop & iOS Safari over HTTP) ─────────

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
    console.warn('execCommand copy failed:', err);
  }
  document.body.removeChild(textarea);
}

function showHistoryToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast toast--visible';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFileKindIcon(filename, kind) {
  if (kind === 'text') return '💬';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)) return '🖼️';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return '🎥';
  if (['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg'].includes(ext)) return '🎵';
  if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) return '📦';
  if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'csv', 'xlsx'].includes(ext)) return '📄';
  return '📁';
}

function formatHistoryDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }) + ' ' + d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
