/* WordSpark — service worker
 *
 * The platform is one HTML file, so "offline" means: keep the last copy the
 * learner successfully loaded, and the handful of things it pulls in.
 *
 * Two strategies, and the split matters:
 *
 *   The page itself → NETWORK FIRST. A cache-first page would pin a student
 *   to whatever version they first opened; a teacher who uploads a fix would
 *   never reach them. Online they always get the newest file; offline they get
 *   the last one that loaded.
 *
 *   Everything else → CACHE FIRST. Icons, fonts and the two libraries do not
 *   change, so there is no reason to pay for them twice.
 *
 * Bump CACHE_VERSION whenever the shell list changes. Old caches are deleted
 * on activate, so a student is never carrying three generations of the app.
 */

const CACHE_VERSION = 'wordspark-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

// Cross-origin extras. These are cached opportunistically rather than during
// install: on a slow or filtered connection a failed cross-origin fetch would
// reject the whole install and leave the learner with no offline copy at all.
const RUNTIME_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Never cache the anonymous counter or any analytics ping: a cached POST-like
  // beacon replayed from disk would be a lie about when it happened.
  if (url.hostname.indexOf('goatcounter') !== -1 || url.hostname === 'gc.zgo.at') return;

  const isDoc = req.mode === 'navigate' ||
                (req.destination === 'document') ||
                url.pathname.endsWith('.html');

  if (isDoc) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const knownHost = RUNTIME_HOSTS.indexOf(url.hostname) !== -1;
  if (!sameOrigin && !knownHost) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // An opaque cross-origin response still serves offline, so it is worth
        // keeping even though we cannot inspect it.
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
    })
  );
});

// Lets the page ask for an immediate takeover after an update is downloaded.
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
