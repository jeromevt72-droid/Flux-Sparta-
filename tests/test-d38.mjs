// RC2.8.4 -- D-38: search setup (robots, sitemap, titles, preview card),
// admin "NAME #TAG" search, and the in-app-browser banner. Real worker.js and
// the real page scripts. Written against RC2.8.3 first: must FAIL there.
// Ends with negative controls that re-insert each defect and require a catch.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'FLUX-Sparta', 'public');
const BASE = 'https://flux-sparta-3.jeromevt72.workers.dev';
const rd = (f) => { try { return fs.readFileSync(path.join(PUB, f), 'utf8'); } catch (e) { return ''; } };
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'worker.js'), 'utf8');
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

function makeEnv(DO) {
  class S { constructor() { this.map = new Map(); } async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
    async put(a, v) { const o = typeof a === 'object' ? a : { [a]: v }; for (const [k, val] of Object.entries(o)) this.map.set(k, structuredClone(val)); } }
  class St { constructor() { this.storage = new S(); } async blockConcurrencyWhile(fn) { return fn(); } }
  const inst = new Map(); let chain = Promise.resolve();
  return { ADMIN_TOKEN: 'tok', STORE_OPEN: 'false', SITE_URL: BASE,
    LEADERBOARD_DO: { idFromName: (n) => n, get(id) { if (!inst.has(id)) inst.set(id, new DO(new St())); const o = inst.get(id);
      return { fetch(u, i) { const r = () => o.fetch(new Request(u, i)); const p = chain.then(r, r); chain = p.then(() => {}, () => {}); return p; } }; } } };
}
async function post(w, env, p, body, token) {
  const h = { 'Content-Type': 'application/json' }; if (token) h['x-admin-token'] = token;
  const r = await w.fetch(new Request(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}

/* Run the banner script the way a browser would, with a given user agent. */
function runBanner(html, ua, { dismissed = false, withStart = false } = {}) {
  const block = html.slice(html.indexOf('<!-- D-38 (RC2.8.4): IN-APP BROWSER BANNER'), html.lastIndexOf('</body>'));
  const js = (block.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  const made = []; const listeners = {};
  const mk = (tag) => { const el = { tag, id: '', children: [], attrs: {}, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
    setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return { onclick: null, textContent: '' }; }, remove() { this.removed = true; },
    addEventListener() {} }; made.push(el); return el; };
  const start = { addEventListener(ev, fn) { listeners[ev] = fn; } };
  const body = { appendChild(el) { el.attached = true; } };
  const doc = { body, createElement: mk, getElementById: (id) => (id === 'iabBanner' ? made.find((m) => m.id === 'iabBanner' && m.attached && !m.removed) || null : id === 'startBtn' && withStart ? start : null),
    addEventListener() {} };
  const ss = new Map(dismissed ? [['fluxIabDismissed', '1']] : []);
  const win = { navigator: { userAgent: ua }, document: doc, sessionStorage: { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) }, location: { href: BASE + '/' } };
  win.window = win;
  try { vm.runInNewContext(js, win); } catch (e) { return { error: String(e) }; }
  const banner = made.find((m) => m.id === 'iabBanner' && m.attached);
  return { app: win.FLUX_IN_APP, banner, startHook: !!listeners.click, js };
}

const UA = {
  tiktokIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_36.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US',
  tiktokAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 trill_360501 BytedanceWebview/d8a21c6',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0 (iPhone15,2; iOS 18_5; en_US)',
  facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0]',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
};

