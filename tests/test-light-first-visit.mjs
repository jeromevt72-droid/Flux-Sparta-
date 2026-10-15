// LIGHT FIRST VISIT (owner): the Gateway's first visit on a slow connection. In the release gate.
// Measured before this change on a BLU G45-sized screen (4x slower processor), slow 3G: about 2.3 MB
// downloaded and "ENTER THE FLUX" ready about 31 s after the Gateway opened (the game queued behind
// large world pictures and the gameplay preview). See test-light-first-visit-browser.mjs (real
// Chromium, not in the gate) for what each kind of connection actually downloads.
//   L1 "lite" ONLY when the browser says the connection is slow or Data Saver is on
//      (navigator.connection: saveData, effectiveType slow-2g / 2g / 3g); Wi-Fi / 4g and browsers
//      that do not say (Safari: iPhone, iPad) are NOT lite;
//   L2 on Wi-Fi nothing changes: the planets keep their sharp pictures, the preview frame keeps
//      src="hero-demo.html", the cards keep srcset; every lite rule is scoped under .gw-lite;
//   L3 lite: the world cards use the small pictures (srcset removed before they load); a player who
//      has not finished a run gets no preview (its src removed, its frame hidden); a player who has
//      finished one gets it as before;
//   L4 lite: the planets show the small pictures only after the page has loaded;
//   L5 a first visit in a browser tab (any connection): the service worker is not registered from the Gateway
//      (FIRST RUN SMOOTH: the game stores its offline copy after the first run); returning players and the
//      Home Screen app register on load as before
//      (the game page registers the same worker); the Home Screen app, a returning player, Wi-Fi and
//      Safari register it as before; no new event listener on the Gateway (still 23);
//   L6 the closing picture (Event Horizon) loads only near the bottom (IntersectionObserver, about
//      1.5 screens ahead), and its sharp copy assets2x/event@2x.webp now exists (it was missing, so
//      phones showed no picture there and a broken Event Horizon card); every picture the Gateway
//      names exists;
//   L7 the Solar Inferno card is lazy like the other seven (it is far down the page).
// Ends with negative controls: each defect re-inserted MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'FLUX-Sparta', 'public');
const GW = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

