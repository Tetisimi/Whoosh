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
import { ChatUI } from './ui/chat.js';
import { saveFileBlob } from './utils/fileStorage.js';

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
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
      reg.update();
    }).catch(() => {});
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

function openChatWithPeer(targetCodename) {
  if (!targetCodename || targetCodename === 'Unknown') return;
  let targetId = null;
  for (const [id, meta] of peerMeta.entries()) {
    if (meta.codename === targetCodename) {
      targetId = id;
      break;
    }
  }
  chatUI.open(targetCodename, targetId);
}

const chatUI = new ChatUI(document.getElementById('chat-panel'), {
  onSend: (targetCodename, targetId, text) => {
    sendTextDirect(targetCodename, targetId, text);
  },
  getPeerStatus: (peerId, codename) => {
    if (peerId && peers.get(peerId)?.isOpen) return true;
    for (const [id, meta] of peerMeta.entries()) {
      if (meta.codename === codename && peers.get(id)?.isOpen) return true;
    }
    return false;
  },
});

const transfersUI = new TransfersUI(transfersPanel, (transferId) => {
  // Cancel on this device
  for (const [peerId, mgr] of transferManagers) {
    mgr.cancelSend(transferId);
    mgr.cancelReceive(transferId);
    // Relay cancel via WebSocket — bypasses a frozen DataChannel
    signaling.signal(peerId, { type: 'transfer-cancel', transferId });
  }
}, openChatWithPeer);

const historyUI = new HistoryUI(historyPanel, updateHistoryBadge, openChatWithPeer);
updateHistoryBadge();

// ── Tab navigation ────────────────────────────────────────────────────────────

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    chatUI.close();
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

function evictStalePeerByCodename(newPeer) {
  for (const [existingId, meta] of peerMeta.entries()) {
    if (meta.codename === newPeer.codename && existingId !== newPeer.id) {
      console.log(`[app] Evicting stale peer session ${existingId} (${newPeer.codename}) replaced by ${newPeer.id}`);
      peerMeta.delete(existingId);
      radar.removePeer(existingId);
      transferManagers.get(existingId)?.cancelAllActive();
      peers.get(existingId)?.close();
      peers.delete(existingId);
      transferManagers.delete(existingId);
    }
  }
}

signaling.on('registered', ({ id, localPeers }) => {
  localPeerId = id;
  radar.setLocalId(id);
  setStatus('connected', '● Connected');

  // Warm the ICE/TURN cache immediately so it's ready before any peer connects
  prefetchIceServers();

  for (const peer of localPeers) {
    if (peer.id === localPeerId) continue;
    evictStalePeerByCodename(peer);
    peerMeta.set(peer.id, peer);
    radar.addPeer(peer);
    // We are the newcomer — only initiate if our ID is lower to avoid both sides offering
    const shouldInitiate = localPeerId < peer.id;
    initiatePeerConnection(peer.id, shouldInitiate);
  }
});

signaling.on('peer-joined', (peer) => {
  if (peerMeta.has(peer.id) || peer.id === localPeerId) return;
  evictStalePeerByCodename(peer);
  peerMeta.set(peer.id, peer);
  radar.addPeer(peer);
  playChime('discovered');
  // If we're hosting a room, close the modal immediately
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
  // Out-of-band transfer cancel — relayed via WebSocket, bypasses frozen DataChannel
  if (payload.type === 'transfer-cancel') {
    const mgr = transferManagers.get(from);
    if (mgr) {
      mgr.cancelSend(payload.transferId);
      mgr.cancelReceive(payload.transferId);
    }
    return;
  }

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
    if (!peerMeta.has(member.id) && member.id !== localPeerId) {
      evictStalePeerByCodename(member);
      peerMeta.set(member.id, member);
      radar.addPeer(member);
      // Use the same ID-comparison logic as LAN discovery so both sides
      // independently agree on who is initiator — avoids offer collisions.
      const shouldInitiate = localPeerId < member.id;
      initiatePeerConnection(member.id, shouldInitiate);
    }
  }
});

