// ANDROID (Google Play, Trusted Web Activity) -- packaging prep, in the release gate.
// Static checks of the files in android/ plus the REAL game page (harness vm):
//   T1 android/twa-manifest.json opens https://fluxsparta.com at /play/?src=playstore,
//      inside the web manifest's scope, standalone (so #75 full screen behaves as in the
//      installed app), dark colours that match the page, notifications off;
//   T2 the icons it names exist in public/ as 512x512 PNGs;
//   T3 the Digital Asset Links file: android/assetlinks.template.json is valid JSON for the
//      SAME package name, with the Play App Signing placeholder still in it; and
//      public/.well-known/assetlinks.json is valid JSON: an empty list [] (not finalized yet), or
//      entries for the same package only, each with real SHA-256 fingerprints (64 hex digits, as
//      32 colon-separated pairs), never the placeholder;
//   T7 https://fluxsparta.com/.well-known/assetlinks.json is answered by worker.js (that one exact
//      path is in run_worker_first): 200, Content-Type application/json, no redirect, the file's
//      contents read from the static assets, else the worker's own copy; HEAD works; other methods
//      are refused. While both are empty they differ on purpose -- the file is "[ ]", the copy "[]" --
//      so the live answer shows which one served it; both must be valid JSON empty lists. Once the
//      file lists com.fluxsparta.app, the worker must serve exactly the file's contents (its copy
//      equal to the file, so the fallback serves them too);
//   T4 no signing material anywhere in the repo, and android/.gitignore blocks it;
//   T5 the store stays closed for the Android app: STORE_OPEN false in the game and in
//      wrangler.jsonc, and buySkin() run from /play/?src=playstore never calls
//      /api/create-checkout-session and never navigates;
//   T6 a NEW pilot opening /play/?src=playstore is counted as "playstore"; an EXISTING
//      pilot keeps the src it first came from (never overwritten).
// Ends with negative controls (each check must fail on a deliberately broken input).
import fs from 'fs'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const PLACEHOLDER = 'PLAY_APP_SIGNING_SHA256_FROM_PLAY_CONSOLE';
const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function pngSize(file) {
  try { const b = fs.readFileSync(file); if (b.toString('latin1', 1, 4) !== 'PNG') return null; return [b.readUInt32BE(16), b.readUInt32BE(20)]; }
  catch (e) { return null; }
}
function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    if (n === '.git' || n === 'node_modules' || n === 'FLUX-Sparta') continue;
    const p = path.join(dir, n); const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function staticSuite(I, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  let t = null, wm = null, tpl = null, live;
  try { t = JSON.parse(I.twa); } catch (e) {}
  try { wm = JSON.parse(I.webManifest); } catch (e) {}
  ck('T1 android/twa-manifest.json is valid JSON', !!t);
  ck('T1 host is fluxsparta.com', !!t && t.host === 'fluxsparta.com', t && t.host);
  ck('T1 launch URL is /play/?src=playstore', !!t && t.startUrl === '/play/?src=playstore', t && t.startUrl);
  const scope = wm && wm.scope ? new URL(wm.scope, 'https://fluxsparta.com/').href : '';
  ck('T1 launch URL is inside the web manifest scope', !!t && !!scope && new URL(t.startUrl, 'https://' + t.host + '/').href.startsWith(scope), scope);
  ck('T1 full scope is the whole site (Gateway and game stay inside the app)', !!t && t.fullScopeUrl === 'https://fluxsparta.com/', t && t.fullScopeUrl);
  ck('T1 standalone display, same as the installed app (#75 full screen runs unchanged)', !!t && t.display === 'standalone', t && t.display);
  ck('T1 package name is reverse-domain style, no personal name', !!t && /^com\.fluxsparta\.[a-z][a-z0-9_]*$/.test(t.packageId || ''), t && t.packageId);
  ck('T1 colours match the page (theme #07091D, background #050719)', !!t && String(t.themeColor).toUpperCase() === '#07091D' && String(t.backgroundColor).toUpperCase() === '#050719' && String(t.navigationColor).toUpperCase() === '#050719');
  ck('T1 notifications off, Custom Tabs fallback, version 1 / 1.0.0', !!t && t.enableNotifications === false && t.fallbackType === 'customtabs' && t.appVersionCode === 1 && t.appVersionName === '1.0.0');
  const icon = (u) => { try { const p = new URL(u).pathname; return path.join(ROOT, 'public', p); } catch (e) { return ''; } };
  const s1 = t ? I.png(icon(t.iconUrl)) : null, s2 = t ? I.png(icon(t.maskableIconUrl)) : null;
  ck('T2 icon exists in public/ and is 512x512 PNG', !!s1 && s1[0] === 512 && s1[1] === 512, s1 && s1.join('x'));
  ck('T2 maskable icon exists in public/ and is 512x512 PNG', !!s2 && s2[0] === 512 && s2[1] === 512, s2 && s2.join('x'));
  try { tpl = JSON.parse(I.template); } catch (e) {}
  const tg = tpl && tpl[0] && tpl[0].target;
  ck('T3 assetlinks template is valid JSON with the TWA relation', !!tg && JSON.stringify(tpl[0].relation) === '["delegate_permission/common.handle_all_urls"]' && tg.namespace === 'android_app');
  ck('T3 template package name = twa-manifest package name', !!tg && !!t && tg.package_name === t.packageId, tg && tg.package_name);
  ck('T3 template still carries the Play App Signing placeholder (finalize only with the real one)', !!tg && JSON.stringify(tg.sha256_cert_fingerprints) === JSON.stringify([PLACEHOLDER]));
  ck('T3 public/.well-known/assetlinks.json exists', I.live !== null);
  try { live = JSON.parse(I.live); } catch (e) { live = undefined; }
  ck('T3 assetlinks.json is a valid JSON list', Array.isArray(live), String(I.live).slice(0, 40));
  if (Array.isArray(live) && live.length === 0) ck('T3 assetlinks.json is the empty list [] (finalize after Play App Signing)', true);
  else if (Array.isArray(live)) {
    const ok = live.every((x) => x && x.target && x.target.namespace === 'android_app' && !!t && x.target.package_name === t.packageId
      && JSON.stringify(x.relation) === '["delegate_permission/common.handle_all_urls"]');
    const fps = live.flatMap((x) => (x && x.target && x.target.sha256_cert_fingerprints) || []);
    ck('T3 assetlinks.json lists only the TWA relation for the same package', ok, live.map((x) => x && x.target && x.target.package_name).join(','));
    ck('T3 every listed entry has real SHA-256 fingerprints (64 hex digits), no placeholder',
      live.every((x) => { const f = (x && x.target && x.target.sha256_cert_fingerprints) || []; return f.length >= 1 && f.every((v) => FP.test(v)); }) && !I.live.includes(PLACEHOLDER), fps.join(','));
  }
  ck('T7 wrangler.jsonc: that one exact path runs the Worker first (nothing wider)', (() => { try { return JSON.stringify(JSON.parse(I.wrangler.replace(/^\s*\/\/.*$/gm, '')).assets.run_worker_first) === '["/api/*","/.well-known/assetlinks.json"]'; } catch (e) { return false; } })());
  const copy = (() => { const m = /const ASSETLINKS_BODY = (".*?");/.exec(I.worker); try { return m ? JSON.parse(m[1]) : null; } catch (e) { return null; } })();
  const isEmptyList = (t) => { try { const v = JSON.parse(t); return Array.isArray(v) && v.length === 0; } catch (e) { return false; } };
  if (isEmptyList(I.live)) ck('T7 while empty: the file and the worker\'s copy are both valid JSON empty lists', copy !== null && isEmptyList(copy), JSON.stringify(I.live) + ' / ' + JSON.stringify(copy));
  else ck('T7 once the file lists com.fluxsparta.app: the worker\'s copy is exactly the file\'s contents', copy !== null && copy === I.live, JSON.stringify(copy).slice(0, 40));
  const bad = I.files.filter((f) => /\.(keystore|jks|p12|pem|aab|apk|idsig)$/i.test(f) || /signing-key-info\.txt$|keystore\.properties$/i.test(f));
  ck('T4 no signing key, keystore or app build is in the repo', bad.length === 0, bad.map((f) => path.relative(ROOT, f)).join(','));
  const GI = ['*.keystore', '*.jks', '*.p12', '*.pem', '*.aab', '*.apk', 'signing-key-info.txt'];
  ck('T4 android/.gitignore blocks keystores, keys and builds', GI.every((p) => I.gitignore.split(/\r?\n/).includes(p)));
  ck('T4 the repo-root .gitignore blocks them everywhere else too', GI.every((p) => I.rootGitignore.split(/\r?\n/).includes(p)));
  ck('T5 game: const STORE_OPEN = false', /\nconst STORE_OPEN = false;/.test(I.game));
  ck('T5 server: wrangler.jsonc "STORE_OPEN": "false"', /"STORE_OPEN":\s*"false"/.test(I.wrangler));
  return { F, failed };
}