function suite(html, files = (p) => fs.existsSync(path.join(PUB, p)), quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const head = scripts.find((s) => s.includes('window.FLUX_LITE =')) || '';
  const demo = scripts.find((s) => s.includes("f.setAttribute('data-src', 'hero-demo.html')")) || '';
  const cards = scripts.find((s) => s.includes("#worlds .card img[srcset]")) || '';
  const tail = scripts.find((s) => s.includes("fin.classList.add('gw-bg')")) || '';
  // A small fake browser for the Gateway's own scripts.
  function run(src, { conn, played = false, standalone = false, ready = 'loading', io = true } = {}) {
    const listeners = {}, classes = new Set(), registered = [], removed = [], attrs = {};
    const frame = { removeAttribute: (a) => removed.push(a), setAttribute: (a, v) => { attrs[a] = v; } };
    const img = () => { const o = { attrs: { srcset: 'x 900w', sizes: '84vw' } }; o.removeAttribute = (a) => { delete o.attrs[a]; }; return o; };
    const imgs = [img(), img()];
    const fin = { classList: { add: (c) => { fin.added = c; } } };
    let observed = null;
    const win = {
      navigator: Object.assign({ serviceWorker: { register: (u, o) => { registered.push(u + ' ' + JSON.stringify(o)); return Promise.resolve(); } } }, conn === undefined ? {} : { connection: conn }, standalone ? { standalone: true } : {}),
      localStorage: { getItem: (k) => (k === 'fluxRunsPlayed' && played ? '3' : null) },
      location: { origin: 'https://fluxsparta.com', search: '?src=tiktok' },
      matchMedia: () => ({ matches: false }),
      addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
      document: {
        readyState: ready,
        documentElement: { classList: { add: (c) => classes.add(c) } },
        getElementById: (id) => (id === 'gameFrame' ? frame : null),
        querySelectorAll: (q) => (q === '#worlds .card img[srcset]' ? imgs : []),
        querySelector: (q) => (q === 'section.final' ? fin : null),
      },
    };
    if (io) win.IntersectionObserver = function (cb, opt) { this.opt = opt; this.observe = (el) => { observed = { el, opt, cb }; }; this.disconnect = () => {}; };
    win.window = win; win.self = win;
    const ctx = vm.createContext(win);
    for (const s of [].concat(src)) vm.runInContext(s, ctx);
    const fire = (t) => (listeners[t] || []).forEach((f) => f());
    return { win, classes, registered, removed, attrs, imgs, fin, fire, observed: () => observed, listeners };
  }
  const lite = (conn) => run(head, { conn }).win.FLUX_LITE;
  try {
    ck('L1 lite on slow-2g, 2g, 3g and with Data Saver', lite({ effectiveType: 'slow-2g' }) === true && lite({ effectiveType: '2g' }) === true && lite({ effectiveType: '3g' }) === true && lite({ effectiveType: '4g', saveData: true }) === true);
    ck('L1 NOT lite on 4g / Wi-Fi, nor when the browser does not say (Safari)', lite({ effectiveType: '4g', saveData: false }) === false && lite(undefined) === false && lite({}) === false);
    ck('L1 lite marks the page (gw-lite) before it renders; Wi-Fi does not', run(head, { conn: { effectiveType: '3g' } }).classes.has('gw-lite') && !run(head, { conn: { effectiveType: '4g' } }).classes.has('gw-lite'));
  } catch (e) { ck('L1 no exception', false, String(e)); }
  // L2: Wi-Fi markup and styles unchanged.
  ck('L2 Wi-Fi: planets keep their sharp pictures (image-set with @2x)', ['solar', 'frozen', 'neon', 'storm', 'celestial'].every((n) => html.includes("image-set(url('assets/" + n + ".webp') 1x, url('assets2x/" + n + "@2x.webp') 2x)")));
  ck('L2 Wi-Fi: the preview frame keeps src="hero-demo.html"; the cards keep srcset', html.includes('<iframe id="gameFrame" src="hero-demo.html" loading="lazy"') && (html.match(/srcset="assets\/[a-z]+\.webp 450w, assets2x\/[a-z]+@2x\.webp 900w"/g) || []).length === 8);
  const css = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  const liteRules = css.split('\n').filter((l) => /assets\/(solar|frozen|neon|storm|celestial)\.webp'\)\}|gameWrap\{display:none\}/.test(l) && !/image-set/.test(l));
  ck('L2 every lite rule is scoped under .gw-lite (the small pictures, the hidden preview)', liteRules.length >= 6 && liteRules.every((l) => l.trim().startsWith('.gw-lite')), liteRules.length);
  try {
    // L3 cards and preview.
    const cLite = run([head, cards], { conn: { effectiveType: '3g' } }), cWifi = run([head, cards], { conn: { effectiveType: '4g' } });
    ck('L3 lite: the cards drop srcset/sizes (small pictures); Wi-Fi keeps them', cLite.imgs.every((i) => !i.attrs.srcset && !i.attrs.sizes) && cWifi.imgs.every((i) => i.attrs.srcset && i.attrs.sizes));
    const dNew = run([head, demo], { conn: { effectiveType: 'slow-2g' } }), dPlayed = run([head, demo], { conn: { effectiveType: 'slow-2g' }, played: true }), dWifi = run([head, demo], { conn: { effectiveType: '4g' } });
    ck('L3 lite + no run finished: no preview (src removed, frame hidden)', dNew.removed.includes('src') && dNew.classes.has('gw-nodemo'));
    ck('L3 lite + a run finished, and Wi-Fi: the preview loads as before', !dPlayed.removed.length && !dPlayed.classes.has('gw-nodemo') && !dWifi.removed.length && !dWifi.classes.has('gw-nodemo'));
    // L4 planets after load.
    const t = run([head, tail], { conn: { effectiveType: '3g' } }), tw = run([head, tail], { conn: { effectiveType: '4g' } });
    const before = t.classes.has('gw-pics'); t.fire('load'); tw.fire('load');
    ck('L4 lite: planet pictures only after the page has loaded (gw-pics on load); never on Wi-Fi', !before && t.classes.has('gw-pics') && !tw.classes.has('gw-pics'));
    ck('L4 the small planet pictures exist only under .gw-lite.gw-pics; .gw-lite alone shows none', css.includes('.gw-lite .planet{background-image:none}') && ['solar', 'frozen', 'neon', 'storm', 'celestial'].every((n, i) => css.includes(".gw-lite.gw-pics .p" + (i + 1) + "{background-image:url('assets/" + n + ".webp')}")));
    // L5 service worker.
    const sw = (o) => { const r = run(head, o); r.fire('load'); return r; };
    const swWifi = sw({ conn: { effectiveType: '4g' } }), swSafari = sw({}), swLiteNew = sw({ conn: { effectiveType: '3g' } }),
      swLitePlayed = sw({ conn: { effectiveType: '3g' }, played: true }), swLiteApp = sw({ conn: { effectiveType: '3g' }, standalone: true }),
      swWifiPlayed = sw({ conn: { effectiveType: '4g' }, played: true }), swWifiApp = sw({ conn: { effectiveType: '4g' }, standalone: true });
    ck('L5 a returning player and the Home Screen app (any connection): registered on load as before',
      swLitePlayed.registered.length === 1 && swLiteApp.registered.length === 1 && swWifiPlayed.registered.length === 1 && swWifiApp.registered.length === 1 && swWifiPlayed.registered[0] === '/sw.js {"scope":"/"}');
    ck('L5 first visit in a browser tab (Wi-Fi, Safari, slow): not registered from the Gateway', swLiteNew.registered.length === 0 && swWifi.registered.length === 0 && swSafari.registered.length === 0);
    ck('L5 no new event listener on the Gateway (still 23)', (html.match(/addEventListener\(/g) || []).length === 23, (html.match(/addEventListener\(/g) || []).length);
    // L6 closing picture.
    const f = run([head, tail], { conn: { effectiveType: '4g' } }), o = f.observed();
    const near = !!o && o.opt && o.opt.rootMargin === '1250px 0px 1250px 0px' && !f.fin.added;
    if (o) o.cb([{ isIntersecting: true }]);
    const noIo = run([head, tail], { conn: { effectiveType: '4g' }, io: false });
    ck('L6 the closing picture loads when the player is about 1.5 screens away (and at once without IntersectionObserver)', near && f.fin.added === 'gw-bg' && noIo.fin.added === 'gw-bg');
    ck('L6 no closing picture until then: the picture is only on .final.gw-bg; small one under .gw-lite',
      !/\.final\{[^}]*url\(/.test(css) && css.includes(".final.gw-bg{background-image:image-set(url('assets/event.webp') 1x, url('assets2x/event@2x.webp') 2x)") && css.includes(".gw-lite .final.gw-bg{background-image:url('assets/event.webp')}"));
  } catch (e) { ck('L3-L6 no exception', false, String(e && e.stack || e)); }
  const named = [...new Set([...html.matchAll(/(assets2?x?\/[a-z]+@?2?x?\.webp)/g)].map((m) => m[1]))];
  const missing = named.filter((p) => !files(p));
  ck('L6 every picture the Gateway names exists (incl. assets2x/event@2x.webp)', named.includes('assets2x/event@2x.webp') && !missing.length, missing.join(', '));
  ck('L7 the Solar Inferno card is lazy like the other seven', (html.match(/<img src="assets\/[a-z]+\.webp"[^>]*loading="lazy"/g) || []).length === 8 && !/alt="Solar Inferno world backdrop" loading="eager"/.test(html));
  return { F, failed };
}

const main = suite(GW);
const twin = fs.readFileSync(path.join(PUB, 'assets2x', 'event@2x.webp'));
const welcomeTwin = fs.readFileSync(path.join(PUB, 'welcome', 'assets2x', 'event@2x.webp'));
const okTwin = twin.equals(welcomeTwin) && twin.length > 100000;
console.log((okTwin ? '  PASS  ' : '  FAIL  ') + 'L6 assets2x/event@2x.webp is the Event Horizon picture (same file as the welcome page\'s copy)');

console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
function control(label, expect, mutate, files) {
  const h2 = mutate(GW);
  if (h2 === GW && !files) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(h2, files, true), hit = r.failed.filter((f) => f.startsWith(expect)), ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
control('4g treated as slow', 'L1', rep("/^(slow-2g|2g|3g)$/", "/^(slow-2g|2g|3g|4g)$/"));
control('no connection info treated as slow (iPhone would change)', 'L1', rep('if (!c) return false;', 'if (!c) return true;'));
control('planets lose their sharp pictures on Wi-Fi', 'L2', rep(".p1{--glow:#ff8c2eaa;background-image:url('assets/solar.webp');background-image:image-set(url('assets/solar.webp') 1x, url('assets2x/solar@2x.webp') 2x);", ".p1{--glow:#ff8c2eaa;background-image:url('assets/solar.webp');"));
control('a lite rule not scoped (changes Wi-Fi)', 'L2', rep('.gw-lite.gw-nodemo .gameWrap{display:none}', '.gameWrap{display:none}'));
control('preview skipped for returning players too', 'L3', rep('if (!window.FLUX_LITE || window.FLUX_PLAYED) return;', 'if (!window.FLUX_LITE) return;'));
control('cards keep the large pictures on slow connections', 'L3', rep("img.removeAttribute('srcset'); img.removeAttribute('sizes');", ''));
control('planet pictures before the page has loaded', 'L4', rep("try { if (window.FLUX_LITE) document.documentElement.classList.add('gw-lite'); } catch (e) {}", "try { if (window.FLUX_LITE) { document.documentElement.classList.add('gw-lite'); document.documentElement.classList.add('gw-pics'); } } catch (e) {}"));
control('Home Screen app no longer registers the worker', 'L5', rep('if (!window.FLUX_PLAYED && !standalone) return;', 'if (!window.FLUX_PLAYED) return;'));
control('service worker always registered (copies compete with the game)', 'L5', rep('if (!window.FLUX_PLAYED && !standalone) return;', 'if (false) return;'));
control('Wi-Fi first visit registers from the Gateway again', 'L5', rep('if (!window.FLUX_PLAYED && !standalone) return;', 'if (window.FLUX_LITE && !window.FLUX_PLAYED && !standalone) return;'));
control('a new event listener added to the Gateway', 'L5', rep("var f = document.getElementById('gameFrame');", "var f = document.getElementById('gameFrame'); window.addEventListener('resize', function(){});"));
control('closing picture loaded at once again', 'L6', rep('.final{min-height:75svh;display:grid;place-items:center;text-align:center;position:relative}', ".final{min-height:75svh;display:grid;place-items:center;text-align:center;background:url('assets/event.webp') center/cover;position:relative}"));
control('Event Horizon sharp picture missing again', 'L6', (s) => s, (p) => p !== 'assets2x/event@2x.webp' && fs.existsSync(path.join(PUB, p)));
control('Solar Inferno card eager again', 'L7', rep('alt="Solar Inferno world backdrop" loading="lazy"', 'alt="Solar Inferno world backdrop" loading="eager"'));
const total = main.F + NC + (okTwin ? 0 : 1);
console.log('\n' + (total ? 'LIGHT FIRST VISIT FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'LIGHT FIRST VISIT PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