signaling.on('room-error', ({ message }) => {
  pairing.showJoinError(message);
});

signaling.on('reconnecting', ({ attempt }) => {
  if (attempt === 1) {
    setStatus('connecting', '◌ Connecting…');
  } else if (attempt <= 3) {
    setStatus('connecting', '◌ Server waking up…');
  } else {
    setStatus('connecting', '◌ Waking up (~30s on free tier)');
  }
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

function createPeer(peerId, initiator, allowTurn = false) {
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
      // Auto-retry up to 2 times to avoid infinite loops
      const retryCount = (peer._retryCount ?? 0) + 1;
      if (retryCount > 2) {
        console.warn(`[app] Peer ${peerId} failed after ${retryCount} attempts — giving up`);
        return;
      }
      console.warn(`[app] Peer ${peerId} failed — retry attempt ${retryCount} (enabling TURN fallback)`);
      setTimeout(() => {
        if (!peers.has(peerId)) return;
        peers.get(peerId)?.close();
        peers.delete(peerId);
        transferManagers.delete(peerId);
        if (peerMeta.has(peerId)) {
          const shouldInitiate = localPeerId < peerId;
          // Pass retry count through so next peer instance knows its attempt #
          const newPeer = createPeer(peerId, shouldInitiate, true);
          newPeer._retryCount = retryCount;
        }
      }, 1500 * retryCount); // back off: 1.5s, 3s
    }
  });

  peer.on('mode-change', ({ mode }) => {
    console.log(`[app] Peer ${peerId} connection mode: ${mode}`);
    transfersUI.updatePeerMode(peerId, mode);
  });

  peer.connect(allowTurn);
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
    const childFiles = await Promise.all(childPromises);
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
  if (!peers.get(peerId)?.isOpen) {
    showToast(`Connecting to ${peerName}… try again in a moment.`);
    return;
  }
  openFilePicker(peerId);
}

// ── Transfer helpers ──────────────────────────────────────────────────────────

const pendingOutboundFiles = new Map();

function sendFilesToPeer(peerId, files) {
  const mgr = transferManagers.get(peerId);
  if (!mgr || !peers.get(peerId)?.isOpen) {
    showToast('Peer not connected yet — wait a moment and try again.');
    return;
  }
  for (const f of files) {
    pendingOutboundFiles.set(f.name, f);
  }
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

function sendTextDirect(targetCodename, targetId, text) {
  let mgr = targetId ? transferManagers.get(targetId) : null;
  let actualId = targetId;
  if (!mgr || !peers.get(actualId)?.isOpen) {
    for (const [id, meta] of peerMeta.entries()) {
      if (meta.codename === targetCodename && peers.get(id)?.isOpen) {
        actualId = id;
        mgr = transferManagers.get(id);
        break;
      }
    }
  }
  if (mgr && peers.get(actualId)?.isOpen) {
    mgr.sendText(text);
    const snippet = text.length > 36 ? text.slice(0, 36) + '…' : text;
    const entry = addHistoryEntry({
      direction: 'sent',
      peerCodename: targetCodename,
      filename: snippet,
      text: text,
      sizeBytes: 0,
      kind: 'text',
    });
    transfersUI.addTextMessage({ id: entry.id, text, peerCodename: targetCodename, direction: 'sent' });
    updateHistoryBadge();
  } else {
    showToast(`Device ${targetCodename} is not currently connected.`);
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
      const entry = addHistoryEntry({
        direction: 'sent',
        peerCodename: codename,
        filename: snippet,
        text: text,
        sizeBytes: 0,
        kind: 'text',
      });
      transfersUI.addTextMessage({ id: entry.id, text, peerCodename: codename, direction: 'sent' });
      openChatWithPeer(codename);
    }
  }
  if (sent === 0) showToast('No connected peers.');
  else showToast(`Message sent to ${sent} device${sent > 1 ? 's' : ''}.`);
}

