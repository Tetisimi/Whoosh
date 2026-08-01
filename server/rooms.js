/**
 * rooms.js — In-memory peer and room registry for Whoosh signaling server.
 *
 * Two kinds of rooms:
 *  - localRooms: keyed by client IP. Peers on the same IP auto-discover each other.
 *  - codeRooms:  keyed by a 6-digit room code. Used for cross-network pairing.
 *
 * All state is ephemeral — it lives only as long as the process.
 */

const CODE_ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Map<ip, Map<peerId, PeerMeta>> */
const localRooms = new Map();

/** Map<code, CodeRoom> */
const codeRooms = new Map();

/**
 * @typedef {Object} PeerMeta
 * @property {string} id         - UUID assigned by server
 * @property {string} codename   - Human-readable two-word name
 * @property {import('ws').WebSocket} ws
 */

/**
 * @typedef {Object} CodeRoom
 * @property {string} code
 * @property {string} creatorId
 * @property {Set<string>} memberIds
 * @property {ReturnType<typeof setTimeout>} expireTimer
 */

// ── Local room helpers ────────────────────────────────────────────────────────

/**
 * Add a peer to its IP-local room.
 * @param {string} ip
 * @param {PeerMeta} peer
 */
export function addToLocalRoom(ip, peer) {
  if (!localRooms.has(ip)) localRooms.set(ip, new Map());
  localRooms.get(ip).set(peer.id, peer);
}

/**
 * Remove a peer from its IP-local room. Cleans up empty rooms.
 * @param {string} ip
 * @param {string} peerId
 */
export function removeFromLocalRoom(ip, peerId) {
  const room = localRooms.get(ip);
  if (!room) return;
  room.delete(peerId);
  if (room.size === 0) localRooms.delete(ip);
}

/**
 * Get all peers in an IP-local room except the given peer.
 * @param {string} ip
 * @param {string} excludeId
 * @returns {PeerMeta[]}
 */
export function getLocalPeers(ip, excludeId) {
  const room = localRooms.get(ip);
  if (!room) return [];
  return [...room.values()].filter((p) => p.id !== excludeId);
}

// ── Code room helpers ─────────────────────────────────────────────────────────

/**
 * Create a new 6-digit room code room.
 * @param {string} creatorId
 * @returns {string} the generated code
 */
export function createCodeRoom(creatorId) {
  // Clean up any existing room owned by this peer
  for (const [code, room] of codeRooms.entries()) {
    if (room.creatorId === creatorId) {
      clearTimeout(room.expireTimer);
      codeRooms.delete(code);
    }
  }

  const code = generateCode();
  const expireTimer = setTimeout(() => codeRooms.delete(code), CODE_ROOM_TTL_MS);
  codeRooms.set(code, {
    code,
    creatorId,
    memberIds: new Set([creatorId]),
    expireTimer,
  });
  return code;
}

/**
 * Join a code room by code.
 * @param {string} code
 * @param {string} peerId
 * @returns {{ ok: true, room: CodeRoom } | { ok: false, error: string }}
 */
export function joinCodeRoom(code, peerId) {
  const room = codeRooms.get(code);
  if (!room) return { ok: false, error: 'Room not found or expired' };
  room.memberIds.add(peerId);
  return { ok: true, room };
}

/**
 * Remove a peer from all code rooms they're in.
 * @param {string} peerId
 */
export function removeFromCodeRooms(peerId) {
  for (const [code, room] of codeRooms.entries()) {
    room.memberIds.delete(peerId);
    // If creator left and room is empty, clean it up
    if (room.memberIds.size === 0) {
      clearTimeout(room.expireTimer);
      codeRooms.delete(code);
    }
  }
}

/**
 * Get all member IDs in a code room.
 * @param {string} code
 * @returns {string[]}
 */
export function getCodeRoomMembers(code) {
  return [...(codeRooms.get(code)?.memberIds ?? [])];
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function generateCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (codeRooms.has(code));
  return code;
}
