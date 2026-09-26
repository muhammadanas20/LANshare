/**
 * LANShare service worker.
 *
 * Responsibilities:
 *  1. Offline shell: the interface loads even without a network. Peer discovery and
 *     transfers still require connectivity — this is documented, not hidden.
 *  2. Web Share Target: files shared from the OS share sheet are parked in the
 *     Cache API and handed to the page on next load (nothing leaves the device).
 *
 * It never caches WebSocket traffic, signaling messages or transfer payloads.
 */
const SHELL_CACHE = 'lanshare-shell-v2';
const SHARE_CACHE = 'lanshare-incoming-share';
const SHARE_PREFIX = 'incoming-file-';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
];

/**
 * The script/style filenames are content-hashed at build time, so the only way to know
 * them is to read them out of `index.html`. Without this the very first offline reload
 * would render the shell without its scripts.
 */
async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(new Request(asset, { cache: 'reload' }))));

  try {
    const response = await fetch(new Request('./index.html', { cache: 'reload' }));
    if (!response.ok) return;
    const html = await response.text();
    const assets = new Set();
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const reference = match[1];
      if (!reference || /^(https?:|data:|#)/.test(reference)) continue;
      if (!/\.(js|css|png|svg|ico|webmanifest|woff2?)$/.test(reference)) continue;
      // Resolve relative to the service worker (which lives at the app base path).
      assets.add(reference.startsWith('./') ? reference : `./${reference.replace(/^\//, '')}`);
    }
    await Promise.allSettled([...assets].map((asset) => cache.add(new Request(asset, { cache: 'reload' }))));
  } catch {
    /* The shell cache stays best-effort: a failure must never break install. */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await precacheShell();
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files').filter((entry) => entry && typeof entry === 'object' && 'size' in entry);
    const text = formData.get('text') ?? formData.get('url') ?? '';
    const cache = await caches.open(SHARE_CACHE);
    const keys = await cache.keys();
    await Promise.all(keys.map((key) => cache.delete(key)));

    let index = 0;
    for (const file of files) {
      const headers = new Headers({
        'content-type': file.type || 'application/octet-stream',
        'x-lanshare-filename': encodeURIComponent(file.name || `shared-${index}`),
      });
      await cache.put(
        new Request(`${SHARE_PREFIX}${index}`, { method: 'GET' }),
        new Response(file, { headers, status: 200 }),
      );
      index += 1;
    }
    if (text) {
      await cache.put(
        new Request(`${SHARE_PREFIX}text`, { method: 'GET' }),
        new Response(String(text), { headers: { 'content-type': 'text/plain' }, status: 200 }),
      );
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach((client) => client.postMessage({ type: 'lanshare:shared', count: index, hasText: Boolean(text) }));

    // Redirect back into the app; the page collects the parked files itself.
    return Response.redirect(new URL('./?share=1', self.registration.scope).toString(), 303);
  } catch (error) {
    return Response.redirect(new URL('./?share-error=1', self.registration.scope).toString(), 303);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/ws')) return; // never intercept signaling
  if (request.headers.get('upgrade') === 'websocket') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('./index.html')) ??
            (await cache.match('./')) ??
            new Response('LANShare is offline and has not been cached yet.', {
              status: 503,
              headers: { 'content-type': 'text/plain' },
            })
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      if (cached) {
        // Refresh in the background without blocking the response.
        fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone()).catch(() => undefined);
          })
          .catch(() => undefined);
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          cache.put(request, response.clone()).catch(() => undefined);
        }
        return response;
      } catch {
        return new Response('', { status: 504 });
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data ?? {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'CLEAR_SHARE_CACHE') {
    event.waitUntil(caches.delete(SHARE_CACHE));
  }
});