async function workerSuite(workerSrc, liveFile, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const tmp = path.join(__dirname, '.twa-worker-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.writeFileSync(tmp, workerSrc);
  try {
    const worker = (await import(pathToFileURL(tmp).href)).default;
    const U = 'https://fluxsparta.com/.well-known/assetlinks.json';
    const assetsWith = { fetch: async (req) => new URL(req.url).pathname === '/.well-known/assetlinks.json' ? new Response(liveFile, { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('<!doctype html>404', { status: 404, headers: { 'Content-Type': 'text/html' } }) };
    const assetsWithout = { fetch: async () => new Response('<!doctype html><title>404</title>', { status: 404, headers: { 'Content-Type': 'text/html' } }) };
    const get = (env, method = 'GET') => worker.fetch(new Request(U, { method }), env, { waitUntil() {} });
    let r = await get({ ASSETS: assetsWith }); let b = await r.text();
    ck('T7 GET: 200, application/json, no redirect, the file\'s contents', r.status === 200 && /^application\/json/.test(r.headers.get('Content-Type') || '') && !r.headers.get('Location') && b === liveFile, r.status + ' ' + r.headers.get('Content-Type') + ' ' + b);
    r = await get({ ASSETS: assetsWithout }); b = await r.text();
    const fallbackOk = (() => { try { const f = JSON.parse(liveFile), v = JSON.parse(b); return Array.isArray(f) && f.length === 0 ? Array.isArray(v) && v.length === 0 : b === liveFile; } catch (e) { return false; } })();
    ck('T7 the asset layer without the file: still 200 application/json (the worker\'s copy: an empty list while the file is empty, the file\'s exact contents once it lists the app)', r.status === 200 && /^application\/json/.test(r.headers.get('Content-Type') || '') && fallbackOk, r.status + ' ' + b.slice(0, 30));
    r = await get({ ASSETS: assetsWith }, 'HEAD');
    ck('T7 HEAD: 200 application/json', r.status === 200 && /^application\/json/.test(r.headers.get('Content-Type') || ''), r.status);
    r = await get({ ASSETS: assetsWith }, 'POST');
    ck('T7 other methods are refused (405)', r.status === 405, r.status);
  } catch (e) { ck('T7 worker ran', false, String(e).slice(0, 120)); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  return { F, failed };
}

async function runtimeSuite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const GAME = scriptsOf(gameHtml);
  const calls = [];
  // the fake server would hand back a Stripe page if asked, so "no navigation" can really fail
  const fetchImpl = (u, init) => { calls.push(String(u)); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: 'https://checkout.stripe.com/c/pay/cs_test_x' }) }); };
  // T5: buySkin from the Play Store launch URL
  {
    const g = boot(GAME, { origin: 'https://fluxsparta.com', path: '/play/', search: '?src=playstore', store: makeStore().store, fetchImpl });
    const btn = { disabled: false, textContent: 'BUY' };
    let threw = '';
    try { await g.ctx.buySkin('solar', btn); } catch (e) { threw = String(e).slice(0, 80); }
    await new Promise((r) => setImmediate(r));
    ck('T5 buySkin() from the Android launch URL: no checkout request', !threw && !calls.some((u) => u.includes('create-checkout-session')), threw || calls.filter((u) => u.includes('checkout')).join(','));
    ck('T5 ...and no navigation away from FLUX', g.nav.to === null, g.nav.to);
  }
  // T6: src tag for a new pilot vs an existing one
  {
    const g = boot(GAME, { origin: 'https://fluxsparta.com', path: '/play/', search: '?src=playstore', store: makeStore().store, fetchImpl });
    let s = ''; try { s = g.ctx.fluxStatsSrc(); } catch (e) { s = 'ERR ' + String(e).slice(0, 60); }
    ck('T6 a new pilot opening the Play Store app is counted as "playstore"', s === 'playstore', s);
    const g2 = boot(GAME, { origin: 'https://fluxsparta.com', path: '/play/', search: '?src=playstore', store: makeStore({ fluxSrc: 'tiktok', fluxPlayerId: 'p-existing-1' }).store, fetchImpl });
    let s2 = ''; try { s2 = g2.ctx.fluxStatsSrc(); } catch (e) { s2 = 'ERR'; }
    ck('T6 an existing pilot keeps the src it first came from', s2 === 'tiktok', s2);
  }
  return { F, failed };
}

