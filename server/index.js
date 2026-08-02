/**
 * index.js — Whoosh WebSocket signaling server.
 *
 * This server is a pure relay. It never sees file contents.
 * It only passes WebRTC handshake metadata (SDP, ICE candidates) between peers.
 *
 * Message protocol (all JSON):
 *
 *  Client → Server:
 *    { type: 'register',    codename: string }
 *    { type: 'create-room' }
 *    { type: 'join-room',   code: string }
 *    { type: 'signal',      to: peerId, payload: RTCSignal }
 *    { type: 'ping' }
 *
 *  Server → Client:
 *    { type: 'registered',     id, codename, localPeers: PeerInfo[] }
 *    { type: 'peer-joined',    peer: PeerInfo }
 *    { type: 'peer-left',      id: peerId }
 *    { type: 'room-created',   code: string }
 *    { type: 'room-joined',    code, members: PeerInfo[] }
 *    { type: 'room-error',     message: string }
 *    { type: 'signal',         from: peerId, payload: RTCSignal }
 *    { type: 'pong' }
 */

import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import {
  addToLocalRoom,
  removeFromLocalRoom,
  getLocalPeers,
  createCodeRoom,
  joinCodeRoom,
  removeFromCodeRooms,
  getCodeRoomMembers,
} from './rooms.js';

const PORT = process.env.PORT ?? 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

// ── ICE / TURN credential cache ───────────────────────────────────────────────
// Metered issues short-lived credentials via their API. We cache them for
// 5 minutes so each /ice-config request doesn’t hammer Metered.
let _iceCache = null;
let _iceCachedAt = 0;
const ICE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getIceServers() {
  if (_iceCache && Date.now() - _iceCachedAt < ICE_CACHE_TTL_MS) {
    return _iceCache;
  }

  const base = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // Option 1: fetch fresh short-lived credentials from Metered API.
  const apiKey =
    process.env.METERED_API_KEY ||
    (process.env.METERED_TURN && !process.env.METERED_TURN.trim().startsWith('{') && !process.env.METERED_TURN.trim().startsWith('[') ? process.env.METERED_TURN.trim() : null) ||
    'd3bac2fe415d4cb0cdb0d1e19dacfb11926b';
  const appName = process.env.METERED_APP_NAME || 'whoosh';

  if (apiKey && appName) {
    try {
      const url = `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const turnServers = await res.json();
        if (Array.isArray(turnServers) && turnServers.length > 0) {
          _iceCache = [...base, ...turnServers];
          _iceCachedAt = Date.now();
          console.log(`[ice] Successfully fetched ${turnServers.length} TURN servers from Metered API`);
          return _iceCache;
        }
      }
      console.warn('[ice] Metered API returned status:', res.status);
    } catch (err) {
      console.warn('[ice] Metered API fetch failed:', err.message);
    }
  }

  // Option 2: METERED_TURN env var set as a JSON ICE-servers array (legacy).
  const meteredTurnJson = process.env.METERED_TURN;
  if (meteredTurnJson) {
    try {
      const parsed = JSON.parse(meteredTurnJson);
      const servers = Array.isArray(parsed) ? parsed : parsed.iceServers ?? [];
      if (servers.length) {
        _iceCache = [...base, ...servers.filter((s) => s.urls)];
        _iceCachedAt = Date.now();
        console.log('[ice] Using METERED_TURN env var ICE servers');
        return _iceCache;
      }
    } catch (err) {
      console.warn('[ice] Failed to parse METERED_TURN env var:', err.message);
    }
  }

  console.warn('[ice] Falling back to STUN only');
  _iceCache = base;
  _iceCachedAt = Date.now();
  return _iceCache;
}

// ── HTTP server (also serves /ice-config for TURN credentials) ────────────────

const httpServer = createServer(async (req, res) => {
  // Allow all origins for HTTP API requests (/ice-config, /health)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/ice-config' && req.method === 'GET') {
    // Expose TURN credentials to client without embedding them in JS bundles.
    const iceServers = await getIceServers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers }));
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  // Allow connections from our client origin + localhost + LAN IPs (for phone testing)
  verifyClient: ({ origin, req }, cb) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress;
    const allowed =
      !origin || // no origin = non-browser client (curl, test scripts)
      origin === CLIENT_ORIGIN ||
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin) ||
      /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin) ||   // LAN: 192.168.x.x
      /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/.test(origin) ||    // LAN: 10.x.x.x
      /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/.test(origin); // LAN: 172.16-31.x.x
    console.log(`[ws] Connection attempt from IP=${ip} origin="${origin}" allowed=${allowed}`);
    cb(allowed, 403, 'Forbidden');
  },
});

/** Map<peerId, { ws, ip, codename }> */
const peers = new Map();

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress;
  const id = randomUUID();

  // State for this connection
  let registered = false;
  let peerCodename = null;

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Message handler ────────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'error', message: 'Invalid JSON' });
    }

    switch (msg.type) {
      case 'register':
        handleRegister(ws, id, ip, msg.codename);
        registered = true;
        peerCodename = msg.codename;
        break;

      case 'create-room':
        if (!assertRegistered(ws, registered)) return;
        handleCreateRoom(id);
        break;

      case 'join-room':
        if (!assertRegistered(ws, registered)) return;
        handleJoinRoom(ws, id, msg.code);
        break;

      case 'signal':
        if (!assertRegistered(ws, registered)) return;
        handleSignal(id, msg.to, msg.payload);
        break;

      case 'ping':
        send(ws, { type: 'pong' });
        break;

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  ws.on('close', () => {
    if (!registered) return;
    const normalizedIp = normalizeIp(ip);
    peers.delete(id);
    removeFromLocalRoom(normalizedIp, id);
    removeFromCodeRooms(id);

    // Notify local peers that this peer left
    for (const peer of getLocalPeers(normalizedIp, id)) {
      send(peer.ws, { type: 'peer-left', id });
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] Error for peer ${id}:`, err.message);
  });
});

