// PILOT MOVE TO fluxsparta.com (owner). The REAL worker.js (stand-in Durable Object storage), the REAL
// hand-off script at the top of the Gateway and the game, and the REAL fluxsparta.com/move.html.
//   W  the one-time ticket on the server: put -> take works once; used, expired and wrong tickets are
//      refused; the keys are deleted on use, and by the alarm after 10 minutes when nobody calls;
//      nothing else is kept; bad uploads are refused; rate limits;
//   O  the old address: a browser tab with a pilot hands it over (only its own FLUX keys, nothing
//      deleted); no pilot -> straight to fluxsparta.com; never in an installed app, in a frame, offline,
//      on a purchase return, with unsent runs, a purchase or a restore in progress, twice in one tab, or
//      after #fluxstay; a failed move leaves the page shown and the pilot unchanged;
//   N  move.html: removes the ticket from the address bar and history BEFORE anything else; writes the
//      pilot only into an empty browser (or over a new empty pilot), all or nothing; never over a real
//      pilot; every failure changes nothing and goes back to the old address;
//   E  end to end through the real worker, and the real game booted after the move keeps the pilot;
//   P  privacy sentence; move.html runs nothing else; both pages carry the same hand-off script, first.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = { gw: R('public/index.html'), game: R('public/play/index.html'), move: R('public/move.html'), worker: R('worker.js'), privacy: R('public/privacy.html'), admin: R('public/admin.html') };
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const OLD = 'https://flux-sparta-3.jeromevt72.workers.dev', NEW = 'https://fluxsparta.com';
const PID = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000a1', OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000b2';
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick(); };
const until = async (fn, ms = 10000) => { const end = realNow() + ms; while (!fn() && realNow() < end) await new Promise((r) => setTimeout(r, 2)); return !!fn(); };   // real time (the worker's crypto runs off the main thread)
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

/* ---------- stand-in Durable Object runtime with list / delete / alarms ---------- */
function makeEnv(LeaderboardDO) {
  class FakeStorage { constructor() { this.map = new Map(); this.alarm = null; }
    async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
    async put(a, v) { if (typeof a === 'object') { for (const [k, x] of Object.entries(a)) this.map.set(k, structuredClone(x)); } else this.map.set(a, structuredClone(v)); }
    async delete(k) { if (Array.isArray(k)) { let n = 0; for (const x of k) n += this.map.delete(x) ? 1 : 0; return n; } return this.map.delete(k); }
    async list({ prefix = '' } = {}) { return new Map([...this.map.entries()].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, structuredClone(v)])); }
    async getAlarm() { return this.alarm; } async setAlarm(t) { this.alarm = +t; } async deleteAlarm() { this.alarm = null; } }
  class FakeState { constructor() { this.storage = new FakeStorage(); } async blockConcurrencyWhile(fn) { return fn(); } }
  const instances = new Map(); let chain = Promise.resolve();
  const ns = { idFromName: (n) => n, _i: instances,
    get(id) { if (!instances.has(id)) instances.set(id, new LeaderboardDO(new FakeState(), env)); const o = instances.get(id);
      return { fetch(url, init) { const run = () => o.fetch(new Request(url, init)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } }; } };
  const env = { LEADERBOARD_DO: ns, STORE_OPEN: 'false', SITE_URL: OLD };
  return env;
}
let ipN = 0;
async function call(worker, env, origin, p, body, ip) {
  const res = await worker.fetch(new Request(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip || ('198.51.100.' + (++ipN % 250)) }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env, { waitUntil() {} });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data };
}