async function suite({ gw, game, admin, robots, sitemap, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };

  if (!quiet) console.log('== search setup ==');
  ck('S1 robots.txt allows the site, blocks admin and the API, names the sitemap',
    /User-agent: \*/.test(robots) && /Allow: \//.test(robots) && /Disallow: \/admin\.html/.test(robots) && /Disallow: \/api\//.test(robots) && robots.includes('Sitemap: ' + BASE + '/sitemap.xml'));
  ck('S2 sitemap lists the Gateway and the game with full addresses',
    sitemap.includes('<loc>' + BASE + '/</loc>') && sitemap.includes('<loc>' + BASE + '/play/</loc>') && !sitemap.includes('admin'));
  ck('S3 Gateway title has the searchable name', /<title>FLUX Sparta[^<]*<\/title>/.test(gw));
  ck('S3 game title has the searchable name', /<title>Play FLUX Sparta[^<]*<\/title>/.test(game));
  for (const [n, h, u] of [['Gateway', gw, BASE + '/'], ['game', game, BASE + '/play/']]) {
    ck('S4 ' + n + ' canonical address', h.includes('<link rel="canonical" href="' + u + '">'));
    ck('S4 ' + n + ' preview image is a full address to a 1200x630 JPG', h.includes('<meta property="og:image" content="' + BASE + '/og-image.jpg">') && h.includes('og:image:width" content="1200"') && h.includes('og:image:height" content="630"'));
    ck('S4 ' + n + ' has exactly one title and one description', (h.match(/<title>/g) || []).length === 1 && (h.match(/name="description"/g) || []).length === 1);
  }
  const nm = gw.replace(/<(link rel="canonical"|meta property="og:(url|image)"|meta name="twitter:image")[^>]*>/g, '');
  ck('S7 the full address appears ONLY in search/preview tags, never in links or scripts', !nm.includes('flux-sparta-3.jeromevt72.workers.dev'));
  ck('S4 old relative preview image removed', !gw.includes('content="assets/solar.webp"'));
  const img = (() => { try { return fs.readFileSync(path.join(PUB, 'og-image.jpg')); } catch (e) { return null; } })();
  let dims = null; if (img) { for (let i = 2; i < img.length - 9;) { if (img[i] !== 0xFF) { i++; continue; } const m = img[i + 1]; if (m >= 0xC0 && m <= 0xC3) { dims = [img.readUInt16BE(i + 7), img.readUInt16BE(i + 5)]; break; } i += 2 + img.readUInt16BE(i + 2); } }
  ck('S5 og-image.jpg exists, 1200x630, under 300 KB', !!img && dims && dims[0] === 1200 && dims[1] === 630 && img.length < 300000, dims && dims.join('x'));
  ck('S6 admin page asks search engines to stay out', /<meta name="robots" content="noindex,\s?nofollow">/.test(admin));

  if (!quiet) console.log('== in-app browser banner ==');
  for (const [page, h] of [['Gateway', gw], ['game', game]]) {
    for (const [k, want] of [['tiktokIOS', 'TikTok'], ['tiktokAndroid', 'TikTok'], ['instagram', 'Instagram'], ['facebook', 'Facebook']]) {
      const r = runBanner(h, UA[k], { withStart: page === 'game' });
      ck('B1 ' + page + ': ' + k + ' -> banner names ' + want, !r.error && r.app === want && r.banner && /Open in browser/.test(r.banner.innerHTML) && r.banner.innerHTML.includes(want), r.error || r.app);
    }
    for (const k of ['safari', 'chromeAndroid', 'ipadSafari']) {
      const r = runBanner(h, UA[k]);
      ck('B2 ' + page + ': ' + k + ' -> no banner', !r.error && r.app === null && !r.banner, r.error || r.app);
    }
    const d = runBanner(h, UA.tiktokIOS, { dismissed: true });
    ck('B3 ' + page + ': dismissed once -> not shown again this visit', !d.error && !d.banner);
  }
  const g = runBanner(game, UA.tiktokIOS, { withStart: true });
  ck('B4 game: banner steps aside when a run starts', g.startHook);
  ck('B5 banner never blocks play (no overlay covering the page, dismissible)', !/inset:0|height:100%|pointer-events:none/.test(g.js) && /iabX/.test(g.js));
  ck('B6 no identity or storage touched beyond the dismiss flag', !/localStorage|fluxPlayerId/.test(g.js));

  if (!quiet) console.log('== admin search: NAME #TAG ==');
  try {
    const w = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
    for (const [id, n] of [['aaaa1111-0000-4000-8000-000000000001', 'FLUX'], ['aaaa1111-0000-4000-8000-000000000002', 'TITAN'], ['aaaa1111-0000-4000-8000-000000000003', 'FLUXER']]) {
      skew += 20000; await post(w, env, '/api/submit-score', { playerId: id, name: n, score: 1000, level: 1, difficulty: 'easy', country: 'US' });
    }
    const all = await post(w, env, '/api/admin/find-player', { query: 'FLUX' }, 'tok');
    const flux = all.data.matches.find((m) => m.name === 'FLUX');
    ck('A1 plain name still works (FLUX finds FLUX and FLUXER)', all.data.matches.length === 2 && !!flux);
    const tag = flux.tag;
    let r = await post(w, env, '/api/admin/find-player', { query: 'FLUX #' + tag }, 'tok');
    ck('A2 "FLUX #' + tag + '" finds exactly that pilot', r.data.matches.length === 1 && r.data.matches[0].tag === tag, JSON.stringify(r.data.matches.map((m) => m.name)));
    r = await post(w, env, '/api/admin/find-player', { query: 'flux  #  ' + tag.toLowerCase() }, 'tok');
    ck('A2 lower case and extra spaces', r.data.matches.length === 1 && r.data.matches[0].tag === tag);
    r = await post(w, env, '/api/admin/find-player', { query: 'TITAN #' + tag }, 'tok');
    ck('A3 right tag, wrong name -> no match', r.data.matches.length === 0);
    r = await post(w, env, '/api/admin/find-player', { query: '#' + tag }, 'tok');
    ck('A4 "#TAG" and "TAG" still work', r.data.matches.length === 1 && (await post(w, env, '/api/admin/find-player', { query: tag }, 'tok')).data.matches.length === 1);
    r = await post(w, env, '/api/admin/find-player', { query: 'FLUX #' + tag }, undefined);
    ck('A5 still needs the admin password', r.status === 401);
  } catch (e) { ck('admin search section ran', false, String(e.stack || e).slice(0, 200)); }
  return { F, failed };
}

const files = { gw: rd('index.html'), game: rd('play/index.html'), admin: rd('admin.html'), robots: rd('robots.txt'), sitemap: rd('sitemap.xml') };
const real = await import(pathToFileURL(path.join(__dirname, 'FLUX-Sparta', 'worker.js')).href);
const main = await suite({ ...files, workerMod: real });

console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
async function control(label, { expect, edit = {}, workerSrc = (s) => s }) {
  const f2 = { ...files }; let changed = false;
  for (const [k, fn] of Object.entries(edit)) { const v = fn(f2[k]); if (v !== f2[k]) changed = true; f2[k] = v; }
  const w2 = workerSrc(WORKER_SRC); if (w2 !== WORKER_SRC) changed = true;
  if (!changed) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc38-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try { const mod = await import(pathToFileURL(tmp).href); const r = await suite({ ...f2, workerMod: mod, quiet: true });
    const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++; } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('robots blocks the whole site', { expect: 'S1', edit: { robots: rep('Allow: /', 'Disallow: /') } });
await control('sitemap uses relative addresses', { expect: 'S2', edit: { sitemap: (s) => s.split(BASE).join('') } });
await control('preview image relative again', { expect: 'S4', edit: { gw: rep(BASE + '/og-image.jpg">\n<meta property="og:image:width"', 'og-image.jpg">\n<meta property="og:image:width"') } });
await control('admin page indexable', { expect: 'S6', edit: { admin: rep('<meta name="robots" content="noindex,nofollow">', '') } });
await control('TikTok not detected', { expect: 'B1', edit: { gw: rep('/TikTok|musical_ly|Bytedance/i', '/TikTok/i') } });
await control('banner shown in normal Safari', { expect: 'B2', edit: { game: rep("if (!app) return;", "if (!app) app='Safari';") } });
await control('dismiss ignored', { expect: 'B3', edit: { gw: rep("if (sessionStorage.getItem('fluxIabDismissed') === '1') return;", '') } });
await control('banner stays over the game', { expect: 'B4', edit: { game: rep("if (s) s.addEventListener('click', function(){ d.remove(); }, { once: true });", '') } });
await control('NAME #TAG search broken', { expect: 'A2', workerSrc: rep('const both = /^(.+?)\\s*#\\s*([0-9A-Z]+)$/.exec(raw);', 'const both = null;') });
await control('tag ignored in NAME #TAG', { expect: 'A3', workerSrc: rep('(v.name.includes(both[1].trim()) && (v.tag.startsWith(both[2]) || tagFromPid(v.pid, 12).startsWith(both[2])))', '(v.name.includes(both[1].trim()))') });

const total = main.F + NC;
console.log('\n' + (total ? ('D-38 FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)') : 'D-38 PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
