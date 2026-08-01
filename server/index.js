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

// ── HTTP server (also serves /ice-config for TURN credentials) ────────────────

const httpServer = createServer((req, res) => {
  // Dynamic CORS: allow CLIENT_ORIGIN + any LAN IP origin
  const origin = req.headers.origin ?? '';
  const isAllowedOrigin =
    !origin ||
    origin === CLIENT_ORIGIN ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin) ||
    /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin) ||
    /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/.test(origin) ||
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/.test(origin);

  if (isAllowedOrigin && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/ice-config' && req.method === 'GET') {
    // Expose TURN credentials to client without embedding them in JS bundles.
    // If you're using Metered's API, fetch credentials dynamically here.
    // For now, return static credentials from env vars.
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    const meteredApiKey = process.env.METERED_API_KEY;
    const meteredApp = process.env.METERED_APP_NAME;

    if (meteredApiKey && meteredApp) {
      // Metered.ca TURN servers with short-lived credentials
      iceServers.push(
        {
          urls: `turn:${meteredApp}.metered.ca:80`,
          username: process.env.METERED_USERNAME ?? 'whoosh',
          credential: meteredApiKey,
        },
        {
          urls: `turn:${meteredApp}.metered.ca:80?transport=tcp`,
          username: process.env.METERED_USERNAME ?? 'whoosh',
          credential: meteredApiKey,
        },
        {
          urls: `turn:${meteredApp}.metered.ca:443`,
          username: process.env.METERED_USERNAME ?? 'whoosh',
          credential: meteredApiKey,
        },
        {
          urls: `turns:${meteredApp}.metered.ca:443?transport=tcp`,
          username: process.env.METERED_USERNAME ?? 'whoosh',
          credential: meteredApiKey,
        },
      );
    }

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