/* ---------- a page script in its own small browser ---------- */
class Store { constructor(init = {}, failAfter = Infinity) { this.m = new Map(Object.entries(init)); this.failAfter = failAfter; this.writes = 0; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (++this.writes > this.failAfter) throw new Error('QuotaExceededError'); this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); } snap() { return Object.fromEntries([...this.m.entries()].sort()); } }
function page(src, { url, store, session, standalone = false, displayMode = '', framed = false, onLine = true, fetchImpl }) {
  const u = new URL(url), ev = [], timers = [];
  const loc = { hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash, nav: null,
    get href() { return u.origin + this.pathname + this.search + this.hash; },
    replace(v) { ev.push(['navigate', String(v)]); if (this.nav === null) this.nav = String(v); }, assign(v) { this.replace(v); } };
  const style = { visibility: '' }, hidden = [];
  const g = { location: loc, JSON, URLSearchParams, Array, String, Number, Object, Error, RegExp, Math, Promise, encodeURIComponent,
    history: { replaceState(_s, _t, v) { ev.push(['replaceState', String(v)]); const x = new URL(String(v), u.origin); loc.pathname = x.pathname; loc.search = x.search; loc.hash = x.hash; } },
    localStorage: store, sessionStorage: session || new Store(),
    navigator: { standalone, onLine },
    matchMedia: (q) => ({ matches: !!displayMode && q.indexOf(displayMode) >= 0 }),
    document: { documentElement: { style: new Proxy(style, { set(t, k, v) { t[k] = v; if (k === 'visibility') hidden.push(v); return true; } }) } },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].f = null; },
    fetch: (p, init) => { ev.push(['fetch', String(p), loc.href]); return fetchImpl(String(p), init); } };
  g.window = g; g.self = g; g.top = framed ? {} : g;
  vm.createContext(g);
  let error = null; try { vm.runInContext(src, g); } catch (e) { error = e; }
  return { g, ev, loc, style, hidden, timers, error, fire: (ms) => { for (const t of timers) if (t.f && t.ms === ms) { const f = t.f; t.f = null; f(); } } };
}
const resp = (status, obj) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));

