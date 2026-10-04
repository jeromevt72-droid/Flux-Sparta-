// STORAGE FIX: the leaderboard no longer keeps every pilot in ONE stored value (Cloudflare caps a
// value at 2 MB: about 8,000 pilots). The new layout is one SQL row per pilot in the same
// LeaderboardDO ("global"), moved by the owner in steps: backup -> dry run -> typed approval ->
// batches + switch -> check -> (rollback) -> clean-up. Proven here with a fake Durable Object whose
// key-value storage ENFORCES the 2 MB per-value limit and whose SQL is a real SQLite (node:sqlite),
// both counting rows read and written (an index entry counts as a row written; a full-table scan
// counts every row).
//   SF1  the old layout fails past ~8,000 pilots (and at 20,000), the new layout works at 20,000+;
//   SF2  dry run: builds the new layout in memory, reconciles EVERY pilot / best / cooldown / purchase
//        (incl. Solar Inferno) / tag / restore code / board / country total: PASS; writes nothing live;
//   SF3  the move refuses without the admin password, without a passing dry run, without the typed
//        "MIGRATE <dry-run id>", and without a verified backup from the last 60 minutes;
//   SF4  the move: a safety backup first, batches, resumable after a failure mid-batch (and mid-switch),
//        writes between batches and IN FLIGHT at the switch are not lost, the old values stay untouched,
//        the public answers are identical after the switch;
//   SF5  (costs) rows written per run, rows read per leaderboard request;
//   SF6  post-change check (sample + every pilot) PASS, detects a damaged row, gates the clean-up;
//   SF7  rollback: back to the old layout with every write made since the move; cancel mid-copy;
//   SF8  a cold start after the move reads far fewer rows than there are pilots;
//   SF9  the new layout answers EXACTLY like the old one under the same operations: boards with the
//        #33 difficulty weights and rounding ties, country totals and leaders, lengthened #tags,
//        restrictions, name bans, score removal, privacy deletion, purchases, restore codes, admin search;
//   SF10 Season: the Season 0 archive survives the move; a season reset on the new layout archives + clears;
//   SF11 privacy deletion on the new layout also erases the old layout's copy and every backup;
//   SF12 backups of the new layout: paged snapshot (writes wait, 503 + Retry-After), verified, dry run,
//        restore of a damaged state, restore of the pre-move backup (back to the old layout),
//        download + upload, daily cron;
//   SF13 the free-plan cost table at 10k / 50k / 200k pilots (measured per pilot, extrapolated);
//   SF14 scale: 20,000 pilots (200,000 with FLUX_SCALE=200000): boards equal a brute-force recount;
//   SF15 admin page STORAGE section + guide; wrangler.jsonc identical to main.
// Ends with negative controls: each defect re-inserted into worker.js / admin.html MUST be caught.
import fs from 'fs'; import path from 'path'; import util from 'util'; import v8 from 'v8'; import nodeCrypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { levelFor, DIFF_WEIGHT } from './level-rule.mjs';
process.removeAllListeners('warning');   // node:sqlite is "experimental" on this Node
const { DatabaseSync } = await import('node:sqlite');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const WRANGLER = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');
const MB2 = 2 * 1024 * 1024;
const T0 = Date.UTC(2026, 9, 5, 9, 0);
const SCALE = Math.max(20000, Number(process.env.FLUX_SCALE || 0) || 200000);   // FLUX_SCALE=20000 for a quicker run

/* ---------------- fake Durable Object runtime ---------------- */
function pidHashSync(id) { return nodeCrypto.createHash('sha256').update('flux-pid:' + id).digest().subarray(0, 8).toString('hex'); }
function tagFromPid(pidHex, len) {
  const a = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let bits = '', out = '';
  for (const ch of String(pidHex)) bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  for (let i = 0; i + 5 <= bits.length && out.length < len; i += 5) out += a[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
/* Real SQLite, with Cloudflare's cursor shape and row counters. */
class FakeSql {
  constructor(meter) { this.db = new DatabaseSync(':memory:'); this.m = meter; this.stmts = new Map(); this.plans = new Map(); this.failAt = null; this.mangle = null; this.n = 0; }
  stmt(q) { let s = this.stmts.get(q); if (!s) { s = this.db.prepare(q); this.stmts.set(q, s); } return s; }
  count(t) { try { return this.db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; } catch (e) { return 0; } }
  scanPenalty(q, args) {   // a query that scans a whole table without LIMIT reads every row of it
    if (!/^\s*SELECT/i.test(q) || /\bLIMIT\b/i.test(q)) return 0;
    let plan = this.plans.get(q);
    if (!plan) { try { plan = this.db.prepare('EXPLAIN QUERY PLAN ' + q).all(...args).map((r) => r.detail); } catch (e) { plan = []; } this.plans.set(q, plan); }
    let p = 0; for (const d of plan) { const m = /^SCAN (\w+)/.exec(d); if (m) p += this.count(m[1]); }
    return p;
  }
  idxFactor(q) {   // index entries written with each changed row (estimate)
    if (!/\bpilots\b/.test(q)) return 0;
    if (/^\s*(INSERT|REPLACE|DELETE)/i.test(q)) return 3;
    const m = /SET (.*) WHERE/i.exec(q); if (!m) return 0;
    let f = 0; for (const re of [/\be_[st]\b/, /\bm_[st]\b/, /\bh_[st]\b/, /\bt12\b/]) if (re.test(m[1])) f++;
    if (/\brs\b/.test(m[1])) f += 2;
    return f;
  }
  exec(q, ...args) {
    this.n++;
    if (this.failAt && this.failAt(q)) throw new Error('injected SQL failure');
    args = args.map((a) => (a === undefined ? null : a));
    const write = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q);
    const before = write ? this.db.prepare('SELECT total_changes() AS c').get().c : 0;
    let rows = this.stmt(q).all(...args).map((r) => ({ ...r }));
    if (this.mangle) rows = this.mangle(q, rows);
    let rowsRead = 0, rowsWritten = 0;
    if (write) { const ch = this.db.prepare('SELECT total_changes() AS c').get().c - before; rowsWritten = ch * (1 + this.idxFactor(q)); rowsRead = ch; }
    else rowsRead = rows.length + this.scanPenalty(q, args);
    this.m.read += rowsRead; this.m.written += rowsWritten;
    return { toArray: () => rows, one: () => rows[0], rowsRead, rowsWritten, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  }
  tables() { return this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name); }
  dump(t) { try { return this.db.prepare('SELECT * FROM ' + t + ' ORDER BY ' + (t === 'pilots' ? 'seq' : 'id')).all().map((r) => ({ ...r })); } catch (e) { return null; } }
}
/* Key-value storage that ENFORCES Cloudflare's 2 MB per value (V8 serialisation, as stored). */
class FakeStorage {
  constructor(map, { limit = MB2 } = {}) { this.map = map || new Map(); this.limit = limit; this.meter = { read: 0, written: 0 }; this.sql = new FakeSql(this.meter); this.failPut = null; this.slowPut = null; }
  async get(k) { this.meter.read++; return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v };
    const keys = Object.keys(obj);
    if (keys.length > 128) throw new Error('put: more than 128 keys');
    for (const kk of keys) { const n = v8.serialize(obj[kk]).length; if (n > this.limit) throw new Error('put: value over the ' + this.limit + '-byte limit (' + kk + ', ' + n + ' bytes)'); }
    if (this.failPut && this.failPut(obj)) throw new Error('storage failure');
    const copy = keys.map((kk) => [kk, structuredClone(obj[kk])]);
    this.meter.written += keys.length;
    for (const [kk, vv] of copy) this.map.set(kk, vv);   // visible at once (like the runtime's cache) ...
    if (this.slowPut && this.slowPut(obj)) await new Promise((r) => setTimeout(r, this.slowPut(obj)));   // ... durable later
  }
  async delete(k) { const ks = [].concat(k); if (ks.length > 128) throw new Error('delete: more than 128 keys'); this.meter.written += ks.length; for (const x of ks) this.map.delete(x); }
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
function makeEnv(mod, g, b) {
  const inst = new Map();
  const env = { ADMIN_TOKEN: 'pw', _g: g, _b: b || new FakeStorage(new Map(), { limit: 128 * 1024 }) };
  env.LEADERBOARD_DO = { idFromName: (n) => n, get(id) {
    if (!inst.has(id)) { const st = new FakeState(id === 'global' ? env._g : id === 'backups' ? env._b : new FakeStorage()); inst.set(id, { st, o: new mod.LeaderboardDO(st, env) }); }
    const x = inst.get(id);
    // Input gate: a new request is delivered only when no blockConcurrencyWhile is running.
    return { fetch: async (url, init) => { await x.st.lock; return x.o.fetch(new Request(url, init)); } }; } };
  env.restart = () => inst.clear();
  env.obj = (id) => { env.LEADERBOARD_DO.get(id); return inst.get(id).o; };
  return env;
}

/* ---------------- data ---------------- */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const CC = ['US', 'PH', 'JP', 'DE', 'BR', 'KE', 'IN', 'FR', 'GB', 'MX'];
function recFor(id, i, r, t0) {
  const bests = {};
  if (r() < 0.75) { const s = 300 + Math.floor(r() * 60000); bests.easy = { score: s, level: levelFor(s, 'easy'), updatedAt: t0 + 100 }; }
  if (r() < 0.55) { const s = 300 + Math.floor(r() * 50000); bests.medium = { score: s, level: levelFor(s, 'medium'), updatedAt: t0 + 200 }; }
  if (r() < 0.35) { const s = 300 + Math.floor(r() * 40000); bests.hard = { score: s, level: levelFor(s, 'hard'), updatedAt: t0 + 300 }; }
  return { playerId: id, name: 'PILOT' + i, country: CC[Math.floor(r() * CC.length)], updatedAt: t0, bests };
}
/* An old-layout leaderboard: pilots with bests on every difficulty, cooldowns (incl. one with no
   pilot any more), purchases (Solar Inferno, a buyer with no score), sessions, restrictions, a name
   ban, flags, restore log, Season 0 archive. */
function seedOld(n, { seed = 7, rich = true } = {}) {
  const r = rng(seed), m = new Map(), players = {}, lastSubmit = {}, ents = {}, seen = {};
  for (let i = 1; i <= n; i++) {
    const id = P(i), t0 = 1790000000000 + i * 1000;
    players[id] = recFor(id, i, r, t0);
    if (i % 5 === 0) lastSubmit[id] = t0 + 500;
    if (rich && i % 13 === 0) { ents[id] = i % 26 === 0 ? ['solar'] : ['cosmic', 'toxic']; seen['cs_live_' + i] = t0 + 700; }
  }
  if (n >= 6) players[P(6)].bests = {};                                  // a pilot with no Season 1 score yet
  m.set('players', players); m.set('nameRulesV1', 1); m.set('season', 1);
  if (!rich) return m;
  if (n >= 9) players[P(5)].note = undefined;                          // a stored undefined survives the move too
  lastSubmit['gone-pilot'] = 1790000000123;                             // cooldown of a pilot whose score was removed
  ents.buyerOnly = ['solar']; seen.cs_buyer_only = 1790000000999;
  m.set('lastSubmit', lastSubmit); m.set('entitlements', ents); m.set('seenSessions', seen);
  m.set('restricted', { [pidHashSync(P(3))]: { at: 1, reason: 'spam' }, deadbeefdeadbeef: { at: 2, reason: 'gone' } });
  m.set('nameBans', { PILOT9: { at: 1 } });
  m.set('flags', [{ id: 'f1:easy', pid: pidHashSync(P(1)), name: 'PILOT1', difficulty: 'easy', score: 1, at: 1790000000000 }]);
  m.set('restoreLog', [{ at: 1, pid: pidHashSync(P(2)), tag: tagFromPid(pidHashSync(P(2)), 7), name: 'PILOT2', reason: 'checked by email' }]);
  const arch = [0, 1].map((c) => Array.from({ length: 30 }, (_, j) => ({ playerId: P(c * 30 + j + 1), name: 'OLD' + j, country: 'US', bests: { medium: { score: 9000 + j, level: 5, updatedAt: 1700000000000 + j } } })));
  m.set('archive:season0', { season: 0, archivedAt: 1780000000000, players: 60, scores: 60, chunks: 2 });
  arch.forEach((a, i) => m.set('archive:season0:' + i, a));
  return m;
}
/* Two pilot ids whose short #tags collide (the first 35 bits of their public hash). */
function collidingIds() {
  const seen = new Map();
  for (let i = 0; ; i++) {
    const id = 'c0llide-' + i, h = nodeCrypto.createHash('sha256').update('flux-pid:' + id).digest();
    const k = h.readUInt32BE(0) * 8 + (h[4] >> 5);
    if (seen.has(k)) return [seen.get(k), id];
    seen.set(k, id);
  }
}
const cloneMap = (m) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
const diffKeys = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => !a.has(k) || !b.has(k) || !util.isDeepStrictEqual(a.get(k), b.get(k)));