// ── Heartbeat interval: drop dead connections ─────────────────────────────────
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ── Message handlers ──────────────────────────────────────────────────────────

function normalizeIp(rawIp) {
  if (!rawIp) return 'local';
  let ip = rawIp.replace(/^::ffff:/, '').trim();
  if (/^(127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|::1|localhost)/.test(ip)) {
    return 'local';
  }
  return ip;
}

function handleRegister(ws, id, rawIp, codename) {
  const ip = normalizeIp(rawIp);

  // Evict any ghost connection with the same IP + codename (e.g. after a reconnect).
  // Without this, a device that briefly drops sees its old self on the radar.
  const ghosts = getLocalPeers(ip, id).filter((p) => p.codename === codename);
  for (const ghost of ghosts) {
    console.log(`[ws] Evicting ghost peer ${ghost.id} (${ghost.codename}) — replaced by ${id}`);
    peers.delete(ghost.id);
    removeFromLocalRoom(ip, ghost.id);
    removeFromCodeRooms(ghost.id);
    // Notify remaining peers before we evict so they don't see a stale entry
    for (const remaining of getLocalPeers(ip, ghost.id)) {
      send(remaining.ws, { type: 'peer-left', id: ghost.id });
    }
    ghost.ws.terminate();
  }

  const peer = { id, codename, ws, ip };
  peers.set(id, peer);
  addToLocalRoom(ip, peer);

  const localPeers = getLocalPeers(ip, id).map(serializePeer);

  // Tell the new peer its own ID and who's already here
  send(ws, { type: 'registered', id, codename, localPeers });

  // Tell existing local peers about the new arrival
  for (const existing of getLocalPeers(ip, id)) {
    send(existing.ws, { type: 'peer-joined', peer: serializePeer(peer) });
  }
}

function handleCreateRoom(creatorId) {
  const code = createCodeRoom(creatorId);
  const creator = peers.get(creatorId);
  send(creator.ws, { type: 'room-created', code });
}

function handleJoinRoom(ws, peerId, code) {
  const result = joinCodeRoom(code, peerId);
  if (!result.ok) {
    return send(ws, { type: 'room-error', message: result.error });
  }

  const { room } = result;
  const joiner = peers.get(peerId);
  const members = [...room.memberIds]
    .filter((mid) => mid !== peerId)
    .map((mid) => peers.get(mid))
    .filter(Boolean)
    .map(serializePeer);

  // Tell joiner who's in the room
  send(ws, { type: 'room-joined', code, members });

  // Tell existing members about the new joiner
  for (const memberId of room.memberIds) {
    if (memberId === peerId) continue;
    const member = peers.get(memberId);
    if (member) {
      send(member.ws, { type: 'peer-joined', peer: serializePeer(joiner) });
    }
  }
}

function handleSignal(fromId, toId, payload) {
  const target = peers.get(toId);
  if (!target) return; // peer disconnected, ignore
  send(target.ws, { type: 'signal', from: fromId, payload });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function assertRegistered(ws, registered) {
  if (!registered) {
    send(ws, { type: 'error', message: 'Not registered. Send { type: "register" } first.' });
    return false;
  }
  return true;
}

function serializePeer({ id, codename }) {
  return { id, codename };
}

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀 Whoosh signaling server running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   ICE config: http://localhost:${PORT}/ice-config`);
  console.log(`   Health:     http://localhost:${PORT}/health`);
});
