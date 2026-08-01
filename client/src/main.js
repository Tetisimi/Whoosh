/**
 * main.js — Whoosh app entry point.
 * Wires together: signaling, WebRTC peers, transfer management, and all UI modules.
 */

import { SignalingClient } from './signaling.js';
import { RtcPeer, prefetchIceServers } from './rtc.js';
import { TransferManager } from './transfer.js';
import { RadarUI } from './ui/radar.js';
import { PairingUI } from './ui/pairing.js';
import { TransfersUI } from './ui/transfers.js';
import { HistoryUI } from './ui/history.js';
import { getOrCreateCodename } from './utils/codename.js';
import { buildSharedSecret, deriveVerificationEmojis } from './utils/verification.js';
import { addHistoryEntry } from './utils/storage.js';
import { playChime } from './utils/audio.js';

// ── PWA Service Worker & Cache Cleanup ──────────────────────────────────────
if (!import.meta.env.PROD) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister();
      }
    });
  }
  if ('caches' in window) {
    caches.keys().then((keys) => {
      for (const key of keys) {
        caches.delete(key);
      }
    });
  }
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}



// ── Config ────────────────────────────────────────────────────────────────────


const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? (() => {
  const { protocol, host } = window.location;
  const ws = protocol === 'https:' ? 'wss' : 'ws';
  return `${ws}://${host}/ws`;
})();

const APP_URL = window.location.origin + window.location.pathname;


// ── State ─────────────────────────────────────────────────────────────────────

const codename = getOrCreateCodename();

/** Map<peerId, RtcPeer> */
const peers = new Map();
/** Map<peerId, TransferManager> */
const transferManagers = new Map();
/** Map<peerId, { codename }> */
const peerMeta = new Map();

let localPeerId = null;
let currentRoomCode = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const radarContainer   = document.getElementById('radar-container');
const pairingContainer = document.getElementById('pairing-actions');
const transfersPanel   = document.getElementById('transfers-panel');
const historyPanel     = document.getElementById('history-panel');
const selfCodenameEl   = document.getElementById('self-codename');
const statusBadge      = document.getElementById('status-badge');
const dropzone         = document.getElementById('dropzone');
const textSendBtn      = document.getElementById('text-send-btn');
const textInput        = document.getElementById('text-input');
const historyBadge     = document.getElementById('history-badge');
const tabBtns          = document.querySelectorAll('.tab-btn');
const tabPanels        = document.querySelectorAll('.tab-panel-page');

// ── Init UI modules ───────────────────────────────────────────────────────────

selfCodenameEl.textContent = codename;

const radar = new RadarUI(radarContainer, handlePeerClick);

const pairing = new PairingUI(pairingContainer, {
  onCreateRoom: () => signaling.createRoom(),
  onJoinRoom: (code) => signaling.joinRoom(code),
});

const transfersUI = new TransfersUI(transfersPanel);

const historyUI = new HistoryUI(historyPanel, updateHistoryBadge);
updateHistoryBadge();

// ── Tab navigation ────────────────────────────────────────────────────────────

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach((b) => b.classList.remove('tab-btn--active'));
    tabPanels.forEach((p) => p.classList.remove('tab-panel-page--active'));
    btn.classList.add('tab-btn--active');
    document.getElementById(`tab-${target}`)?.classList.add('tab-panel-page--active');
    if (target === 'history') historyUI.render();
  });
});

// ── Signaling ─────────────────────────────────────────────────────────────────

const signaling = new SignalingClient(SIGNALING_URL, codename);

signaling.on('registered', ({ id, localPeers }) => {
  localPeerId = id;
  radar.setLocalId(id);
  setStatus('connected', '● Connected');

  // Warm the ICE/TURN cache immediately so it's ready before any peer connects
  prefetchIceServers();

  for (const peer of localPeers) {
    peerMeta.set(peer.id, peer);
    radar.addPeer(peer);
    // We are the newcomer — only initiate if our ID is lower to avoid both sides offering
    const shouldInitiate = localPeerId < peer.id;
    initiatePeerConnection(peer.id, shouldInitiate);
  }
});

signaling.on('peer-joined', (peer) => {
  if (peerMeta.has(peer.id)) return;
  peerMeta.set(peer.id, peer);
  radar.addPeer(peer);
  playChime('discovered');
  // If we're hosting a room, close the modal immediately — no need to wait
  // for the WebRTC channel to open before dismissing the pairing UI.
  if (currentRoomCode) {
    pairing.closeModal();
    showToast(`${peer.codename} joined — connecting…`);
  }
  // We are the existing peer — only initiate if our ID is lower
  const shouldInitiate = localPeerId < peer.id;
  initiatePeerConnection(peer.id, shouldInitiate);
});


