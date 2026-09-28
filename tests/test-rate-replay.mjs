// RATE LIMITS + REPLAY PROTECTION on score uploads (/api/submit-score) and stats (/api/events).
//   R1 a repeated run id is counted once: same success reply (duplicate: true), best, country, name, cooldown unchanged;
//   R2 a retry after a lost reply (server accepted, network failed) succeeds once, the queue empties, nothing double-counted;
//   R3 a new run with a new id is judged normally (new best; the 10 s cooldown still applies to it);
//   R4 pages from before run ids (no runId) are still accepted under the existing rules;
//   R5 a repeated stats batch id is counted once; a new batch counts; the remembered ids are bounded;
//   R6 per-address limit on uploads: 429 + Retry-After past the limit, other addresses unaffected, resets after the window;
//   R7 per-pilot limit on uploads: 429 + Retry-After, resets after the window;
//   R8 stats, restore check and admin routes are limited too (admin tighter, and before the password check);
//   R9 a whole class on one school Wi-Fi playing normally is never limited;
//   R10 counters expire: memory is swept each window and capped; nothing is written to storage by the limiter;
//   R11 no raw IP address anywhere (storage or counters);
//   R12 run ids per pilot are bounded (200 entries, 7 days) and compact;
//   R13 backups copy run ids with the scores; a privacy deletion erases the pilot's run ids, live and in every backup;
//   C1 the game gives each upload a random run id from crypto.getRandomValues;
//   C2 every retry of the same upload sends the same run id; a new run gets a new id;
//   C3 a 429 keeps the upload queued (same run id) and waits at least Retry-After;
//   C4 an upload queued by an older page gets a run id once, saved before it is sent;
//   C5 every stats batch carries its own batch id; no new event listener.
// Ends with negative controls: each defect re-inserted into worker.js / play/index.html MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { levelFor } from './level-rule.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');
const RID = (n) => String(n).padStart(8, '0') + 'r'.repeat(24);      // 32 chars, like the game's
const IP_A = '203.0.113.7', IP_B = '198.51.100.23', IP6 = '2001:db8::beef:1';

class FakeStorage {
  constructor() { this.map = new Map(); this.puts = 0; }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { const o = typeof k === 'object' ? k : { [k]: v }; this.puts++; for (const [kk, vv] of Object.entries(o)) this.map.set(kk, structuredClone(vv)); }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
  async list(o = {}) { let ks = [...this.map.keys()].sort(); if (o.startAfter !== undefined) ks = ks.filter((k) => k > o.startAfter); if (o.limit) ks = ks.slice(0, o.limit); return new Map(ks.map((k) => [k, structuredClone(this.map.get(k))])); }
}
class FakeState { constructor(s) { this.storage = s; this.lock = Promise.resolve(); } blockConcurrencyWhile(fn) { const r = this.lock.then(fn); this.lock = r.then(() => {}, () => {}); return r; } }
function makeEnv(DO) {
  const instances = new Map();
  const env = { ADMIN_TOKEN: 'pw', LEADERBOARD_DO: { idFromName: (n) => n, _instances: instances, get(id) {
    if (!instances.has(id)) instances.set(id, new DO(new FakeState(new FakeStorage()), env));   // "backups" calls "global" from inside its own request
    const o = instances.get(id);
    return { fetch: (url, init) => o.fetch(new Request(url, init)) }; } } };
  return env;
}
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0) + 1000;   // one second into a minute: windows are predictable

