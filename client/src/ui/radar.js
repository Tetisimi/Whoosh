/**
 * radar.js — Animated radar-style device discovery UI.
 *
 * Renders an SVG radar with concentric rings and animated sweep.
 * Each discovered peer appears as a clickable avatar orbiting the rings.
 */

import { buildSharedSecret, deriveVerificationEmojis } from '../utils/verification.js';

export class RadarUI {
  /** @type {HTMLElement} */
  #container;
  #svgEl;
  #peersEl;

  /** Map<peerId, { el, meta, angle }> */
  #peerEls = new Map();

  #onPeerClick = null;
  #localId = null;

  /**
   * @param {HTMLElement} container
   * @param {(peerId: string) => void} onPeerClick
   */
  constructor(container, onPeerClick) {
    this.#container = container;
    this.#onPeerClick = onPeerClick;
    this.#render();
  }

  setLocalId(id) {
    this.#localId = id;
  }

  #render() {
    this.#container.innerHTML = `
      <div class="radar-wrap">
        <svg class="radar-svg" viewBox="-150 -150 300 300" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="radarGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.08"/>
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
            </radialGradient>
            <linearGradient id="sweepGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0"/>
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.4"/>
            </linearGradient>
          </defs>

          <!-- Background fill -->
          <circle cx="0" cy="0" r="148" fill="url(#radarGrad)"/>

          <!-- Concentric rings -->
          <circle class="radar-ring" cx="0" cy="0" r="50"/>
          <circle class="radar-ring" cx="0" cy="0" r="95"/>
          <circle class="radar-ring" cx="0" cy="0" r="140"/>

          <!-- Cross hairs -->
          <line class="radar-crosshair" x1="-148" y1="0" x2="148" y2="0"/>
          <line class="radar-crosshair" x1="0" y1="-148" x2="0" y2="148"/>

          <!-- Sweep arm -->
          <g class="radar-sweep">
            <path d="M0,0 L148,0 A148,148 0 0,0 0,-148 Z" fill="url(#sweepGrad)" opacity="0.5"/>
          </g>
        </svg>

        <!-- Self avatar at center -->
        <div class="radar-self" title="You">
          <div class="radar-avatar radar-avatar--self">
            <span class="avatar-icon">🖥️</span>
          </div>
        </div>