signaling.on('peer-left', ({ id }) => {
  peerMeta.delete(id);
  radar.removePeer(id);
  transferManagers.get(id)?.cancelAllActive();
  peers.get(id)?.close();
  peers.delete(id);
  transferManagers.delete(id);
});


signaling.on('signal', ({ from, payload }) => {
  let peer = peers.get(from);
  if (!peer) {
    peer = createPeer(from, false);
  }
  peer.handleSignal(payload);
});

signaling.on('room-created', async ({ code }) => {
  currentRoomCode = code;
  await pairing.showRoomCode(code, APP_URL);
});

signaling.on('room-joined', ({ code, members }) => {
  currentRoomCode = code;
  pairing.closeModal();
  for (const member of members) {
    if (!peerMeta.has(member.id)) {
      peerMeta.set(member.id, member);
      radar.addPeer(member);
      initiatePeerConnection(member.id, true);
    }
  }
});

signaling.on('room-error', ({ message }) => {
  pairing.showJoinError(message);
});

signaling.on('disconnected', () => {
  setStatus('disconnected', '○ Disconnected');
});

// ── Auto-join from URL ?join=CODE ─────────────────────────────────────────────

const joinParam = new URLSearchParams(window.location.search).get('join');
if (joinParam) {
  signaling.addEventListener('registered', () => {
    signaling.joinRoom(joinParam);
    history.replaceState({}, '', window.location.pathname);
  }, { once: true });
}

// ── WebRTC peer management ────────────────────────────────────────────────────

function initiatePeerConnection(peerId, asInitiator) {
  if (peers.has(peerId)) return;
  createPeer(peerId, asInitiator);
}

function createPeer(peerId, initiator) {
  const peer = new RtcPeer({
    signaling,
    localId: localPeerId,
    remoteId: peerId,
    initiator,
  });

  peers.set(peerId, peer);

  const mgr = new TransferManager(peer);
  transferManagers.set(peerId, mgr);
  bindTransferManagerEvents(mgr, peerId);

  peer.on('channel-open', () => {
    radar.updatePeer({ id: peerId }, 'connected');
    playChime('connected');
    showVerificationIfNeeded(peerId);
  });


  peer.on('state-change', ({ state }) => {
    if (state === 'failed' || state === 'disconnected') {
      radar.updatePeer({ id: peerId }, state);
    }
    if (state === 'failed') {
      // Auto-retry once — cleans up the failed peer and renegotiates
      console.warn(`[app] Peer ${peerId} failed — retrying in 1s`);
      setTimeout(() => {
        if (!peers.has(peerId)) return; // already cleaned up
        peers.get(peerId)?.close();
        peers.delete(peerId);
        transferManagers.delete(peerId);
        if (peerMeta.has(peerId)) {
          const shouldInitiate = localPeerId < peerId;
          initiatePeerConnection(peerId, shouldInitiate);
        }
      }, 1000);
    }
  });

  peer.on('mode-change', ({ mode }) => {
    // Mode badge updated per-peer; tie to any active transfers
    console.log(`[app] Peer ${peerId} connection mode: ${mode}`);
  });

  peer.connect();
  return peer;
}

// ── Verification ──────────────────────────────────────────────────────────────

const verifiedPeers = new Set();

async function showVerificationIfNeeded(peerId) {
  if (verifiedPeers.has(peerId)) return;
  const meta = peerMeta.get(peerId);
  if (!meta) return;

  verifiedPeers.add(peerId);
  radar.updatePeer({ id: peerId }, 'connected');
  pairing.closeModal(); // Ensure pairing modal closes cleanly
  showToast(`Connected to ${meta.codename}`);
}

// ── File selection & Paste toolbar ───────────────────────────────────────────

const globalFileInput = document.getElementById('global-file-input');
const pasteBtn        = document.getElementById('paste-btn');
let selectedTargetPeerId = null;

function openFilePicker(targetPeerId = null) {
  selectedTargetPeerId = targetPeerId;
  if (globalFileInput) {
    globalFileInput.value = '';
    globalFileInput.click();
  }
}

if (pasteBtn) {
  pasteBtn.addEventListener('click', () => handleClipboardPaste());
}



if (globalFileInput) {
  globalFileInput.addEventListener('change', () => {
    const files = [...globalFileInput.files];
    if (!files.length) return;
    if (selectedTargetPeerId) {
      sendFilesToPeer(selectedTargetPeerId, files);
    } else {
      sendFilesToAllOrSelected(files);
    }
  });
}

