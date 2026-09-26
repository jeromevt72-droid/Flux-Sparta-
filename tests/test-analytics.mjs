// STATS (in-house, anonymous gameplay counts), in the release gate.
// Server (REAL worker.js, fake Durable Object runtime):
//   S1 /api/events takes a small batch; bad pilot IDs, unknown events and bad
//      src tags are refused or cleaned; country only (chosen, else Cloudflare's);
//   S2 no personal information: the raw pilot ID is never stored, and the
//      stats code differs from the leaderboard's public code;
//   S3 daily totals: opens, Home Screen launches, first runs, runs, run
//      length, level reached, level-ups, shares -- by country and by src;
//   S4 active players are counted once per day and once per month;
//   S5 retention by start date: came back on day 1 / 7 / 30, by src;
//   S6 raw events are kept 90 days, then only the totals;
//   S7 the dashboard data needs the admin password;
//   S8 stats never touch the leaderboard (own instance, no player data loaded);
//   S9 a flood from one pilot is capped per day.
// Game (REAL page, harness vm):
//   C1 app open (Home Screen or not) and the first-touch ?src= tag, kept;
//   C2 first run once, run finished (length, level, difficulty), sent in ONE
//      background request at game over with the pilot ID, country and src;
//   C3 level-ups and shares are counted (the share link's ?src=share tag is set by the share card);
//   C4 if stats cannot be sent (no sendBeacon, or it throws) the game carries
//      on and nothing waits;
//   C5 same-origin only, and no name is ever sent.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux-sparta-3.example.dev', DAY = 86400000, T0 = Date.parse('2026-10-01T12:00:00Z');
const PID = '11111111-aaaa-4bbb-8ccc-000000000001', PID2 = '22222222-aaaa-4bbb-8ccc-000000000002';

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { if (typeof k === 'object') { for (const [kk, vv] of Object.entries(k)) this.map.set(kk, structuredClone(vv)); } else this.map.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
}
function makeEnv(LeaderboardDO, extra = {}) {
  const instances = new Map(); let chain = Promise.resolve();
  return { LEADERBOARD_DO: { idFromName: (n) => n, _instances: instances, get(id) {
    if (!instances.has(id)) instances.set(id, new LeaderboardDO({ storage: new FakeStorage(), blockConcurrencyWhile: (fn) => fn() }));
    const o = instances.get(id);
    return { fetch(url, init) { const run = () => o.fetch(new Request(url, init)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } }; } },
    ADMIN_TOKEN: 'secret-admin', ...extra };
}

async function suite({ gameHtml, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, LeaderboardDO = workerMod.LeaderboardDO;
  const env = makeEnv(LeaderboardDO);
  let now = T0;
  const call = async (p, { method = 'GET', body, headers = {}, cf } = {}) => {
    const r = new Request(ORIGIN + p, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (cf) Object.defineProperty(r, 'cf', { value: cf });
    const res = await worker.fetch(r, env, {}); let data = null; try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
  const send = (pid, events, extra = {}) => call('/api/events', { method: 'POST', body: { pid, events, ...extra }, cf: { country: 'JP' } });
  const inst = () => env.LEADERBOARD_DO._instances.get('analytics') || env.LEADERBOARD_DO._instances.get('global');
  const report = async () => (await call('/api/admin/analytics', { method: 'POST', body: { from: '2026-09-01', to: '2027-02-01' }, headers: { 'x-admin-token': 'secret-admin' } })).data;
  const dayOf = (rep, date) => (rep.days.find((d) => d.date === date) || { groups: {} }).groups;
  try {
    // ---- day 0 (2026-10-01): pilot A from TikTok (PH), pilot B direct (country from Cloudflare)
    await call('/api/admin/analytics', { method: 'POST', body: {}, headers: { 'x-admin-token': 'secret-admin' } });   // creates the stats instance
    inst().nowMs = () => now;
    const first = await send(PID, [{ e: 'open', home: true }, { e: 'first_run' }], { country: 'PH', src: 'TikTok' });
    ck('S1 a batch is accepted', first.status === 200 && first.data.ok === true);
    await send(PID, [{ e: 'run_end', sec: 95, lvl: 3, diff: 'hard' }, { e: 'level_up', lvl: 2, diff: 'hard' }, { e: 'level_up', lvl: 3, diff: 'hard' }, { e: 'share' }, { e: 'hack' }, { e: 'run_end', sec: 99999, lvl: 77, diff: 'x' }], { country: 'PH', src: 'facebook' });
    await send(PID2, [{ e: 'open', home: false }, { e: 'run_end', sec: 30, lvl: 1, diff: 'easy' }], { country: 'nope', src: 'bad src!!' });
    const bad = await send('<b>x</b>', [{ e: 'open' }]);
    ck('S1 a bad pilot ID is refused', bad.status === 400);
    let rep = await report(); const d0 = dayOf(rep, '2026-10-01');
    ck('S1 unknown events dropped, out-of-range values cleaned, bad src -> "direct", no chosen country -> Cloudflare country',
      d0.all && d0.all.runs === 3 && d0.all.sec === 95 + 0 + 30 && d0.all.lvl === 3 + 1 + 1 && !!d0['s:direct'] && !!d0['c:JP'], JSON.stringify(d0.all));
    const store = JSON.stringify([...inst().state.storage.map.entries()]);
    const lbCode = await (async () => { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('flux-pid:' + PID)); return Array.from(new Uint8Array(b)).slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join(''); })();
    ck('S2 the raw pilot ID is never stored, and the stats code is not the leaderboard code', !store.includes(PID) && !store.includes(PID2) && !store.includes(lbCode) && /an:p:[0-9a-f]{16}/.test(store));
    ck('S3 daily totals: opens, Home Screen launches, first runs, runs, level-ups, shares',
      d0.all.opens === 2 && d0.all.home === 1 && d0.all.first === 1 && d0.all.levelups === 2 && d0.all.shares === 1, JSON.stringify(d0.all));
    ck('S3 ...by country and by src (the src a pilot FIRST came from: TikTok, not the later facebook tag)',
      d0['c:PH'].runs === 2 && d0['c:JP'].runs === 1 && d0['s:tiktok'].runs === 2 && d0['s:tiktok'].shares === 1 && !d0['s:facebook'], Object.keys(d0).join(','));
    ck('S4 active players counted once per day (A sent 2 batches) and new players counted', d0.all.active === 2 && d0.all.new === 2 && d0['s:tiktok'].active === 1);
    // ---- later days: A returns on day 1 and 7, B on day 1 only
    for (const [dd, who] of [[1, [PID, PID2]], [7, [PID]], [8, [PID]]]) { now = T0 + dd * DAY; for (const w of who) await send(w, [{ e: 'open' }], { country: 'PH' }); }
    rep = await report();
    const mon = (rep.months.find((m) => m.month === '2026-10') || { groups: {} }).groups;
    ck('S4 monthly active players: distinct pilots in the month (2), not visits', mon.all && mon.all.active === 2, JSON.stringify(mon.all));
    const coh = (rep.cohorts.find((c) => c.date === '2026-10-01') || { groups: {} }).groups;
    ck('S5 retention by start date: 2 started, 2 back on day 1, 1 on day 7, none on day 30 yet', coh.all && coh.all.n === 2 && coh.all.d1 === 2 && coh.all.d7 === 1 && !coh.all.d30, JSON.stringify(coh.all));
    ck('S5 ...by src: the TikTok pilot came back on day 7, the direct one did not', coh['s:tiktok'].d7 === 1 && !coh['s:direct'].d7);
    now = T0 + 30 * DAY; await send(PID, [{ e: 'open' }]); rep = await report();
    ck('S5 ...and day 30', (rep.cohorts.find((c) => c.date === '2026-10-01').groups.all.d30) === 1);
    // ---- 90 days
    now = T0 + 95 * DAY; await send(PID, [{ e: 'open' }]);
    await inst().fetch(new Request('https://do.internal/an-purge', { method: 'POST' }));
    const keys = [...inst().state.storage.map.keys()];
    ck('S6 raw events older than 90 days are deleted, the totals stay', !keys.some((k) => k.startsWith('an:ev:' + Math.floor(T0 / DAY) + ':')) && keys.includes('an:day:' + Math.floor(T0 / DAY)) && keys.some((k) => k.startsWith('an:ev:' + Math.floor((T0 + 95 * DAY) / DAY))), keys.filter((k) => k.startsWith('an:ev')).join(','));
    let w = 0; const cron = worker.scheduled ? (worker.scheduled({}, env, { waitUntil: (p) => { w++; return p; } }), w) : 0;
    ck('S6 ...and the 30-minute cron runs the clean-up', cron >= 2 && /analyticsDO\(env, "\/an-purge"/.test(workerMod.__src || WORKER_SRC));
    const noPw = await call('/api/admin/analytics', { method: 'POST', body: {} }), wrongPw = await call('/api/admin/analytics', { method: 'POST', body: {}, headers: { 'x-admin-token': 'nope' } });
    ck('S7 the dashboard data needs the admin password', noPw.status === 401 && wrongPw.status === 401 && rep.ok === true && Array.isArray(rep.days));
    ck('S8 stats never touch the leaderboard: no leaderboard instance was even created', !env.LEADERBOARD_DO._instances.has('global') && !keys.includes('players'));
    const flood = []; for (let i = 0; i < 14; i++) flood.push(send(PID2, Array.from({ length: 40 }, () => ({ e: 'share' }))));
    await Promise.all(flood); rep = await report();
    const today = dayOf(rep, new Date(now).toISOString().slice(0, 10));
    ck('S9 a flood from one pilot is capped (at most ~500 events a day)', today.all.shares <= 520 && today.all.shares >= 480, String(today.all.shares));
  } catch (e) { ck('server section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const GAME = scriptsOf(gameHtml);
    const bootGame = (init, search = '', standalone = false) => {
      const { store, mem } = makeStore(Object.assign({ fluxPlayerId: 'p-stats-1', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1' }, init));
      const fetched = [];
      const g = boot(GAME, { origin: ORIGIN, path: '/play/', search, store, standalone, fetchImpl: (u) => { fetched.push(String(u)); return Promise.resolve(new Response('{"ok":true}', { status: 200 })); } });
      g.ctx.Blob = Blob; const beacons = []; g.win.navigator.sendBeacon = (u, b) => { beacons.push({ u, b }); return true; };
      g.ctx.fluxIsStandalone = () => standalone;
      return { g, mem, run: (c) => vm.runInContext(c, g.ctx), beacons, fetched };
    };
    const a = bootGame({}, '?src=TikTok');
    const q0 = a.run('JSON.stringify(fluxStatsQueue)');
    ck('C1 app open is counted (a browser tab here), and the first-touch src is kept', /"e":"open","home":false/.test(q0) && a.mem.fluxSrc === 'tiktok', q0 + ' ' + a.mem.fluxSrc);
    const a2 = bootGame(a.mem, '?src=facebook', true);
    ck('C1 ...a Home Screen launch is marked, and a later ?src= never replaces where the pilot first came from', /"home":true/.test(a2.run('JSON.stringify(fluxStatsQueue)')) && a2.mem.fluxSrc === 'tiktok');
    const n = bootGame({ fluxRunsPlayed: '0' });
    n.g.ctx.newGame(); n.run('level=3; difficulty="hard"; score=1200;'); n.g.ctx.endGame();
    const sent = n.beacons.map((x) => x.b);
    ck('C2 one background request at game over, to our own server', n.beacons.length === 1 && n.beacons[0].u === '/api/events', n.beacons.map((x) => x.u).join(','));
    let body = {}; try { body = JSON.parse(await sent[0].text()); } catch (e) {}
    const ev = (body.events || []).map((e) => e.e).join(',');
    ck('C2 it carries the pilot ID, country, src, and open + first run + run finished (level 3, hard, length)',
      body.pid === 'p-stats-1' && body.country === 'PH' && body.src === 'direct' && ev === 'open,first_run,run_end' && body.events[2].lvl === 3 && body.events[2].diff === 'hard' && typeof body.events[2].sec === 'number', JSON.stringify(body).slice(0, 200));
    ck('C2 ...the queue is empty afterwards, and "first run" is sent only once', n.run('fluxStatsQueue.length') === 0 && (n.g.ctx.newGame(), n.run('fluxStatsQueue.length')) === 0);
    ck('C5 no name is ever sent', !JSON.stringify(body).includes('TITAN'));
    const s = bootGame({ fluxRunsPlayed: '4' }); s.run('fluxStatsQueue=[];'); s.g.ctx.newGame(); s.run('pendingLevel=level+1;'); s.g.ctx.finishLevelUp();
    ck('C3 a level-up is counted with its level and difficulty', /"e":"level_up","lvl":2/.test(s.run('JSON.stringify(fluxStatsQueue)')), s.run('JSON.stringify(fluxStatsQueue)'));
    s.run('shareInfo=null;'); s.g.win.document.getElementById('shareBtn').onclick();
    ck('C3 a share tap is counted (and sent straight away)', s.beacons.some((x) => true) && s.run('fluxStatsQueue.length') === 0);
    const x = bootGame({}); delete x.g.win.navigator.sendBeacon; x.g.ctx.newGame(); x.g.ctx.endGame();
    ck('C4 no sendBeacon: nothing is sent, nothing waits, the game carries on', x.fetched.every((u) => !u.includes('/api/events')) && x.run('fluxStatsQueue.length') === 0 && x.run('playing') === false);
    const y = bootGame({}); y.g.win.navigator.sendBeacon = () => { throw new Error('blocked'); };
    let threw = false; try { y.g.ctx.newGame(); y.g.ctx.endGame(); } catch (e) { threw = true; }
    ck('C4 a failing send never breaks the game', !threw && y.run('playing') === false);
    ck('C5 stats go only to our own server (same origin), no third-party tracker', /const FLUX_STATS_URL='\/api\/events';/.test(gameHtml) && !/google-analytics|googletagmanager|facebook\.net|segment\.com|mixpanel|amplitude|firebase/i.test(gameHtml));
  } catch (e) { ck('game section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ gameHtml: GAME_HTML, workerMod: realMod });
console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { game = (s) => s, worker = (s) => s }) {
  const g2 = game(GAME_HTML), w2 = worker(WORKER_SRC);
  if (g2 === GAME_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-stats-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ gameHtml: g2, workerMod: Object.assign({}, mod, { __src: w2 }), quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('stats code the same as the leaderboard code (matchable)', 'S2', { worker: rep('new TextEncoder().encode("flux-stats:" + String(playerId))', 'new TextEncoder().encode("flux-pid:" + String(playerId))') });
await control('active players counted per visit, not per day', 'S4', { worker: rep('    if (p.l !== today) {', '    if (true) {') });
await control('retention never recorded', 'S5', { worker: rep('const age = today - p.f, bit = { 1: 1, 7: 2, 30: 4 }[age];', 'const age = today - p.f, bit = 0;') });
await control('raw events kept forever', 'S6', { worker: rep('cut = this.anToday() - AN_KEEP_DAYS;', 'cut = -Infinity;') });
await control('dashboard data open without a password', 'S7', { worker: rep('  const denied = requireAdmin(request, env); if (denied) return denied;\n  const b = (await readJsonObject(request)) || {};', '  const b = (await readJsonObject(request)) || {};') });
await control('stats written into the leaderboard instance', 'S8', { worker: rep('env.LEADERBOARD_DO.idFromName("analytics")', 'env.LEADERBOARD_DO.idFromName("global")') });
await control('no daily cap', 'S9', { worker: rep('if (p.k >= 500) return', 'if (false) return') });
await control('later src overwrites the first one', 'C1', { game: rep("  if(!s){\n    try{ const q=", "  if(true){\n    try{ const q=") });
await control('stats sent without a guard (a failure breaks game over)', 'C4', { game: rep("    navigator.sendBeacon(FLUX_STATS_URL,new Blob([body],{type:'text/plain'}));   // fire and forget\n  }catch(x){ fluxStatsQueue=[]; }", "    navigator.sendBeacon(FLUX_STATS_URL,new Blob([body],{type:'text/plain'}));   // fire and forget\n  }finally{}") });
await control('the pilot name is sent', 'C5', { game: rep('JSON.stringify({pid:playerId,country:country,', 'JSON.stringify({pid:playerId,name:callsign,country:country,') });
const total = main.F + NC;
console.log('\n' + (total ? 'STATS FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'STATS PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