async function suite(src, workerMod, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + String(x).slice(0, 220) + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, DO = workerMod.LeaderboardDO;
  const OUT = scriptsOf(src.gw)[0], OUT2 = scriptsOf(src.game)[0], MOVE = scriptsOf(src.move)[0];
  const KEYS = { fluxPlayerId: PID, fluxCallsign: 'TITAN', fluxCountry: 'FR', fluxPublicTag: 'Z007M00', fluxProfileComplete: '1', fluxSkin: 'solar', fluxBackground: 'solar',
    fluxSolarUsed: PID, fluxFounding: JSON.stringify({ pid: PID, n: 57 }), fluxRunsPlayed: '42', fluxBest_medium: '16553', fluxBestLevel_medium: '7',
    fluxBestRun_medium: JSON.stringify({ score: 16553, level: 7, difficulty: 'medium', playerId: PID }), fluxSrc: 'tiktok', fluxStatFirstRun: '1' };
  const CACHES = { fluxLbCache: '{"x":1}', fluxEntitlementsV1: '{"skus":["solar"]}', fluxOwned_solar: '1', fluxNetPause: '1', fluxRankSnap: '{}', fluxInstallOffers: '2' };
  const mvStore = (env) => { const o = env.LEADERBOARD_DO._i.get('move'); return o ? o.state.storage : null; };

  /* ================= W: the ticket on the server ================= */
  try {
    const env = makeEnv(DO);
    const p1 = await call(worker, env, OLD, '/api/move/put', { playerId: PID, keys: KEYS });
    const st = mvStore(env), t1 = p1.data && p1.data.ticket;
    const rec = st ? await st.get('mv:' + t1) : null;
    ck('W1 put: a random 32-hex one-time ticket; the keys are stored under it with a 10-minute end, and an alarm is set', p1.status === 200 && /^[0-9a-f]{32}$/.test(t1 || '') && rec && JSON.stringify(rec.keys) === JSON.stringify(KEYS)
      && Math.abs(rec.exp - (Date.now() + 600000)) < 2000 && st.alarm !== null && st.alarm <= Date.now() + 602000, JSON.stringify([p1, st && st.alarm]));
    const k1 = await call(worker, env, NEW, '/api/move/take', { ticket: t1 });
    ck('W2 take: the same keys come back once, and nothing is left stored', k1.status === 200 && k1.data.ok === true && JSON.stringify(k1.data.keys) === JSON.stringify(KEYS) && st.map.size === 0, JSON.stringify([k1.status, st.map.size]));
    const k2 = await call(worker, env, NEW, '/api/move/take', { ticket: t1 });
    ck('W3 a USED ticket is refused (404) and gives nothing', k2.status === 404 && k2.data.ok === false && !k2.data.keys, JSON.stringify(k2));
    const p2 = await call(worker, env, OLD, '/api/move/put', { playerId: PID, keys: KEYS }); skew += 600001;
    const k3 = await call(worker, env, NEW, '/api/move/take', { ticket: p2.data.ticket });
    ck('W4 an EXPIRED ticket (10 min + 1 ms) is refused (410), gives nothing, and is deleted', k3.status === 410 && !k3.data.keys && st.map.size === 0, JSON.stringify([k3, st.map.size]));
    const p3 = await call(worker, env, OLD, '/api/move/put', { playerId: PID, keys: KEYS });
    const w1 = await call(worker, env, NEW, '/api/move/take', { ticket: 'f'.repeat(32) }), w2 = await call(worker, env, NEW, '/api/move/take', { ticket: 'not-a-ticket' }), w3 = await call(worker, env, NEW, '/api/move/take', { ticket: p3.data.ticket.slice(0, 31) + (p3.data.ticket[31] === '0' ? '1' : '0') });
    ck('W5 a WRONG ticket is refused (unknown 404, malformed 400), gives nothing, and leaves the real one waiting', w1.status === 404 && w2.status === 400 && w3.status === 404 && !w1.data.keys && !w3.data.keys && st.map.size === 1, JSON.stringify([w1.status, w2.status, w3.status, st.map.size]));
    const p4 = await call(worker, env, OLD, '/api/move/put', { playerId: PID, keys: KEYS }); skew += 300000;
    const p5 = await call(worker, env, OLD, '/api/move/put', { playerId: PID, keys: KEYS }); skew += 300001;   // p3, p4 expired now, p5 not yet
    const obj = env.LEADERBOARD_DO._i.get('move'); await obj.alarm();
    ck('W6 with nobody calling, the alarm deletes every expired ticket and keeps the one still valid (rescheduled)', st.map.size === 1 && st.map.has('mv:' + p5.data.ticket) && st.alarm >= Date.now() && !st.map.has('mv:' + p4.data.ticket), JSON.stringify([...st.map.keys(), st.alarm - Date.now()]));
    skew += 300001; await obj.alarm();
    ck('W6 ...and the last one once its 10 minutes are over', st.map.size === 0, st.map.size);
    const sizes = [];
    for (const b of [{ playerId: 'bad id!', keys: { fluxPlayerId: 'bad id!' } }, { playerId: PID, keys: { fluxPlayerId: OTHER } }, { playerId: PID, keys: { fluxPlayerId: PID, fluxX: 5 } },
      { playerId: PID, keys: { fluxPlayerId: PID, other: 'x' } }, { playerId: PID, keys: { fluxPlayerId: PID, fluxBig: 'x'.repeat(4097) } }, { playerId: PID, keys: [] }, { playerId: PID }])
      sizes.push((await call(worker, env, OLD, '/api/move/put', b)).status);
    ck('W7 bad uploads are refused (400) and store nothing: bad id, keys of another pilot, non-text, non-FLUX key, oversized, no keys', sizes.every((x) => x === 400) && st.map.size === 0, sizes.join(','));
    const kinds = new Set(); const pp = await call(worker, env, OLD, '/api/move/put', { playerId: PID, keys: KEYS }); for (const k of st.map.keys()) kinds.add(k.split(':')[0]);
    await call(worker, env, NEW, '/api/move/take', { ticket: pp.data.ticket });
    ck('W8 nothing else is kept: only "mv:<ticket>" values ever, none after use, in their own "move" instance (the leaderboard is not touched)', [...kinds].join() === 'mv' && st.map.size === 0 && !env.LEADERBOARD_DO._i.has('global'), [...kinds].join() + ' ' + [...env.LEADERBOARD_DO._i.keys()].join());
    let lim = 0; for (let i = 0; i < 8; i++) { const r = await call(worker, env, OLD, '/api/move/put', { playerId: OTHER, keys: { fluxPlayerId: OTHER } }); if (r.status === 429) lim++; }
    let limT = 0; for (let i = 0; i < 32; i++) { const r = await call(worker, env, NEW, '/api/move/take', { ticket: 'e'.repeat(32) }, '203.0.113.9'); if (r.status === 429) limT++; }
    ck('W9 rate limits: 6 hand-overs a minute per pilot, 30 redeems a minute per address', lim === 2 && limT === 2, lim + ' / ' + limT);
  } catch (e) { ck('ticket section ran', false, String(e.stack || e)); }

  /* ================= O: the old address ================= */
  try {
    ck('P1 the Gateway and the game carry the SAME hand-off script, as the FIRST script on the page', OUT && OUT === OUT2 && /MOVE TO fluxsparta\.com/.test(OUT) && /fluxPlayerId/.test(OUT));
    const run = (o = {}) => { const store = new Store(Object.assign({}, KEYS, CACHES, { fluxPendingSubmits: '[]' }, o.store || {}));
      let put = null; const r = page(OUT, { url: o.url || OLD + '/play/?src=x', store, session: o.session, standalone: o.standalone, displayMode: o.displayMode, framed: o.framed, onLine: o.onLine,
        fetchImpl: o.fetchImpl || ((p, init) => { put = JSON.parse(init.body); return resp(200, { ok: true, ticket: 'a'.repeat(32) }); }) });
      return Object.assign(r, { store, put: () => put, before: store.snap() }); };
    const a = run(); const before = a.store.snap(); await settle();
    const sent = a.put();
    ck('O1 a browser tab with a pilot: hands over ONLY its own FLUX keys (no caches, queue or install marks) for a ticket', sent && sent.playerId === PID && JSON.stringify(Object.keys(sent.keys).sort()) === JSON.stringify(Object.keys(KEYS).sort())
      && Object.keys(KEYS).every((k) => sent.keys[k] === KEYS[k]), JSON.stringify(sent && Object.keys(sent.keys)));
    ck('O1 ...then opens fluxsparta.com/move.html with the page in ?to= and ONLY the ticket after #', a.loc.nav === NEW + '/move.html?to=' + encodeURIComponent('/play/?src=x') + '#t=' + 'a'.repeat(32), a.loc.nav);
    ck('O1 ...the page is hidden while it asks (no flash), and NOTHING on the old address is deleted or changed', a.hidden[0] === 'hidden' && JSON.stringify(a.store.snap()) === JSON.stringify(before), a.hidden.join());
    const b = page(OUT, { url: OLD + '/?src=tiktok', store: new Store({}), fetchImpl: () => { throw new Error('no request expected'); } });
    ck('O2 no pilot here: straight to the same page on fluxsparta.com (?src= kept), no request', b.loc.nav === NEW + '/?src=tiktok' && !b.ev.some((e) => e[0] === 'fetch'), b.loc.nav);
    const skips = {
      'installed app (iPhone)': { standalone: true }, 'installed app (Android, standalone)': { displayMode: 'standalone' }, 'installed app (fullscreen)': { displayMode: 'fullscreen' },
      'inside the Gateway frame': { framed: true }, 'offline': { onLine: false }, 'purchase return': { url: OLD + '/play/?session_id=cs_1&sku=solar' },
      'unsent runs': { store: { fluxPendingSubmits: '[{"playerId":"x"}]' } }, 'purchase in progress': { store: { fluxPendingCheckout: '{"sessionId":"cs"}' } },
      'restore in progress': { store: { fluxRestoreJournal: '{}' } }, 'tried in this tab': { session: new Store({ fluxMoveTried: '1' }) }, 'kept here (#fluxstay before)': { store: { fluxMoveStay: '1' } },
      'on fluxsparta.com itself': { url: NEW + '/play/' }, 'on another address': { url: 'http://localhost:8787/play/' } };
    const bad = [];
    for (const [n, o] of Object.entries(skips)) { const r = run(o); await settle(5); if (r.loc.nav !== null || r.ev.some((e) => e[0] === 'fetch') || r.hidden.length || r.error) bad.push(n); }
    ck('O3 never moves (no request, no navigation, page untouched): ' + Object.keys(skips).join(', '), bad.length === 0, bad.join(', '));
    const fails = { 'server error': () => resp(500, { ok: false }), 'network error': () => Promise.reject(new TypeError('offline')), 'bad reply': () => resp(200, { ok: true, ticket: '#evil' }), 'rate limited': () => resp(429, { error: 'x' }) };
    const fb = [];
    for (const [n, f] of Object.entries(fails)) { const r = run({ fetchImpl: f }); await settle(); if (r.loc.nav !== null || r.style.visibility !== '' || JSON.stringify(r.store.snap()) !== JSON.stringify(r.before)) fb.push(n); }
    const slow = run({ fetchImpl: () => new Promise(() => {}) }); await settle(); slow.fire(6000);
    ck('O4 a FAILED move (server error, network, bad reply, rate limit, no answer in 6 s): the page shows again, stays here, pilot unchanged', fb.length === 0 && slow.loc.nav === null && slow.style.visibility === '' && JSON.stringify(slow.store.snap()) === JSON.stringify(slow.before), fb.join(', '));
    const s = run({ url: OLD + '/play/#fluxstay' }); await settle(5);
    ck('O5 #fluxstay (fluxsparta.com already has another pilot in this browser): kept here for good, the mark removed from the address', s.store.getItem('fluxMoveStay') === '1' && s.loc.nav === null && s.ev[0] && s.ev[0][0] === 'replaceState' && !/#/.test(s.ev[0][1]), JSON.stringify(s.ev));
  } catch (e) { ck('old address section ran', false, String(e.stack || e)); }

  /* ================= N: fluxsparta.com/move.html ================= */
  try {
    const T = 'c'.repeat(32), url = NEW + '/move.html?to=' + encodeURIComponent('/play/?src=x') + '#t=' + T;
    const arrive = (store, take, u = url) => page(MOVE, { url: u, store, fetchImpl: take || (() => resp(200, { ok: true, keys: Object.assign({ fluxEvil: 'x', fluxLbCache: 'old' }, KEYS) })) });
    const first = [arrive(new Store()), arrive(new Store(), null, NEW + '/move.html?to=/#t=zz'), arrive({ getItem() { throw new Error('blocked'); } })];
    for (const f of first) await settle();
    const firstOk = first.every((p) => p.ev[0] && p.ev[0][0] === 'replaceState' && !/#|t=/.test(p.ev[0][1]) && p.ev.filter((e) => e[0] === 'fetch').every((e) => !/#/.test(e[2])));
    ck('N0 the FIRST thing move.html does is remove the ticket from the address bar and history (replaceState, before any request), also for a malformed ticket or blocked storage', firstOk, JSON.stringify(first.map((p) => p.ev[0])));
    ck('N0 ...the request that redeems it goes out from the clean address (no # in the address bar at that moment)', first[0].ev.some((e) => e[0] === 'fetch' && e[2] === NEW + '/move.html?to=' + encodeURIComponent('/play/?src=x')), JSON.stringify(first[0].ev));
    const e1 = first[0];
    const wrote = e1.g.localStorage.snap();
    ck('N1 an empty browser: the pilot is written (only the known FLUX keys, nothing else), the journal is gone, the page opens', Object.keys(KEYS).every((k) => wrote[k] === KEYS[k]) && !('fluxEvil' in wrote) && !('fluxLbCache' in wrote) && !('fluxRestoreJournal' in wrote) && e1.loc.nav === '/play/?src=x', JSON.stringify([Object.keys(wrote), e1.loc.nav]));
    const auto = new Store({ fluxPlayerId: OTHER, fluxCallsign: 'SWIFT COMET 12', fluxAutoName: '1', fluxProfileComplete: '1', fluxEntitlementsV1: '{"x":1}', fluxRankSnap: '{}', fluxBest_easy: '5', fluxPendingSubmits: '[]' });
    const e2 = arrive(auto); await settle(); const w2 = auto.snap();
    ck('N2 a NEW EMPTY pilot here (auto-named, nothing uploaded, nothing waiting): replaced by the moved pilot; its caches and bests cleared', w2.fluxPlayerId === PID && w2.fluxCallsign === 'TITAN' && !('fluxAutoName' in w2) && !('fluxEntitlementsV1' in w2) && !('fluxRankSnap' in w2) && !('fluxBest_easy' in w2) && e2.loc.nav === '/play/?src=x', JSON.stringify(w2));
    const same = new Store({ fluxPlayerId: PID, fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxBest_medium: '20000' }); const sb = same.snap();
    const e3 = arrive(same); await settle();
    ck('N3 the SAME pilot is already here: nothing changes (its newer best kept), the page opens', JSON.stringify(same.snap()) === JSON.stringify(sb) && e3.loc.nav === '/play/?src=x');
    const real = new Store({ fluxPlayerId: OTHER, fluxCallsign: 'NOVA', fluxProfileComplete: '1', fluxPublicTag: 'K2X9P00' }); const rb = real.snap();
    const e4 = arrive(real); await settle();
    const real2 = new Store({ fluxPlayerId: OTHER, fluxCallsign: 'SWIFT COMET 12', fluxAutoName: '1', fluxProfileComplete: '1', fluxPublicTag: 'K2X9P01' }); const rb2 = real2.snap();
    const e4b = arrive(real2); await settle();
    ck('N4 ANOTHER REAL pilot here (a name, or scores uploaded): never overwritten; back to the old address, which keeps its pilot for good (#fluxstay)', JSON.stringify(real.snap()) === JSON.stringify(rb) && JSON.stringify(real2.snap()) === JSON.stringify(rb2)
      && e4.loc.nav === OLD + '/play/?src=x#fluxstay' && e4b.loc.nav === OLD + '/play/?src=x#fluxstay', e4.loc.nav);
    const fl = {};
    for (const [n, f] of Object.entries({ used: () => resp(404, { ok: false, reason: 'unknown' }), expired: () => resp(410, { ok: false, reason: 'expired' }), wrong: () => resp(400, { ok: false, reason: 'wrong' }),
      network: () => Promise.reject(new TypeError('x')), 'empty reply': () => resp(200, { ok: true }), 'bad pilot id': () => resp(200, { ok: true, keys: { fluxPlayerId: '../x' } }) })) {
      const st = new Store({ fluxPlayerId: OTHER, fluxAutoName: '1', fluxProfileComplete: '1' }), b0 = st.snap(); const p = arrive(st, f); await settle();
      fl[n] = JSON.stringify(st.snap()) === JSON.stringify(b0) && p.loc.nav === OLD + '/play/?src=x'; }
    const slow = arrive(new Store(), () => new Promise(() => {})); await settle(); slow.fire(8000);
    ck('N5 used, expired or wrong ticket, network failure, empty or bad reply, no answer in 8 s: nothing changes here, back to the old address (pilot unchanged there)', Object.values(fl).every(Boolean) && slow.loc.nav === OLD + '/play/?src=x', JSON.stringify(fl));
    const busy = {};
    for (const [n, o] of Object.entries({ 'runs waiting': { fluxPendingSubmits: '[{"a":1}]' }, 'purchase': { fluxPendingCheckout: '{}' }, 'restore': { fluxRestoreJournal: '{}' } })) {
      const st = new Store(Object.assign({ fluxPlayerId: OTHER, fluxAutoName: '1', fluxProfileComplete: '1' }, o)), b0 = st.snap(); const p = arrive(st); await settle();
      busy[n] = JSON.stringify(st.snap()) === JSON.stringify(b0) && p.loc.nav === OLD + '/play/?src=x'; }
    ck('N6 the new empty pilot has runs waiting, a purchase or a restore in progress: nothing changes, back to the old address', Object.values(busy).every(Boolean), JSON.stringify(busy));
    class Once extends Store { setItem(k, v) { if (++this.writes === 7) throw new Error('QuotaExceededError'); this.m.set(k, String(v)); } }
    const half = new Once({ fluxPlayerId: OTHER, fluxAutoName: '1', fluxProfileComplete: '1', fluxCallsign: 'SWIFT COMET 12' }); const hb = half.snap();
    const e7 = arrive(half); await settle();
    ck('N7 one write fails half-way (storage full): every key is put back as it was (no mixture of two pilots), the journal is removed, back to the old address', JSON.stringify(half.snap()) === JSON.stringify(hb) && e7.loc.nav === OLD + '/play/?src=x', JSON.stringify(half.snap()));
    const dead = new Store({ fluxPlayerId: OTHER, fluxAutoName: '1', fluxProfileComplete: '1', fluxCallsign: 'SWIFT COMET 12' }, 6);
    const e7b = arrive(dead); await settle(); const j = dead.getItem('fluxRestoreJournal');
    const replay = scriptsOf(src.game).find((x) => /RESTORE JOURNAL REPLAY/.test(x)) || '';
    const revived = new Store(dead.snap()); const rp = page(replay.slice(0, replay.indexOf('/* D-45')), { url: NEW + '/play/', store: revived, fetchImpl: () => resp(500, {}) });
    const rv = revived.snap(), whole = rv.fluxPlayerId === PID ? Object.keys(KEYS).every((k) => rv[k] === KEYS[k]) && !('fluxAutoName' in rv) : JSON.stringify(rv) === JSON.stringify(hb);
    ck('N7 storage keeps failing (nothing can be put back): the journal stays, so the game\'s own replay on the next launch ends with ONE whole pilot, never a mixture', j !== null && e7b.loc.nav === OLD + '/play/?src=x' && !rp.error && whole && !('fluxRestoreJournal' in rv), JSON.stringify([j !== null, rv.fluxPlayerId, rp.error && String(rp.error)]));
    const tos = ['//evil.example/x', 'https://evil.example/', '/move.html?to=/', '/\\evil', 'javascript:alert(1)'].map(async (t) => { const p = arrive(new Store(), null, NEW + '/move.html?to=' + encodeURIComponent(t) + '#t=' + T); await settle(); return p.loc.nav; });
    const navs = await Promise.all(tos);
    ck('N8 only a page of this site can follow (?to= of another site, a loop or a script falls back to "/")', navs.every((x) => x === '/'), navs.join(' | '));
    const nt = arrive(new Store(), () => { throw new Error('no'); }, NEW + '/move.html?to=%2Fplay%2F'); await settle();
    ck('N8 ...and with no ticket at all, it simply opens the page (no request)', nt.loc.nav === '/play/' && !nt.ev.some((e) => e[0] === 'fetch'), nt.loc.nav);
  } catch (e) { ck('move.html section ran', false, String(e.stack || e)); }

  /* ================= E: end to end ================= */
  try {
    const env = makeEnv(DO), oldStore = new Store(Object.assign({}, KEYS, CACHES, { fluxPendingSubmits: '[]' })), ob = oldStore.snap();
    const viaWorker = (origin) => async (p, init) => { const r = await call(worker, env, origin, p, init.body, '192.0.2.77'); return new Response(JSON.stringify(r.data), { status: r.status, headers: { 'Content-Type': 'application/json' } }); };
    const o = page(OUT, { url: OLD + '/?src=ig', store: oldStore, fetchImpl: viaWorker(OLD) }); await until(() => o.loc.nav !== null);
    const nav = o.loc.nav || '', newStore = new Store();
    const n = page(MOVE, { url: nav || NEW + '/move.html', store: newStore, fetchImpl: viaWorker(NEW) }); await until(() => n.loc.nav !== null);
    const ns = newStore.snap(), st = mvStore(env), ticket = (nav.match(/#t=([0-9a-f]{32})$/) || [])[1];
    const again = ticket ? await call(worker, env, NEW, '/api/move/take', { ticket }) : null;
    ck('E1 old address -> real worker -> fluxsparta.com: the pilot arrives (name, tag, bests, Solar Inferno marks, Founding Pilot), the page "/?src=ig" opens', /^https:\/\/fluxsparta\.com\/move\.html\?to=%2F%3Fsrc%3Dig#t=[0-9a-f]{32}$/.test(nav)
      && Object.keys(KEYS).every((k) => ns[k] === KEYS[k]) && n.loc.nav === '/?src=ig', JSON.stringify([nav, n.loc.nav]));
    ck('E1 ...afterwards the ticket is worthless (404), the server keeps nothing, and the old address still has the pilot unchanged', again && again.status === 404 && st.map.size === 0 && JSON.stringify(oldStore.snap()) === JSON.stringify(ob), JSON.stringify([again && again.status, st && st.map.size]));
    const { store, mem } = makeStore(Object.assign({}, ns));
    const gg = boot(scriptsOf(src.game), { origin: NEW, path: '/play/', store });
    ck('E2 the real game booted on fluxsparta.com after the move plays as the moved pilot (no new pilot made)', gg.errors.length === 0 && vm.runInContext('playerId', gg.ctx) === PID && mem.fluxPlayerId === PID && mem.fluxCallsign === 'TITAN', gg.errors.join(';'));
  } catch (e) { ck('end-to-end section ran', false, String(e.stack || e)); }

  /* ================= P: page rules ================= */
  try {
    const ms = scriptsOf(src.move);
    ck('P2 move.html runs nothing else: one inline script, no other script, stylesheet, image, frame or service worker; noindex, no referrer', ms.length === 1 && !/<script[^>]+src=|<link\b|<img\b|<iframe\b|serviceWorker|addEventListener/.test(src.move)
      && /<meta name="robots" content="noindex">/.test(src.move) && /<meta name="referrer" content="no-referrer">/.test(src.move));
    ck('P3 the privacy page says what is sent, why, and that it is deleted on use and always within 10 minutes', /Moving to fluxsparta\.com\.<\/strong>[^<]*one-time ticket[^<]*deletes them as soon as that ticket is used, and always within 10 minutes/.test(src.privacy));
    ck('P4 listener counts kept (game 17, admin 2); requestAnimationFrame(loop) still 2', (src.game.match(/addEventListener\(/g) || []).length === 17 && (src.admin.match(/addEventListener\(/g) || []).length === 2 && (src.game.match(/requestAnimationFrame\(loop\)/g) || []).length === 2);
  } catch (e) { ck('page rules section ran', false, String(e.stack || e)); }
  return { F, failed };
}

const t0 = realNow();
const real = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const res = await suite(SRC, real);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0, nTmp = 0;
async function control(label, expect, file, a, b) {
  const s2 = Object.assign({}, SRC); if (!s2[file].includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  s2[file] = s2[file].split(a).join(b);
  if (file === 'gw') s2.game = s2.game.split(a).join(b);   // the same script lives in both pages
  let mod = real;
  if (file === 'worker') { const f = path.join(os.tmpdir(), 'flux-move-' + process.pid + '-' + (++nTmp) + '.mjs'); fs.writeFileSync(f, s2.worker); mod = await import(pathToFileURL(f).href); fs.unlinkSync(f); }
  const r = await suite(s2, mod, true); const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
await control('a used ticket can be redeemed again', 'W3', 'worker', '          await st.delete(k);                                                    // one use only', '          // one use only');
await control('an expired ticket is still accepted', 'W4', 'worker', 'if (!(rec.exp > now)) return json({ ok: false, reason: "expired" }, 410);', '');
await control('the alarm does not delete expired tickets', 'W6', 'worker', '    await this.moveSweep(now);\n    let next = null;', '    let next = null;');
await control('the server keeps a log of hand-overs', 'W8', 'worker', '          await st.put(MOVE_PREFIX + ticket, { keys: b.keys, exp: now + MOVE_TTL_MS });', '          await st.put(MOVE_PREFIX + ticket, { keys: b.keys, exp: now + MOVE_TTL_MS }); await st.put("log:" + now, { n: 1 });');
await control('keys of another pilot accepted', 'W7', 'worker', '|| keys.fluxPlayerId !== playerId', '');
await control('the old address sends its caches too', 'O1 a browser tab', 'gw', 'v=ls.getItem(KEYS[i]); if(v!==null) keys[KEYS[i]]=v; }', 'v=ls.getItem(KEYS[i]); if(v!==null) keys[KEYS[i]]=v; } keys.fluxLbCache=ls.getItem(\'fluxLbCache\')||\'\';');
await control('the old address deletes its pilot after handing it over', 'O1 ...the page is hidden', 'gw', "location.replace(NEW+'/move.html?to='", "ls.removeItem('fluxPlayerId'),location.replace(NEW+'/move.html?to='");
await control('installed apps move too', 'O3', 'gw', "if(navigator.standalone===true || mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)') || mm('(display-mode: minimal-ui)')) return;", '');
await control('moves while runs wait to upload', 'O3', 'gw', 'if(!Array.isArray(q) || q.length) return;', '');
await control('a failed move leaves the page hidden', 'O4', 'gw', "})['catch'](function(){ if(!over){ clearTimeout(give); show(); } });", "})['catch'](function(){});");
await control('the ticket is removed only after the request', 'N0', 'move', "  try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){}\n", '');
await control('every key from the server is written (no list)', 'N1', 'move', "for(i=0;i<KEYS.length;i++){ n=KEYS[i]; after[n]=(typeof k[n]==='string' && k[n].length<=4096) ? k[n] : null; }", "for(n in k){ after[n]=k[n]; }");
await control('a real pilot is overwritten', 'N4', 'move', "if(cur && !empty){ back(true); return; }", '');
await control('a half-written move is not put back', 'N7 one write', 'move', 'try{ put(before); ls.removeItem(\'fluxRestoreJournal\'); }catch(e2){}', 'try{ ls.removeItem(\'fluxRestoreJournal\'); }catch(e2){}');
await control('the journal is dropped even when nothing could be put back', 'N7 storage keeps', 'move', 'try{ put(before); ls.removeItem(\'fluxRestoreJournal\'); }catch(e2){}', 'try{ put(before); }catch(e2){} try{ ls.removeItem(\'fluxRestoreJournal\'); }catch(e3){}');
await control('?to= may lead to another site', 'N8', 'move', "if(/^\\/(?!\\/)[A-Za-z0-9_\\-.\\/?=&%]{0,200}$/.test(t) && t.indexOf('/move.html')!==0) to=t;", 'to=t;');
const total = res.F + NC;
console.log('\n' + (total ? 'PILOT MOVE FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PILOT MOVE PASSED: all checks and all negative controls') + '  (' + ((realNow() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
