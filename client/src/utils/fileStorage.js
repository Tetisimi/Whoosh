/**
 * fileStorage.js — IndexedDB wrapper for persisting transferred file blobs.
 *
 * Ensures received and sent documents remain accessible forever from the History tab
 * even after they transition out of active transfers or when the page reloads.
 */

const DB_NAME = 'whoosh_db';
const DB_VERSION = 1;
const STORE_NAME = 'transferred_files';

let dbPromise = null;

function initDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => {
        console.warn('[fileStorage] Failed to open IndexedDB:', e.target.error);
        reject(e.target.error);
      };
    } catch (err) {
      reject(err);
    }
  });
  return dbPromise;
}

/**
 * Save a file blob to IndexedDB keyed by transfer/history ID.
 * @param {string} id - UUID matching history entry id or transfer id
 * @param {Blob} blob - Raw file data
 * @param {string} fileName - Original file name
 * @param {string} fileType - MIME type
 */
export async function saveFileBlob(id, blob, fileName, fileType = '') {
  try {
    const db = await initDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const data = {
        id,
        blob,
        fileName,
        fileType: fileType || blob.type || 'application/octet-stream',
        timestamp: Date.now(),
      };
      store.put(data);
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => {
        console.warn('[fileStorage] Failed to save file blob:', e.target.error);
        resolve(false);
      };
    });
  } catch (err) {
    console.warn('[fileStorage] Storage exception:', err);
    return false;
  }
}

/**
 * Retrieve a stored file blob by ID.
 * @param {string} id
 * @returns {Promise<{ id: string, blob: Blob, fileName: string, fileType: string } | null>}
 */
export async function getFileBlob(id) {
  try {
    const db = await initDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    return null;
  }
}

/**
 * Delete a stored file blob by ID when history entry is removed.
 * @param {string} id
 */
export async function deleteFileBlob(id) {
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
  } catch (err) {
    console.warn('[fileStorage] Delete failed:', err);
  }
}

/**
 * Clear all stored file blobs when clearing transfer history.
 */
export async function clearAllFileBlobs() {
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
  } catch (err) {
    console.warn('[fileStorage] Clear failed:', err);
  }
}