async function suite({ gameHtml, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, DO = workerMod.LeaderboardDO;
  let clock = T0; const realNow = Date.now; Date.now = () => clock;
  const realErr = console.error; console.error = () => {};
  const mk = () => {
    const env = makeEnv(DO);
    const call = async (p, body, headers = {}) => {
      const res = await worker.fetch(new Request(ORIGIN + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }), env, {});
      let d = null; try { d = await res.json(); } catch (e) {}
      return { status: res.status, data: d, retryAfter: res.headers.get('Retry-After') };
    };
    const submit = (id, score, extra = {}, ip = null) => call('/api/submit-score', { playerId: id, name: 'NOVA', score, level: levelFor(score, 'medium'), difficulty: 'medium', country: 'US', season: 1, ...extra }, ip ? { 'CF-Connecting-IP': ip } : {});
    const events = (pid, bid, n = 1, ip = null) => call('/api/events', { pid, bid, country: 'PH', src: 'direct', events: Array.from({ length: n }, () => ({ e: 'share' })) }, ip ? { 'CF-Connecting-IP': ip } : {});
    const inst = (n) => env.LEADERBOARD_DO._instances.get(n);
    const stor = (n) => (inst(n) ? inst(n).state.storage.map : new Map());
    return { env, call, submit, events, inst, stor };
  };
  const shares = async (S) => { const d = Math.floor(clock / 86400000); const day = S.stor('analytics').get('an:day:' + d); return day && day.all ? (day.all.shares || 0) : 0; };
  const strip = (d) => { const o = { ...(d || {}) }; delete o.duplicate; return JSON.stringify(o); };

  try {
    if (!quiet) console.log('== replay protection: scores ==');
    const S = mk();
    const first = await S.submit(P(1), 3000, { runId: RID(1) });
    const rec1 = structuredClone(S.stor('global').get('players')[P(1)]);
    const cnt1 = structuredClone(S.stor('global').get('countries'));
    const last1 = structuredClone(S.stor('global').get('lastSubmit'));
    clock += 2000;                                                   // inside the 10 s cooldown
    const again = await S.submit(P(1), 3000, { runId: RID(1) });
    ck('R1 a repeated run id gets the same success reply (marked duplicate), not a 429', first.status === 200 && again.status === 200 && again.data.duplicate === true && strip(again.data) === strip(first.data) && first.data.isNewBest === true, again.status + ' ' + JSON.stringify(again.data));
    const cheat = await S.submit(P(1), 9000, { runId: RID(1), country: 'JP', name: 'OTHER' });
    const rec2 = S.stor('global').get('players')[P(1)];
    ck('R1 ...and changes nothing: best, country, name, date, country totals, cooldown (even with another score/country)', cheat.status === 200 && cheat.data.duplicate === true && cheat.data.best === 3000 && cheat.data.country === 'US'
      && JSON.stringify(rec2) === JSON.stringify(rec1) && JSON.stringify(S.stor('global').get('countries')) === JSON.stringify(cnt1) && JSON.stringify(S.stor('global').get('lastSubmit')) === JSON.stringify(last1), JSON.stringify(cheat.data));
    const runs1 = String(S.stor('global').get(Object.keys(Object.fromEntries(S.stor('global'))).find((k) => k.startsWith('runs:'))) || '');
    ck('R1 the run id is remembered once', runs1.split(',').filter(Boolean).length === 1, runs1);

    clock += 11000;
    const next = await S.submit(P(1), 4000, { runId: RID(2) });
    ck('R3 a new run with a new id is judged normally (a higher score is a new best)', next.status === 200 && !next.data.duplicate && next.data.isNewBest === true && next.data.best === 4000, JSON.stringify(next.data));
    clock += 2000;
    const fast = await S.submit(P(1), 5000, { runId: RID(3) });
    ck('R3 ...and the 10 s cooldown still applies to new runs (429 + Retry-After)', fast.status === 429 && Number(fast.retryAfter) >= 1, fast.status);
    clock += 11000;
    const old = await S.submit(P(2), 2600);
    ck('R4 an upload without a run id (a page from before run ids) is still accepted under the existing rules', old.status === 200 && old.data.ok === true && old.data.isNewBest === true, old.status);
    clock += 3000;
    const old2 = await S.submit(P(2), 2700);
    const bad = await S.submit(P(3), 2600, { runId: 'x' });
    ck('R4 ...with the cooldown; a malformed run id is treated like none', old2.status === 429 && bad.status === 200, old2.status + '/' + bad.status);

    if (!quiet) console.log('== replay protection: stats batches ==');
    clock += 61000;
    const b0 = await shares(S);
    await S.events('pilot-1', 'batch-000001', 3);
    const b1 = await shares(S);
    const dup = await S.events('pilot-1', 'batch-000001', 3);
    const b2 = await shares(S);
    await S.events('pilot-1', 'batch-000002', 3);
    const b3 = await shares(S);
    ck('R5 a repeated batch id is counted once; a new batch counts', b1 - b0 === 3 && b2 === b1 && b3 - b2 === 3 && dup.status === 200, [b0, b1, b2, b3].join(','));
    for (let i = 0; i < 50; i++) { if (i % 15 === 14) clock += 61000; await S.events('pilot-2', 'many-' + String(i).padStart(6, '0'), 1); }
    const pRec = [...S.stor('analytics').entries()].filter(([k]) => k.startsWith('an:p:')).map(([, v]) => v).find((v) => Array.isArray(v.b) && v.b.some((x) => x.startsWith('many-')));
    ck('R5 the batch ids kept per pilot are bounded (32)', pRec && pRec.b.length === 32, pRec && pRec.b.length);
    const oldEv = await S.events('pilot-3', undefined, 2);
    ck('R5 a batch without an id (older page) is still counted', oldEv.status === 200 && oldEv.data.ok === true);

    if (!quiet) console.log('== rate limits ==');
    clock = T0 + 3600000;
    const L = mk();
    const r60 = []; for (let i = 0; i < 60; i++) r60.push((await L.submit(P(100 + i), 2600, { runId: RID(100 + i) }, IP_A)).status);
    const over = await L.submit(P(200), 2600, { runId: RID(200) }, IP_A);
    const other = await L.submit(P(201), 2600, { runId: RID(201) }, IP_B);
    ck('R6 60 uploads a minute from one address pass; the 61st gets 429 with Retry-After', r60.every((s) => s === 200) && over.status === 429 && Number(over.retryAfter) >= 1 && Number(over.retryAfter) <= 60 && over.data.retryAfterSec === Number(over.retryAfter), r60.filter((s) => s !== 200).length + ' refused; ' + over.status + ' RA=' + over.retryAfter);
    ck('R6 ...another address is not affected', other.status === 200, other.status);
    clock += 60000;
    const after = await L.submit(P(200), 2600, { runId: RID(200) }, IP_A);
    ck('R6 ...and the address is served again after the window', after.status === 200, after.status);

    clock = T0 + 7200000;
    const M = mk(); const pr = [];
    for (let i = 0; i < 30; i++) { pr.push((await M.submit(P(300), 2600 + i, { runId: RID(300 + i) })).status); clock += 300; }
    const pOver = await M.submit(P(300), 2700, { runId: RID(399) });
    ck('R7 one pilot hammering: 30 tries a minute are answered (cooldown), then 429 + Retry-After from the limiter', pr[0] === 200 && pr.slice(1).every((s) => s === 429) && pOver.status === 429 && pOver.data.rateLimited === true && Number(pOver.retryAfter) >= 1, pOver.status + ' ' + JSON.stringify(pOver.data));
    clock += 60000;
    const pAfter = await M.submit(P(300), 2800, { runId: RID(398) });
    ck('R7 ...and the pilot is served again after the window', pAfter.status === 200, pAfter.status);

    clock = T0 + 3 * 3600000;
    const E = mk(); const er = [];
    for (let i = 0; i < 120; i++) er.push((await E.events('ev-' + i, 'eb-' + String(i).padStart(6, '0'), 1, IP_A)).status);
    const eOver = await E.events('ev-x', 'eb-xxxxxx', 1, IP_A);
    const ep = []; for (let i = 0; i < 20; i++) ep.push((await E.events('ev-solo', 'es-' + String(i).padStart(6, '0'), 1, IP_B)).status);
    const epOver = await E.events('ev-solo', 'es-xxxxxx', 1, IP_B);
    ck('R8 stats: 120 batches a minute per address and 20 per pilot pass, then 429 + Retry-After', er.every((s) => s === 200) && eOver.status === 429 && Number(eOver.retryAfter) >= 1 && ep.every((s) => s === 200) && epOver.status === 429, eOver.status + '/' + epOver.status);
    const rr = []; for (let i = 0; i < 30; i++) rr.push((await E.call('/api/restore-check', { playerId: P(500 + i) }, { 'CF-Connecting-IP': IP_A })).status);
    const rOver = await E.call('/api/restore-check', { playerId: P(599) }, { 'CF-Connecting-IP': IP_A });
    ck('R8 restore check: 30 a minute per address, then 429 + Retry-After (never cached)', rr.every((s) => s === 200) && rOver.status === 429 && Number(rOver.retryAfter) >= 1, rOver.status);
    const ar = []; for (let i = 0; i < 30; i++) ar.push((await E.call('/api/admin/find-player', { query: 'X' }, { 'CF-Connecting-IP': IP6, 'x-admin-token': i % 2 ? 'pw' : 'wrong' })).status);
    const aOver = await E.call('/api/admin/find-player', { query: 'X' }, { 'CF-Connecting-IP': IP6, ...H });
    const aOther = await E.call('/api/admin/find-player', { query: 'X' }, { 'CF-Connecting-IP': IP_B, ...H });
    ck('R8 admin: 30 a minute per address (wrong passwords count too), then 429; another address still works', ar.every((s) => s === 200 || s === 401) && aOver.status === 429 && Number(aOver.retryAfter) >= 1 && aOther.status === 200, aOver.status + '/' + aOther.status);
    clock += 60000;
    const aAfter = await E.call('/api/admin/find-player', { query: 'X' }, { 'CF-Connecting-IP': IP6, ...H });
    ck('R8 admin is served again after the window', aAfter.status === 200, aAfter.status);

    if (!quiet) console.log('== a school on one Wi-Fi ==');
    clock = T0 + 4 * 3600000;
    const W = mk(); const ws = [];
    for (let minute = 0; minute < 3; minute++) {
      for (let k = 0; k < 30; k++) {
        ws.push((await W.submit(P(700 + k), 2600 + minute * 100, { runId: RID(700 + k * 10 + minute) }, IP_A)).status);
        ws.push((await W.events('kid-' + k, 'kb-' + k + '-' + minute + '-a-batch', 2, IP_A)).status);
        ws.push((await W.events('kid-' + k, 'kb-' + k + '-' + minute + '-b-batch', 1, IP_A)).status);
        if (k % 3 === 0) ws.push((await W.submit(P(700 + k), 2600 + minute * 100, { runId: RID(700 + k * 10 + minute) }, IP_A)).status);   // a third retry after a lost reply
      }
      clock += 60000;
    }
    ck('R9 30 pilots behind one address, each ending a run a minute (a third also retrying it) and sending stats: never limited', ws.every((s) => s === 200), ws.filter((s) => s !== 200).length + ' refused of ' + ws.length);

    if (!quiet) console.log('== counters expire, no raw address ==');
    clock = T0 + 5 * 3600000;
    const X = mk();
    await X.call('/api/restore-check', { playerId: P(1) });   // the object loads (its own one-time writes happen here)
    const keys0 = X.stor('global').size;
    for (let i = 0; i < 300; i++) await X.call('/api/restore-check', { playerId: P(900 + i) }, { 'CF-Connecting-IP': '10.0.' + (i >> 8) + '.' + (i & 255) });
    const g = X.inst('global'); const rlSize = g.rl ? g.rl.size : -1;
    const keys1 = X.stor('global').size; const puts1 = g.state.storage.puts;
    clock += 61000;
    await X.call('/api/restore-check', { playerId: P(1) }, { 'CF-Connecting-IP': IP_A });
    ck('R10 counters live in memory for one window and are swept after it', rlSize >= 300 && g.rl.size <= 2, rlSize + ' -> ' + g.rl.size);
    ck('R10 the limiter writes nothing to storage (no growth from 300 addresses)', keys1 === keys0 && puts1 === g.state.storage.puts, keys0 + ' -> ' + keys1);
    const cap = new DO(new FakeState(new FakeStorage()));
    const capKeys = []; for (let i = 0; i < 50010; i++) capKeys.push({ k: 'i:t:' + i, max: 5 });
    for (const k of capKeys) cap.rateCheck([k], clock);
    ck('R10 the counters are capped in memory (50,000)', cap.rl.size === 50000, cap.rl.size);
    const everything = JSON.stringify([...X.env.LEADERBOARD_DO._instances.values(), ...L.env.LEADERBOARD_DO._instances.values(), ...E.env.LEADERBOARD_DO._instances.values(), ...W.env.LEADERBOARD_DO._instances.values()]
      .map((o) => [[...o.state.storage.map.entries()], [...(o.rl ? o.rl.keys() : [])]]));
    ck('R11 no raw IP address in storage or counters (IPv4 and IPv6)', !everything.includes(IP_A) && !everything.includes(IP_B) && !everything.includes(IP6) && !everything.includes('10.0.1.') && everything.includes('i:submit:'), everything.length);

    if (!quiet) console.log('== bounded run ids ==');
    clock = T0 + 6 * 3600000;
    const B = mk();
    for (let i = 0; i < 205; i++) { await B.submit(P(42), 2600 + i, { runId: RID(4200 + i) }); clock += 11000; }
    const rk = [...B.stor('global').keys()].find((k) => k.startsWith('runs:'));
    const rv = String(B.stor('global').get(rk) || '');
    ck('R12 at most 200 run ids per pilot, newest kept, compact (under 8 KB), keyed by the public hash', rv.split(',').length === 200 && rv.includes(RID(4404).slice(0, 24)) && !rv.includes(RID(4204).slice(0, 24)) && rv.includes(RID(4205).slice(0, 24)) && rv.length < 8192 && /^runs:[0-9a-f]{16}$/.test(rk) && !rk.includes(P(42)), rv.split(',').length + ' / ' + rv.length + ' B');
    const oldReplay = await B.submit(P(42), 2804, { runId: RID(4404) });
    clock += 8 * 86400000;
    await B.submit(P(42), 9000, { runId: RID(9999) });
    const rv2 = String(B.stor('global').get(rk) || '');
    ck('R12 run ids older than 7 days are dropped', oldReplay.data.duplicate === true && rv2.split(',').length === 1, rv2.split(',').length);
    const find = await B.call('/api/admin/find-player', { query: 'NOVA' }, H);
    const pid = find.data && find.data.matches && find.data.matches[0] && find.data.matches[0].pid;
    const bk = await B.call('/api/admin/backup-now', {}, H);
    const bid = bk.data && bk.data.snapshot && bk.data.snapshot.id;
    const dl1 = await B.call('/api/admin/backup-download', { id: bid }, H);
    const inBackup = (d) => !!(d && d.snapshot && Array.isArray(d.snapshot.entries) && d.snapshot.entries.some((e) => e[0] === rk));
    ck('R13 backups copy the run ids with the scores (a restore brings them back together)', bk.status === 200 && inBackup(dl1.data), bk.status + '/' + dl1.status);
    const del = await B.call('/api/admin/privacy-delete', { pid }, H);
    ck('R13 a privacy deletion erases the pilot\'s run ids', del.status === 200 && ![...B.stor('global').keys()].some((k) => k.startsWith('runs:')), del.status);
    const dl2 = await B.call('/api/admin/backup-download', { id: bid }, H);
    ck('R13 ...from every backup copy too', dl2.status === 200 && dl2.data.snapshot && !inBackup(dl2.data) && del.data.backups && del.data.backups.ok === true, dl2.status + ' ' + JSON.stringify(del.data && del.data.backups));
  } catch (e) { ck('server section ran', false, String(e.stack || e).slice(0, 400)); }
  finally { console.error = realErr; }

  /* ================= client ================= */
  const GAME = scriptsOf(gameHtml);
  const keep = { fluxPlayerId: P(77), fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxSeason: '1', fluxRunsPlayed: '3', fluxWelcomeDone: '1' };
  const tick = () => new Promise((r) => setTimeout(r, 1));
  const drain = async () => { for (let i = 0; i < 8; i++) await tick(); };
  const bootGame = (init, fetchImpl) => {
    const { store, mem } = makeStore(init);
    const posts = [], timers = [];
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, fetchImpl: (u, o = {}) => {
      if (String(u).includes('submit-score')) { posts.push(JSON.parse(o.body)); return fetchImpl(u, o, mem); }
      return Promise.resolve(new Response('{"skus":[]}', { status: 200 })); } });
    g.win.setTimeout = (fn, ms) => { timers.push(ms); return timers.length; };
    const run = (c) => vm.runInContext(c, g.ctx);
    return { g, mem, posts, timers, run, queue: () => JSON.parse(mem.fluxPendingSubmits || '[]') };
  };
  try {
    if (!quiet) console.log('== client ==');
    clock = T0 + 7 * 3600000;
    // C2 + R2: the server accepts, the reply is lost; the retry sends the same run id and is counted once.
    const S = mk(); let drop = true;
    const c = bootGame(keep, async (u, o) => {
      const res = await worker.fetch(new Request(ORIGIN + '/api/submit-score', { method: 'POST', headers: o.headers, body: o.body }), S.env, {});
      if (drop) { drop = false; throw new TypeError('network connection was lost'); }
      return res;
    });
    let rv = 0; c.g.win.crypto.getRandomValues = (a) => { rv++; for (let i = 0; i < a.length; i++) a[i] = (i * 37 + rv * 11) & 255; return a; };
    c.run("difficulty='medium'; recordBestRun(2600, 2);"); await c.run('submitScore()'); await drain();
    const q1 = c.queue();
    ck('C1 the upload carries a random run id from crypto.getRandomValues (32 hex), kept with the queued item', rv >= 1 && /^[0-9a-f]{32}$/.test((c.posts[0] || {}).runId || '') && q1.length === 1 && q1[0].runId === c.posts[0].runId, JSON.stringify(c.posts[0]));
    clock += 3000;                                                   // the retry comes back inside the cooldown
    await c.run('flushSubmitQueue()'); await drain();
    const players = S.stor('global').get('players') || {};
    const runsKey = [...S.stor('global').keys()].find((k) => k.startsWith('runs:'));
    ck('C2 the retry sends the same run id', c.posts.length === 2 && c.posts[1].runId === c.posts[0].runId, c.posts.map((p) => p.runId).join(' / '));
    ck('R2 a retry after a lost reply succeeds once: queue empty, one best, one remembered run, no error left', c.queue().length === 0 && players[P(77)] && players[P(77)].bests.medium.score === 2600 && String(S.stor('global').get(runsKey)).split(',').length === 1 && !('fluxLastSubmitError' in c.mem), c.queue().length + ' queued');
    clock += 11000;
    c.run("recordBestRun(3100, 2);"); await c.run('submitScore()'); await drain();
    ck('C2 a new run gets a new run id and is accepted normally', c.posts.length === 3 && c.posts[2].runId !== c.posts[0].runId && /^[0-9a-f]{32}$/.test(c.posts[2].runId) && S.stor('global').get('players')[P(77)].bests.medium.score === 3100);

    // C3: a 429 keeps the upload, with its run id, and waits at least Retry-After.
    const t = bootGame(keep, async () => ({ ok: false, status: 429, headers: { get: (h) => (/retry-after/i.test(h) ? '45' : null) }, json: async () => ({ error: 'Too many requests' }) }));
    t.run("difficulty='medium'; recordBestRun(2600, 2);"); await t.run('submitScore()'); await drain();
    await t.run('flushSubmitQueue()'); await drain();
    const tq = t.queue();
    ck('C3 a 429 keeps the upload queued with the same run id (never dropped, no rejection recorded)', tq.length === 1 && t.posts.length === 2 && t.posts[0].runId === t.posts[1].runId && tq[0].runId === t.posts[0].runId && !/rejected/.test(t.mem.fluxLastSubmitError || ''), tq.length + ' queued, ' + (t.mem.fluxLastSubmitError || ''));
    ck('C3 ...and the next try waits at least Retry-After (45 s)', t.timers.some((ms) => ms >= 45000), t.timers.join(','));

    // C4: an item queued by an older page (no run id) gets one once, saved before it is sent, reused on retry.
    const legacy = [{ id: P(77) + ':medium:2600:2', playerId: P(77), name: 'TITAN', score: 2600, level: 2, difficulty: 'medium', season: 1, at: 1, attempts: 0 }];
    const seenInStore = [];
    const l = bootGame({ ...keep, fluxPendingSubmits: JSON.stringify(legacy) }, async (u, o, mem) => { seenInStore.push((JSON.parse(mem.fluxPendingSubmits || '[]')[0] || {}).runId); throw new TypeError('offline'); });
    await l.run('flushSubmitQueue()'); await drain(); await l.run('flushSubmitQueue()'); await drain();
    ck('C4 an upload queued by an older page gets a run id, saved before sending, reused on the retry', l.posts.length >= 2 && /^[0-9a-f]{32}$/.test(l.posts[0].runId || '') && l.posts.every((p) => p.runId === l.posts[0].runId) && seenInStore.length === l.posts.length && seenInStore.every((r) => r === l.posts[0].runId) && l.queue()[0].runId === l.posts[0].runId, JSON.stringify(l.posts.map((p) => p.runId)));

    // C5: stats batches.
    const s = bootGame(keep, async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const beacons = []; s.g.win.navigator.sendBeacon = (u, b) => { beacons.push(JSON.parse(b.parts[0])); return true; };
    s.g.win.Blob = class { constructor(parts) { this.parts = parts; } };
    s.run("fluxTrack('share'); fluxStatsFlush(); fluxTrack('share'); fluxStatsFlush();");
    ck('C5 every stats batch carries its own batch id', beacons.length === 2 && beacons.every((b) => /^[0-9a-f]{32}$/.test(b.bid || '')) && beacons[0].bid !== beacons[1].bid, JSON.stringify(beacons.map((b) => b.bid)));
    ck('C5 no new event listener (addEventListener( stays at 17)', (gameHtml.match(/addEventListener\(/g) || []).length === 17);
  } catch (e) { ck('client section ran', false, String(e.stack || e).slice(0, 400)); }
  finally { Date.now = realNow; }
  return { F, failed };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ gameHtml: GAME_HTML, workerMod: realMod });

