/**
 * verification.js — Emoji verification sequence for confirming peer identity.
 *
 * During WebRTC pairing, both sides independently derive a short emoji sequence
 * from a shared secret (a hash of the room code + both peer IDs). Users compare
 * these sequences visually to confirm they're connected to the right peer and
 * not a rogue device on the same network.
 *
 * The emoji pool uses visually distinct symbols to minimize confusion.
 */

const EMOJI_POOL = [
  '🐬', '🦊', '🌊', '🔥', '⚡', '🌙', '☀️', '🌈', '❄️', '🍀',
  '🦋', '🐉', '🎯', '💎', '🗝️', '🌺', '🍁', '🦅', '🐋', '🎸',
  '🌋', '🧲', '🎲', '🦁', '🐢', '🌵', '🎪', '🧊', '🦚', '🎭',
  '🦜', '🐙', '🍄', '🌙', '🦋', '🐝', '🌻', '🦩', '🐞', '🦉',
  '🌟', '💫', '🌀', '🎠', '🦋', '🐾', '🌍', '🎋', '🦕', '🧿',
];

/**
 * Derive a 4-emoji verification sequence from a shared string.
 * Both peers call this with the same input and get the same output.
 *
 * @param {string} sharedSecret - e.g. roomCode + sortedPeerIds joined
 * @returns {Promise<string[]>} Array of 4 emoji
 */
export async function deriveVerificationEmojis(sharedSecret) {
  const encoder = new TextEncoder();
  const data = encoder.encode(sharedSecret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);

  // Use 4 bytes of the hash to pick 4 emoji from the pool
  return [
    EMOJI_POOL[hashArray[0] % EMOJI_POOL.length],
    EMOJI_POOL[hashArray[1] % EMOJI_POOL.length],
    EMOJI_POOL[hashArray[2] % EMOJI_POOL.length],
    EMOJI_POOL[hashArray[3] % EMOJI_POOL.length],
  ];
}

/**
 * Create the shared secret string for a pair of peers in a room.
 * Peer IDs are sorted so both sides produce the same string regardless of order.
 *
 * @param {string} roomCode - 6-digit code or 'local'
 * @param {string} peerId1
 * @param {string} peerId2
 * @returns {string}
 */
export function buildSharedSecret(roomCode, peerId1, peerId2) {
  const sortedIds = [peerId1, peerId2].sort().join('|');
  return `whoosh:${roomCode}:${sortedIds}`;
}
