/**
 * pairing.js — Cross-network pairing UI.
 * Handles: room code display, QR code generation, 6-digit join input,
 *          and the emoji verification overlay shown after connection.
 */

import QRCode from 'qrcode';
import { buildSharedSecret, deriveVerificationEmojis } from '../utils/verification.js';

export class PairingUI {
  #container;
  #modal;
  #onCreateRoom;
  #onJoinRoom;

  /**
   * @param {HTMLElement} container
   * @param {{ onCreateRoom: () => void, onJoinRoom: (code: string) => void }} callbacks
   */
  constructor(container, { onCreateRoom, onJoinRoom }) {
    this.#container = container;
    this.#onCreateRoom = onCreateRoom;
    this.#onJoinRoom = onJoinRoom;
    this.#render();
  }

  #render() {
    // Inject pairing button into the container (used in the bottom action bar)
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost';
    btn.id = 'pairing-btn';
    btn.innerHTML = `<span class="btn-icon">🔗</span> Pair Device`;
    btn.addEventListener('click', () => this.showPairingModal());
    this.#container.appendChild(btn);
  }

  showPairingModal() {
    this.#removeModal();
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'pairing-modal';
    modal.innerHTML = `
      <div class="modal">
        <button class="modal-close" id="pairing-close" aria-label="Close">✕</button>
        <h2 class="modal-title">Pair a Device</h2>
        <p class="modal-subtitle">Share a room code or QR with another device</p>

        <div class="pairing-tabs">
          <button class="pairing-tab pairing-tab--active" data-tab="create">Create Room</button>
          <button class="pairing-tab" data-tab="join">Join Room</button>
        </div>

        <div id="tab-create" class="tab-panel tab-panel--active">
          <button class="btn btn--primary btn--wide" id="create-room-btn">
            Generate Room Code
          </button>
          <div id="room-code-display" class="room-code-display" style="display:none">
            <div class="room-code-digits" id="room-code-digits"></div>
            <canvas id="qr-canvas" class="qr-canvas"></canvas>
            <p class="room-code-hint">Share this code or QR with the other device.<br>Expires in 24 hours.</p>
          </div>
        </div>

        <div id="tab-join" class="tab-panel">
          <div class="otp-inputs" id="otp-inputs">
            <input class="otp-digit" type="text" inputmode="numeric" maxlength="1" pattern="[0-9]" autocomplete="off" data-index="0">
            <input class="otp-digit" type="text" inputmode="numeric" maxlength="1" pattern="[0-9]" autocomplete="off" data-index="1">
            <input class="otp-digit" type="text" inputmode="numeric" maxlength="1" pattern="[0-9]" autocomplete="off" data-index="2">
            <span class="otp-sep">—</span>
            <input class="otp-digit" type="text" inputmode="numeric" maxlength="1" pattern="[0-9]" autocomplete="off" data-index="3">
            <input class="otp-digit" type="text" inputmode="numeric" maxlength="1" pattern="[0-9]" autocomplete="off" data-index="4">
            <input class="otp-digit" type="text" inputmode="numeric" maxlength="1" pattern="[0-9]" autocomplete="off" data-index="5">
          </div>
          <button class="btn btn--primary btn--wide" id="join-room-btn">Join Room</button>
          <p class="join-hint">Enter the 6-digit code from the other device.</p>
          <div id="join-error" class="join-error" style="display:none"></div>
        </div>
      </div>
    `;

    // Tab switching
    modal.querySelectorAll('.pairing-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.pairing-tab').forEach((t) => t.classList.remove('pairing-tab--active'));
        modal.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('tab-panel--active'));
        tab.classList.add('pairing-tab--active');
        modal.querySelector(`#tab-${tab.dataset.tab}`).classList.add('tab-panel--active');
      });
    });

    // Create room — loading state
    const createBtn = modal.querySelector('#create-room-btn');
    createBtn.addEventListener('click', () => {
      createBtn.disabled = true;
      createBtn.textContent = 'Generating…';
      this.#onCreateRoom?.();
      // Re-enable after 5s fallback in case server doesn't respond
      setTimeout(() => {
        if (createBtn.disabled) {
          createBtn.disabled = false;
          createBtn.textContent = 'Generate Room Code';
        }
      }, 5000);
    });

    // OTP digit boxes — auto-advance, backspace, paste
    const otpInputs = [...modal.querySelectorAll('.otp-digit')];
    const getOtpValue = () => otpInputs.map((i) => i.value).join('');

    otpInputs.forEach((input, idx) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          if (input.value) {
            input.value = '';
          } else if (idx > 0) {
            otpInputs[idx - 1].focus();
            otpInputs[idx - 1].value = '';
          }
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' && idx > 0) {
          otpInputs[idx - 1].focus();
        } else if (e.key === 'ArrowRight' && idx < 5) {
          otpInputs[idx + 1].focus();
        } else if (e.key === 'Enter') {
          modal.querySelector('#join-room-btn').click();
        }
      });

      input.addEventListener('input', (e) => {
        const val = e.target.value.replace(/\D/g, '');
        input.value = val ? val[val.length - 1] : '';
        if (input.value && idx < 5) {
          otpInputs[idx + 1].focus();
        }
      });

      // Paste support — paste a 6-digit code and fill all boxes
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        const digits = text.replace(/\D/g, '').slice(0, 6);
        digits.split('').forEach((d, i) => {
          if (otpInputs[i]) otpInputs[i].value = d;
        });
        const last = Math.min(digits.length, 5);
        otpInputs[last].focus();
      });
    });

    // Focus first OTP box when join tab is shown
    modal.querySelectorAll('.pairing-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (tab.dataset.tab === 'join') {
          setTimeout(() => otpInputs[0].focus(), 50);
        }
      });
    });

    // Join room
    modal.querySelector('#join-room-btn').addEventListener('click', () => {
      const code = getOtpValue();
      if (code.length !== 6 || !/^\d{6}$/.test(code)) {
        this.showJoinError('Please enter all 6 digits.');
        otpInputs[0].focus();
        return;
      }
      this.#onJoinRoom?.(code);
    });

    // Close
    modal.querySelector('#pairing-close').addEventListener('click', () => this.#removeModal());
    modal.addEventListener('click', (e) => { if (e.target === modal) this.#removeModal(); });

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('modal-backdrop--visible'));
    this.#modal = modal;
  }

  /**
   * Display the generated room code and QR in the create tab.
   * @param {string} code
   * @param {string} appUrl - full URL to encode in QR
   */
  async showRoomCode(code, appUrl) {
    const modal = document.getElementById('pairing-modal');
    if (!modal) return;

    // Reset the generate button
    const createBtn = modal.querySelector('#create-room-btn');
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.textContent = 'Regenerate Code';
    }

    const display = modal.querySelector('#room-code-display');
    const digitsEl = modal.querySelector('#room-code-digits');

    // Render spaced digits
    digitsEl.innerHTML = code.split('').map((d) =>
      `<span class="room-digit">${d}</span>`
    ).join('');
    display.style.display = 'flex';

    // Generate QR
    const qrUrl = `${appUrl}?join=${code}`;
    try {
      await QRCode.toCanvas(modal.querySelector('#qr-canvas'), qrUrl, {
        width: 180,
        margin: 2,
        color: { dark: '#e2e8f0', light: '#0f1117' },
      });
    } catch (err) {
      console.warn('[pairing] QR generation failed:', err);
    }
  }

  showJoinError(msg) {
    const el = document.getElementById('join-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  clearJoinError() {
    const el = document.getElementById('join-error');
    if (el) { el.style.display = 'none'; }
  }

  /**
   * Show the emoji verification overlay after connection is established.
   * @param {string[]} emojis - 4-element array
   * @param {string} peerCodename
   * @param {(confirmed: boolean) => void} callback
   */
  showVerification(emojis, peerCodename, callback) {
    this.#removeModal();
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop modal-backdrop--visible';
    modal.innerHTML = `
      <div class="modal modal--verification">
        <div class="verification-shield">🛡️</div>
        <h2 class="modal-title">Verify Connection</h2>
        <p class="modal-subtitle">
          Confirm these symbols match on <strong>${peerCodename}'s</strong> device.
          <br>This protects against rogue devices on the same network.
        </p>
        <div class="verification-emojis">
          ${emojis.map((e) => `<span class="verification-emoji">${e}</span>`).join('')}
        </div>
        <div class="verification-actions">
          <button class="btn btn--success btn--wide" id="verify-confirm">✓ They Match</button>
          <button class="btn btn--danger btn--wide" id="verify-reject">✕ They Don't Match</button>
        </div>
      </div>
    `;

    modal.querySelector('#verify-confirm').addEventListener('click', () => {
      this.#removeModal();
      callback(true);
    });
    modal.querySelector('#verify-reject').addEventListener('click', () => {
      this.#removeModal();
      callback(false);
    });

    document.body.appendChild(modal);
    this.#modal = modal;
  }

  #removeModal() {
    // Dismiss mobile keyboard
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }

    // Purge all modal backdrops from DOM safely
    const backdrops = document.querySelectorAll('.modal-backdrop');
    backdrops.forEach((el) => {
      el.classList.remove('modal-backdrop--visible');
      setTimeout(() => el.remove(), 200);
    });

    this.#modal = null;
  }

  closeModal() { this.#removeModal(); }

}
