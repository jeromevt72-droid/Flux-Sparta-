/* ===========================================================================
   FLUX SPARTA — SERVICE WORKER  v2
   ---------------------------------------------------------------------------
   RC2.2. v1 kept an already-running session alive offline but FAILED a real
   cold standalone launch on iPhone: Airplane Mode + app terminated + launched
   from the Home Screen icon gave "Safari can't open the page".

   What v1 got wrong, and what changed:

   1. EVERY KEY IS ABSOLUTE. v1 precached './' and './index.html' and looked
      them up the same way. Relative resolution inside a worker is one more
      thing that can differ from what iOS actually requests on a cold
      standalone launch. Every key is now an absolute URL computed once from
      self.location, so what is stored and what is looked up cannot drift.

   2. EXPLICIT APPLICATION SHELL. The same HTML is stored under three keys:
      the scope root, /index.html, and a synthetic key nothing else can
      collide with. An offline navigation anywhere in scope returns the shell
      whether iOS asks for /, /index.html, the installed start_url, or a URL
      carrying query parameters.

   3. respondWith NEVER RESOLVES UNDEFINED. v1's fallback chain could resolve
      to undefined if both lookups missed — and undefined is exactly the
      browser network-error page the player saw. There is now a terminal
      fallback that always returns a real Response.

   Unchanged on purpose: /api/* is never cached, only 200 same-origin
   responses are stored, navigation is network-first so updates land, and the
   page decides when a new worker activates.
   =========================================================================== */

const CACHE_VERSION = 'flux-sparta-v3';
const CACHE_PREFIX  = 'flux-sparta-';

const SCOPE_ROOT = new URL('./', self.location).href;
const SHELL_URL  = new URL('./index.html', self.location).href;
const SHELL_KEY  = new URL('./__flux_shell', self.location).href;

const PRECACHE = [
  SCOPE_ROOT,
  SHELL_URL,
  new URL('./manifest.webmanifest', self.location).href,
  new URL('./icon-192.png', self.location).href,
  new URL('./icon-512.png', self.location).href,
  new URL('./solar-inferno.webp', self.location).href,
  new URL('./neon-tokyo.webp', self.location).href
];

function isNetworkOnly(url) {
  return url.pathname.startsWith('/api/');
}
function isCacheable(response) {
  return !!response &&
         response.status === 200 &&
         (response.type === 'basic' || response.type === 'default');
}
function inScope(url) {
  return url.href.indexOf(SCOPE_ROOT) === 0;
}

/* ------------------------------ install ---------------------------------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(PRECACHE).then(function () {
        return fetch(SHELL_URL, { cache: 'no-store' }).then(function (res) {
          if (!isCacheable(res)) throw new Error('shell not cacheable');
          return cache.put(SHELL_KEY, res.clone());
        });
      });
    })
  );
});

/* ------------------------------ activate --------------------------------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
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

/* --------------------------- shell retrieval ----------------------------- */
function shellResponse(req) {
  return caches.open(CACHE_VERSION).then(function (cache) {
    const tries = [];
    if (req) tries.push(function () { return cache.match(req, { ignoreSearch: true }); });
    tries.push(function () { return cache.match(SHELL_URL, { ignoreSearch: true }); });
    tries.push(function () { return cache.match(SCOPE_ROOT, { ignoreSearch: true }); });
    tries.push(function () { return cache.match(SHELL_KEY); });
    return tries.reduce(function (chain, next) {
      return chain.then(function (hit) { return hit || next(); });
    }, Promise.resolve(null)).then(function (hit) {
      if (hit) return hit;
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>FLUX</title>' +
        '<body style="background:#050719;color:#eaf7ff;font-family:-apple-system,sans-serif;text-align:center;padding:40px">' +
        '<h1 style="letter-spacing:.2em;color:#62eaff">FLUX</h1>' +
        '<p>Offline copy not ready yet. Open FLUX once with a connection.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    });
  });
}

/* -------------------------------- fetch ---------------------------------- */
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNetworkOnly(url)) return;

  if (req.mode === 'navigate' && inScope(url)) {
    /* MERGE (RC2.5.6): the Gateway now lives on this origin at /welcome/.
       v2 stored EVERY in-scope navigation as the game shell, so simply visiting
       the Gateway would have overwritten the offline copy of the game with
       Gateway HTML -- and a cold offline launch would then show the Gateway,
       which cannot run offline. Only a navigation to the GAME itself may
       refresh the game shell now. */
    const isGameShell = (url.pathname === '/' || url.pathname === '/index.html');
    const isGateway   = url.pathname === '/welcome' || url.pathname.indexOf('/welcome/') === 0;
    event.respondWith(
      fetch(req).then(function (res) {
        if (isGameShell && isCacheable(res)) {
          const a = res.clone(), b = res.clone(), c = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(SHELL_URL, a);
            cache.put(SCOPE_ROOT, b);
            cache.put(SHELL_KEY, c);
          });
        }
        return res;
      }).catch(function () {
        // Offline launch of the installed app lands on /welcome/. The Gateway
        // needs the network (it is marketing plus the live World Grid), so send
        // the player straight into the game, which is fully cached and playable.
        if (isGateway) return Response.redirect(SCOPE_ROOT, 302);
        return shellResponse(req);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (isCacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return new Response('', { status: 504 });
      });
    })
  );
});

/* ------------------------------- messages -------------------------------- */
self.addEventListener('message', function (event) {
  const d = event.data;
  if (!d) return;
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
  }
  // Registration succeeding is NOT the same as the cache being populated.
  // The page uses this before it is allowed to claim OFFLINE READY.
  if (d.type === 'GET_READY' && event.source) {
    const src = event.source;
    caches.open(CACHE_VERSION).then(function (cache) {
      return Promise.all(PRECACHE.concat([SHELL_KEY]).map(function (u) {
        return cache.match(u, { ignoreSearch: true });
      }));
    }).then(function (hits) {
      src.postMessage({ type: 'SW_READY', ready: hits.every(Boolean), version: CACHE_VERSION });
    }).catch(function () {
      src.postMessage({ type: 'SW_READY', ready: false, version: CACHE_VERSION });
    });
  }
});
