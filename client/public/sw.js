/**
 * sw.js — Whoosh Service Worker
 *
 * Strategy:
 *  - App shell (HTML, CSS, JS): Cache-first with network fallback
 *  - Google Fonts: Stale-while-revalidate
 *  - Share Target (POST /?share-target): Store files in cache, redirect to app
 *
 * This is the manual service worker. If using vite-plugin-pwa in 'generateSW'
 * mode this file is replaced. In 'injectManifest' mode this is the base file.
 */

const CACHE_NAME = 'whoosh-shell-v1';
const FONT_CACHE = 'whoosh-fonts-v1';

// Files to precache (Vite will inject the actual hashed filenames via workbox)
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
];

// ── Install ────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate ───────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== FONT_CACHE && k !== 'whoosh-share-v1')
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ──────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Bypass service worker entirely for local dev / Vite server
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || /^192\.168\./.test(url.hostname)) {
    return;
  }

  // Share Target: POST /?share-target
  if (request.method === 'POST' && url.searchParams.has('share-target')) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // Google Fonts: stale-while-revalidate
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  // WebSocket / signaling server: don't intercept
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  // App shell: cache-first
  if (request.destination === 'document' || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // JS/CSS/images: cache-first
  if (['script', 'style', 'image', 'font'].includes(request.destination)) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
  }
});


// ── Share Target handler ───────────────────────────────────────────
async function handleShareTarget(request) {
  const formData = await request.formData();
  const cache = await caches.open('whoosh-share-v1');

  // Store each shared file in the cache keyed by a session ID
  const sessionId = crypto.randomUUID();
  const files = formData.getAll('files');
  const metadata = { sessionId, files: [], text: formData.get('text'), title: formData.get('title') };

  for (const file of files) {
    if (file instanceof File) {
      const key = `/share/${sessionId}/${encodeURIComponent(file.name)}`;
      await cache.put(key, new Response(file, { headers: { 'Content-Type': file.type } }));
      metadata.files.push({ key, name: file.name, type: file.type, size: file.size });
    }
  }

  // Store metadata
  await cache.put(`/share/${sessionId}/meta.json`, new Response(JSON.stringify(metadata), {
    headers: { 'Content-Type': 'application/json' },
  }));

  // Redirect to app with session ID
  return Response.redirect(`/?share=${sessionId}`, 303);
}

// ── Cache strategies ───────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  return cached ?? fetchPromise;
}
