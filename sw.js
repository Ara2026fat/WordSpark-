// WordSpark — Minimal Service Worker
// Its only job is to make Chrome/Android treat the site as an installable
// app (a fetch handler is required for the install prompt to fire). It
// does NOT cache aggressively — every request still goes to the network
// first, so students always get the latest version after you upload an
// update. If the network is unavailable, it falls back to whatever was
// last successfully loaded.

const CACHE_NAME = 'wordspark-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Keep a lightweight fallback copy of successfully loaded pages
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