const live = (() => { try { return rd('public/.well-known/assetlinks.json'); } catch (e) { return null; } })();
const INPUT = {
  twa: rd('android/twa-manifest.json'), webManifest: rd('public/manifest.webmanifest'),
  template: rd('android/assetlinks.template.json'), live, gitignore: rd('android/.gitignore'),
  rootGitignore: (() => { try { return rd('.gitignore'); } catch (e) { return ''; } })(),
  game: rd('public/play/index.html'), wrangler: rd('wrangler.jsonc'), worker: rd('worker.js'),
  files: walk(ROOT), png: pngSize,
};
const t0 = Date.now();
console.log('== ANDROID / TWA packaging prep ==');
const a = staticSuite(INPUT);
const b = await runtimeSuite(INPUT.game);
const w = await workerSuite(INPUT.worker, INPUT.live);
let F = a.F + b.F + w.F;

console.log('\n== negative controls (each must FAIL on broken input) ==');
const twa = JSON.parse(INPUT.twa);
const mut = (o) => JSON.stringify(Object.assign({}, twa, o));
const NEG = [
  ['launch URL without ?src=playstore', { twa: mut({ startUrl: '/play/' }) }, /launch URL is \/play\/\?src=playstore/],
  ['launch URL outside scope', { twa: mut({ startUrl: 'https://evil.example/play/?src=playstore' }) }, /launch URL is inside the web manifest scope/],
  ['wrong host', { twa: mut({ host: 'evil.example' }) }, /host is fluxsparta\.com/],
  ['fullscreen display', { twa: mut({ display: 'fullscreen' }) }, /standalone display/],
  ['personal package name', { twa: mut({ packageId: 'com.jerome.flux' }) }, /package name is reverse-domain/],
  ['missing icon', { twa: mut({ iconUrl: 'https://fluxsparta.com/nope-512.png' }) }, /T2 icon exists/],
  ['template package differs', { template: INPUT.template.replace('com.fluxsparta.app', 'com.fluxsparta.other') }, /template package name/],
  ['template placeholder replaced by a guess', { template: INPUT.template.replace(PLACEHOLDER, 'AB:CD') }, /still carries the Play App Signing placeholder/],
  ['deployed file with placeholder', { live: INPUT.template }, /real SHA-256 fingerprints/],
  ['deployed file with wrong package', { live: INPUT.template.replace('com.fluxsparta.app', 'com.other.app').replace(PLACEHOLDER, Array(32).fill('AB').join(':')) }, /same package/],
  ['our package listed without a fingerprint', { live: '[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"com.fluxsparta.app","sha256_cert_fingerprints":[]}}]' }, /real SHA-256 fingerprints/],
  ['our package with a short fingerprint', { live: INPUT.template.replace(PLACEHOLDER, Array(16).fill('AB').join(':')) }, /real SHA-256 fingerprints/],
  ['our package with a non-hex fingerprint', { live: INPUT.template.replace(PLACEHOLDER, Array(32).fill('ZZ').join(':')) }, /real SHA-256 fingerprints/],
  ['assetlinks.json missing', { live: null }, /assetlinks\.json exists/],
  ['assetlinks.json not a list', { live: '{}' }, /valid JSON list/],
  ['assetlinks path not run by the Worker', { wrangler: INPUT.wrangler.replace('"/api/*",\n      "/.well-known/assetlinks.json"', '"/api/*"') }, /that one exact path runs the Worker first/],
  ['every path runs the Worker', { wrangler: INPUT.wrangler.replace('"/.well-known/assetlinks.json"', '"/.well-known/assetlinks.json", "/*"') }, /that one exact path runs the Worker first/],
  ['worker copy not an empty list while the file is empty', { worker: INPUT.worker.replace('const ASSETLINKS_BODY = "[]";', 'const ASSETLINKS_BODY = "[{}]";') }, /both valid JSON empty lists/],
  ['worker copy not valid JSON', { worker: INPUT.worker.replace('const ASSETLINKS_BODY = "[]";', 'const ASSETLINKS_BODY = "[";') }, /both valid JSON empty lists/],
  ['the file lists the app but the worker copy is still empty', { live: INPUT.template.replace(PLACEHOLDER, Array(32).fill('AB').join(':')) }, /worker\'s copy is exactly the file\'s contents/],
  ['keystore committed', { files: INPUT.files.concat([path.join(ROOT, 'android', 'flux-upload.keystore')]) }, /no signing key/],
  ['gitignore missing keystore rule', { gitignore: INPUT.gitignore.replace('*.keystore', '') }, /android\/\.gitignore blocks/],
  ['root gitignore missing', { rootGitignore: '' }, /repo-root \.gitignore/],
  ['private key committed at the root', { files: INPUT.files.concat([path.join(ROOT, 'upload.pem')]) }, /no signing key/],
  ['game store opened', { game: INPUT.game.replace('\nconst STORE_OPEN = false;', '\nconst STORE_OPEN = true;') }, /game: const STORE_OPEN = false/],
  ['server store opened', { wrangler: INPUT.wrangler.replace(/"STORE_OPEN":\s*"false"/, '"STORE_OPEN": "true"') }, /server: wrangler/],
];
for (const [name, patch, expect] of NEG) {
  const r = staticSuite(Object.assign({}, INPUT, patch), true);
  const ok = r.failed.some((l) => expect.test(l));
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'negative control caught: ' + name);
  if (!ok) F++;
}
{
  const r = await runtimeSuite(INPUT.game.replace('\nconst STORE_OPEN = false;', '\nconst STORE_OPEN = true;'), true);
  const ok = r.failed.some((l) => /no checkout request/.test(l));
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'negative control caught: store opened -> Android buySkin reaches checkout');
  if (!ok) F++;
}
{
  // positive: the finished file (real fingerprint, same package) with the worker's copy updated to match passes T3 and T7
  const done = INPUT.template.replace(PLACEHOLDER, Array(32).fill('AB').join(':'));
  const wk = INPUT.worker.replace('const ASSETLINKS_BODY = "[]";', 'const ASSETLINKS_BODY = ' + JSON.stringify(done) + ';');
  const r = staticSuite(Object.assign({}, INPUT, { live: done, worker: wk }), true), r2 = await workerSuite(wk, done, true);
  const ok = !r.failed.some((l) => /^T3|^T7/.test(l)) && r2.F === 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'a finished file (real 64-hex fingerprint for com.fluxsparta.app) passes' + (ok ? '' : '  [' + r.failed.concat(r2.failed).join(' | ') + ']'));
  if (!ok) F++;
}
for (const [name, src, expect] of [
  ['worker answers with HTML', INPUT.worker.replace('headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }', 'headers: { "Content-Type": "text/html" }'), /T7 GET/],
  ['worker redirects', INPUT.worker.replace('if (path === ASSETLINKS_PATH) return await assetLinks(request, env);', 'if (path === ASSETLINKS_PATH) return Response.redirect("https://fluxsparta.com/", 301);'), /T7 GET/],
  ['no fallback when the asset layer lacks the file', INPUT.worker.replace('let body = ASSETLINKS_BODY;', 'let body = "";'), /the asset layer without the file/],
  ['the worker never reads the file (always its copy)', INPUT.worker.replace('if (r.status === 200) {', 'if (false) {'), /T7 GET/],
]) {
  const r = await workerSuite(src, INPUT.live, true);
  const ok = src !== INPUT.worker && r.failed.some((l) => expect.test(l));
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'negative control caught: ' + name);
  if (!ok) F++;
}
{
  // a src rule too strict for "playstore" (9 letters) would count every Play Store player as "direct"
  const broken = INPUT.game.replace("s=/^[a-z0-9_-]{1,24}$/.test(q)?q:'direct';", "s=/^[a-z0-9_-]{1,8}$/.test(q)?q:'direct';");
  const r = await runtimeSuite(broken, true);
  const ok = broken !== INPUT.game && r.failed.some((l) => /counted as "playstore"/.test(l));
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'negative control caught: src rule rejects "playstore"');
  if (!ok) F++;
}

console.log('\n' + (F === 0 ? 'ALL PASSED' : F + ' FAILED') + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
process.exit(F ? 1 : 0);