// Clipboard Paste handler (Button & Ctrl+V) - 1-Tap Instant Read & Send
async function handleClipboardPaste() {
  if (navigator.clipboard && navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        sendTextToAllConnected(text.trim());
        showToast('📋 Pasted & sent!');
        return;
      } else {
        showToast('⚠️ Clipboard is empty.');
        return;
      }
    } catch (err) {
      console.warn('Clipboard readText error:', err);
    }
  }

  // If text was typed in message box, send it
  if (textInput && textInput.value.trim()) {
    const val = textInput.value.trim();
    sendTextToAllConnected(val);
    textInput.value = '';
    showToast('📋 Sent message!');
    return;
  }

  showToast('⚠️ Please tap "Allow Paste" when iOS prompts.');
}






// Global Ctrl+V / Cmd+V keyboard paste handler
window.addEventListener('paste', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const clipboardData = e.clipboardData;
  if (!clipboardData) return;

  const files = [...clipboardData.files];
  if (files.length) {
    sendFilesToAllOrSelected(files);
    showToast(`📋 Pasted ${files.length} file(s)`);
    return;
  }

  const text = clipboardData.getData('text');
  if (text && text.trim()) {
    sendTextToAllConnected(text.trim());
  }
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dropzone--active');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dropzone--active'));
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.classList.remove('dropzone--active');
  const files = await parseDroppedFiles(e.dataTransfer);
  if (files.length) sendFilesToAllOrSelected(files);
});

async function parseDroppedFiles(dataTransfer) {
  const items = dataTransfer.items;
  if (!items || !items[0]?.webkitGetAsEntry) {
    return [...dataTransfer.files];
  }
  const promises = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry();
    if (entry) promises.push(traverseEntry(entry));
  }
  const fileArrays = await Promise.all(promises);
  return fileArrays.flat();
}

async function traverseEntry(entry, path = '') {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file((file) => {
        const fullPath = path ? `${path}/${file.name}` : file.name;
        const fileWithRelPath = new File([file], fullPath, { type: file.type });
        resolve([fileWithRelPath]);
      });
    });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await new Promise((resolve) => reader.readEntries(resolve));
    const childPromises = entries.map((child) => traverseEntry(child, path ? `${path}/${entry.name}` : entry.name));
    return childFiles.flat();
  }
  return [];
}

dropzone.addEventListener('click', () => {
  openFilePicker(null);
});

// ── Text messaging ────────────────────────────────────────────────────────────

textSendBtn.addEventListener('click', () => {
  const text = textInput.value.trim();
  if (!text) return;
  sendTextToAllConnected(text);
  textInput.value = '';
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    textSendBtn.click();
  }
});

// ── Peer click → send files ───────────────────────────────────────────────────

function handlePeerClick(peerId, peerName) {
  openFilePicker(peerId);
}

// ── Transfer helpers ──────────────────────────────────────────────────────────

function sendFilesToPeer(peerId, files) {
  const mgr = transferManagers.get(peerId);
  if (!mgr) return showToast('Peer not connected yet. Try again in a moment.');
  radar.flashPeer(peerId, 'send');
  mgr.sendFiles(files);
}

function sendFilesToAllOrSelected(files) {
  const connected = [...transferManagers.entries()].filter(([id]) => peers.get(id)?.isOpen);
  if (connected.length === 0) return showToast('No connected peers. Wait for someone to join.');
  if (connected.length === 1) {
    sendFilesToPeer(connected[0][0], files);
  } else {
    showPeerPickerModal(files);
  }
}

function sendTextToAllConnected(text) {
  let sent = 0;
  const snippet = text.length > 36 ? text.slice(0, 36) + '…' : text;
  for (const [peerId, mgr] of transferManagers) {
    if (peers.get(peerId)?.isOpen) {
      mgr.sendText(text);
      sent++;
      const codename = peerMeta.get(peerId)?.codename ?? 'Unknown';
      addHistoryEntry({
        direction: 'sent',
        peerCodename: codename,
        filename: snippet,
        text: text,
        sizeBytes: 0,
        kind: 'text',
      });
      transfersUI.addTextMessage({ text, peerCodename: codename, direction: 'sent' });
    }
  }
  if (sent === 0) showToast('No connected peers.');
  else showToast(`Message sent to ${sent} device${sent > 1 ? 's' : ''}.`);
}