console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { game = (s) => s, worker = (s) => s }) {
  const g2 = game(GAME_HTML), w2 = worker(WORKER_SRC);
  if (g2 === GAME_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-rr-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ gameHtml: g2, workerMod: mod, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('repeated run id not recognised', 'R1 a repeated run id', { worker: rep('if (seen && ownGet(this.players, playerId)) return', 'if (false) return') });
await control('run id not remembered', 'R1', { worker: rep('    if (runId) {                         // stored in the SAME write', '    if (false) {                         // stored in the SAME write') });
await control('replay checked after the cooldown', 'R2', { worker: (s) => rep('    if (seen && ownGet(this.players, playerId)) return', '    if (now - (ownGet(this.lastSubmit, playerId) || 0) < SUBMIT_COOLDOWN_MS) return json({ error: "Slow down" }, 429, { "Retry-After": "10" });\n    if (seen && ownGet(this.players, playerId)) return')(s) });
await control('run id required too early (old pages refused)', 'R4', { worker: rep('const RUN_ID_REQUIRED = false;', 'const RUN_ID_REQUIRED = true;') });
await control('stats batch id ignored', 'R5 a repeated batch id', { worker: rep('if (bid && Array.isArray(p.b) && p.b.includes(bid)) return', 'if (false) return') });
await control('stats batch ids unbounded', 'R5 the batch ids kept', { worker: rep('.concat([bid]).slice(-AN_BATCH_IDS_MAX);', '.concat([bid]);') });
await control('no per-address upload limit', 'R6', { worker: rep('submit:  { ip: 60,  player: 30 },', 'submit:  { ip: 6000,  player: 30 },') });
await control('429 without Retry-After', 'R6', { worker: rep('429, { "Retry-After": String(sec) });', '429);') });
await control('windows never reset', 'R6 ...and the address is served again', { worker: rep('const w = Math.floor(now / RL_WINDOW_MS) * RL_WINDOW_MS;', 'const w = 0;') });
await control('no per-pilot upload limit', 'R7', { worker: rep('submit:  { ip: 60,  player: 30 },', 'submit:  { ip: 60 },') });
// FLUX COMMAND: the admin limit now runs once, first, for every /api/admin/* POST (login included).
await control('admin not limited', 'R8 admin', { worker: rep('          const limited = await adminRateLimit(request, env);\n          if (limited) return adminOut(limited);\n', '') });
await control('restore check not limited', 'R8 restore', { worker: rep('const limited = await rateLimit(env, "global", "restore", request, await pidHash(playerId));', 'const limited = null;') });
await control('per-address limit too tight for a school', 'R9', { worker: rep('submit:  { ip: 60,  player: 30 },', 'submit:  { ip: 20,  player: 30 },') });
await control('counters never swept', 'R10 counters live', { worker: rep('for (const [k, e] of rl) if (e.w !== w) rl.delete(k);', '') });
await control('counters uncapped', 'R10 the counters are capped', { worker: rep('while (rl.size > RL_MAX_KEYS) rl.delete(rl.keys().next().value);', '') });
await control('raw IP used as the key', 'R11', { worker: rep('if (!ip) return null;                  // Cloudflare', 'if (ip) return ip;                  // Cloudflare') });
await control('run ids unbounded', 'R12 at most 200', { worker: rep('runs.concat([entry]).slice(-RUN_IDS_MAX).join(",")', 'runs.concat([entry]).join(",")') });
await control('run ids never age out', 'R12 run ids older', { worker: rep('.filter((e) => parseInt(e.split(".")[1], 36) >= cut);', ';') });
await control('privacy deletion keeps run ids', 'R13 a privacy deletion erases', { worker: rep('await this.state.storage.delete("runs:" + pid);', '{}') });
await control('upload sent without its run id', 'C1', { game: rep('        runId:item.runId,\n', '') });
await control('run id from Math.random only', 'C1', { game: rep('const u=new Uint8Array(16); crypto.getRandomValues(u); for(let i=0;i<u.length;i++) a.push(u[i]);', 'for(let i=0;i<16;i++) a.push(Math.floor(Math.random()*256));') });
await control('new run id on every retry', 'C2 the retry', { game: rep('        runId:item.runId,\n', '        runId:fluxRandomId(),\n') });
await control('429 drops the upload', 'C3', { game: rep("if(res.status===429||res.status>=500){", "if(res.status===429) return { kind:'permanent' };\n  if(res.status>=500){") });
await control('Retry-After ignored', 'C3 ...and the next', { game: rep("if(ra && isFinite(+ra)) waitMs=(+ra)*1000;", '') });
await control('older queued item not given a saved run id', 'C4', { game: rep('if(ci>=0){ cq[ci].runId=item.runId; saveQueue(cq); }', '') });
await control('stats batch without an id', 'C5 every stats batch', { game: rep('bid:fluxRandomId(),', '') });
const total = main.F + NC;
console.log('\n' + (total ? 'RATE/REPLAY FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'RATE/REPLAY PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
