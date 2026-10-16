// EVERY RUN COUNTS (owner switch in FLUX COMMAND, default OFF): every accepted run gives a share of
// its points to the pilot's country. In the release gate. REAL worker.js on a fake Durable Object
// runtime (real SQLite, counted rows, as tests/test-storage-fix.mjs), compared with origin/main's.
//   E1 OFF (the default): every board, World Grid, run reply, entitlements answer and stored value,
//      and the rows read and written, equal main's;
//   E2 the switch: owner login only; ON needs the typed "EVERY RUN ON" and a checked backup from the
//      last 60 minutes, new storage layout only; OFF is immediate; logged; survives a restart;
//      nothing is counted backwards;
//   E3 ON: each accepted run gives floor(points x difficulty weight x 10%) to its pilot's country;
//      World Grid total = main's total (same runs) + contributions; sorted again; every pilot board,
//      pilot count, top score and leader is main's; the run reply is main's + a "cg" part; restricted
//      pilots give nothing; stored on its own ("cg:tot", "cg:p:<public pid>"); OFF again = main's at
//      once (kept, not shown); ON again brings it back;
//   E4 the daily cap: at most 1,000 a day per pilot (UTC days), a capped run writes nothing new;
//   E5 replays never count twice; refused runs (cooldown, ceiling, level) give nothing; no run id or
//      no country gives nothing; a privacy deletion removes the pilot's own numbers;
//   E6 free plan: a giving run writes exactly 2 rows more than today's upload, a capped run none;
//   E7 the game: OFF uploads as today; ON uploads the run's own score with its stats (one request),
//      shows "🇵🇭 +N for Philippines" at game over and the total in the menu; a reply without the
//      share puts it back to normal; no new button, fetch, timer or per-frame work;
//   E8 FLUX COMMAND section + guide.
// Ends with negative controls: each defect re-inserted MUST be caught.
import fs from 'fs'; import path from 'path'; import util from 'util'; import v8 from 'v8'; import vm from 'vm'; import nodeCrypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { levelFor } from './level-rule.mjs';
process.removeAllListeners('warning');   // node:sqlite is "experimental" on this Node
const { DatabaseSync } = await import('node:sqlite');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');
const T0 = Date.UTC(2026, 9, 5, 9, 0);

