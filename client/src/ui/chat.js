/**
 * chat.js — Interactive B2B messaging conversation panel.
 *
 * Renders an organized threaded conversation with a selected device,
 * complete with back navigation, timestamped message bubbles, 1-tap copy,
 * and direct WebRTC text sending that opens the conversation on both ends.
 */

import { loadHistory } from '../utils/storage.js';

export class ChatUI {
  #panel;
  #onSend;
  #getPeerStatus;
  #activePeer = null;
  #activePeerId = null;

  /**
   * @param {HTMLElement} panelEl
   * @param {{ onSend: (peerCodename: string, peerId: string|null, text: string) => void, getPeerStatus: (peerId: string|null, codename: string) => boolean }} callbacks
   */
  constructor(panelEl, { onSend, getPeerStatus }) {
    this.#panel = panelEl;
    this.#onSend = onSend;
    this.#getPeerStatus = getPeerStatus;
  }

  get isOpen() {
    return this.#panel.classList.contains('chat-panel-overlay--active');
  }

  get activePeerCodename() {
    return this.#activePeer;
  }

  /**
   * Open the interactive chat interface with a target peer.
   * @param {string} peerCodename
   * @param {string} [peerId]
   */
  open(peerCodename, peerId = null) {
    if (!peerCodename || peerCodename === 'Unknown') return;
    this.#activePeer = peerCodename;
    this.#activePeerId = peerId;

    this.render();
    this.#panel.classList.add('chat-panel-overlay--active');

    // Scroll to bottom immediately
    requestAnimationFrame(() => this.#scrollToBottom());
  }

  close() {
    this.#panel.classList.remove('chat-panel-overlay--active');
    this.#activePeer = null;
    this.#activePeerId = null;
    this.#panel.innerHTML = '';
  }

  refresh() {
    if (!this.isOpen || !this.#activePeer) return;
    this.render();
    requestAnimationFrame(() => this.#scrollToBottom());
  }

  render() {
    const isOnline = this.#getPeerStatus(this.#activePeerId, this.#activePeer);
    const history = loadHistory();

    // Filter all text messages between us and this peer, oldest first
    const messages = history
      .filter((entry) => entry.kind === 'text' && entry.peerCodename === this.#activePeer)
      .reverse();

    this.#panel.innerHTML = `
      <div class="chat-header">
        <button class="chat-back-btn" id="chat-back-btn" aria-label="Back to Transfers / History">
          ← Back
        </button>
        <div class="chat-peer-info">
          <span class="chat-status-dot ${isOnline ? '' : 'chat-status-dot--offline'}" title="${isOnline ? 'Connected' : 'Offline'}"></span>
          <span class="chat-peer-name">${escapeHtml(this.#activePeer)}</span>
        </div>
      </div>
      <div class="chat-stream" id="chat-stream">
        ${messages.length === 0
          ? `<div class="chat-empty-stream">No previous messages with ${escapeHtml(this.#activePeer)}.<br/>Type below to start an interactive B2B conversation!</div>`
          : messages.map((m) => this.#renderMessage(m)).join('')}
      </div>
      <div class="chat-input-bar">
        <input type="text" class="chat-input" id="chat-input-field" placeholder="Message ${escapeHtml(this.#activePeer)}…" maxlength="4096" autocomplete="off" />
        <button class="chat-send-btn" id="chat-send-btn">↑</button>
      </div>
    `;

    // Event listeners
    this.#panel.querySelector('#chat-back-btn')?.addEventListener('click', () => {
      this.close();
    });

    const inputEl = this.#panel.querySelector('#chat-input-field');
    const sendBtn = this.#panel.querySelector('#chat-send-btn');

    const handleSend = () => {
      const text = inputEl?.value.trim();
      if (!text) return;
      inputEl.value = '';
      this.#onSend(this.#activePeer, this.#activePeerId, text);
      this.refresh();
      inputEl?.focus();
    };

    sendBtn?.addEventListener('click', handleSend);
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Copy actions inside bubbles
    this.#panel.querySelectorAll('.chat-copy-action').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = btn.dataset.copyText;
        if (text) {
          copyTextToClipboard(text);
          btn.textContent = '✓ Copied';
          setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
        }
      });
    });
  }

  #renderMessage(entry) {
    const isSent = entry.direction === 'sent';
    const bubbleClass = isSent ? 'chat-bubble--sent' : 'chat-bubble--received';
    const timeStr = new Date(entry.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const textContent = entry.text || entry.filename;

    return `
      <div class="chat-bubble ${bubbleClass}" data-id="${entry.id}">
        <div class="chat-text">${escapeHtml(textContent)}</div>
        <div class="chat-meta">
          <span class="chat-timestamp">${timeStr}</span>
          <button class="chat-copy-action" data-copy-text="${escapeHtml(textContent)}" title="Copy message">📋 Copy</button>
        </div>
      </div>
    `;
  }

  #scrollToBottom() {
    const stream = this.#panel.querySelector('#chat-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  }
}

// ── Universal Clipboard Copy Helper ────────────────────────────────────────

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

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