/* ---------------- the suite ---------------- */
async function suite({ workerMod, adminHtml, quiet = false, parts = null, small = false }) {
  let F = 0; const failed = [], report = {};
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const say = (t) => { if (!quiet) console.log(t); };
  const on = (p) => !parts || parts.includes(p);
  const worker = workerMod.default;
  const realNow = Date.now; let now = T0; Date.now = () => now;
  const realErr = console.error; console.error = () => {};
  const mk = (g, b) => {
    const env = makeEnv(workerMod, g, b);
    const req = async (p, body, headers = {}, method = 'POST') => {
      const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, {});
      const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: res.status, data, text, headers: res.headers };
    };
    const admin = (route, body) => req('/api/admin/' + route, body, H);
    const submit = (id, score, d = 'medium', o = {}) => req('/api/submit-score', { playerId: id, name: o.name || 'PILOT' + String(id).replace(/\D/g, '').slice(-6), score, level: levelFor(score, d), difficulty: d, country: o.country || 'US', season: 1, ...(o.runId ? { runId: o.runId } : {}) });
    const cron = async () => { const w = []; await worker.scheduled({}, env, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
    const doFetch = (path, body) => env.LEADERBOARD_DO.get('global').fetch('https://do.internal' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const view = async (ids = []) => {
      const out = {};
      for (const d of ['', 'easy', 'medium', 'hard']) out['lb:' + d] = (await req('/api/leaderboard?limit=100' + (d ? '&difficulty=' + d : ''), null, {}, 'GET')).text;
      out['lb:boards'] = (await req('/api/leaderboard?limit=100&boards=1&v=' + now, null, {}, 'GET')).text;   // EARTH / MARS / JUPITER / WORLD in one response
      for (const id of ids) {
        out['ent:' + id] = (await req('/api/entitlements?playerId=' + id, null, {}, 'GET')).text;
        out['rc:' + id] = (await req('/api/restore-check', { playerId: id })).text;
      }
      return out;
    };
    const move = async () => {   // backup -> dry run -> MIGRATE (all batches)
      const bk = await admin('backup-now'); const dr = await admin('migrate-storage-dry-run');
      let r = null; for (let i = 0; i < 50; i++) { r = await admin('migrate-storage', { confirm: dr.data && dr.data.confirm }); if (r.status !== 200 || !r.data.more) break; }
      return { bk, dr, r };
    };
    return { env, req, admin, submit, cron, doFetch, view, move };
  };
  const sameView = (a, b, skipCountry) => {
    const keys = Object.keys(a); const bad = [];
    for (const k of keys) {
      let x = a[k], y = b[k];
      if (skipCountry && k.startsWith('lb:')) { const X = JSON.parse(x), Y = JSON.parse(y); X.countries = X.countries.filter((c) => c.country !== skipCountry); Y.countries = Y.countries.filter((c) => c.country !== skipCountry); X.leadingCountry = Y.leadingCountry = null; delete X.totals; delete Y.totals; x = JSON.stringify(X); y = JSON.stringify(Y); }
      if (x !== y) bad.push(k);
    }
    return bad;
  };
  const ids12 = [P(1), P(2), P(3), P(5), P(6), P(9), P(13), P(26), P(52), 'buyerOnly', P(999999)];

  try {
    /* ================= SF1 the 2 MB wall ================= */
    if (on('A')) {
      say('== SF1 the old layout: one value, 2 MB ==');
      const res = {};
      for (const n of small ? [6000, 12000] : [6000, 8000, 9000, 10000, 12000, 20000]) {
        const g = new FakeStorage(seedOld(n, { rich: false }));
        const S = mk(g);
        const r = await S.submit('brand-new-pilot', 4321, 'medium');
        res[n] = { status: r.status, bytes: v8.serialize(g.map.get('players')).length };
      }
      const firstFail = Object.keys(res).map(Number).sort((a, b) => a - b).find((n) => res[n].status !== 200);
      report.oldWall = { firstFailingPilots: firstFail, bytesAt: Object.fromEntries(Object.entries(res).map(([n, x]) => [n, x.bytes])) };
      ck('SF1 the old layout works at 6,000 pilots', res[6000].status === 200, res[6000].bytes + ' bytes');
      ck('SF1 ...and every upload fails once the one "players" value passes 2 MB (between 8,000 and 12,000 pilots here)', firstFail > 6000 && firstFail <= 12000 && res[12000].status === 500, 'first failure at ' + firstFail);
      if (!small) ck('SF1 at 20,000 pilots the old layout cannot take a single upload', res[20000].status === 500);
    }

    /* ================= SF2 + SF3 dry run and refusals ================= */
    if (on('B')) {
      say('== SF2 dry run / SF3 refusals ==');
      const N = small ? 600 : 3000;
      const g = new FakeStorage(seedOld(N)), S = mk(g);
      await S.view();   // loaded
      for (const r of ['storage-status', 'migrate-storage-dry-run', 'migrate-storage', 'migrate-storage-check', 'migrate-storage-rollback', 'migrate-storage-cleanup']) {
        const ip = { 'CF-Connecting-IP': '10.9.' + r.length + '.' + r.charCodeAt(r.length - 1) };   // FLUX COMMAND locks a client after 5 wrong passwords
        const x = await S.req('/api/admin/' + r, {}, ip), y = await S.req('/api/admin/' + r, {}, { 'x-admin-token': 'nope', ...ip });
        if (x.status !== 401 || y.status !== 401) { ck('SF3 every storage route needs the admin password', false, r + ': ' + x.status + '/' + y.status); break; }
      }
      ck('SF3 every storage route needs the admin password (401 without it)', !failed.includes('SF3 every storage route needs the admin password'));
      const bk0 = await S.admin('backup-now');
      const noDry = await S.admin('migrate-storage', { confirm: 'MIGRATE DR-x' });
      ck('SF3 the move is refused before a dry run', noDry.status === 409 && !g.map.has('mig') && g.sql.tables().length === 0, noDry.status + ' ' + (noDry.data && noDry.data.error));
      const before = cloneMap(g.map), sqlBefore = g.sql.tables().length, w0 = g.meter.written;
      const dr = await S.admin('migrate-storage-dry-run');
      const d = dr.data || {};
      ck('SF2 the dry run passes: every reconciliation check PASS', dr.status === 200 && d.pass === true && d.checks.length >= 12 && d.checks.every((c) => c.pass),
        (d.checks || []).filter((c) => !c.pass).map((c) => c.name + ': ' + c.detail).join(' | ') || (d.checks || []).length + ' checks');
      const want = { easy: 0, medium: 0, hard: 0 }; for (const p of Object.values(g.map.get('players'))) for (const k of Object.keys(want)) if (p.bests[k]) want[k]++;
      ck('SF2 it reports the counts: pilots, bests per difficulty, buyers incl. Solar Inferno, flags, bans, restrictions',
        d.pilots === N && util.isDeepStrictEqual(d.counts.bests, want) && d.counts.solarInferno === Object.values(g.map.get('entitlements')).filter((x) => x.includes('solar')).length
        && d.counts.flags === 1 && d.counts.nameBans === 1 && d.counts.restricted === 2 && d.counts.purchasePilots === Object.keys(g.map.get('entitlements')).length,
        JSON.stringify(d.counts));
      ck('SF2 it estimates the rows the move writes, the batches and the time', d.est && d.est.rowsWritten > N * 3 && d.est.rowsWritten < N * 7 && d.est.batches === Math.ceil(N / 1000) && d.est.seconds > 0, JSON.stringify(d.est));
      ck('SF2 the dry run wrote nothing live (only its own report; no table, no layout change)', util.isDeepStrictEqual(diffKeys(before, g.map), ['mig:dry']) && g.sql.tables().length === sqlBefore && g.meter.written - w0 === 1,
        diffKeys(before, g.map).join(',') + ' / tables ' + g.sql.tables().join(','));
      ck('SF2 the confirmation phrase names the dry run', /^MIGRATE DR-\d{8}-\d{6}$/.test(d.confirm));
      const wrong = await S.admin('migrate-storage', { confirm: 'MIGRATE DR-00000000-000000' }), none = await S.admin('migrate-storage', {});
      ck('SF3 the move is refused without the exact typed phrase (nothing written, no safety backup)', wrong.status === 400 && none.status === 400 && /MIGRATE DR-/.test(wrong.data.error) && !g.map.has('mig') && g.sql.tables().length === 0
        && (await S.admin('backups')).data.snapshots.length === 1, wrong.status + '/' + none.status);
      now += 25 * 3600 * 1000;
      await S.admin('backup-now');
      const old = await S.admin('migrate-storage', { confirm: d.confirm });
      ck('SF3 a move is not started from a dry run older than 24 hours', old.status === 409 && /24 hours/.test(old.data.error) && !g.map.has('mig'), old.status);
      const dr3 = await S.admin('migrate-storage-dry-run'); d.confirm = dr3.data.confirm;
      now += 61 * 60 * 1000;
      const stale = await S.admin('migrate-storage', { confirm: d.confirm });
      ck('SF3 the move is refused when the newest verified backup is older than 60 minutes (and offers BACK UP NOW)', stale.status === 409 && stale.data.needBackup === true && /BACK UP NOW/.test(stale.data.error) && !g.map.has('mig'), stale.status);
      const g2 = new FakeStorage(seedOld(300)), S2 = mk(g2);
      const dr2 = await S2.admin('migrate-storage-dry-run');
      const nob = await S2.admin('migrate-storage', { confirm: dr2.data.confirm });
      ck('SF3 the move is refused when there is no backup at all', nob.status === 409 && nob.data.needBackup === true && !g2.map.has('mig') && g2.sql.tables().length === 0);
      // an uploaded file is not a copy of the live leaderboard: it does not count
      const file = await S.req('/api/admin/backup-download', { id: bk0.data.snapshot.id }, H);
      await S2.admin('backup-import', { backup: JSON.parse(file.text) });
      const imp = await S2.admin('migrate-storage', { confirm: dr2.data.confirm });
      ck('SF3 an uploaded backup file does not count as the recent backup', imp.status === 409 && imp.data.needBackup === true);
      // a copy that reads back differently from the old layout (here: one pilot's name, as SQL returns it) is never switched to
      await S2.admin('backup-now');
      g2.sql.mangle = (q, rows) => (/^SELECT \* FROM pilots WHERE id = \?/.test(q) ? rows.map((r) => (r.id === P(100) ? { ...r, rec: r.rec.replace('"PILOT100"', '"PILOT101"') } : r)) : rows);
      let mv = null; for (let i = 0; i < 10; i++) { mv = await S2.admin('migrate-storage', { confirm: dr2.data.confirm }); if (mv.status !== 200 || !mv.data.more) break; }
      g2.sql.mangle = null;
      ck('SF4 a copy that does not match the old layout is never switched to (FLUX stays on the old layout, the copy is dropped)',
        mv.status === 409 && mv.data.switched === false && !g2.map.has('storageLayout') && g2.sql.tables().length === 0 && g2.map.get('mig').phase === 'failed' && mv.data.checks.some((c) => !c.pass)
        && (await S2.submit(P(100), 1234, 'hard', { name: 'PILOT100' })).status === 200 && g2.map.get('players')[P(100)].bests.hard, mv.status + ' ' + (mv.data && mv.data.error));
      now += 60 * 1000;
    }

    /* ================= SF4 SF5 SF6 SF8 the move ================= */
    if (on('D')) {
      say('== SF4 the move / SF6 check / SF8 cold start ==');
      const N = small ? 2500 : 6000, CUT = small ? 1000 : 2000;
      const g = new FakeStorage(seedOld(N)), S = mk(g);
      const bk = await S.admin('backup-now');
      const dr = await S.admin('migrate-storage-dry-run');
      ck('SF4 (setup) a verified backup and a passing dry run', bk.status === 200 && dr.data.pass === true);
      // a failure injected in the 3rd batch: the move stops, nothing of that batch is written
      let batches = 0;
      g.sql.failAt = (q) => /^INSERT OR REPLACE INTO pilots/.test(q) && ++batches === CUT + 500;   // half-way through the next batch
      const m1 = await S.admin('migrate-storage', { confirm: dr.data.confirm });
      g.sql.failAt = null;
      const mig1 = g.map.get('mig');
      const snaps1 = (await S.admin('backups')).data.snapshots;
      ck('SF4 the move takes a verified safety backup first', snaps1.some((m) => m.kind === 'safety' && m.verified && m.id === (mig1 && mig1.safetyId)), snaps1.map((m) => m.kind).join(','));
      ck('SF4 a failure mid-batch stops the move with an error; the batches before it are kept, the failed one is not half-written',
        m1.status === 500 && mig1 && mig1.phase === 'copying' && mig1.cursor === CUT && g.sql.count('pilots') === CUT && !g.map.has('storageLayout'), m1.status + ' cursor ' + (mig1 && mig1.cursor) + ' rows ' + g.sql.count('pilots'));
      // the daily budget: once the move has written its share of today's free rows it pauses until tomorrow
      const mm = g.map.get('mig'); mm.dayRows = 60000; g.map.set('mig', mm);
      const mp = await S.admin('migrate-storage', { confirm: dr.data.confirm });
      ck('SF4 the move pauses for the day once it has written its budget (the rest of the free day stays for play)',
        mp.status === 200 && mp.data.paused === true && g.map.get('mig').phase === 'paused' && g.map.get('mig').cursor === CUT && !g.map.has('storageLayout'), mp.status + ' ' + (mp.data && (mp.data.message || mp.data.error)));
      now += 24 * 3600 * 1000;
      await S.admin('backup-now');   // the next day: a fresh backup (the dry run may be older than 24 h: a move under way continues)
      // players keep playing meanwhile, on the old layout
      now += 20000;
      const w1 = await S.submit(P(4), 59000, 'hard', { name: 'PILOT4', country: 'JP' });
      const w2 = await S.submit('late-pilot-1', 5000, 'easy', { name: 'LATEONE', country: 'KE' });
      const pd = await S.admin('privacy-delete', { pid: pidHashSync(P(7)), removePurchases: true });
      await S.doFetch('/grant', { playerId: P(8), sku: 'solar', sessionId: 'cs_during_move' });
      ck('SF4 during the move FLUX keeps running on the old layout (uploads, privacy deletion, purchases)', w1.status === 200 && w2.status === 200 && pd.status === 200 && !g.map.has('storageLayout')
        && g.map.get('players')['late-pilot-1'] && !g.map.get('players')[P(7)] && g.map.get('entitlements')[P(8)].includes('solar'));
      ck('SF4 ...and a privacy deletion also removes the pilot from the half-made copy', !g.sql.dump('pilots').some((r) => r.id === P(7)));
      // continue: resumes at the next batch, no second safety backup; a failure in the switch changes nothing
      let sw = 0; g.sql.failAt = (q) => /^(DELETE FROM pilots WHERE seq|INSERT INTO pilots|UPDATE pilots)/.test(q) && ++sw === 1;
      const m2 = await S.admin('migrate-storage', { confirm: dr.data.confirm });
      g.sql.failAt = null;
      const mig2 = g.map.get('mig');
      ck('SF4 the move resumes where it stopped (same move, no restart, one safety backup)', mig2.id === mig1.id && mig2.startedAt === mig1.startedAt && mig2.cursor === mig2.total && (await S.admin('backups')).data.snapshots.filter((m) => m.kind === 'safety').length === 1,
        'cursor ' + mig2.cursor + '/' + mig2.total);
      ck('SF4 a failure inside the switch leaves FLUX on the old layout (nothing switched)', m2.status === 500 && !g.map.has('storageLayout') && mig2.phase === 'copying', m2.status);
      // the switch: one upload IN FLIGHT (its storage write still pending) must land in the new layout
      const viewBefore = await S.view(ids12.concat(['late-pilot-1', 'in-flight-1']));
      const oldVals = ['players', 'lastSubmit', 'entitlements', 'seenSessions'].map((k) => [k, structuredClone(g.map.get(k))]);
      ck('SF4 (setup) still on the old layout before the switch', !g.map.has('storageLayout') && g.map.get('mig').phase === 'copying');
      g.slowPut = (o) => (o.players && o.players['in-flight-1'] ? 150 : 0);
      now += 20000;
      const flight = S.submit('in-flight-1', 777, 'medium', { name: 'INFLIGHT', country: 'ZZ' });
      await new Promise((r) => setTimeout(r, 20));
      const m3 = await S.admin('migrate-storage', { confirm: dr.data.confirm });
      const fr = await flight; g.slowPut = null;
      const mig3 = g.map.get('mig');
      ck('SF4 the switch: every comparison passes, then FLUX uses the new layout', m3.status === 200 && m3.data.switched === true && g.map.get('storageLayout') === 'v2' && mig3.phase === 'switched' && m3.data.checks.every((c) => c.pass),
        m3.status + ' ' + ((m3.data && m3.data.checks) || []).filter((c) => !c.pass).map((c) => c.name + ': ' + c.detail).join(' | '));
      const oldKept = oldVals.every(([k, v]) => { const cur = g.map.get(k); return k === 'players' ? util.isDeepStrictEqual(Object.keys(cur).filter((x) => x !== 'in-flight-1'), Object.keys(v)) && Object.keys(v).every((x) => util.isDeepStrictEqual(cur[x], v[x])) : k === 'lastSubmit' ? Object.keys(v).every((x) => util.isDeepStrictEqual(cur[x], v[x])) : util.isDeepStrictEqual(cur, v); });
      ck('SF4 the old layout\'s values are kept untouched (read-only copy until CLEAN UP)', oldKept);
      const rcFlight = await S.req('/api/restore-check', { playerId: 'in-flight-1' });
      ck('SF4 an upload in flight when the switch started is not lost (it is in the new layout)', fr.status === 200 && rcFlight.data && rcFlight.data.found === true && rcFlight.data.bests.medium.score === 777, fr.status + ' ' + rcFlight.text);
      const viewAfter = await S.view(ids12.concat(['late-pilot-1']));
      const bad = sameView(Object.fromEntries(Object.entries(viewBefore).filter(([k]) => !k.endsWith('in-flight-1'))), viewAfter, 'ZZ');
      ck('SF4 every public answer is identical after the switch (4 boards incl. #33 weights, countries, skins, restore codes)', !bad.length, bad.join(','));
      ck('SF4 new pilots after the move go to the new layout only', (await S.submit('after-pilot-1', 3000, 'easy', { name: 'AFTERONE' })).status === 200 && !g.map.get('players')['after-pilot-1'] && g.sql.dump('pilots').some((r) => r.id === 'after-pilot-1'));
      report.move = { pilots: N + 2, rowsWritten: mig3.rows, batches: mig3.batches };
      ck('SF4 the move wrote about 3-6 rows per pilot (within one free day at this size)', mig3.rows > N * 2 && mig3.rows < N * 7 && mig3.rows < 100000, mig3.rows + ' rows for ' + N + ' pilots');

      /* SF8 cold start + SF5 costs */
      S.env.restart();
      let m0 = { ...g.meter };
      const e1 = await S.req('/api/entitlements?playerId=' + P(13), null, {}, 'GET');
      const cold = g.meter.read - m0.read;
      ck('SF8 a cold start after the move reads a few rows, never the pilots (bound: 30 rows for ' + (N + 3) + ' pilots)', e1.status === 200 && cold <= 30, cold + ' rows read');
      m0 = { ...g.meter }; await S.req('/api/leaderboard?difficulty=hard&limit=100', null, {}, 'GET'); const lbCold = g.meter.read - m0.read;
      m0 = { ...g.meter }; await S.req('/api/leaderboard?limit=100', null, {}, 'GET'); const allCold = g.meter.read - m0.read;
      m0 = { ...g.meter }; await S.req('/api/leaderboard?difficulty=hard&limit=100', null, {}, 'GET'); await S.req('/api/leaderboard?limit=25', null, {}, 'GET'); const lbWarm = g.meter.read - m0.read;
      ck('SF5 a leaderboard request reads ~100 rows the first time after a restart (ALL a few hundred) and 0 from memory', lbCold <= 130 && allCold <= 700 && lbWarm === 0, 'hard ' + lbCold + ', all ' + allCold + ', warm ' + lbWarm);
      const runCost = async (fn) => { const a = { ...g.meter }; const r = await fn(); return { status: r.status, read: g.meter.read - a.read, written: g.meter.written - a.written }; };
      now += 20000;
      if (process.env.SF_DBG) { const e = g.sql.exec.bind(g.sql); g.sql.exec = (q, ...a) => { const r = e(q, ...a); if (r.rowsWritten) console.log('W', r.rowsWritten, q.slice(0, 60)); return r; }; const p0 = g.put.bind(g); g.put = (k, v) => { console.log('KV', typeof k === 'object' ? Object.keys(k) : k); return p0(k, v); }; }
      const withEasy = (from) => { for (let i = from; ; i++) { const r = g.map.get('players')[P(i)]; if (r && r.bests.easy && r.bests.easy.score > 400 && !(g.map.get('restricted') || {})[pidHashSync(P(i))]) return i; } };
      const i21 = withEasy(21), i23 = withEasy(i21 + 1);
      const cNo = await runCost(() => S.submit(P(i21), 301, 'easy', { name: 'PILOT' + i21, country: g.map.get('players')[P(i21)].country }));
      if (process.env.SF_DBG) process.exit(0);
      now += 20000;
      const cBest = await runCost(() => S.submit(P(22), 44000, 'easy', { name: 'PILOT22', country: g.map.get('players')[P(22)].country }));
      const cNew = await runCost(() => S.submit('cost-new-1', 2000, 'medium', { name: 'COSTNEW', country: 'US' }));
      now += 20000;
      const cNo2 = await runCost(() => S.submit(P(i23), 302, 'easy', { name: 'PILOT' + i23, country: g.map.get('players')[P(i23)].country }));
      const cNew2 = await runCost(() => S.submit('cost-new-2', 2100, 'medium', { name: 'COSTNEWTWO', country: 'US' }));
      report.run = { noBest: cNo, newBest: cBest, newPilot: cNew, noBestSteady: cNo2, newPilotSteady: cNew2, coldStart: cold, leaderboardCold: lbCold, allCold, leaderboardWarm: lbWarm };
      ck('SF5 rows written per run: 1-2 without a new best, <= 6 with one, <= 7 for a new pilot', cNo.status === 200 && cNo.written <= 2 && cBest.written <= 6 && cNew.written <= 7, JSON.stringify(report.run));
      ck('SF5 rows read per run: a few (+ ~100 when that board changed; + 1,000 once per 10 min for the rank floor)', cNo2.read <= 120 && cNew2.read <= 20 && cNo.read <= 1200 && cNew.read <= 1200, cNo2.read + '/' + cNew2.read);

      /* SF6 the check */
      const cs = await S.admin('migrate-storage-check', { mode: 'sample' });
      ck('SF6 CHECK A SAMPLE passes (boards, countries, running totals, restore codes, skins, tags)', cs.status === 200 && cs.data.done && cs.data.pass && cs.data.pilots.compared >= 150, cs.status + ' ' + JSON.stringify(cs.data && cs.data.pilots) + ' ' + ((cs.data && cs.data.checks) || []).filter((c) => !c.pass).map((c) => c.name).join('|'));
      ck('SF6 ...pilots changed since the move are counted as changed, not failed', cs.data.changed >= 3);
      const all = async () => { let cur = 0, r; for (let i = 0; i < 100; i++) { r = await S.admin('migrate-storage-check', { mode: 'all', cursor: cur }); if (r.status !== 200 || !r.data.more) break; cur = r.data.cursor; } return r; };
      const early = await S.admin('migrate-storage-cleanup', { confirm: 'CLEANUP ' + mig3.id });
      ck('SF6 CLEAN UP is refused before CHECK EVERY PILOT has passed', early.status === 409 && g.map.has('players'), early.status);
      const ca = await all();
      ck('SF6 CHECK EVERY PILOT passes, in batches', ca.status === 200 && ca.data.done && ca.data.pass && ca.data.pilots.compared + ca.data.pilots.skipped === ca.data.total && ca.data.total > N - 5, JSON.stringify(ca.data && ca.data.pilots));
      // a damaged row (a score changed behind the server's back) is detected
      const victim = g.sql.dump('pilots').find((r) => r.id === P(40) && r.e_s != null) || g.sql.dump('pilots').find((r) => r.e_s != null && r.id.startsWith('aaaa'));
      const rec = JSON.parse(victim.rec); rec.bests.easy.score += 1;
      g.sql.db.prepare('UPDATE pilots SET rec = ? WHERE seq = ?').run(JSON.stringify(rec), victim.seq);
      S.env.restart();
      const cd = await all();
      ck('SF6 the check detects a damaged row: FAIL, with the pilot\'s #tag (never a playerId)', cd.status === 200 && cd.data.done && !cd.data.pass && cd.data.pilots.failed >= 1 && cd.data.pilots.examples.includes('#' + tagFromPid(victim.pid, 7)) && !JSON.stringify(cd.data).includes(victim.id),
        JSON.stringify(cd.data && cd.data.pilots));
      const blocked = await S.admin('migrate-storage-cleanup', { confirm: 'CLEANUP ' + mig3.id });
      ck('SF6 ...and CLEAN UP stays refused while the last full check failed', blocked.status === 409);
      g.sql.db.prepare('UPDATE pilots SET rec = ? WHERE seq = ?').run(victim.rec, victim.seq); S.env.restart();
      const ok2 = await all();
      const wrongC = await S.admin('migrate-storage-cleanup', { confirm: 'CLEANUP nope' });
      const nSafety = (await S.admin('backups')).data.snapshots.filter((m) => m.kind === 'safety').length;
      const cl = await S.admin('migrate-storage-cleanup', { confirm: 'CLEANUP ' + mig3.id });
      ck('SF6 CLEAN UP after a passing full check: typed phrase, safety backup first, then the old values go',
        ok2.data.pass && wrongC.status === 400 && cl.status === 200 && !g.map.has('players') && !g.map.has('entitlements') && !g.map.has('lastSubmit') && g.map.get('mig').phase === 'cleaned'
        && (await S.admin('backups')).data.snapshots.filter((m) => m.kind === 'safety').length === nSafety + 1, cl.status + ' ' + wrongC.status);
      const after = await S.admin('migrate-storage-check', { mode: 'sample' });
      ck('SF6 after CLEAN UP there is nothing left to compare (the check says so) and FLUX still answers', after.status === 409 && (await S.submit('post-clean', 1500, 'hard', { name: 'POSTCLEAN' })).status === 200);
      S.env.restart();
      ck('SF8 ...and still starts cold without reading the pilots', await (async () => { const a = g.meter.read; await S.req('/api/entitlements?playerId=x', null, {}, 'GET'); return g.meter.read - a <= 30; })());
    }

    /* ================= SF7 rollback / cancel ================= */
    if (on('F')) {
      say('== SF7 rollback ==');
      const g = new FakeStorage(seedOld(small ? 400 : 1200, { seed: 11 })), S = mk(g);
      const { r } = await S.move();
      ck('SF7 (setup) moved', r.status === 200 && g.map.get('storageLayout') === 'v2');
      now += 20000;
      await S.submit('rb-new-1', 30000, 'hard', { name: 'ROLLNEW', country: 'BR' });
      await S.submit(P(10), 58000, 'easy', { name: 'PILOT10' });
      await S.doFetch('/grant', { playerId: 'rb-new-1', sku: 'solar', sessionId: 'cs_rb' });
      const v1 = await S.view(ids12.concat(['rb-new-1', P(10)]));
      const no = await S.admin('migrate-storage-rollback', { confirm: 'rollback' });
      const rb = await S.admin('migrate-storage-rollback', { confirm: 'ROLLBACK' });
      ck('SF7 rollback needs the typed ROLLBACK', no.status === 400 && rb.status === 200, no.status + ' ' + no.text);
      ck('SF7 ROLLBACK: back to the old layout, the new tables dropped, a safety backup taken first',
        rb.status === 200 && !g.map.has('storageLayout') && g.sql.tables().length === 0 && g.map.get('mig').phase === 'rolledback'
        && (await S.admin('backups')).data.snapshots.filter((m) => m.kind === 'safety').length === 2, rb.status + ' ' + (rb.data && rb.data.error));
      const v2 = await S.view(ids12.concat(['rb-new-1', P(10)]));
      S.env.restart();
      const v3 = await S.view(ids12.concat(['rb-new-1', P(10)]));
      const b2 = sameView(v1, v2), b3 = sameView(v1, v3);
      ck('SF7 ...with every score and purchase made since the move (public answers identical, also after a restart)', !b2.length && !b3.length && g.map.get('players')['rb-new-1'] && g.map.get('entitlements')['rb-new-1'][0] === 'solar', b2.concat(b3).join(','));
      // cancel a half-made move
      const dr = await S.admin('migrate-storage-dry-run');
      await S.admin('backup-now');
      let k = 0; g.sql.failAt = (q) => /^INSERT OR REPLACE INTO pilots/.test(q) && ++k === 1;
      const half = await S.admin('migrate-storage', { confirm: dr.data.confirm }); g.sql.failAt = null;
      const half2 = small ? half : await S.admin('migrate-storage', { confirm: 'MIGRATE nope' });
      const cancel = await S.admin('migrate-storage-rollback', { confirm: 'ROLLBACK' });
      ck('SF7 a half-made move can be cancelled (typed ROLLBACK): the copy is dropped, FLUX never left the old layout',
        half.status === 500 && cancel.status === 200 && cancel.data.cancelled && g.sql.tables().length === 0 && !g.map.has('storageLayout') && g.map.get('mig').phase === 'cancelled' && half2.status >= 400, half.status + '/' + cancel.status);
    }

    /* ================= SF9 SF10 SF11 the same answers ================= */
    if (on('E')) {
      say('== SF9 the new layout answers exactly like the old one ==');
      const N = small ? 700 : 1500;
      const seed = seedOld(N, { seed: 3 });
      const pl = seed.get('players');
      // rounding ties on ALL: 160 Easy-only pilots at the top of ALL whose weighted scores (x0.09) collide; within a
      // weighted score, fewer points = an earlier time, so ALL's top 100 is NOT the Easy board's top 100
      for (let i = 0; i < 160; i++) { const id = 'tie-' + i, s = 450000 + (i % 23) * 3, t = 1790500000000 + (i % 23) * 10 + (i >> 5); pl[id] = { playerId: id, name: 'TIE' + i, country: CC[i % 4], updatedAt: t, bests: { easy: { score: s, level: 9, updatedAt: t } } }; }
      // full ties (same score, same time): the older pilot first
      for (let i = 0; i < 6; i++) { const id = 'same-' + i; pl[id] = { playerId: id, name: 'SAME' + i, country: 'DE', updatedAt: 1790600000000, bests: { hard: { score: 39000, level: 9, updatedAt: 1790600000000 } } }; }
      const [ca, cb] = collidingIds();
      pl[ca] = { playerId: ca, name: 'ROBIN', country: 'GB', updatedAt: 1790700000000, bests: { medium: { score: 30000, level: 7, updatedAt: 1790700000000 } } };
      pl[cb] = { playerId: cb, name: 'ROBIN', country: 'GB', updatedAt: 1790700000001, bests: { medium: { score: 29000, level: 7, updatedAt: 1790700000001 } } };
      const go = new FakeStorage(seed), gn = new FakeStorage(cloneMap(seed));
      const O = mk(go), Nw = mk(gn);
      const mv = await Nw.move();
      ck('SF9 (setup) the same leaderboard in both layouts', mv.r.status === 200 && gn.map.get('storageLayout') === 'v2' && !go.map.has('storageLayout'), mv.r.status + ' ' + JSON.stringify(mv.r.data && mv.r.data.checks && mv.r.data.checks.filter((c) => !c.pass)));
      const tags = await Nw.req('/api/restore-check', { playerId: cb });
      ck('SF9 two pilots with the same shown name and short #tag get 12-character tags', tags.data.tag.length === 12);
      const watch = ids12.concat([ca, cb, 'tie-5', 'same-2', 'new-a', 'new-b', 'new-c']);
      const cmp = async (label, fnO, fnN = fnO) => {
        const a = await fnO(O), b = await fnN(Nw);
        let ok = a.status === b.status && (a.text === b.text || label.startsWith('submit') && (() => { const x = JSON.parse(a.text), y = JSON.parse(b.text); if (!(x.rank > 1000 && y.rank === null)) return false; for (const k of ['rank', 'total', 'countryRank', 'countryTotal', 'above']) { delete x[k]; delete y[k]; } return JSON.stringify(x) === JSON.stringify(y); })());
        const va = await O.view(watch), vb = await Nw.view(watch), bad = sameView(va, vb);
        ck('SF9 ' + label + ': same answer and same public view', ok && !bad.length, (ok ? '' : a.status + ' ' + a.text.slice(0, 160) + ' <> ' + b.status + ' ' + b.text.slice(0, 160) + ' ') + bad.join(','));
      };
      await cmp('start', async (X) => ({ status: 200, text: '' }));
      const step = () => { now += 11000; };
      step(); await cmp('submit: a new pilot straight into the Hard top 100', (X) => X.submit('new-a', 39500, 'hard', { name: 'NEWA', country: 'PH' }));
      step(); await cmp('submit: a full tie (same score, same time) sorts by the older pilot', (X) => X.submit('new-b', 39000, 'hard', { name: 'NEWB', country: 'DE' }));
      step(); await cmp('submit: an Easy best that ties on ALL after the x0.09 weight', (X) => X.submit('tie-7', 450067, 'easy', { name: 'TIE7', country: CC[7 % 4] }));
      step(); await cmp('submit: no new best (name and country refresh)', (X) => X.submit(P(12), 301, 'easy', { name: 'PILOT12', country: 'MX' }));
      step(); await cmp('submit: with a run id (rank, country rank, pilot above)', (X) => X.submit(P(44), 39800, 'hard', { name: 'PILOT44', country: 'KE', runId: 'run-aaaaaaaaaaaaaaaa-1' }));
      step(); await cmp('submit: the same run id again = the same reply, nothing changes (duplicate)', (X) => X.submit(P(44), 39800, 'hard', { name: 'PILOT44', country: 'KE', runId: 'run-aaaaaaaaaaaaaaaa-1' }));
      step(); await cmp('submit: a pilot beyond the top 100 (rank counted on the index)', (X) => X.submit(P(33), 2400, 'medium', { name: 'PILOT33', country: 'US' }));
      await cmp('submit: cooldown (429 with Retry-After)', (X) => X.submit(P(33), 2500, 'medium', { name: 'PILOT33', country: 'US' }));
      step(); await cmp('submit: a colliding pilot renames -> both tags go back to 7 characters', (X) => X.submit(cb, 29500, 'medium', { name: 'OTTER', country: 'GB' }));
      step(); await cmp('submit: ...and back -> 12 characters again', (X) => X.submit(cb, 29600, 'medium', { name: 'ROBIN', country: 'GB' }));
      step(); await cmp('submit: a new pilot in a small country', (X) => X.submit('new-c', 1000, 'hard', { name: 'NEWC', country: 'NZ' }));
      const frLead = JSON.parse((await O.req('/api/leaderboard?limit=100', null, {}, 'GET')).text).countries.find((x) => x.country === 'FR');
      const frId = P(Number(/^PILOT(\d+)$/.exec(frLead.topName)[1]));
      step(); await cmp('submit: a country leader moves to another country (the old one looks its leader up again)', (X) => X.submit(frId, 300, 'easy', { name: frLead.topName, country: 'JP' }));
      step(); await cmp('submit: a flagged jump (exceptions list)', (X) => X.submit(P(15), 180000, 'medium', { name: 'PILOT15', country: 'US' }));
      await cmp('admin: exceptions (flags)', async (X) => { const r = await X.admin('exceptions'), d = JSON.parse(r.text); delete d.founding; return { status: r.status, text: JSON.stringify(d) }; });   // the Founding Pilot gaps exist on the new layout only
      const topHard = JSON.parse((await O.req('/api/leaderboard?difficulty=hard&limit=5', null, {}, 'GET')).text).top[0];
      await cmp('admin: restrict the Hard #1', (X) => X.admin('restrict', { pid: topHard.pid, reason: 'test' }));
      await cmp('admin: unrestrict', (X) => X.admin('unrestrict', { pid: topHard.pid }));
      await cmp('admin: name ban (shown as PILOT; tags regrouped)', (X) => X.admin('name-ban', { name: 'ROBIN' }));
      await cmp('admin: name unban', (X) => X.admin('name-unban', { name: 'ROBIN' }));
      const lbAll = JSON.parse((await O.req('/api/leaderboard?limit=100', null, {}, 'GET')).text);
      const leaderName = lbAll.countries[0].topName, leader = (await O.admin('find-player', { query: leaderName })).data.matches[0];
      await cmp('admin: find a pilot by NAME #TAG', (X) => X.admin('find-player', { query: leader.name + ' #' + leader.tag }));
      await cmp('admin: find by part of a name', (X) => X.admin('find-player', { query: 'PILOT13' }));
      await cmp('admin: remove the top country leader\'s score (the leader is looked up again)', (X) => X.admin('remove-score', { pid: leader.pid }));
      step(); await cmp('submit: after a removal the cooldown is kept', (X) => X.submit(leader.name.startsWith('PILOT') ? P(Number(leader.name.slice(5))) : 'x', 500, 'easy', { name: leader.name }));
      await cmp('grant: Solar Inferno to a pilot', (X) => X.doFetch('/grant', { playerId: P(14), sku: 'solar', sessionId: 'cs_eq_1' }));
      await cmp('grant: the same session again is a duplicate', (X) => X.doFetch('/grant', { playerId: P(14), sku: 'solar', sessionId: 'cs_eq_1' }));
      await cmp('revoke', (X) => X.doFetch('/revoke', { playerId: P(26), sku: 'solar' }));
      const p13 = pidHashSync(P(13));
      await cmp('admin: issue a restore code (logged first)', (X) => X.admin('issue-restore-code', { pid: p13, reason: 'checked by email' }));
      await cmp('admin: Season 0 archive (read-only)', (X) => X.admin('season-archive'));
      await cmp('admin: privacy deletion incl. purchases (a pilot in the Season 0 archive)', (X) => X.admin('privacy-delete', { pid: p13, removePurchases: true }).then((r) => ({ status: r.status, text: JSON.stringify({ ...r.data, backups: undefined }) })));
      await cmp('admin: privacy deletion of a buyer with no score', (X) => X.admin('privacy-delete', { pid: pidHashSync('buyerOnly'), removePurchases: true }).then((r) => ({ status: r.status, text: JSON.stringify({ ...r.data, backups: undefined }) })));
      await cmp('admin: overview (restore log, bans)', (X) => X.doFetch('/admin-overview', {}));
      await cmp('admin: FLUX COMMAND summary (purchases today from the sessions table)', (X) => X.doFetch('/admin-summary', {}));
      await cmp('admin: privacy deletion also forgets the pilot\'s run ids', (X) => X.admin('privacy-delete', { pid: pidHashSync(P(44)), removePurchases: false }).then((r) => ({ status: r.status, text: JSON.stringify({ ...r.data, backups: undefined }) })));
      ck('SF11 ...no run ids are kept for a privacy-deleted pilot (both layouts)', !go.map.has('runs:' + pidHashSync(P(44))) && !gn.map.has('runs:' + pidHashSync(P(44))));
      ck('SF10 the Season 0 archive survives the move untouched (minus the privacy-deleted pilot, in both layouts)', util.isDeepStrictEqual(['archive:season0', 'archive:season0:0', 'archive:season0:1'].map((k) => go.map.get(k)), ['archive:season0', 'archive:season0:0', 'archive:season0:1'].map((k) => gn.map.get(k))));
      ck('SF11 a privacy deletion on the new layout also erases the pilot from the old layout\'s copy (kept until CLEAN UP) and its cooldown',
        !gn.map.get('players')[P(13)] && !gn.sql.dump('pilots').some((r) => r.id === P(13)) && !gn.sql.dump('ents').some((r) => r.id === P(13)) && !(gn.map.get('entitlements') || {})[P(13)]);
      step(); await cmp('recompute (country totals rebuilt from every row)', (X) => X.doFetch('/recompute', {}));
    }

    /* ================= SF10 a season on the new layout ================= */
    if (on('I')) {
      say('== SF10 season reset on the new layout ==');
      const g = new FakeStorage(seedOld(300, { seed: 5 })), S = mk(g);
      await S.move();
      const bestsBefore = g.sql.dump('pilots').filter((r) => r.e_s != null || r.m_s != null || r.h_s != null).length;
      g.map.set('season', 0); S.env.restart();
      const lb = JSON.parse((await S.req('/api/leaderboard?limit=100', null, {}, 'GET')).text);
      const arch = await S.admin('season-archive');
      const rc = await S.req('/api/restore-check', { playerId: P(26) });
      ck('SF10 a new season on the new layout: bests archived (every one), boards and countries empty, pilots and skins kept',
        lb.top.length === 0 && lb.countries.length === 0 && g.map.get('season') === 1 && arch.data.players === bestsBefore && rc.data.found && rc.data.skus.includes('solar') && Object.keys(rc.data.bests).length === 0,
        lb.top.length + ' ' + arch.data.players + '/' + bestsBefore);
    }

    /* ================= SF12 SF13 backups of the new layout ================= */
    if (on('G')) {
      say('== SF12 backups of the new layout ==');
      const N = small ? 500 : 2500;
      const g = new FakeStorage(seedOld(N, { seed: 9 })), b = new FakeStorage(new Map(), { limit: 128 * 1024 }), S = mk(g, b);
      const B0 = (await S.admin('backup-now')).data.snapshot;
      const vOld = await S.view(ids12);
      await S.move();
      now += 60000;
      const W = ids12.concat([P(30), P(31), P(40), P(41), 'bk-new-1']);
      const vB1 = await S.view(W);
      const rm0 = { ...g.meter }, bw0 = { ...b.meter };
      const bn = await S.admin('backup-now');
      const B1 = bn.data.snapshot;
      const readPer = (g.meter.read - rm0.read) / N, wrote = b.meter.written - bw0.written;
      ck('SF12 BACK UP NOW on the new layout: a paged snapshot (schema 2), verified, every pilot / buyer / session counted',
        bn.status === 200 && B1.schema === 2 && B1.verified && B1.pages.length >= 3 && B1.summary.players === N + 0 && B1.summary.layout === 'new' && B1.summary.purchasePilots === Object.keys(g.map.get('entitlements')).length,
        JSON.stringify({ pages: B1.pages && B1.pages.length, chunks: B1.chunks, players: B1.summary && B1.summary.players }));
      // bytes of the pilot pages only (the stored values -- incl. the old layout's copy until CLEAN UP -- do not grow after the move)
      let ci = 0, rowBytes = 0;
      for (const pg of B1.pages) { for (let j = 0; j < pg.c; j++, ci++) if (pg.t === 'pilots') rowBytes += Buffer.byteLength(b.map.get('c:' + B1.id + ':' + B1.gen + ':' + ci)); }
      const perPilotBytes = rowBytes / N;
      report.backup = { pilots: N, rowsReadPerPilot: +readPer.toFixed(3), backupRowsWritten: wrote, bytesPerPilot: Math.round(perPilotBytes) };
      for (const n of [10000, 50000, 200000]) { const bytes = n * perPilotBytes, chunks = Math.ceil(bytes / 30000); report['backupAt' + n] = { rowsRead: Math.round(n * readPer + chunks * 19), rowsWritten: chunks + 6, mb: +(bytes / 1048576).toFixed(1) }; }
      ck('SF13 a daily backup reads each row about once and writes one row per 30,000 characters (per pilot: ' + readPer.toFixed(2) + ' rows read, ' + Math.round(perPilotBytes) + ' bytes)',
        readPer >= 1 && readPer < 1.3 && wrote <= B1.chunks + 12 && report.backupAt200000.rowsRead < 5000000 * 0.2 && report.backupAt200000.rowsWritten < 100000 * 0.1, JSON.stringify(report.backupAt200000));
      // writes wait while the pages are read
      const beg = await (await S.doFetch('/v2bk-begin', { mode: 'dump' })).json();
      const during = await S.submit(P(30), 50000, 'hard', { name: 'PILOT30' });
      await S.doFetch('/v2bk-end', { token: beg.token });
      now += 11000;
      const afterEnd = await S.submit(P(30), 50000, 'hard', { name: 'PILOT30' });
      await S.doFetch('/v2bk-begin', { mode: 'dump' }); now += 61000;
      const lease = await S.submit(P(31), 50000, 'hard', { name: 'PILOT31' });
      ck('SF12 while a backup reads the pages, uploads get 503 + Retry-After (the game retries) and go through right after; an abandoned backup frees writes after 60 s',
        during.status === 503 && during.headers.get('Retry-After') === '5' && during.data.busy && afterEnd.status === 200 && lease.status === 200, during.status + '/' + afterEnd.status + '/' + lease.status);
      const dr0 = await S.admin('backup-dry-run', { id: B1.id });
      ck('SF12 dry run of the new-layout backup: writes nothing, shows the pilots changed since', dr0.status === 200 && !dr0.data.identical && dr0.data.diff.players.changed === 2 && dr0.data.diff.players.added === 0, JSON.stringify(dr0.data.diff && dr0.data.diff.players));
      // damage: new pilots, removed score, a purchase
      now += 11000;
      await S.submit('bk-new-1', 20000, 'medium', { name: 'BKNEW', country: 'KE' });
      await S.admin('remove-score', { pid: pidHashSync(P(40)) });
      await S.doFetch('/grant', { playerId: P(41), sku: 'toxic', sessionId: 'cs_bk_1' });
      const rowsB1 = null;
      const dr1 = await S.admin('backup-dry-run', { id: B1.id });
      ck('SF12 ...after changes it counts pilots added / changed / removed and purchases', dr1.data.diff.players.added === 1 && dr1.data.diff.players.removed === 1 && dr1.data.diff.players.changed === 2 && dr1.data.diff.purchases.removed === 1, JSON.stringify(dr1.data.diff));
      const no = await S.admin('backup-restore', { id: B1.id, confirm: 'RESTORE x' });
      const rs = await S.admin('backup-restore', { id: B1.id, confirm: 'RESTORE ' + B1.id });
      const dr2 = await S.admin('backup-dry-run', { id: B1.id });
      const safety = (await S.admin('backups')).data.snapshots.find((m) => m.id === rs.data.safetyId);
      ck('SF12 restore of a new-layout backup: typed phrase, safety backup (paged) first, then the leaderboard is identical to the backup',
        no.status === 400 && rs.status === 200 && rs.data.verified && dr2.data.identical && safety && safety.schema === 2 && safety.verified && !g.map.has('v2:restoring'), rs.status + ' ' + (rs.data && rs.data.error));
      const vR = await S.view(W);
      ck('SF12 ...the public answers are exactly those at backup time (later scores gone, removed pilot back, purchase gone)', !sameView(vB1, vR).length, sameView(vB1, vR).join(','));
      ck('SF12 ...and uploads work again after the restore', (now += 11000, (await S.submit('bk-after', 1200, 'easy', { name: 'BKAFTER' })).status === 200));
      // download + upload of a new-layout backup
      const file = await S.req('/api/admin/backup-download', { id: B1.id }, H);
      const parsed = JSON.parse(file.text);
      const up = await S.admin('backup-import', { backup: parsed });
      const bad = JSON.parse(file.text); bad.pages[1].entries[0][1].seq += 1;
      const upBad = await S.admin('backup-import', { backup: bad });
      ck('SF12 DOWNLOAD streams the new-layout backup (manifest + pages); UPLOAD checks it (a changed file is refused)',
        file.status === 200 && parsed.format === 'flux-leaderboard-backup' && parsed.manifest.schema === 2 && parsed.pages.length === B1.pages.length && up.status === 200 && up.data.snapshot.verified && upBad.status === 400, file.status + '/' + up.status + '/' + upBad.status);
      // the pre-move backup brings the old layout back
      const r0 = await S.admin('backup-restore', { id: B0.id, confirm: 'RESTORE ' + B0.id });
      const vO = await S.view(ids12);
      ck('SF12 restoring the backup from BEFORE the move brings the old layout back exactly (new tables dropped)', r0.status === 200 && r0.data.verified && !g.map.has('storageLayout') && g.sql.tables().length === 0 && !sameView(vOld, vO).length, r0.status + ' ' + sameView(vOld, vO).join(','));
      const r1 = await S.admin('backup-restore', { id: B1.id, confirm: 'RESTORE ' + B1.id });
      const vN = await S.view(W);
      ck('SF12 ...and restoring the new-layout backup onto the old layout brings the new layout back', r1.status === 200 && r1.data.verified && g.map.get('storageLayout') === 'v2' && !sameView(vR, vN).length, r1.status + ' ' + sameView(vR, vN).join(','));
      // privacy deletion reaches every backup, both schemas
      const target = P(52), tpid = pidHashSync(target);
      const pd = await S.admin('privacy-delete', { pid: tpid, removePurchases: true });
      const chunksText = [...b.map].filter(([k]) => k.startsWith('c:')).map(([, v]) => v).join('');
      ck('SF11 a privacy deletion on the new layout erases the pilot from every backup (old and new schema) and the old layout\'s copy',
        pd.status === 200 && pd.data.backups.ok && pd.data.backups.changed >= 3 && !chunksText.includes(target) && !(g.map.get('players') || {})[target], JSON.stringify(pd.data && pd.data.backups));
      const list = (await S.admin('backups')).data.snapshots;
      ck('SF12 every backup still passes its check after the privacy clean-up', list.every((m) => m.verified), list.filter((m) => !m.verified).map((m) => m.id).join(','));
      now = Date.UTC(2026, 9, 7, 0, 5);
      await S.cron();
      const daily = (await S.admin('backups')).data.snapshots.find((m) => m.kind === 'daily');
      ck('SF12 the daily cron backs up the new layout (paged, verified)', daily && daily.schema === 2 && daily.verified);
    }

    /* ================= SF14 scale ================= */
    if (on('H')) {
      say('== SF14 scale ==');
      const g = new FakeStorage(seedOld(small ? 1000 : 5000, { seed: 21 })), S = mk(g);
      await S.move();
      const target = small ? 3000 : SCALE, t0 = realNow();
      const r = rng(99);
      let n = g.sql.count('pilots');
      for (let base = n; base < target; base += 1000) {
        const records = [];
        for (let i = base; i < Math.min(target, base + 1000); i++) records.push(recFor('bulk-' + i, i, r, 1791000000000 + i * 1000));
        const res = await S.doFetch('/import', { records });
        if (res.status !== 200) { ck('SF14 bulk import', false, res.status); break; }
      }
      const ms = realNow() - t0;
      n = g.sql.count('pilots');
      ck('SF14 the new layout holds ' + n.toLocaleString() + ' pilots (the old one fails near 8,000)', n >= target, ms + ' ms to load');
      now += 20000;
      const ups = [];
      for (let i = 0; i < 5; i++) ups.push((await S.submit('bulk-' + (100 + i), 45000 + i, 'hard', { name: 'BULK' + i })).status);
      ups.push((await S.submit('scale-new', 3000, 'easy', { name: 'SCALENEW' })).status);
      ck('SF14 uploads work at this size (existing and new pilots)', ups.every((s) => s === 200), ups.join(','));
      // brute force: every row, the old layout's rules
      const rows = g.sql.dump('pilots'), restricted = g.map.get('restricted') || {};
      const pub = rows.filter((x) => !restricted[x.pid]).map((x) => ({ x, rec: JSON.parse(x.rec) }));
      const W = DIFF_WEIGHT;
      const board = (d) => pub.map(({ x, rec }) => { let b; if (d) { b = rec.bests[d]; if (!b) return null; return { pid: x.pid, s: b.score, t: b.updatedAt || rec.updatedAt || 0, seq: x.seq }; }
        let best = null; for (const [k, v] of Object.entries(rec.bests)) { const w = Math.round(v.score * (W[k] || 1)); if (!best || w > best.s) best = { pid: x.pid, s: w, t: v.updatedAt || rec.updatedAt || 0, seq: x.seq }; } return best; })
        .filter(Boolean).sort((a, b) => b.s - a.s || a.t - b.t || a.seq - b.seq).slice(0, 100).map((e) => e.pid + ':' + e.s).join();
      const okB = [];
      for (const d of ['', 'easy', 'medium', 'hard']) { const lb = JSON.parse((await S.req('/api/leaderboard?limit=100' + (d ? '&difficulty=' + d : ''), null, {}, 'GET')).text); okB.push(lb.top.map((e) => e.pid + ':' + e.score).join() === board(d)); }
      const lb = JSON.parse((await S.req('/api/leaderboard?limit=100', null, {}, 'GET')).text), tot = {};
      for (const { x, rec } of pub) { let best = null; for (const [k, v] of Object.entries(rec.bests)) { const w = Math.round(v.score * (W[k] || 1)); if (best === null || w > best) best = w; } if (best !== null) tot[x.cc] = (tot[x.cc] || 0) + best; }
      ck('SF14 every board (ALL with the weights, Easy, Medium, Hard) and every country total equal a brute-force recount of every row', okB.every(Boolean) && lb.countries.every((c) => tot[c.country] === c.totalScore) && lb.countries.length === Object.keys(tot).length, okB.join(','));
      S.env.restart();
      const a = g.meter.read; await S.req('/api/entitlements?playerId=x', null, {}, 'GET');
      const cold = g.meter.read - a;
      let m0 = g.meter.read; await S.req('/api/leaderboard?limit=100', null, {}, 'GET'); const allCold = g.meter.read - m0;
      now += 20000; const w0 = { ...g.meter };
      const up = await S.submit('bulk-' + (n - 7), 300, 'easy', { name: 'BULK' + (n - 7) });
      const runRows = { status: up.status, read: g.meter.read - w0.read, written: g.meter.written - w0.written };
      const tb = realNow(), bw = { ...S.env._b.meter }, gr = g.meter.read;
      const bk = await S.admin('backup-now');
      const bkMs = realNow() - tb;
      report.scale = { pilots: n, loadMs: ms, coldStartRowsRead: cold, allBoardColdRowsRead: allCold, run: runRows,
        backup: { ms: bkMs, pages: bk.data.snapshot && bk.data.snapshot.pages.length, mb: bk.data.snapshot && +(bk.data.snapshot.bytes / 1048576).toFixed(1), rowsRead: g.meter.read - gr, backupRowsWritten: S.env._b.meter.written - bw.written } };
      ck('SF8 a cold start at ' + n.toLocaleString() + ' pilots reads ' + cold + ' rows (bound 30); the ALL board ' + allCold + ' rows the first time', cold <= 30 && allCold <= 1000);
      ck('SF14 a run at this size still writes a few rows', up.status === 200 && runRows.written <= 6, JSON.stringify(runRows));
      ck('SF14 the daily backup copes page by page at this size (verified; reads each row about once)', bk.status === 200 && bk.data.snapshot.verified && bk.data.snapshot.schema === 2 && report.scale.backup.rowsRead < n * 1.3, JSON.stringify(report.scale.backup));
    }

    /* ================= SF15 admin page + deploy ================= */
    if (on('K')) {
      say('== SF15 admin page and deploy ==');
      const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'), adminHtml.indexOf('<details id="advanced">'));
      ck('SF15 admin.html has a STORAGE section: status, back up, dry run, typed MIGRATE, check, rollback, clean-up',
        /<h2>STORAGE<\/h2>/.test(adminHtml) && /id="sgLoad"/.test(adminHtml) && /call\('storage-status'\)/.test(adminHtml) && /call\('migrate-storage-dry-run'\)/.test(adminHtml) && /call\('migrate-storage', \{ confirm: phrase \}\)/.test(adminHtml)
        && /call\('migrate-storage-check', \{ mode: x\[1\], cursor: cur \}\)/.test(adminHtml) && /call\('migrate-storage-rollback', \{ confirm: phrase \}\)/.test(adminHtml) && /call\('migrate-storage-cleanup', \{ confirm: phrase \}\)/.test(adminHtml));
      ck('SF15 the MOVE / ROLL BACK / CLEAN UP buttons stay disabled until the exact phrase is typed (MOVE also needs a recent backup)',
        /goBtn\.disabled = true;\n    inp\.oninput = function \(\) \{ goBtn\.disabled = inp\.value !== phrase \|\| \(extraOk \? !extraOk\(\) : false\); \};/.test(adminHtml) && /SG\.backup\.fresh/.test(adminHtml));
      ck('SF15 the GUIDE explains the storage move step by step in plain words', /<h3>Storage move \(2 MB limit\)<\/h3>/.test(guide) && /1\. Back up\./.test(guide) && /2\. Dry run\./.test(guide) && /3\. Approve and move\./.test(guide) && /4\. Check\./.test(guide) && /ROLLBACK/.test(guide) && /CLEAN UP/.test(guide));
      ck('SF15 the page still adds no event listeners and writes text only', (adminHtml.match(/addEventListener\(/g) || []).length === 2 && !/innerHTML/.test(adminHtml));
      const cfg = JSON.parse(WRANGLER.replace(/^\s*\/\/.*$/mg, ''));
      ck('SF15 deploy: the same LeaderboardDO class, binding and migration (no new class, no DO migration)',
        JSON.stringify(cfg.durable_objects.bindings) === JSON.stringify([{ name: 'LEADERBOARD_DO', class_name: 'LeaderboardDO' }]) && JSON.stringify(cfg.migrations) === JSON.stringify([{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }])
        && Object.keys(workerMod).filter((k) => k !== '__src').sort().join() === 'LeaderboardDO,default');
      let mainCfg = null;
      try { const r = spawnSync('git', ['show', 'origin/main:wrangler.jsonc'], { cwd: ROOT, encoding: 'utf8' }); if (r.status === 0 && r.stdout) mainCfg = r.stdout; } catch (e) {}
      ck('SF15 wrangler.jsonc is byte-identical to main', mainCfg === null || mainCfg === WRANGLER, mainCfg === null ? 'git not available' : '');
    }
  } catch (e) { ck('suite ran to the end', false, String(e.stack || e).slice(0, 600)); }
  finally { Date.now = realNow; console.error = realErr; }
  return { F, failed, report };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const t0 = Date.now();
const main = process.env.SF_NC ? { F: 0, failed: [], report: {} } : await suite({ workerMod: realMod, adminHtml: ADMIN_HTML, parts: process.env.SF_PARTS ? process.env.SF_PARTS.split(',') : null, small: !!process.env.SF_SMALL });
console.log('\n== SF13 free-plan cost table (measured with the fake row counter; Cloudflare\'s dashboard is the authority) ==');
console.log(JSON.stringify(main.report, null, 1));
console.log('suite time ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

if (process.env.SF_NO_NC) process.exit(main.F ? 1 : 0);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, parts, { worker = (s) => s, admin = (s) => s }) {
  if (process.env.SF_NC && !label.includes(process.env.SF_NC)) return;
  const w2 = worker(WORKER_SRC), a2 = admin(ADMIN_HTML);
  if (w2 === WORKER_SRC && a2 === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-storage-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ workerMod: Object.assign({ __src: w2 }, mod), adminHtml: a2, quiet: true, parts, small: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('a cold start reads every pilot (summary rebuilt each time)', 'SF8 a cold start', ['D'], { worker: rep('if (sum && sum.weights === JSON.stringify(DIFF_WEIGHT) && sum.bc && (sum.grid || "s") === this.gridTag()) { this.sum = sum; this.sumText = raw; return; }', '') });
await control('boards not kept in memory (every request reads rows)', 'SF5 a leaderboard request', ['D'], { worker: rep('board(d) { return this.boards[d] || (this.boards[d] =', 'board(d) { return (this.boards[d] =') });
await control('the dry run writes live data', 'SF2 the dry run wrote nothing live', ['B'], { worker: rep('await this.state.storage.put(MIG_DRY_KEY, report);', 'await this.state.storage.put({ [MIG_DRY_KEY]: report, storageLayout: "v2-dry" });') });
await control('the move without the typed confirmation', 'SF3 the move is refused without the exact typed phrase', ['B'], { worker: rep('if (b.confirm !== "MIGRATE " + dry.id) return', 'if (false) return') });
await control('the move without a backup from the last 60 minutes', 'SF3 the move is refused when the newest', ['B'], { worker: rep('const MIG_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;', 'const MIG_BACKUP_MAX_AGE_MS = 1e12;') });
await control('the move without a safety backup', 'SF4 the move takes a verified safety backup first', ['D'], { worker: rep('    if (p.needSafety) {\n      const sf = await sfSafety(env, "before the storage move "', '    if (false) {\n      const sf = await sfSafety(env, "before the storage move "') });
await control('a batch not written all-or-nothing', 'SF4 a failure mid-batch', ['D'], { worker: rep('db.tx(() => { for (const r of rows) db.replacePilot(r); });', 'for (const r of rows) db.replacePilot(r);') });
await control('the move restarts from zero after a failure', 'SF4 the move resumes where it stopped', ['D'], { worker: rep('const going = mig && (mig.phase === "copying" || mig.phase === "paused") && mig.id === dry.id;', 'const going = false;') });
await control('writes in flight lost at the switch', 'SF4 an upload in flight', ['D'], { worker: rep('      await this.waitIdle();\n      const w0 = this.sqlUse.written;', '      const w0 = this.sqlUse.written;') });
await control('the switch writes into the old layout\'s value', 'SF4 the old layout\'s values are kept untouched', ['D'], { worker: rep('await st.put({ [STORAGE_LAYOUT_KEY]: "v2", [MIG_KEY]: next });', 'await st.put({ [STORAGE_LAYOUT_KEY]: "v2", [MIG_KEY]: next, lastSubmit: {} });') });
await control('the switch goes ahead although a comparison failed', 'SF4 a copy that does not match the old layout is never switched to', ['B'], { worker: rep('const now = Date.now(), pass = checks.every((c) => c.pass);', 'const now = Date.now(), pass = true;') });
await control('the move copies a wrong country (row-building defect)', 'SF2 the dry run passes', ['B'], { worker: rep('cc: ISO2.test(String(rec.country || "")) ? rec.country : "XX", rs:', 'cc: "XX", rs:') });
await control('the ALL board ignores the difficulty weights (new layout)', 'SF2 the dry run passes', ['B'], { worker: rep('score: b.weighted, points: b.score, level: b.level, difficulty: b.difficulty, s: b.weighted,', 'score: b.score, points: b.score, level: b.level, difficulty: b.difficulty, s: b.score,') });
await control('ALL misses rounding ties beyond each board\'s top 100', 'SF9 ', ['E'], { worker: rep('    if (items.length >= BOARD_MAX) {\n      const v = items[BOARD_MAX - 1].s;', '    if (false) {\n      const v = items[BOARD_MAX - 1].s;') });
await control('colliding #tags not lengthened (new layout)', 'SF9 ', ['E'], { worker: rep('const len = rows.length > 1 ? 12 : 7, changed = [];', 'const len = 7, changed = [];') });
await control('a country leader not looked up again when it leaves', 'SF9 ', ['E'], { worker: rep('    for (const cc of need) this.relead(sum, cc);', '') });
await control('restrictions ignored by the new boards', 'SF9 ', ['E'], { worker: rep('this.db.updatePilot(row.seq, { rs: on ? 1 : 0 });', 'void 0;') });
await control('the check is blind to a changed restore answer', 'SF6 the check detects a damaged row', ['D'], { worker: rep('    if (a !== b) { r.restore++; bad = true; }', '    if (false) { r.restore++; bad = true; }') });
await control('clean-up without a full check', 'SF6 CLEAN UP is refused before', ['D'], { worker: rep('if (!chk || chk.mode !== "all" || !chk.done || !chk.pass || !(chk.at >= mig.switchedAt)) return', 'if (false) return') });
await control('rollback keeps the old values (loses what was written since the move)', 'SF7 ...with every score', ['F'], { worker: rep('await st.put({ players, lastSubmit, entitlements, seenSessions, countries: twin.countries,', 'await st.put({ countries: twin.countries,') });
await control('rollback without the typed phrase', 'SF7 rollback needs the typed ROLLBACK', ['F'], { worker: rep('if (b.confirm !== "ROLLBACK") return json({ error: "To roll back, type exactly: ROLLBACK" }, 400);', '') });
await control('a new-layout backup read without pausing writes', 'SF12 while a backup reads the pages', ['G'], { worker: rep('return !!this.restoring || !!(s && s.mode === "dump" && Date.now() - s.at < V2_FREEZE_MS);', 'return !!this.restoring;') });
await control('restore of a new-layout backup writes nothing', 'SF12 restore of a new-layout backup', ['G'], { worker: rep('if (apply && (dels.length || puts.length)) db.tx(', 'if (false) db.tx(') });
await control('the old layout\'s tables kept after restoring an old backup', 'SF12 restoring the backup from BEFORE the move', ['G'], { worker: rep('if (!want.has(STORAGE_LAYOUT_KEY) && st.sql) new V2SqlDb(st).drop();', '') });
await control('privacy deletion leaves new-layout backups', 'SF11 a privacy deletion on the new layout erases the pilot from every backup', ['G'], { worker: rep('if (m.schema === 2) { const r = await this.purgePaged(m, pid, removePurchases);', 'if (m.schema === 2) { const r = "unchanged";') });
await control('privacy deletion leaves the old layout\'s copy', 'SF11 a privacy deletion on the new layout also erases', ['E'], { worker: rep('const saving = o.state.storage.put({ flags: nextFlags, restoreLog: nextLog, ...old });', 'const saving = o.state.storage.put({ flags: nextFlags, restoreLog: nextLog });') });
await control('new layout: a repeated run id counts again', 'SF9 submit: the same run id again', ['E'], { worker: rep('if (seenRun && row) return this.submitReply(', 'if (false) return this.submitReply(') });
await control('new layout: country rank wrong in the upload reply', 'SF9 submit: ', ['E'], { worker: rep('      for (let k = 0; k < i; k++) if (B[k].cc === row.cc) countryRank++;', '') });
await control('storage routes without the password', 'SF3 every storage route needs the admin password', ['B'], { worker: rep('async function adminStorage(request, env, action) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminStorage(request, env, action) {') });
await control('admin page loses the STORAGE section', 'SF15 admin.html has a STORAGE section', ['K'], { admin: rep('<h2>STORAGE</h2>', '<h2>DATA</h2>') });
await control('admin page enables MOVE without the typed phrase', 'SF15 the MOVE / ROLL BACK / CLEAN UP buttons', ['K'], { admin: rep('    goBtn.disabled = true;\n    inp.oninput = function () { goBtn.disabled = inp.value !== phrase', '    goBtn.disabled = false;\n    inp.oninput = function () { goBtn.disabled = inp.value !== phrase') });
await control('guide loses the storage note', 'SF15 the GUIDE explains the storage move', ['K'], { admin: rep('<h3>Storage move (2 MB limit)</h3>', '<h3>Storage</h3>') });
const total = main.F + NC;
console.log('\n' + (total ? 'STORAGE FIX FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'STORAGE FIX PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