/* ---------------- fake Durable Object runtime (as tests/test-storage-fix.mjs) ---------------- */
function pidHashSync(id) { return nodeCrypto.createHash('sha256').update('flux-pid:' + id).digest().subarray(0, 8).toString('hex'); }
function tagFromPid(pidHex, len) {
  const a = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let bits = '', out = '';
  for (const ch of String(pidHex)) bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  for (let i = 0; i + 5 <= bits.length && out.length < len; i += 5) out += a[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
class FakeSql {
  constructor(meter) { this.db = new DatabaseSync(':memory:'); this.m = meter; this.stmts = new Map(); this.plans = new Map(); }
  stmt(q) { let s = this.stmts.get(q); if (!s) { s = this.db.prepare(q); this.stmts.set(q, s); } return s; }
  count(t) { try { return this.db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; } catch (e) { return 0; } }
  scanPenalty(q, args) {
    if (!/^\s*SELECT/i.test(q) || /\bLIMIT\b/i.test(q)) return 0;
    let plan = this.plans.get(q);
    if (!plan) { try { plan = this.db.prepare('EXPLAIN QUERY PLAN ' + q).all(...args).map((r) => r.detail); } catch (e) { plan = []; } this.plans.set(q, plan); }
    let p = 0; for (const d of plan) { const m = /^SCAN (\w+)/.exec(d); if (m) p += this.count(m[1]); }
    return p;
  }
  idxFactor(q) {
    if (!/\bpilots\b/.test(q)) return 0;
    if (/^\s*(INSERT|REPLACE|DELETE)/i.test(q)) return 3;
    const m = /SET (.*) WHERE/i.exec(q); if (!m) return 0;
    let f = 0; for (const re of [/\be_[st]\b/, /\bm_[st]\b/, /\bh_[st]\b/, /\bt12\b/]) if (re.test(m[1])) f++;
    if (/\brs\b/.test(m[1])) f += 2;
    return f;
  }
  exec(q, ...args) {
    args = args.map((a) => (a === undefined ? null : a));
    const write = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q);
    const before = write ? this.db.prepare('SELECT total_changes() AS c').get().c : 0;
    const rows = this.stmt(q).all(...args).map((r) => ({ ...r }));
    let rowsRead = 0, rowsWritten = 0;
    if (write) { const ch = this.db.prepare('SELECT total_changes() AS c').get().c - before; rowsWritten = ch * (1 + this.idxFactor(q)); rowsRead = ch; }
    else rowsRead = rows.length + this.scanPenalty(q, args);
    this.m.read += rowsRead; this.m.written += rowsWritten;
    return { toArray: () => rows, one: () => rows[0], rowsRead, rowsWritten, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  }
  tables() { return this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name); }
  dump(t) { try { return this.db.prepare('SELECT * FROM ' + t + ' ORDER BY ' + (t === 'pilots' ? 'seq' : 'id')).all().map((r) => ({ ...r })); } catch (e) { return null; } }
}
class FakeStorage {
  constructor(map, { limit = 2 * 1024 * 1024 } = {}) { this.map = map || new Map(); this.limit = limit; this.meter = { read: 0, written: 0 }; this.sql = new FakeSql(this.meter); }
  async get(k) { this.meter.read++; return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v };
    const keys = Object.keys(obj);
    if (keys.length > 128) throw new Error('put: more than 128 keys');
    for (const kk of keys) { const n = v8.serialize(obj[kk]).length; if (n > this.limit) throw new Error('put: value over the limit (' + kk + ')'); }
    this.meter.written += keys.length;
    for (const kk of keys) this.map.set(kk, structuredClone(obj[kk]));
  }
  async delete(k) { const ks = [].concat(k); this.meter.written += ks.length; for (const x of ks) this.map.delete(x); }
  async list(o = {}) {
    let keys = [...this.map.keys()].sort();
    if (o.prefix) keys = keys.filter((k) => k.startsWith(o.prefix));
    if (o.startAfter !== undefined) keys = keys.filter((k) => k > o.startAfter);
    if (o.limit) keys = keys.slice(0, o.limit);
    this.meter.read += keys.length;
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async transaction(fn) { const before = new Map(this.map); try { return await fn(this); } catch (e) { this.map = before; throw e; } }
  transactionSync(fn) {
    this.sql.db.exec('BEGIN');
    try { const r = fn(); this.sql.db.exec('COMMIT'); return r; } catch (e) { this.sql.db.exec('ROLLBACK'); throw e; }
  }
}
class FakeState {
  constructor(storage) { this.storage = storage; this.lock = Promise.resolve(); }
  blockConcurrencyWhile(fn) { const r = this.lock.then(fn); this.lock = r.then(() => {}, () => {}); return r; }
}
function makeEnv(mod, g) {
  const inst = new Map();
  const env = { ADMIN_TOKEN: 'pw', _g: g, _b: new FakeStorage(new Map(), { limit: 128 * 1024 }) };
  env.LEADERBOARD_DO = { idFromName: (n) => n, get(id) {
    if (!inst.has(id)) { const st = new FakeState(id === 'global' ? env._g : id === 'backups' ? env._b : new FakeStorage()); inst.set(id, { st, o: new mod.LeaderboardDO(st, env) }); }
    const x = inst.get(id);
    return { fetch: async (url, init) => { await x.st.lock; return x.o.fetch(new Request(url, init)); } }; } };
  env.restart = () => inst.clear();
  return env;
}
/* A leaderboard on the new storage layout (as production): n pilots created in order (seq = i). */
function newStorage() { return new FakeStorage(new Map([['storageLayout', 'v2'], ['season', 1], ['nameRulesV1', 1]])); }
function recFor(i) { const s = 1000 + ((i * 7919) % 40000); return { playerId: P(i), name: 'PILOT' + i, country: ['US', 'PH', 'JP', 'DE'][i % 4], updatedAt: T0 + i, bests: { medium: { score: s, level: 2, updatedAt: T0 + i } } }; }
const snapshot = (g) => ({ kv: structuredClone(g.map), sql: Object.fromEntries(g.sql.tables().map((t) => [t, g.sql.dump(t)])) });


/* ---------------- the suite ---------------- */
const W = { easy: 0.09, medium: 0.21, hard: 1 };
const give = (score, d) => Math.floor(score * W[d] * 0.10 + 1e-9);
let RUN = 0; const rid = () => 'run' + String(++RUN).padStart(13, '0') + 'x';

async function suite({ mod, main, game = GAME_HTML, adminHtml = ADMIN_HTML, quiet = false, parts = null }) {
  let F = 0; const failed = [], report = {};
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const say = (t) => { if (!quiet) console.log(t); };
  const on = (p) => !parts || parts.includes(p);
  const realNow = Date.now; let now = T0; Date.now = () => now;
  const realErr = console.error; console.error = () => {};
  const mk = (m, g) => {
    const env = makeEnv(m, g), worker = m.default;
    const req = async (p, body, headers = {}, method = 'POST') => {
      now += 1100;   // under every per-minute limit
      const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, {});
      const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: res.status, data, text };
    };
    const admin = (route, body) => { now += 2100; return req('/api/admin/' + route, body, H); };
    const doFetch = async (p, body) => { const r = await env.LEADERBOARD_DO.get('global').fetch('https://do.internal' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, data: await r.json().catch(() => null) }; };
    const seed = async (from, to) => { for (let i = from; i <= to; i += 400) await doFetch('/import', { records: Array.from({ length: Math.min(400, to - i + 1) }, (_, k) => recFor(i + k)) }); };
    // A finished run: the pilot's 10-second cooldown is respected (11 s later).
    const run = (id, score, o = {}) => { now += 11000; const d = o.d || 'medium';
      return req('/api/submit-score', { playerId: id, name: o.name || 'PILOT' + id.slice(-3), score, level: levelFor(score, d), difficulty: d, country: o.cc === undefined ? 'PH' : o.cc, season: 1, runId: o.runId || rid() }); };
    const lb = () => req('/api/leaderboard?limit=50&boards=1&v=' + now, null, {}, 'GET');
    const ent = (id) => req('/api/entitlements?playerId=' + encodeURIComponent(id), null, {}, 'GET');
    const meter = async (fn) => { const a = { ...g.meter }; const out = await fn(); return { out, read: g.meter.read - a.read, written: g.meter.written - a.written }; };
    return { env, req, admin, doFetch, seed, run, lb, ent, meter, g };
  };
  const pidOf = (i) => pidHashSync(P(i));
  const ctry = (lbData) => Object.fromEntries((lbData.countries || []).map((c) => [c.country, c.totalScore]));
  const order = (lbData) => (lbData.countries || []).map((c) => c.country).join(',');
  const turnOn = async (S) => { await S.admin('backup-now'); return S.admin('cg-switch', { on: true, confirm: 'EVERY RUN ON' }); };
  // The same steps on any build: pilots, a restricted pilot, runs on every planet.
  const steps = async (S, beforeRuns) => {
    await S.seed(1, 60);
    await S.admin('restrict', { pid: pidOf(3), reason: 'test' });
    if (beforeRuns) await beforeRuns(S);
    const out = [];
    out.push(await S.run(P(1), 900, { d: 'medium' }));     // below its best: no new best
    out.push(await S.run(P(2), 60000, { d: 'medium' }));   // a new best
    out.push(await S.run(P(4), 9000, { d: 'hard', cc: 'US' }));
    out.push(await S.run(P(5), 20000, { d: 'easy', cc: 'JP' }));
    out.push(await S.run(P(3), 5000, { d: 'medium' }));    // restricted
    out.push(await S.run(P(500), 4000, { d: 'medium' }));  // a brand-new pilot
    return out;
  };

  try {
    /* ================= E1 OFF: identical to main ================= */
    if (on('A') && main) {
      say('== E1 OFF (the default): identical to main ==');
      const runE1 = async (m) => {
        now = T0; RUN = 0;
        const S = mk(m, newStorage()), out = {}, cost = {};
        const lb0 = await S.lb(); out.lb0 = lb0.text;
        out.lbAll = (await S.req('/api/leaderboard?limit=25', null, {}, 'GET')).text;
        for (const d of ['easy', 'medium', 'hard']) out['lb:' + d] = (await S.req('/api/leaderboard?limit=25&difficulty=' + d, null, {}, 'GET')).text;
        const r = await steps(S); r.forEach((x, i) => { out['run' + i] = x.text; });
        out.lb1 = (await S.lb()).text;
        out.ent = (await S.ent(P(1))).text;
        let x = await S.meter(() => S.run(P(6), 1200)); cost.runNoBest = [x.read, x.written]; out.runNoBest = x.out.text;
        x = await S.meter(() => S.run(P(6), 80000)); cost.runBest = [x.read, x.written]; out.runBest = x.out.text;
        x = await S.meter(() => S.lb()); cost.lb = [x.read, x.written];
        S.env.restart();
        x = await S.meter(() => S.lb()); cost.cold = [x.read, x.written]; out.coldLb = x.out.text;
        out.state = JSON.stringify([...S.g.map.keys()].sort()) + JSON.stringify(S.g.sql.tables().map((t) => S.g.sql.dump(t)));
        return { out, cost };
      };
      const a = await runE1(main), b = await runE1(mod);
      const diff = Object.keys(a.out).filter((k) => a.out[k] !== b.out[k]);
      ck('E1 OFF: every board, World Grid, run reply, entitlements answer and stored value equals main\'s', diff.length === 0, diff.join(', ') || Object.keys(a.out).length + ' answers');
      ck('E1 OFF: rows read and written equal main\'s (a run with / without a best, the leaderboard, a cold start)', util.isDeepStrictEqual(a.cost, b.cost), JSON.stringify(b.cost) + ' vs ' + JSON.stringify(a.cost));
      report.costOff = b.cost;
    }

    /* ================= E2 the switch ================= */
    if (on('B')) {
      say('== E2 the switch (owner only, typed, backup first) ==');
      now = T0; RUN = 0;
      const S = mk(mod, newStorage());
      await S.seed(1, 20);
      const noAuth = [await S.req('/api/admin/cg-status', {}), await S.req('/api/admin/cg-switch', { on: true, confirm: 'EVERY RUN ON' })];
      ck('E2 both routes need the FLUX COMMAND login (401 without it)', noAuth.every((r) => r.status === 401), noAuth.map((r) => r.status).join(','));
      const st0 = await S.admin('cg-status');
      ck('E2 OFF by default; status shows the settings (10%, 1,000 a day)', st0.status === 200 && st0.data.on === false && st0.data.rate === 0.1 && st0.data.cap === 1000 && st0.data.layout === 'new', st0.text.slice(0, 160));
      const noTyped = await S.admin('cg-switch', { on: true, confirm: 'every run on' });
      ck('E2 ON is refused without the typed "EVERY RUN ON"', noTyped.status === 400 && /EVERY RUN ON/.test(noTyped.data.error) && (await S.admin('cg-status')).data.on === false, noTyped.text.slice(0, 120));
      const noBk = await S.admin('cg-switch', { on: true, confirm: 'EVERY RUN ON' });
      ck('E2 ON is refused without a verified backup from the last 60 minutes', noBk.status === 409 && noBk.data.needBackup === true && (await S.admin('cg-status')).data.on === false, noBk.text.slice(0, 120));
      await S.admin('backup-now'); now += 61 * 60 * 1000;
      const old = await S.admin('cg-switch', { on: true, confirm: 'EVERY RUN ON' });
      ck('E2 ...also when the newest backup is older than 60 minutes', old.status === 409 && old.data.needBackup === true, old.text.slice(0, 120));
      const r0 = await S.run(P(1), 5000);
      const sw = await turnOn(S);
      ck('E2 with a fresh backup and the phrase: ON, logged', sw.status === 200 && sw.data.on === true && sw.data.log[0].event === 'on' && sw.data.given === 0, sw.text.slice(0, 160));
      ck('E2 nothing is counted backwards (the run before ON gave nothing)', !r0.data.cg && sw.data.runs === 0);
      const oldS = mk(mod, new FakeStorage(new Map([['season', 1], ['nameRulesV1', 1]])));
      await oldS.admin('backup-now');
      const oldOn = await oldS.admin('cg-switch', { on: true, confirm: 'EVERY RUN ON' });
      ck('E2 the old storage layout refuses ON (new layout only, as Founding Pilot)', oldOn.status === 409 && /new storage layout/.test(oldOn.data.error), oldOn.text.slice(0, 120));
      const off = await S.admin('cg-switch', { on: false });
      ck('E2 OFF is immediate (no phrase, no backup) and logged', off.status === 200 && off.data.on === false && off.data.log[0].event === 'off');
      S.env.restart();
      const cold = await S.admin('cg-status');
      ck('E2 the switch survives a restart (kept in the summary row)', cold.data.on === false && cold.data.log.length === 2);
      await turnOn(S); S.env.restart();
      ck('E2 ...ON too', (await S.admin('cg-status')).data.on === true);
    }

    /* ================= E3 contributions add correctly ================= */
    if (on('C') && main) {
      say('== E3 ON: every accepted run gives its share ==');
      now = T0; RUN = 0;
      const M = mk(main, newStorage()); const mr = await steps(M); const mlb = (await M.lb()).data;
      now = T0; RUN = 0;
      const S = mk(mod, newStorage()); let swOn = null;
      const r = await steps(S, async (X) => { swOn = await turnOn(X); });
      const lbOn = (await S.lb()).data;
      const exp = { PH: give(900, 'medium') + give(60000, 'medium') + give(4000, 'medium'), US: Math.min(1000, give(9000, 'hard')), JP: give(20000, 'easy') };
      const adds = r.map((x) => x.data && x.data.cg ? x.data.cg.add : null);
      ck('E3 each run gives floor(points x difficulty weight x 10%): Medium 900 -> 18, Medium 60,000 -> 1,260 (capped at 1,000), Hard 9,000 -> 900, Easy 20,000 -> 180',
        swOn.status === 200 && adds[0] === 18 && adds[1] === 1000 && r[1].data.cg.capped === 1 && adds[2] === 900 && adds[3] === 180, JSON.stringify(adds));
      exp.PH = 18 + 1000 + give(4000, 'medium');
      ck('E3 a restricted pilot gives nothing (its run is accepted as today)', r[4].status === 200 && adds[4] === 0, r[4].text.slice(0, 120));
      ck('E3 a brand-new pilot gives from its first run', adds[5] === give(4000, 'medium') && adds[5] === 84, String(adds[5]));
      const base = ctry(mlb), withCg = ctry(lbOn), bad = [];
      for (const cc of Object.keys(base)) { const want = base[cc] + (exp[cc] || 0); if (Math.abs(withCg[cc] - want) > 1e-6) bad.push(cc + ' ' + withCg[cc] + ' vs ' + want); }
      ck('E3 World Grid total = today\'s total (main, same runs) + the country\'s contributions, for every country', bad.length === 0 && Object.keys(base).length === Object.keys(withCg).length, bad.join('; ') || JSON.stringify(exp));
      const sorted = (lbOn.countries || []).every((c, i, a) => i === 0 || a[i - 1].totalScore >= c.totalScore);
      ck('E3 the World Grid is sorted by the new totals and the leading country follows them', sorted && lbOn.leadingCountry && lbOn.leadingCountry.country === lbOn.countries[0].country && lbOn.cg && lbOn.cg.on === 1);
      const strip = (b) => JSON.stringify({ top: b.top, boards: b.boards, totals: b.totals });
      ck('E3 every pilot board (ALL, Easy, Medium, Hard) is exactly main\'s', strip(lbOn) === strip(mlb));
      const who = (b) => (b.countries || []).map((c) => [c.country, c.playerCount, c.topScore, c.topName, c.topTag].join('|')).sort().join(';');
      ck('E3 each country\'s pilots, top score and leader are main\'s (only the total grows)', who(lbOn) === who(mlb), who(lbOn));
      const replies = r.map((x, i) => { const a = JSON.parse(x.text), b = JSON.parse(mr[i].text); delete a.cg; return JSON.stringify(a) === JSON.stringify(b); });
      ck('E3 each run reply is main\'s plus one "cg" part (rank, best, tag unchanged)', replies.every(Boolean), replies.join(','));
      ck('E3 the reply says the country and the pilot\'s running total', r[2].data.cg.cc === 'US' && r[2].data.cg.total === 900 && r[2].data.cg.today === 900 && r[0].data.cg.cc === 'PH');
      const st = (await S.admin('cg-status')).data;
      ck('E3 FLUX COMMAND: given in all, runs counted, per country', st.given === exp.PH + exp.US + exp.JP && st.runs === 5 && st.countries[0].country === 'PH' && st.countries.find((c) => c.country === 'US').given === 900, JSON.stringify(st.countries));
      const kv = [...S.g.map.keys()].filter((k) => k.startsWith('cg:'));
      ck('E3 stored on its own: "cg:tot" + one "cg:p:<public pid>" per giving pilot, never the player ID',
        kv.includes('cg:tot') && kv.filter((k) => k.startsWith('cg:p:')).length === 5 && kv.every((k) => k === 'cg:tot' || /^cg:p:[0-9a-f]{16}$/.test(k)) && !JSON.stringify([...S.g.map.entries()].filter(([k]) => k.startsWith('cg:'))).includes(P(1)), kv.join(','));
      const ent = await S.ent(P(1));
      ck('E3 the entitlements answer at launch says ON (cg: 1)', ent.data && ent.data.cg === 1);
      // OFF again: the World Grid and every answer are main's
      await S.admin('cg-switch', { on: false });
      const lbOff = await S.lb(), entOff = await S.ent(P(1));
      const mlb2 = await M.lb(), ment = await M.ent(P(1));
      const norm = (t) => t.replace(/"v=\d+"/g, '');
      ck('E3 switched OFF again: the World Grid, boards and entitlements equal main\'s at once (contributions kept, not shown)',
        norm(lbOff.text) === norm(mlb2.text) && entOff.text === ment.text && (await S.admin('cg-status')).data.given === exp.PH + exp.US + exp.JP, norm(lbOff.text) === norm(mlb2.text) ? 'grid ok' : 'grid differs');
      const rOff = await S.run(P(7), 3000), mOff = await M.run(P(7), 3000);
      ck('E3 ...and a run while OFF is main\'s: no share, no extra row', rOff.text === mOff.text && !rOff.data.cg);
      await turnOn(S);
      ck('E3 switched ON again: what was given comes back', Math.abs(ctry((await S.lb()).data).US - (ctry((await M.lb()).data).US + 900)) < 1e-6);
      report.example = { adds, exp };
    }

    /* ================= E4 the daily cap ================= */
    if (on('D')) {
      say('== E4 the daily cap (1,000 a day per pilot, UTC days) ==');
      now = T0; RUN = 0;
      const S = mk(mod, newStorage());
      await S.seed(1, 10); await turnOn(S);
      const a = await S.run(P(1), 7000, { d: 'hard' });   // 700
      const b = await S.run(P(1), 5000, { d: 'hard' });   // 500 -> 300
      const k0 = JSON.stringify([...S.g.map.entries()].filter(([k]) => k.startsWith('cg:')));
      const m = await S.meter(() => S.run(P(1), 9000, { d: 'hard' }));   // 0
      const k1 = JSON.stringify([...S.g.map.entries()].filter(([k]) => k.startsWith('cg:')));
      ck('E4 700, then 300 (capped), then 0 (capped): never more than 1,000 a day', a.data.cg.add === 700 && b.data.cg.add === 300 && b.data.cg.capped === 1 && m.out.data.cg.add === 0 && m.out.data.cg.capped === 1 && m.out.data.cg.today === 1000,
        [a.data.cg.add, b.data.cg.add, m.out.data.cg.add].join(','));
      ck('E4 a capped run writes nothing new (no contribution row)', k0 === k1);
      const other = await S.run(P(2), 7000, { d: 'hard' });
      ck('E4 the cap is per pilot (another pilot still gives)', other.data.cg.add === 700);
      now = Date.UTC(2026, 9, 6, 0, 0, 30);
      const next = await S.run(P(1), 4000, { d: 'hard' });
      ck('E4 the next UTC day counts again; the running total keeps growing', next.data.cg.add === 400 && next.data.cg.today === 400 && next.data.cg.total === 1400, JSON.stringify(next.data.cg));
      const tot = (await S.admin('cg-status')).data;
      ck('E4 the country total adds up (700 + 300 + 700 + 400)', tot.given === 2100 && tot.countries[0].given === 2100);
    }

    /* ================= E5 replays and anti-cheat ================= */
    if (on('E')) {
      say('== E5 replays never count twice; only accepted runs count ==');
      now = T0; RUN = 0;
      const S = mk(mod, newStorage());
      await S.seed(1, 10); await turnOn(S);
      const id = rid();
      const a = await S.run(P(1), 5000, { runId: id });
      const before = (await S.admin('cg-status')).data.given;
      const b = await S.run(P(1), 5000, { runId: id });
      const c = await S.run(P(1), 5000, { runId: id });
      const after = (await S.admin('cg-status')).data.given;
      ck('E5 the same run sent again (a retry or a replay) gives nothing more', a.data.cg.add === 105 && b.data.duplicate === true && b.data.cg.add === 0 && b.data.cg.dup === 1 && c.data.cg.add === 0 && before === 105 && after === 105, [a.data.cg.add, b.text.slice(0, 80)].join(' | '));
      now += 11000;
      const fast1 = await S.req('/api/submit-score', { playerId: P(2), name: 'FAST', score: 5000, level: levelFor(5000, 'medium'), difficulty: 'medium', country: 'PH', season: 1, runId: rid() });
      const fast2 = await S.req('/api/submit-score', { playerId: P(2), name: 'FAST', score: 5000, level: levelFor(5000, 'medium'), difficulty: 'medium', country: 'PH', season: 1, runId: rid() });
      ck('E5 a second run inside the 10-second cooldown is refused, and gives nothing', fast1.data.cg.add === 105 && fast2.status === 429 && (await S.admin('cg-status')).data.given === 210);
      const ceil = await S.req('/api/submit-score', { playerId: P(3), name: 'HIGH', score: 500000, level: 9, difficulty: 'hard', country: 'PH', season: 1, runId: rid() });
      now += 11000;
      const lvl = await S.req('/api/submit-score', { playerId: P(4), name: 'LVL', score: 40000, level: 1, difficulty: 'hard', country: 'PH', season: 1, runId: rid() });
      ck('E5 a score above the ceiling, or not plausible for its level, is refused as today and gives nothing', ceil.status >= 400 && lvl.status === 422 && !ceil.data.cg && !lvl.data.cg && (await S.admin('cg-status')).data.given === 210, ceil.status + ' ' + lvl.status);
      const noId = await (async () => { now += 11000; return S.req('/api/submit-score', { playerId: P(5), name: 'OLD', score: 5000, level: levelFor(5000, 'medium'), difficulty: 'medium', country: 'PH', season: 1 }); })();
      ck('E5 an upload without a run id (an old page) is accepted as today but gives nothing (it could not be told apart from a replay)', noId.status === 200 && noId.data.cg.add === 0);
      const noCc = await S.run(P(6), 5000, { cc: 'XX' });
      ck('E5 a pilot with no country gives nothing', noCc.data.cg.add === 0);
      // privacy deletion removes the pilot's own numbers (the country totals stay)
      await S.admin('privacy-delete', { pid: pidOf(1), removePurchases: false });
      ck('E5 a privacy deletion removes the pilot\'s own numbers; the country totals stay', !S.g.map.has('cg:p:' + pidOf(1)) && (await S.admin('cg-status')).data.given === 210);
    }

    /* ================= E6 free plan ================= */
    if (on('F')) {
      say('== E6 free plan: no extra request; rows written ==');
      now = T0; RUN = 0;
      const S = mk(mod, newStorage()); await S.seed(1, 30);
      const off = await S.meter(() => S.run(P(1), 1200));
      await turnOn(S);
      await S.run(P(9), 100);   // warms the totals read
      const onGive = await S.meter(() => S.run(P(2), 1200));
      const onGive2 = await S.meter(() => S.run(P(2), 1300));
      for (let i = 0; i < 2; i++) await S.run(P(3), 30000, { d: 'hard' });
      const onCapped = await S.meter(() => S.run(P(3), 30000, { d: 'hard' }));
      const extra = onGive2.written - off.written, capped = onCapped.written - off.written;
      ck('E6 a run that gives writes exactly 2 more rows than today\'s upload; a capped run writes none more', extra === 2 && capped === 0, 'OFF ' + off.written + ' · ON ' + onGive2.written + ' · capped ' + onCapped.written);
      report.rows = { uploadToday: off.written, extraPerGivingRun: extra, extraCapped: capped, readsOn: onGive2.read - off.read };
      report.perDay = Object.fromEntries([1000, 10000, 100000].map((n) => [n, { extraRows: n * extra, pctOfFree: Math.round(100 * n * extra / 100000) + '%' }]));
    }

    /* ================= E7 the game ================= */
    if (on('G')) {
      say('== E7 the game: one line at game over, the total in the menu, no new button ==');
      const GAME = scriptsOf(game);
      const bootGame = (init, reply) => {
        const { store, mem } = makeStore(Object.assign({ fluxPlayerId: 'p-cg-1', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxRunsPlayed: '3' }, init));
        const fetched = [], posts = [], timers = [];
        const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, standalone: false, fetchImpl: (u, o) => { fetched.push(String(u)); if (o && o.body) posts.push({ u: String(u), body: JSON.parse(o.body) });
          const body = String(u).startsWith('/api/submit-score') ? JSON.stringify(reply || { ok: true, isNewBest: false, best: 9000, public: true, rank: 4, difficulty: 'medium', tag: 'ABCDEFG' }) : '{"ok":true}';
          return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })); } });
        g.ctx.Blob = Blob; const beacons = []; g.win.navigator.sendBeacon = (u, b) => { beacons.push({ u, b }); return true; };
        g.ctx.setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
        const gameOver = async () => { g.ctx.endGame(); timers.splice(0).filter((t) => t.ms === 420).forEach((t) => t.f()); for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
        return { g, mem, run: (c) => vm.runInContext(c, g.ctx), beacons, fetched, posts, gameOver };
      };
      const best = { fluxSeason: '1', fluxBestRun_medium: JSON.stringify({ score: 9000, level: 3, difficulty: 'medium' }), fluxBest_medium: '9000', fluxUploadedBest: JSON.stringify({ season: 1, pid: 'p-cg-1', medium: 9000, name: 'TITAN', country: 'PH' }) };
      // OFF: a run below the best is not uploaded (stats alone), exactly as today
      const a = bootGame(best); a.g.ctx.newGame(); a.run('difficulty="medium"; score=5000; level=2;'); await a.gameOver();
      ck('E7 OFF: a run below the best is not uploaded; its stats go alone (one request), as today', a.posts.filter((x) => x.u === '/api/submit-score').length === 0 && a.beacons.length === 1);
      // ON: the run's own score goes up, its stats inside, one request
      const cgReply = { ok: true, isNewBest: false, best: 9000, public: true, rank: 4, difficulty: 'medium', tag: 'ABCDEFG', cg: { on: 1, add: 105, cc: 'PH', total: 4321, today: 105, cap: 1000 } };
      const b = bootGame(Object.assign({}, best, { fluxCg: JSON.stringify({ on: true, at: 1 }) }), cgReply);
      b.g.els.gameover = { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } };   // the game-over screen is showing
      b.g.ctx.newGame(); b.run('difficulty="medium"; score=5000; level=2;'); await b.gameOver();
      const up = b.posts.filter((x) => x.u === '/api/submit-score');
      ck('E7 ON: the run\'s own score is uploaded (not the best), with its stats inside: still ONE request', up.length === 1 && up[0].body.score === 5000 && up[0].body.difficulty === 'medium' && !!up[0].body.stats && b.beacons.length === 0, up.length + ' ' + (up[0] && up[0].body.score) + ' beacons ' + b.beacons.length);
      const line = String(b.g.els.goLine.innerHTML || '');
      ck('E7 ON: game over shows ONE line with the run\'s share: "🇵🇭 +105 for Philippines"', /🇵🇭 \+105 for Philippines/.test(line) && b.g.els.goLine.style.display === '', line);
      b.run('updateUploadStatus()');
      const stat = String(b.g.els.uploadStatus.textContent || '');
      ck('E7 ON: the menu\'s status line shows what the pilot gave in all', /4,321 GIVEN TO PHILIPPINES/.test(stat), stat);
      // the line rule (pure)
      const L = (cg, sc, po) => b.run('fluxCgLine(' + JSON.stringify(cg) + ',' + sc + ',' + po + ')');
      ck('E7 the line adds what a new best adds; a capped run says so; nothing to say -> no line',
        L({ on: 1, add: 50, cc: 'PH' }, 10000, 0) === '🇵🇭 +' + (2100 + 50).toLocaleString() + ' for Philippines' && L({ on: 1, add: 0, cc: 'PH', capped: 1 }, 10, 99999) === "Today's max given to 🇵🇭 Philippines" && L({ on: 1, add: 0, cc: 'PH' }, 10, 99999) === null,
        [L({ on: 1, add: 50, cc: 'PH' }, 10000, 0), L({ on: 1, add: 0, cc: 'PH', capped: 1 }, 10, 99999)].join(' | '));
      // a reply without "cg" (the switch went OFF) turns the game back to normal
      const c = bootGame(Object.assign({}, best, { fluxCg: JSON.stringify({ on: true, at: 1 }) }));
      c.g.ctx.newGame(); c.run('difficulty="medium"; score=5000; level=2;'); await c.gameOver();
      ck('E7 a reply without the share (switched OFF) puts the game back to normal at once', !c.mem.fluxCg && !/GIVEN/.test(String((c.run('updateUploadStatus()'), c.g.els.uploadStatus.textContent) || '')));
      const d = bootGame(best); d.run('fluxCgSet(true)');
      ck('E7 OFF: no total in the menu even if one was kept', (d.run('fluxCgSet(false); localStorage.setItem("fluxCgGiven", JSON.stringify({pid:"p-cg-1",t:50})); updateUploadStatus()'), !/GIVEN/.test(String(d.g.els.uploadStatus.textContent || ''))));
      const mainGame = execFileSync('git', ['show', 'origin/main:public/play/index.html'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const cnt = (h, re) => (h.match(re) || []).length;
      ck('E7 no new button, fetch, timer or per-frame work in the game (counts equal main\'s)',
        cnt(game, /<button\b/g) === cnt(mainGame, /<button\b/g) && cnt(game, /\bfetch\(/g) === cnt(mainGame, /\bfetch\(/g) && cnt(game, /setInterval\(|setTimeout\(|requestAnimationFrame\(/g) === cnt(mainGame, /setInterval\(|setTimeout\(|requestAnimationFrame\(/g),
        [cnt(game, /<button\b/g), cnt(mainGame, /<button\b/g)].join('/'));
      ck('E7 the game learns the switch only from answers it already gets (board, entitlements, run reply)',
        /fluxCgSet\(!!\(o\.data && o\.data\.cg && o\.data\.cg\.on\)\)/.test(game) && /fluxCgSet\(d\.cg === 1\)/.test(game) && /fluxCgSet\(!!\(b && b\.cg && b\.cg\.on\)\)/.test(game));
    }

    /* ================= E8 FLUX COMMAND ================= */
    if (on('H')) {
      ck('E8 FLUX COMMAND: EVERY RUN COUNTS section with SHOW, the typed TURN ON, TURN OFF and a guide entry',
        adminHtml.includes('<h2>EVERY RUN COUNTS</h2>') && adminHtml.includes('id="cgOn"') && adminHtml.includes('id="cgOff"') && adminHtml.includes("call('cg-status')") &&
        adminHtml.includes("post('cg-switch', { on: true, confirm: inp.value.trim() })") && adminHtml.includes("call('cg-switch', { on: false })") && adminHtml.includes('<h3>Every Run Counts</h3>'));
    }
  } catch (e) { ck('suite ran without an exception', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)); }
  Date.now = realNow; console.error = realErr;
  return { F, failed, report };
}

/* ---------------- main + negative controls ---------------- */
const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const tmpMain = path.join(__dirname, '.cg-main-' + process.pid + '.mjs');
let mainMod = null;
try {
  fs.writeFileSync(tmpMain, execFileSync('git', ['show', 'origin/main:worker.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  mainMod = await import(pathToFileURL(tmpMain).href);
} catch (e) { console.log('  (origin/main not available: E1 and E3 compare against nothing)'); }
finally { try { fs.unlinkSync(tmpMain); } catch (e) {} }
const res = await suite({ mod: realMod, main: mainMod });
console.log('\n== costs (fake row counter; the Cloudflare dashboard is the authority) ==\n' + JSON.stringify(res.report));

if (process.env.CG_NO_NC) process.exit(res.F ? 1 : 0);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, parts, { worker = (s) => s, game = (s) => s, admin = (s) => s }) {
  const w2 = worker(WORKER_SRC), g2 = game(GAME_HTML), a2 = admin(ADMIN_HTML);
  if (w2 === WORKER_SRC && g2 === GAME_HTML && a2 === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  let mod = realMod, tmp = null;
  if (w2 !== WORKER_SRC) { tmp = path.join(__dirname, '.nc-cg-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2); mod = await import(pathToFileURL(tmp).href); }
  try {
    const r = await suite({ mod, main: mainMod, game: g2, adminHtml: a2, quiet: true, parts });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { if (tmp) try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('ON by default', 'E1', ['A'], { worker: rep('cgOn() { return !!(this.sum && this.sum.cg && this.sum.cg.on); }', 'cgOn() { return !(this.sum && this.sum.cg && this.sum.cg.on === false); }') });
await control('contributions shown while OFF', 'E3', ['C'], { worker: rep('if (!this.cgOn() || !this.cgTot) return list;', 'if (!this.cgTot) return list;') });
await control('ON without the typed phrase', 'E2', ['B'], { worker: rep('if (String(b.confirm || "").trim() !== CG_CONFIRM) return', 'if (false) return') });
await control('ON without a backup', 'E2', ['B'], { worker: rep('  if (!bk.fresh) return json({ ok: false, needBackup: true, backup: bk,\n    error: "Switching ON needs', '  if (false) return json({ ok: false, needBackup: true, backup: bk,\n    error: "Switching ON needs') });
await control('the wrong share (20%)', 'E3', ['C'], { worker: rep('const CG_RATE = 0.10;', 'const CG_RATE = 0.20;') });
await control('difficulty weights ignored', 'E3', ['C'], { worker: rep('const w = DIFF_WEIGHT[difficulty] || 0;', 'const w = 1;') });
await control('no daily cap', 'E4', ['D'], { worker: rep('const add = Math.min(want, Math.max(0, CG_DAY_CAP - (p.g || 0)));', 'const add = want;') });
await control('the cap never resets', 'E4', ['D'], { worker: rep('const p = prev && prev.d === day ? prev : { d: day, g: 0,', 'const p = prev ? prev : { d: day, g: 0,') });
await control('a replay counts again', 'E5', ['E'], { worker: rep('cgOn ? { cg: this.cgReply(cgPrev, country, now, 0, 0, true) } : undefined);', 'cgOn ? { cg: (this.cgCount(pid, country, score, difficulty, now, cgPrev, true), this.cgReply(cgPrev, country, now, 0, 0, true)) } : undefined);') });
await control('a restricted pilot gives', 'E3', ['C'], { worker: rep('!!runId && !ownGet(o.restricted, pid)', '!!runId') });
await control('a share kept from the run\'s write (written apart)', 'E6', ['F'], { worker: rep('if (cgRes && cgRes.puts) Object.assign(kv, cgRes.puts);', 'if (cgRes && cgRes.puts) { o.state.storage.put(cgRes.puts); o.state.storage.put({ "cg:extra": 1 }); }') });
await control('the switch read on every cold start (a row more than main)', 'E1', ['A'], { worker: rep('    await this.load();\n    const url = new URL(request.url);', '    await this.load(); await this.state.storage.get("cg:cfg");\n    const url = new URL(request.url);') });
await control('a board changed by the contributions', 'E3', ['C'], { worker: rep('return list.map((c) => (t[c.country] > 0 ? { ...c, totalScore: c.totalScore + t[c.country] } : c))', 'return list.map((c) => (t[c.country] > 0 ? { ...c, totalScore: c.totalScore + t[c.country], playerCount: c.playerCount + 1 } : c))') });
await control('the game uploads every run even when OFF', 'E7', ['G'], { game: rep('const every=run && fluxCgOn();', 'const every=run;') });
await control('the game shows no share at game over', 'E7', ['G'], { game: rep("if(add>0) return c.flag+' +'+add.toLocaleString()+' for '+c.name;", "if(add>0) return null;") });
await control('the game keeps ON after a reply without the share', 'E7', ['G'], { game: rep('fluxCgSet(!!(b && b.cg && b.cg.on));', 'if(b && b.cg) fluxCgSet(true);') });
await control('FLUX COMMAND has no TURN OFF', 'E8', ['H'], { admin: rep('id="cgOff"', 'id="cgOffX"') });
const total = res.F + NC;
console.log('\n' + (total ? 'EVERY RUN COUNTS FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'EVERY RUN COUNTS PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
