// FREE PLAN (owner decision): FLUX stays on Cloudflare's free Workers plan
// (100,000 Worker requests a day; Durable Objects: 100,000 requests and 100,000
// SQLite rows written a day). In the release gate.
// Server (REAL worker.js, fake Durable Object runtime that counts requests and rows):
//   S1 ONE request per run: /api/submit-score carrying the score AND the run's
//      stats is fanned out inside the server: the leaderboard gets the score,
//      the "analytics" instance gets the cleaned stats (one-way code, country
//      only, no name) -- two DO requests, one Worker request;
//   S2 the stats are counted only once the score has a final answer: never on a
//      429 cooldown or a 5xx (the game sends the same upload again), and then
//      exactly once;
//   S3 old pages keep working: /api/submit-score without stats and /api/events;
//   S4 the leaderboard still receives exactly the fields the privacy policy lists;
//   S5 GET /api/leaderboard asks the Durable Object at most once a minute per
//      board (per Worker isolate), and any POST clears it;
//   S6 the request counter: /api/admin/usage (admin password) reports today's
//      Worker and DO requests vs the free limits, exactly for one isolate; the
//      alert is on from 80%;
//   S7 game and site files never go through the Worker: wrangler.jsonc sends only
//      /api/* to it and answers missing paths from the asset layer (404-page);
//      the worker's only non-/api line is the unreachable asset fallback; the
//      service worker never caches or calls /api/ and serves the cached game on a
//      Cloudflare limit page (429 / 5xx).
// Game (REAL page, harness vm; Gateway REAL page):
//   C1 a run is ONE request: the score upload carries the stats; a run with no new
//      best sends only its stats; a new best sends one upload again;
//   C2 no idle polling: a returning player's page makes no request at load and none
//      from any timer (no 3 s entitlements repeat, no 8 s stats timer);
//   C3 the leaderboard is fetched at most once a minute across views and tabs
//      (game leaderboard + Gateway World Grid share one copy); after a minute, once;
//   C4 Cloudflare's limit page (1027, HTML) or no network: the run is queued, every
//      call pauses until the reset (at most an hour), nothing loops; afterwards the
//      run uploads exactly once, stats included;
//   C5 the offline note and the admin usage panel exist and are wired up.
// Ends with negative controls: each defect re-inserted into the source MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = { game: R('public/play/index.html'), gw: R('public/index.html'), worker: R('worker.js'), wrangler: R('wrangler.jsonc'), sw: R('public/sw.js'), admin: R('public/admin.html') };
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', ADMIN = { 'x-admin-token': 'pw' };
const PID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const realNow = Date.now;
let skew = 0; Date.now = () => realNow() + skew;   // the tests move the clock forward

