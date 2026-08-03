/**
 * storage.js — LocalStorage wrapper for Whoosh transfer history.
 *
 * History is stored only on the local device. Nothing is synced.
 * Each entry records a single file transfer (sent or received).
 */

import { generateUUID } from './uuid.js';
import { getOrCreateCodename } from './codename.js';
import { deleteFileBlob } from './fileStorage.js';

const HISTORY_KEY = 'whoosh:history';
const MAX_ENTRIES = 200;

/**
 * @typedef {Object} HistoryEntry
 * @property {string}  id          - UUID
 * @property {'sent'|'received'} direction
 * @property {string}  peerCodename
 * @property {string}  filename
 * @property {number}  sizeBytes
 * @property {number}  timestamp   - Unix ms
 * @property {'file'|'text'}  kind
 * @property {string}  [ownerCodename]
 * @property {string}  [text]
 */

/**
 * Load all history entries for the current device from localStorage.
 * @returns {HistoryEntry[]}
 */
export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const all = raw ? JSON.parse(raw) : [];
    const currentOwner = getOrCreateCodename();
    // Filter history so each device only sees its own activity (crucial for same-origin testing)
    return all.filter((e) => !e.ownerCodename || e.ownerCodename === currentOwner);
  } catch {
    return [];
  }
}

/**
 * Append a new history entry. Trims to MAX_ENTRIES automatically.
 * @param {Omit<HistoryEntry, 'timestamp'>} entry
 */
export function addHistoryEntry(entry) {
  let all = [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    all = raw ? JSON.parse(raw) : [];
  } catch {
    all = [];
  }

  const newEntry = {
    id: entry.id || generateUUID(),
    timestamp: Date.now(),
    ownerCodename: getOrCreateCodename(),
    ...entry,
  };

  all.unshift(newEntry); // newest first
  all.splice(MAX_ENTRIES); // cap length
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  return newEntry;
}

/**
 * Remove a single entry by ID.
 * @param {string} id
 */
export function removeHistoryEntry(id) {
  let all = [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    all = raw ? JSON.parse(raw) : [];
  } catch { return; }
  all = all.filter((e) => e.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  deleteFileBlob(id);
}

/**
 * Clear all history for the current device.
 */
export function clearHistory() {
  const currentOwner = getOrCreateCodename();
  let all = [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    all = raw ? JSON.parse(raw) : [];
  } catch { return; }

  const toDelete = all.filter((e) => !e.ownerCodename || e.ownerCodename === currentOwner);
  for (const item of toDelete) {
    deleteFileBlob(item.id);
  }

  const remaining = all.filter((e) => e.ownerCodename && e.ownerCodename !== currentOwner);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(remaining));
}

/**
 * Format a byte count for display.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Format a timestamp as a human-readable relative or absolute string.
 * @param {number} timestamp
 * @returns {string}
 */
export function formatTimestamp(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