function bindTransferManagerEvents(mgr, peerId) {
  const getMeta = () => peerMeta.get(peerId)?.codename ?? 'Unknown';

  mgr.on('send-start', ({ transferId, fileName, fileSize, chunkCount }) => {
    transfersUI.addSend({ transferId, fileName, fileSize, chunkCount, peerCodename: getMeta() });
  });

  mgr.on('send-progress', ({ transferId, bytesSent, totalBytes, speedBps }) => {
    transfersUI.updateProgress({ transferId, bytesTransferred: bytesSent, totalBytes, speedBps });
  });

  mgr.on('send-done', ({ transferId, fileName }) => {
    transfersUI.completeSend({ transferId });
    addHistoryEntry({ direction: 'sent', peerCodename: getMeta(), filename: fileName, sizeBytes: 0, kind: 'file' });
    updateHistoryBadge();
  });

  mgr.on('receive-start', ({ transferId, fileName, fileSize }) => {
    transfersUI.addReceive({ transferId, fileName, fileSize, peerCodename: getMeta() });
    radar.flashPeer(peerId, 'receive');
  });

  mgr.on('receive-progress', ({ transferId, bytesReceived, totalBytes, speedBps }) => {
    transfersUI.updateProgress({ transferId, bytesTransferred: bytesReceived, totalBytes, speedBps });
  });

  mgr.on('receive-done', ({ transferId, fileName, fileSize, url, blob }) => {
    transfersUI.completeReceive({ transferId, url, blob, fileName });
    addHistoryEntry({ direction: 'received', peerCodename: getMeta(), filename: fileName, sizeBytes: fileSize, kind: 'file' });
    updateHistoryBadge();
    playChime('complete');

    // Auto-trigger file download/save
    try {
      const dlLink = document.createElement('a');
      dlLink.href = url;
      dlLink.download = fileName;
      document.body.appendChild(dlLink);
      dlLink.click();
      dlLink.remove();
    } catch { /* Fallback to manual save button in Transfers UI */ }

    showToast(`🎉 Received "${fileName}" from ${getMeta()}`);
  });

  mgr.on('send-cancel', ({ transferId }) => {
    transfersUI.markInterrupted(transferId);
  });

  mgr.on('receive-cancel', ({ transferId }) => {
    transfersUI.markInterrupted(transferId);
  });

  mgr.on('text-message', ({ text }) => {
    showTextMessageToast(text, getMeta());
    const snippet = text.length > 36 ? text.slice(0, 36) + '…' : text;
    addHistoryEntry({
      direction: 'received',
      peerCodename: getMeta(),
      filename: snippet,
      text: text,
      sizeBytes: 0,
      kind: 'text',
    });
    transfersUI.addTextMessage({ text, peerCodename: getMeta(), direction: 'received' });
    updateHistoryBadge();
    playChime('complete');
  });
}




// ── Peer picker modal ─────────────────────────────────────────────────────────

function showPeerPickerModal(files) {
  const existing = document.getElementById('peer-picker-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop modal-backdrop--visible';
  modal.id = 'peer-picker-modal';

  const connectedPeers = [...peerMeta.entries()].filter(([id]) => peers.get(id)?.isOpen);

  modal.innerHTML = `
    <div class="modal">
      <button class="modal-close" id="picker-close">✕</button>
      <h2 class="modal-title">Send to…</h2>
      <p class="modal-subtitle">${files.length} file${files.length > 1 ? 's' : ''} selected</p>
      <div class="peer-list">
        ${connectedPeers.map(([id, meta]) => `
          <button class="peer-pick-btn" data-peer-id="${id}">
            <span class="peer-pick-icon">🖥️</span>
            <span class="peer-pick-name">${meta.codename}</span>
          </button>
        `).join('')}
        <button class="peer-pick-btn peer-pick-btn--all" data-peer-id="all">
          <span class="peer-pick-icon">📡</span>
          <span class="peer-pick-name">All Devices</span>
        </button>
      </div>
    </div>
  `;

  modal.querySelector('#picker-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  modal.querySelectorAll('.peer-pick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.peerId;
      if (id === 'all') {
        connectedPeers.forEach(([pid]) => sendFilesToPeer(pid, files));
      } else {
        sendFilesToPeer(id, files);
      }
      modal.remove();
    });
  });

  document.body.appendChild(modal);
}

// ── Utility UI ────────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusBadge.textContent = text;
  statusBadge.dataset.state = state;
}

function updateHistoryBadge() {
  try {
    const count = JSON.parse(localStorage.getItem('whoosh:history') ?? '[]').length;
    historyBadge.textContent = count > 0 ? String(count) : '';
    historyBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  } catch { /* */ }
}

let toastTimer = null;
function showToast(msg) {
  let toast = document.getElementById('whoosh-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'whoosh-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('toast--visible'), 3500);
}

function showTextMessageToast(text, from) {
  let toast = document.getElementById('whoosh-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'whoosh-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<strong>💬 ${from}</strong><br>${escapeHtml(text.slice(0, 120))}`;
  toast.classList.add('toast--visible', 'toast--message');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('toast--visible', 'toast--message');
  }, 6000);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
