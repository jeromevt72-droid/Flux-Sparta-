/* ===========================================================================
   FLUX SPARTA — SERVICE WORKER
   ---------------------------------------------------------------------------
   D-02: core gameplay must work offline after one successful online load.

   Design notes, because the stale-cache trap is the real risk here:

   1. CACHE VERSION is explicit and lives in one constant. Every release that
      changes a runtime asset MUST bump it. Nothing else needs editing.

   2. NAVIGATION is network-first with a cache fallback. That is deliberate:
      cache-first on the HTML is exactly how an installed app gets stuck on an
      old version forever. Online, the player always gets the newest index.html;
      offline, they get the last good one.

   3. ASSETS are cache-first. They are safe to serve from cache because the
      cache name itself is the version — a new release lands in a new cache and
      the old one is deleted on activate.

   4. API IS NEVER CACHED. /api/* is passed straight through: leaderboard,
      entitlements, checkout, webhook, geo. A cached checkout session or a
      cached leaderboard would be worse than no offline support at all.

   5. ONLY SUCCESSFUL RESPONSES ARE CACHED. A 404 page or a 500 must never
      become the permanent cached copy of index.html.
   =========================================================================== */

const CACHE_VERSION = 'flux-sparta-v1';
const CACHE_PREFIX  = 'flux-sparta-';

// The complete runtime asset list for the public/ layout. Anything not here is
// not available offline — by design, not by accident.
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './solar-inferno.webp',
  './neon-tokyo.webp'
];

// Requests that must always go to the network and must never be cached.
function isNetworkOnly(url) {
  return url.pathname.startsWith('/api/');
}

// A response is only worth caching if it actually succeeded and came from us.
// `basic` means same-origin; opaque cross-origin responses are not stored.
function isCacheable(response) {
  return !!response &&
         response.status === 200 &&
         (response.type === 'basic' || response.type === 'default');
}

/* ------------------------------ install ---------------------------------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // addAll is atomic: if any asset 404s the whole install fails and the
      // old worker stays in charge, rather than a half-populated cache.
      return cache.addAll(PRECACHE);
    })
  );
  // Do NOT skipWaiting automatically. The page decides when to activate, so a
  // running game is never swapped out from under the player mid-run.
});

/* ------------------------------ activate --------------------------------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        // Delete OUR obsolete caches only. Anything belonging to another app
        // on this origin is left alone.
        if (name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE_VERSION) {
          return caches.delete(name);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* -------------------------------- fetch ---------------------------------- */
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (the Gateway's Grid calls, fonts, anything else): untouched.
  if (url.origin !== self.location.origin) return;

  // API: straight to the network, never cached, never faked.
  if (isNetworkOnly(url)) return;

  // Navigation: network-first so updates land, cache fallback so offline works.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        if (isCacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put('./index.html', copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('./index.html', { ignoreSearch: true })
          .then(function (hit) { return hit || caches.match('./'); });
      })
    );
    return;
  }

  // Everything else same-origin: cache-first, then network, then cache the win.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (isCacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});

/* ------------------------------- messages -------------------------------- */
self.addEventListener('message', function (event) {
  const d = event.data;
  if (d && d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d && d.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
  }
});