class FakeStorage {
  constructor(name, S) { this.name = name; this.S = S; this.map = new Map(); }
  async get(k) { this.S.read++; return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { const o = typeof k === 'object' ? k : { [k]: v }; for (const [kk, vv] of Object.entries(o)) { this.map.set(kk, structuredClone(vv)); this.S.written++; } }
  async delete(k) { for (const x of [].concat(k)) { this.map.delete(x); this.S.written++; } }
}
function makeEnv(LeaderboardDO) {
  const S = { req: [], read: 0, written: 0 }, inst = new Map(); let chain = Promise.resolve();
  const env = { S, ADMIN_TOKEN: 'pw', LEADERBOARD_DO: { idFromName: (n) => n, get(id) {
    if (!inst.has(id)) inst.set(id, new LeaderboardDO({ storage: new FakeStorage(id, S), blockConcurrencyWhile: (fn) => fn() }));
    const o = inst.get(id);
    return { fetch(url, init) { S.req.push({ id, path: new URL(url).pathname, body: init && init.body }); const run = () => o.fetch(new Request(url, init)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } };
  } }, inst };
  return env;
}

async function suite(src, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  skew = 0;
  /* ------------------------------ server ------------------------------ */
  const tmp = path.join(__dirname, '.fp-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  fs.writeFileSync(tmp, src.worker);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const worker = mod.default;
    const call = async (env, p, { method = 'GET', body, headers = {}, cf, ctx } = {}) => {
      const r = new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (cf) Object.defineProperty(r, 'cf', { value: cf });
      const res = await worker.fetch(r, env, ctx);
      let data = null; try { data = await res.clone().json(); } catch (e) {}
      return { status: res.status, data, headers: res.headers };
    };
    const run = (extra = {}) => ({ playerId: PID, name: 'TITAN', score: 3000, level: 3, difficulty: 'medium', country: 'PH', season: 1, ...extra });
    const STATS = { src: 'tiktok', events: [{ e: 'open', home: true }, { e: 'run_end', sec: 42, lvl: 3, diff: 'medium' }, { e: 'nonsense' }] };
    const dayRow = (env) => env.inst.get('analytics') && env.inst.get('analytics').state.storage.map.get('an:day:' + Math.floor(Date.now() / 86400000));

    // S1
    let env = makeEnv(mod.LeaderboardDO);
    const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
    let r = await call(env, '/api/submit-score', { method: 'POST', body: run({ stats: STATS }), cf: { country: 'JP' }, ctx });
    await Promise.all(waits); await tick();
    const lbReq = env.S.req.filter((x) => x.id === 'global'), anReq = env.S.req.filter((x) => x.id === 'analytics');
    const an = anReq[0] ? JSON.parse(anReq[0].body) : {};
    const day = dayRow(env) || {};
    ck('S1 one Worker request per run: the score reply comes back and the server fans out -- 1 leaderboard + 1 stats DO request',
      r.status === 200 && r.data && r.data.ok === true && lbReq.length === 1 && lbReq[0].path === '/submit' && anReq.length === 1 && anReq[0].path === '/an-ingest', env.S.req.map((x) => x.id + x.path).join(','));
    ck('S1 ...the stats are cleaned as /api/events cleans them: one-way code, chosen country, src, only known events, no name or playerId',
      /^[0-9a-f]{16}$/.test(an.h || '') && an.country === 'PH' && an.src === 'tiktok' && JSON.stringify(an.events) === JSON.stringify([{ e: 'open', home: true }, { e: 'run_end', lvl: 3, diff: 'medium', sec: 42 }]) && !JSON.stringify(an).includes('TITAN') && !JSON.stringify(an).includes(PID), JSON.stringify(an).slice(0, 160));
    ck('S1 ...and they are counted (1 run, 1 open)', day.all && day.all.runs === 1 && day.all.opens === 1, JSON.stringify(day.all || {}));
    const lbBoard = await call(env, '/api/leaderboard?limit=50');
    ck('S1 ...and the score is on the board', lbBoard.data && lbBoard.data.top && lbBoard.data.top.length === 1 && lbBoard.data.top[0].score === 3000);

    // S2
    env = makeEnv(mod.LeaderboardDO);
    await call(env, '/api/submit-score', { method: 'POST', body: run() });
    const before = env.S.req.filter((x) => x.id === 'analytics').length;
    r = await call(env, '/api/submit-score', { method: 'POST', body: run({ score: 4000, level: 3, stats: STATS }) });
    const onCooldown = env.S.req.filter((x) => x.id === 'analytics').length - before;
    skew += 11000;
    r = await call(env, '/api/submit-score', { method: 'POST', body: run({ score: 4000, level: 3, stats: STATS }) });
    const d2 = dayRow(env) || {};
    ck('S2 a 429 cooldown answer does NOT count the stats (the game sends the whole upload again)', onCooldown === 0, String(onCooldown));
    ck('S2 ...the accepted retry counts them exactly once', r.status === 200 && d2.all && d2.all.runs === 1, JSON.stringify(d2.all || {}));
    const bad = await call(env, '/api/submit-score', { method: 'POST', body: run({ score: 999999, level: 1, stats: { src: 'x', events: [{ e: 'run_end', sec: 5, lvl: 1, diff: 'medium' }] } }) });
    ck('S2 a permanent refusal (the game drops it) still counts the run\'s stats once', bad.status === 422 && (dayRow(env).all.runs === 2), JSON.stringify(dayRow(env).all));

    // S3
    env = makeEnv(mod.LeaderboardDO);
    r = await call(env, '/api/submit-score', { method: 'POST', body: run() });
    const e3 = await call(env, '/api/events', { method: 'POST', body: { pid: PID, src: 'direct', events: [{ e: 'share' }] } });
    ck('S3 old pages keep working: /api/submit-score without stats (no stats request) and /api/events',
      r.status === 200 && env.S.req.filter((x) => x.path === '/an-ingest').length === 1 && e3.status === 200 && dayRow(env).all.shares === 1);

    // S4
    const fw = JSON.parse(env.S.req.find((x) => x.path === '/submit').body);
    ck('S4 the leaderboard receives exactly the fields the privacy policy lists (no stats, nothing new)', JSON.stringify(Object.keys(fw).sort()) === JSON.stringify(['country', 'detected', 'difficulty', 'level', 'name', 'playerId', 'score']), Object.keys(fw).join(','));

    // S5
    env = makeEnv(mod.LeaderboardDO);
    const n0 = () => env.S.req.filter((x) => x.path === '/leaderboard').length;
    const a = await call(env, '/api/leaderboard?limit=50'), b = await call(env, '/api/leaderboard?limit=50');
    ck('S5 a second board request within the minute is answered without the Durable Object', n0() === 1 && a.headers.get('X-Flux-Cache') === 'miss' && b.headers.get('X-Flux-Cache') === 'hit' && JSON.stringify(a.data) === JSON.stringify(b.data), n0() + ' ' + b.headers.get('X-Flux-Cache'));
    skew += 11000; await call(env, '/api/submit-score', { method: 'POST', body: run({ playerId: 'bbbbbbbb-bbbb-4ccc-8ddd-000000000002' }) });
    const c = await call(env, '/api/leaderboard?limit=50');
    ck('S5 ...a POST through the Worker clears it: the new score shows at once', n0() === 2 && c.data.top.length === 1 + (a.data.top.length), n0() + ' ' + c.data.top.length);
    skew += 61000; await call(env, '/api/leaderboard?limit=50');
    ck('S5 ...and after a minute the Durable Object is asked again', n0() === 3, String(n0()));

    // S6
    env = makeEnv(mod.LeaderboardDO);
    const noPw = await call(env, '/api/admin/usage', { method: 'POST', body: {} });
    const u1 = await call(env, '/api/admin/usage', { method: 'POST', body: {}, headers: ADMIN });
    for (let i = 0; i < 5; i++) await call(env, '/api/geo');
    await call(env, '/api/leaderboard?limit=7');
    const u2 = await call(env, '/api/admin/usage', { method: 'POST', body: {}, headers: ADMIN });
    const dw = u2.data && u1.data ? u2.data.usage.workerRequests - u1.data.usage.workerRequests : -1;
    const dd = u2.data && u1.data ? u2.data.usage.doRequests - u1.data.usage.doRequests : -1;
    ck('S6 the usage route needs the admin password', noPw.status === 401 && u1.status === 200);
    ck('S6 it counts every Worker request of this isolate exactly (5 geo + 1 board + the usage call itself)', dw === 7, String(dw));
    ck('S6 ...and the Durable Object requests (the board + the previous usage call)', dd === 2, String(dd));
    ck('S6 ...against the free limits (100,000 a day), no alert at low use', u2.data.limits.workerRequests === 100000 && u2.data.limits.doRequests === 100000 && u2.data.alert === false && u2.data.alertPct === 80 && Array.isArray(u2.data.days) && u2.data.days.length === 7);
    const set = (w) => { const k = 'an:day:' + Math.floor(Date.now() / 86400000), row = env.inst.get('analytics').state.storage.map.get(k); row._use.w = w; };
    set(78000); const u3 = await call(env, '/api/admin/usage', { method: 'POST', body: {}, headers: ADMIN });
    set(80500); const u4 = await call(env, '/api/admin/usage', { method: 'POST', body: {}, headers: ADMIN });
    ck('S6 the alert shows from 80% of the daily limit', u3.data.alert === false && u4.data.alert === true && u4.data.pct.workerRequests >= 80, u3.data.alert + ' ' + u4.data.alert);
    const rep = await call(env, '/api/admin/analytics', { method: 'POST', body: {}, headers: ADMIN });
    ck('S6 usage is not shown as a stats group', rep.status === 200 && (rep.data.days || []).every((d) => !('_use' in d.groups)));

    // S7
    const cfg = JSON.parse(src.wrangler.replace(/^\s*\/\/.*$/gm, ''));
    ck('S7 only /api/* runs the Worker; missing paths are answered by the asset layer (404-page), never the Worker',
      JSON.stringify(cfg.assets.run_worker_first) === '["/api/*"]' && cfg.assets.not_found_handling === '404-page' && fs.existsSync(path.join(ROOT, 'public', '404.html')) && cfg.assets.directory === './public', JSON.stringify(cfg.assets));
    const fetchBody = src.worker.slice(src.worker.indexOf('async fetch(request, env'), src.worker.indexOf('/* Durable Object plumbing'));
    const outside = fetchBody.split('if (path.startsWith("/api/")) {')[1] || '';
    ck('S7 the worker fetch handler routes /api/ first and serves no page itself (only the unreachable asset fallback)',
      /if \(path\.startsWith\("\/api\/"\)\) \{/.test(fetchBody) && !/text\/html|\.html"/.test(fetchBody) && (fetchBody.match(/env\.ASSETS\.fetch/g) || []).length === 1);
    ck('S7 the service worker never touches /api/ and serves the cached game on a Cloudflare limit page',
      /return url\.pathname\.startsWith\('\/api\/'\);/.test(src.sw) && /res\.status === 429 \|\| res\.status >= 500/.test(src.sw) && /\? shellResponse\(req\)\.then/.test(src.sw));
    void outside;
  } catch (e) { ck('server section ran', false, String(e.stack || e).slice(0, 300)); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }

  /* ------------------------------ game ------------------------------ */
  try {
    const TIMERS = 'setTimeout=function(f,ms){ (globalThis.__T=globalThis.__T||[]).push({f:f,ms:ms}); return __T.length; }; setInterval=function(f,ms){ (globalThis.__I=globalThis.__I||[]).push({f:f,ms:ms}); return 1; };';
    const bootGame = (init, fetchImpl) => {
      const { store, mem } = makeStore(Object.assign({ fluxPlayerId: 'p-free-1', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxDifficulty: 'medium', fluxSeason: '1', fluxRunsPlayed: '5', fluxStatFirstRun: '1' }, init));
      const calls = [], beacons = [];
      const f = fetchImpl || (() => Promise.resolve(new Response('{"ok":true,"skus":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
      const g = boot([TIMERS].concat(scriptsOf(src.game)), { origin: ORIGIN, path: '/play/', store, fetchImpl: (u, o) => { calls.push({ u: String(u), body: o && o.body ? JSON.parse(o.body) : null }); return f(u, o); } });
      g.ctx.Blob = Blob; g.win.navigator.sendBeacon = (u, b) => { beacons.push({ u, b }); return true; };
      const run = (c) => vm.runInContext(c, g.ctx);
      const timers = () => run('globalThis.__T || []');
      const gameOver = async (sc) => { run('document.hidden=false'); g.ctx.newGame(); run('score=' + sc + ';'); const k = timers().length; g.ctx.endGame(); timers().slice(k).filter((t) => t.ms === 420).forEach((t) => t.f()); await tick(); };
      return { g, mem, run, calls, beacons, timers, gameOver, store };
    };
    const fresh = () => JSON.stringify({ v: 1, source: 'server', playerId: 'p-free-1', skus: [], verifiedAt: Date.now() });

    // C1
    const a = bootGame({ fluxEntitlementsV1: fresh() });
    const net0 = a.calls.length;
    await a.gameOver(3000);
    const ups = () => a.calls.filter((x) => x.u === '/api/submit-score');
    const first = ups()[0];
    ck('C1 a run is ONE request: the score upload carries the run\'s stats; no separate stats request',
      ups().length === 1 && a.beacons.length === 0 && first.body.stats && first.body.stats.events.some((e) => e.e === 'run_end') && first.body.stats.events.some((e) => e.e === 'open') && first.body.score === 3000, JSON.stringify(first && first.body).slice(0, 200));
    skew += 20000; await a.gameOver(1200);
    ck('C1 ...a run that is not a new best sends only its stats (one small request), not the same best again', ups().length === 1 && a.beacons.length === 1 && a.beacons[0].u === '/api/events', ups().length + ' ' + a.beacons.length);
    skew += 20000; await a.gameOver(5200);
    ck('C1 ...a new best is one upload again, with its stats', ups().length === 2 && a.beacons.length === 1 && ups()[1].body.score === 5200 && ups()[1].body.stats.events.some((e) => e.e === 'run_end'), ups().length + ' ' + a.beacons.length);
    ck('C1 ...a new name always uploads (the board shows it)', (a.run('callsign="VEGA";'), a.g.ctx.submitScore(), await tick(), ups().length === 3 && ups()[2].body.name === 'VEGA'));
    void net0;

    // C2
    const b = bootGame({ fluxEntitlementsV1: fresh() });
    const atLoad = b.calls.length + b.beacons.length;
    for (let round = 0; round < 3; round++) { const ts = b.timers().splice(0); for (const t of ts) { try { t.f(); } catch (e) {} } await tick(); }
    for (const t of b.run('globalThis.__I || []')) { for (let i = 0; i < 3; i++) { try { t.f(); } catch (e) {} } }
    await tick();
    const idle = b.calls.length + b.beacons.length - atLoad;
    ck('C2 a returning player\'s page makes no request at load (entitlements checked < 30 min ago, country known, nothing queued)', atLoad === 0, b.calls.map((x) => x.u).join(','));
    ck('C2 no idle polling: running every timer and interval the page set makes no request', idle === 0, b.calls.map((x) => x.u).join(',') + ' beacons=' + b.beacons.length);
    const b2 = bootGame({ fluxEntitlementsV1: JSON.stringify({ v: 1, source: 'server', playerId: 'p-free-1', skus: [], verifiedAt: Date.now() - 3600000 }) });
    for (const t of b2.timers().splice(0)) { try { t.f(); } catch (e) {} }
    await tick();
    ck('C2 ...an older entitlements answer is checked once per page load, never twice', b2.calls.filter((x) => x.u.includes('/api/entitlements')).length === 1, b2.calls.map((x) => x.u).join(','));

    // C3
    const lbData = { top: [{ pid: 'x', tag: 'ABC1234', name: 'NOVA', country: 'PH', score: 9000, level: 5, difficulty: 'medium' }], countries: [{ country: 'PH', totalScore: 9000, playerCount: 1 }], leadingCountry: { country: 'PH', playerCount: 1 } };
    const lbFetch = () => Promise.resolve(new Response(JSON.stringify(lbData), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const c = bootGame({ fluxEntitlementsV1: fresh() }, lbFetch);
    const lbCalls = (x) => x.calls.filter((y) => y.u.includes('/api/leaderboard')).length;
    c.g.ctx.openLeaderboard(); await tick(); c.g.ctx.openLeaderboard(); await tick();
    const gw = boot(scriptsOf(src.gw), { origin: ORIGIN, path: '/', store: c.store, fetchImpl: (u) => { c.calls.push({ u: String(u) }); return lbFetch(); } });
    await tick();
    ck('C3 the leaderboard is fetched once for two game views AND the Gateway World Grid in another tab (one shared copy)', lbCalls(c) === 1, String(lbCalls(c)));
    ck('C3 ...every view uses the limit=50 board', c.calls.filter((y) => y.u.includes('/api/leaderboard')).every((y) => /\/api\/leaderboard\?limit=50$/.test(y.u)));
    skew += 30000; gw.ctx.fetchGlobalGrid(); c.g.ctx.openLeaderboard(); await tick();
    ck('C3 ...a manual refresh inside the minute shows the copy (no request)', lbCalls(c) === 1, String(lbCalls(c)));
    skew += 31000; c.g.ctx.openLeaderboard(); await tick(); gw.ctx.fetchGlobalGrid(); await tick();
    ck('C3 ...after a minute, exactly one new request for all views', lbCalls(c) === 2, String(lbCalls(c)));

    // C4
    let mode = 'limit';
    const LIMIT = () => Promise.resolve({ ok: false, status: 429, headers: { get: (k) => (/content-type/i.test(k) ? 'text/html; charset=UTF-8' : null) }, text: () => Promise.resolve('<title>This website has been temporarily rate limited</title><h1>Error 1027</h1>'), json: () => Promise.reject(new Error('html')) });
    const OK = () => Promise.resolve(new Response('{"ok":true,"public":true,"rank":1,"skus":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const d = bootGame({ fluxEntitlementsV1: fresh() }, () => (mode === 'limit' ? LIMIT() : mode === 'down' ? Promise.reject(new TypeError('offline')) : OK()));
    await d.gameOver(6000); await tick();
    const q1 = JSON.parse(d.mem.fluxPendingSubmits || '[]');
    const pauseMs = (+d.mem.fluxNetPause || 0) - Date.now();
    const sent1 = d.calls.filter((x) => x.u === '/api/submit-score').length;
    ck('C4 on Cloudflare\'s limit page the run is kept (score + stats queued), not dropped', q1.length === 1 && q1[0].score === 6000 && q1[0].stats && q1[0].stats.events.some((e) => e.e === 'run_end'), JSON.stringify(q1).slice(0, 160));
    ck('C4 ...every server call pauses until the daily reset (at most an hour), and the offline note is on', pauseMs > 0 && pauseMs <= 3600000 && d.run('fluxNetHeld()') === true && /id="fluxNetNote"[^>]*>OFFLINE — SCORES WILL UPLOAD LATER</.test(src.game), String(pauseMs));
    const retryTimers = d.timers().filter((t) => t.ms >= 60000);
    const netBefore = d.calls.length;
    await d.g.ctx.flushSubmitQueue(); d.g.ctx.openLeaderboard(); await tick();
    await d.gameOver(7000); await tick();
    ck('C4 ...no retry loop: while paused nothing is sent (uploads, leaderboard, stats), later runs queue too', d.calls.length === netBefore && d.beacons.length === 0 && retryTimers.length >= 1, d.calls.map((x) => x.u).join(',') + ' b=' + d.beacons.length);
    mode = 'ok'; skew += 3700000;
    await d.g.ctx.flushSubmitQueue(); await tick();
    await d.g.ctx.flushSubmitQueue(); await tick();
    const okUps = d.calls.filter((x) => x.u === '/api/submit-score').slice(sent1);
    ck('C4 ...after the reset the queued best uploads exactly once, with every waiting run\'s stats', okUps.length === 1 && okUps[0].body.score === 7000 && okUps[0].body.stats.events.filter((e) => e.e === 'run_end').length === 2 && JSON.parse(d.mem.fluxPendingSubmits || '[]').length === 0 && d.run('fluxNetHeld()') === false, okUps.length + ' ' + JSON.stringify(okUps[0] && okUps[0].body.stats));
    const e = bootGame({ fluxEntitlementsV1: fresh() }, () => (mode === 'down' ? Promise.reject(new TypeError('offline')) : OK()));
    mode = 'down'; await e.gameOver(4000); await tick();
    const qd = JSON.parse(e.mem.fluxPendingSubmits || '[]');
    mode = 'ok'; e.g.fire('online'); await tick(); await e.g.ctx.flushSubmitQueue(); await tick();
    ck('C4 no network: the run is queued, then uploads exactly once when back online', qd.length === 1 && e.calls.filter((x) => x.u === '/api/submit-score').length === 2 && JSON.parse(e.mem.fluxPendingSubmits || '[]').length === 0, e.calls.map((x) => x.u).join(','));

    // C5
    ck('C5 the offline note is small, never during a run, and the admin page shows usage with an 80% alert',
      /#fluxNetNote\{position:fixed/.test(src.game) && /!\(typeof playing!=='undefined' && \(playing \|\| runActive\)\)/.test(src.game)
      && /call\('usage'\)/.test(src.admin) && /id="usageAlert"/.test(src.admin) && /if \(d\.alert\)/.test(src.admin) && /Worker requests/.test(src.admin));
  } catch (e) { ck('game section ran', false, String(e.stack || e).slice(0, 300)); }
  skew = 0;
  return { F, failed };
}

const main = await suite(SRC);
console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (key, a, b) => (s) => { if (!s[key].includes(a)) throw new Error('control did not apply: ' + a.slice(0, 60)); return Object.assign({}, s, { [key]: s[key].replace(a, b) }); };
async function control(label, expect, mutate) {
  let s2; try { s2 = mutate(SRC); } catch (e) { console.log('  FAIL  ' + e.message); NC++; return; }
  const r = await suite(s2, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
await control('the run\'s stats not put into the score upload', 'C1', rep('game', "  if(run) fluxMergeStats(item, fluxStatsTake());", ''));
await control('the same best uploaded again at every game over', 'C1', rep('game', 'if(!item || (run && fluxAlreadyUploaded(item))){', 'if(!item){'));
await control('the 8-second stats timer back', 'C2', rep('game', '    let hideSent=false;', '    let hideSent=false; setTimeout(fluxStatsFlush,8000);'));
await control('the 3-second entitlements repeat back', 'C2', rep('game', '  if (back) setTimeout(syncEntitlements, 3000);', '  setTimeout(syncEntitlements, 3000);'));
await control('the leaderboard copy never reused', 'C3', rep('game', "FLUX_LB_TTL_MS=60000", "FLUX_LB_TTL_MS=0"));
await control('the Gateway ignores the shared copy', 'C3', rep('gw', "var LB_KEY = 'fluxLbCache', LB_TRY = 'fluxLbTry', LB_TTL = 60000;", "var LB_KEY = 'fluxLbCacheGw', LB_TRY = 'fluxLbTryGw', LB_TTL = 60000;"));
await control('the limit page not recognised (normal backoff, no pause)', 'C4', rep('game', "if(await fluxEdgeKind(res)==='limit'){", "if(false){"));
await control('a paused queue retried anyway', 'C4', rep('game', "      if(fluxNetPausedFor()>0){ if(loadQueue().length) scheduleFlush(fluxNetPausedFor()); return; }", ''));
await control('stats counted on a 429 (counted twice after the retry)', 'S2', rep('worker', 'if (stats && resp.status !== 429 && resp.status < 500) {', 'if (stats) {'));
await control('stats in the run request dropped by the server', 'S1', rep('worker', '  const stats = runStats(body, playerId);', '  const stats = null;'));
await control('a new field forwarded to the leaderboard', 'S4', rep('worker', 'body: JSON.stringify({ playerId, name, score, level, difficulty, country, detected })', 'body: JSON.stringify({ playerId, name, score, level, difficulty, country, detected, ua: "x" })'));
await control('leaderboard memo off', 'S5', rep('worker', 'if (hit && now - hit.at < LB_MEMO_MS)', 'if (false)'));
await control('Worker requests not counted', 'S6', rep('worker', '    useCount("w");                        // FREE PLAN: every invocation of this script', ''));
await control('alert threshold moved to 95%', 'S6', rep('worker', 'const USAGE_ALERT_PCT = 80;', 'const USAGE_ALERT_PCT = 95;'));
await control('missing paths invoke the Worker again', 'S7', rep('wrangler', '"not_found_handling": "404-page",', ''));
await control('every path runs the Worker first', 'S7', rep('wrangler', '"/api/*"\n    ],', '"/api/*", "/*"\n    ],'));
await control('the service worker shows Cloudflare\'s limit page instead of the cached game', 'S7', rep('sw', 'if (res && (res.status === 429 || res.status >= 500)) {', 'if (false) {'));
const total = main.F + NC;
console.log('\n' + (total ? 'FREE PLAN FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'FREE PLAN PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