function bindTransferManagerEvents(mgr, peerId) {
  const getMeta = () => peerMeta.get(peerId)?.codename ?? 'Unknown';

  mgr.on('send-start', ({ transferId, fileName, fileSize, chunkCount }) => {
    transfersUI.addSend({ transferId, fileName, fileSize, chunkCount, peerCodename: getMeta(), peerId });
  });

  mgr.on('send-progress', ({ transferId, bytesSent, totalBytes, speedBps }) => {
    transfersUI.updateProgress({ transferId, bytesTransferred: bytesSent, totalBytes, speedBps });
  });

  mgr.on('send-done', ({ transferId, fileName }) => {
    transfersUI.completeSend({ transferId });
    const entry = addHistoryEntry({ id: transferId, direction: 'sent', peerCodename: getMeta(), filename: fileName, sizeBytes: 0, kind: 'file' });
    const sentFile = pendingOutboundFiles.get(fileName);
    if (sentFile) {
      saveFileBlob(entry.id, sentFile, fileName, sentFile.type);
      pendingOutboundFiles.delete(fileName);
    }
    updateHistoryBadge();
  });

  mgr.on('receive-start', ({ transferId, fileName, fileSize }) => {
    transfersUI.addReceive({ transferId, fileName, fileSize, peerCodename: getMeta(), peerId });
    radar.flashPeer(peerId, 'receive');
  });

  mgr.on('receive-progress', ({ transferId, bytesReceived, totalBytes, speedBps }) => {
    transfersUI.updateProgress({ transferId, bytesTransferred: bytesReceived, totalBytes, speedBps });
  });

  mgr.on('receive-done', ({ transferId, fileName, fileSize, fileType, url, blob }) => {
    const codename = getMeta();
    const entry = addHistoryEntry({ id: transferId, direction: 'received', peerCodename: codename, filename: fileName, sizeBytes: fileSize, kind: 'file' });

    if (blob) {
      saveFileBlob(entry.id, blob, fileName, fileType || blob.type);
    }

    let saveUrl = url;
    try {
      if (blob) saveUrl = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
    } catch { /* use original */ }

    transfersUI.completeReceive({ transferId, url: saveUrl, blob, fileName });
    updateHistoryBadge();
    playChime('complete');

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && !/Windows/i.test(navigator.userAgent));
    if (!isMobile) {
      try {
        const dlLink = document.createElement('a');
        dlLink.href = saveUrl;
        dlLink.download = fileName;
        document.body.appendChild(dlLink);
        dlLink.click();
        dlLink.remove();
      } catch { /* Fallback to manual save button */ }
      showToast(`🎉 Received "${fileName}" from ${codename}`);
    } else {
      showToast(`🎉 Received "${fileName}" from ${codename}! Tap Share / Save below.`);
    }
  });

  mgr.on('send-cancel', ({ transferId }) => {
    transfersUI.cancelTransfer(transferId);
  });

  mgr.on('receive-cancel', ({ transferId }) => {
    transfersUI.cancelTransfer(transferId);
  });

  mgr.on('text-message', ({ id, text }) => {
    const codename = getMeta();
    showTextMessageToast(text, codename);
    const snippet = text.length > 36 ? text.slice(0, 36) + '…' : text;
    const entry = addHistoryEntry({
      id: id,
      direction: 'received',
      peerCodename: codename,
      filename: snippet,
      text: text,
      sizeBytes: 0,
      kind: 'text',
    });
    transfersUI.addTextMessage({ id: entry.id, text, peerCodename: codename, direction: 'received' });
    updateHistoryBadge();
    playChime('complete');

    if (chatUI.isOpen && chatUI.activePeerCodename === codename) {
      chatUI.refresh();
    } else {
      openChatWithPeer(codename);
    }
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