        <!-- Peers rendered as absolutely positioned elements -->
        <div class="radar-peers" id="radar-peers"></div>
      </div>
    `;

    this.#svgEl = this.#container.querySelector('.radar-svg');
    this.#peersEl = this.#container.querySelector('#radar-peers');
  }

  /**
   * Add or update a peer on the radar.
   * @param {{ id: string, codename: string }} peer
   */
  addPeer(peer) {
    // Purge any existing peer entry with the same codename to avoid duplicate icons
    for (const [id, entry] of this.#peerEls.entries()) {
      if (entry.meta.codename === peer.codename && id !== peer.id) {
        entry.el.remove();
        this.#peerEls.delete(id);
      }
    }

    if (this.#peerEls.has(peer.id)) {
      this.updatePeer(peer);
      return;
    }

    // Pick angle evenly distributed, slight randomness to avoid stacking
    const count = this.#peerEls.size;
    let angle = ((count * 137.5) % 360) + (Math.random() * 20 - 10);
    let ring = count < 3 ? 60 : count < 6 ? 95 : 125;
    let { x, y } = polarToPercent(angle, ring);

    // Collision-repulsion check against existing bubbles and central icon (50%, 50%)
    for (let attempt = 0; attempt < 12; attempt++) {
      let hasOverlap = Math.hypot(x - 50, y - 50) < 20; // preserve center clearance
      for (const entry of this.#peerEls.values()) {
        const ex = parseFloat(entry.el.style.left) || 50;
        const ey = parseFloat(entry.el.style.top) || 50;
        if (Math.hypot(x - ex, y - ey) < 24) {
          hasOverlap = true;
          break;
        }
      }
      if (!hasOverlap) break;
      angle = (angle + 45) % 360;
      if (attempt % 3 === 2) ring = Math.min(135, ring + 20);
      ({ x, y } = polarToPercent(angle, ring));
    }

    const el = document.createElement('div');
    el.className = 'radar-peer';
    el.dataset.peerId = peer.id;
    el.innerHTML = `
      <div class="radar-avatar radar-avatar--peer" data-state="connecting" title="${peer.codename} — connecting…">
        <span class="avatar-icon">${getPeerIcon(peer.codename)}</span>
        <div class="radar-peer-ping"></div>
      </div>
      <div class="radar-peer-label">${peer.codename}</div>
    `;

    // Position on radar (convert polar to %)
    el.style.left = `${x}%`;
    el.style.top = `${y}%`;

    // Interactive pointer drag-and-drop vs tap differentiation
    let isDragging = false;
    let startX = 0, startY = 0;
    let origLeft = 0, origTop = 0;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== undefined) return;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = parseFloat(el.style.left) || x;
      origTop = parseFloat(el.style.top) || y;
      isDragging = false;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > 5) {
        isDragging = true;
        el.classList.add('dragging');
        const container = this.#peersEl.getBoundingClientRect();
        if (container.width && container.height) {
          const pctX = (dx / container.width) * 100;
          const pctY = (dy / container.height) * 100;
          let newX = Math.max(8, Math.min(92, origLeft + pctX));
          let newY = Math.max(8, Math.min(92, origTop + pctY));
          el.style.left = `${newX}%`;
          el.style.top = `${newY}%`;
        }
      }
    });

    const endDrag = (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
      if (!isDragging) {
        this.#onPeerClick?.(peer.id, peer.codename);
      }
      isDragging = false;
    };

    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    // Animate in
    requestAnimationFrame(() => el.classList.add('radar-peer--visible'));

    this.#peersEl.appendChild(el);
    this.#peerEls.set(peer.id, { el, meta: peer, angle, ring });
  }

  /**
   * Remove a peer from the radar.
   * @param {string} peerId
   */
  removePeer(peerId) {
    const entry = this.#peerEls.get(peerId);
    if (!entry) return;
    entry.el.classList.add('radar-peer--leaving');
    setTimeout(() => entry.el.remove(), 400);
    this.#peerEls.delete(peerId);
  }

  /**
   * Update peer display (e.g. connection state).
   */
  updatePeer(peer, state = null) {
    const entry = this.#peerEls.get(peer.id);
    if (!entry) return;
    if (state) {
      const av = entry.el.querySelector('.radar-avatar');
      av.dataset.state = state;
      if (state === 'connected') {
        av.title = entry.meta.codename + ' — tap to send';
      } else if (state === 'failed') {
        av.title = entry.meta.codename + ' — connection failed';
      }
    }
  }

  /**
   * Flash a peer avatar to indicate incoming/outgoing transfer.
   */
  flashPeer(peerId, mode = 'send') {
    const entry = this.#peerEls.get(peerId);
    if (!entry) return;
    const av = entry.el.querySelector('.radar-avatar');
    av.classList.add(`radar-avatar--${mode}`);
    setTimeout(() => av.classList.remove(`radar-avatar--${mode}`), 1500);
  }

  clearPeers() {
    for (const [id] of this.#peerEls) this.removePeer(id);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert polar coords on the radar circle to CSS % positions */
function polarToPercent(angleDeg, radius) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  // radar-wrap is 300x300 viewBox, map radius from 0-148 to 0-50% offset from center
  const pct = (radius / 148) * 50;
  return {
    x: 50 + pct * Math.cos(rad),
    y: 50 + pct * Math.sin(rad),
  };
}

/** Pick a deterministic emoji icon based on codename */
const DEVICE_ICONS = ['🦊', '🐬', '🦅', '🐉', '🦁', '🦋', '🐢', '🐙', '🦜', '🦩'];
function getPeerIcon(codename) {
  let hash = 0;
  for (let i = 0; i < codename.length; i++) hash = (hash * 31 + codename.charCodeAt(i)) | 0;
  return DEVICE_ICONS[Math.abs(hash) % DEVICE_ICONS.length];
}
