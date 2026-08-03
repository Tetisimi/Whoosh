# Whoosh 💨

**Peer-to-peer file transfer and B2B messaging in your browser.** Encrypted by default, no accounts required, files never touch a server.

> Inspired by PairDrop/Snapdrop — built from scratch with modern UX, persistent IndexedDB storage, and interactive B2B messaging.

---

## Features

| | Feature | Details |
|---|---|---|
| 🔍 | **LAN auto-discovery** | Devices on the same network appear automatically on an interactive radar |
| 🎯 | **Draggable Radar UI** | Non-overlapping peer bubble placement with smooth drag-and-drop repositioning |
| 💬 | **Interactive B2B Chat** | Threaded conversation view, 1-tap message copy, and real-time open-on-receive |
| 🔗 | **Cross-network pairing** | 6-digit room code + QR code for connecting across different networks |
| 🛡️ | **Emoji verification** | Visual verification sequence to confirm connection security (MITM protection) |
| 📦 | **Fast chunked transfers** | 64 KB binary chunks with WebRTC backpressure flow control & bi-directional ACKs |
| 💾 | **IndexedDB file persistence** | Received & sent files stay permanently downloadable/shareable in History |
| 📱 | **Mobile save safeguards** | Native Share Sheet (`navigator.share`) + forced download headers to prevent mobile PDF tab takeover |
| ⚡ | **TURN fallback** | Transparent TURN relay when direct P2P is blocked by strict NATs |
| 📊 | **Progress & speed** | Real-time per-file progress bar, speed indicator (KB/s), and ETA |
| 📜 | **Device-isolated history** | Local history log scoped per device identity (`ownerCodename`), clearable anytime |
| 📱 | **PWA & offline shell** | Installable Web App with service worker caching and share target support |
| 🔐 | **End-to-End Encrypted** | WebRTC DTLS encryption on all DataChannel transfers and text messages |

---

## How it works

```
[Browser A] ←── WebSocket (SDP/ICE only) ──→ [Signaling Server] ←── WebSocket ──→ [Browser B]
      │                                                                                     │
      └──────────────────────── WebRTC DataChannel (files & chat, direct P2P or TURN) ──────┘
```

The signaling server **never sees file bytes or chat text**. It only relays WebRTC handshake metadata (SDP offers/answers, ICE candidates) between peers.

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
# → http://localhost:5173
```

Open two browser tabs or windows at `http://localhost:5173` — they will automatically discover each other on the radar.

---

## Deployment

| Part | Platform | Notes |
|---|---|---|
| Signaling server | [Render](https://render.com) | Web Service, `node index.js`, free tier |
| Client | [Vercel](https://vercel.com) | Static site, build command: `npm run build`, output: `dist` |
| TURN relay | [Metered.ca](https://dashboard.metered.ca) | Free tier, required for mobile data & strict NATs |

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

TURN traffic is DTLS-encrypted — the relay can see *that* data flows but not *what* is inside.

---

## Security

- **DTLS Encryption** — all WebRTC DataChannel traffic is encrypted end-to-end by the browser
- **Emoji Verification** — 4-emoji sequence derived from SHA-256 hash of room secret. Mis-matched keys produce distinct emoji sequences
- **Zero Server Storage** — signaling server holds peer metadata in memory only. No database, no logs, no storage of files or messages

---

## Project structure

```
whoosh/
├── server/
│   ├── index.js          # WebSocket signaling server + /ice-config HTTP endpoint
│   ├── rooms.js          # In-memory peer and room registry
│   └── .env.example
└── client/
    ├── src/
    │   ├── main.js              # App entry: wires signaling, RTC, and UI modules
    │   ├── signaling.js         # WebSocket client with auto-reconnect
    │   ├── rtc.js               # WebRTC peer connection manager
    │   ├── transfer.js          # Binary chunking, flow control, and speed tracking
    │   ├── ui/
    │   │   ├── radar.js         # Animated & draggable radar UI
    │   │   ├── chat.js          # Interactive B2B conversation panel
    │   │   ├── pairing.js       # Room code, QR code, and emoji verification
    │   │   ├── transfers.js     # Active transfers panel with progress bars
    │   │   └── history.js       # Transfer history panel with IndexedDB access
    │   └── utils/
    │       ├── fileStorage.js   # IndexedDB wrapper for persistent file blobs
    │       ├── storage.js       # LocalStorage history helper with device isolation
    │       ├── codename.js      # Session-scoped human-readable codename generator
    │       ├── verification.js  # SHA-256 emoji verification sequence generator
    │       ├── audio.js         # Web Audio API chime synthesizer
    │       └── uuid.js          # UUID v4 generator
    ├── public/
    │   ├── manifest.json        # PWA manifest
    │   └── sw.js                # Service worker shell cache
    ├── index.html
    ├── style.css                # Glassmorphism design system & component styles
    └── vite.config.js
```

---

## License

MIT
