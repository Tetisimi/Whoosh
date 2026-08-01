# Whoosh 💨

**Peer-to-peer file transfer in your browser.** Encrypted by default, no accounts, files never touch a server.

> Inspired by PairDrop/Snapdrop — built from scratch with meaningful improvements.

---

## Features

| | Feature | Details |
|---|---|---|
| 🔍 | **LAN auto-discovery** | Devices on the same network appear automatically |
| 🔗 | **Cross-network pairing** | 6-digit room code + QR code |
| 🛡️ | **Emoji verification** | Confirm you're connected to the right peer (MITM protection) |
| 📦 | **Chunked transfers** | 64 KB chunks with ACK-based resume on reconnect |
| ⚡ | **TURN fallback** | Transparent relay when direct P2P fails (shows mode badge) |
| 📊 | **Progress + speed** | Real-time per-file progress bar, KB/s and ETA |
| 💬 | **Text messages** | Send text snippets between paired devices |
| 📜 | **Transfer history** | Local-only log, clearable, never synced anywhere |
| 📱 | **PWA** | Installable, offline UI shell, native share sheet on Android |
| 🔐 | **E2E encrypted** | WebRTC DTLS encryption on all data channel traffic |

---

## How it works

```
[Browser A] ←── WebSocket (SDP/ICE only) ──→ [Signaling Server] ←── WebSocket ──→ [Browser B]
      │                                                                                     │
      └──────────────────────── WebRTC DataChannel (files, direct P2P or TURN) ────────────┘
```

The signaling server **never sees file bytes**. It only relays WebRTC handshake metadata (SDP offers/answers, ICE candidates) between peers.

---

## Running locally

**1. Start the signaling server**
```bash
cd server
cp .env.example .env
npm install
npm run dev
# → ws://localhost:3000
```

**2. Start the client**
```bash
cd client
cp .env.example .env
npm install
npm run dev
# → https://localhost:5173
```

Open two browser tabs at `https://localhost:5173` — they'll auto-discover each other.

---

## Deployment

| Part | Platform | Notes |
|---|---|---|
| Signaling server | [Render](https://render.com) | Web Service, `node index.js`, free tier |
| Client | [Vercel](https://vercel.com) | Static site, build: `npm run build`, output: `dist` |
| TURN relay | [Metered.ca](https://dashboard.metered.ca) | Free tier, needed for mobile/strict NAT |

**Key env vars:**

```bash
# server/.env
CLIENT_ORIGIN=https://your-app.vercel.app
METERED_API_KEY=your_key
METERED_APP_NAME=your_app_name

# client/.env
VITE_SIGNALING_URL=wss://your-server.onrender.com
```

---

## NAT traversal

| Scenario | Path | Badge |
|---|---|---|
| Same WiFi / LAN | Local ICE candidate → direct socket | `⬤ Direct P2P` |
| Different networks, normal NAT | STUN → direct UDP hole-punch | `⬤ Direct P2P` |
| Symmetric NAT (mobile data, strict corporate) | STUN fails → TURN relay | `⚡ Relayed` |

TURN traffic is DTLS-encrypted — the relay can see *that* data flows but not *what*.

---

## Security

- **DTLS encryption** — all WebRTC DataChannel traffic is encrypted end-to-end by the browser
- **Emoji verification** — 4-emoji sequence derived from `SHA-256(roomCode + sorted peerIds)`. A rogue interceptor has a different peer ID → different emoji → mismatch detected
- **No server storage** — signaling server holds peer state in memory only. No database, no transfer logs

---

## Project structure

```
whoosh/
├── server/
│   ├── index.js      # WebSocket signaling server + /ice-config HTTP endpoint
│   ├── rooms.js      # In-memory peer and room registry
│   └── .env.example
└── client/
    ├── src/
    │   ├── main.js          # App entry: wires all modules
    │   ├── signaling.js     # WebSocket client with auto-reconnect
    │   ├── rtc.js           # WebRTC peer (perfect negotiation pattern)
    │   ├── transfer.js      # Chunking, ACK, resume, speed tracking
    │   └── ui/
    │       ├── radar.js     # Animated radar UI
    │       ├── pairing.js   # Room code, QR, emoji verification
    │       ├── transfers.js # Progress bars + mode badges
    │       └── history.js   # localStorage history panel
    ├── public/
    │   ├── manifest.json    # PWA manifest with share_target
    │   └── sw.js            # Service worker (cache-first + share target)
    ├── index.html
    ├── style.css
    └── vite.config.js
```

---

## License

MIT
