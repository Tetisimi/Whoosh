/**
 * storage.js — LocalStorage wrapper for Whoosh transfer history.
 *
 * History is stored only on the local device. Nothing is synced.
 * Each entry records a single file transfer (sent or received).
 */

import { generateUUID } from './uuid.js';

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
 */

/**
 * Load all history entries from localStorage.
 * @returns {HistoryEntry[]}
 */
export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Append a new history entry. Trims to MAX_ENTRIES automatically.
 * @param {Omit<HistoryEntry, 'id' | 'timestamp'>} entry
 */
export function addHistoryEntry(entry) {
  const history = loadHistory();
  const newEntry = {
    id: generateUUID(),
    timestamp: Date.now(),
    ...entry,
  };

  history.unshift(newEntry); // newest first
  history.splice(MAX_ENTRIES); // cap length
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  return newEntry;
}

/**
 * Remove a single entry by ID.
 * @param {string} id
 */
export function removeHistoryEntry(id) {
  const history = loadHistory().filter((e) => e.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

/**
 * Clear all history.
 */
export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
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
