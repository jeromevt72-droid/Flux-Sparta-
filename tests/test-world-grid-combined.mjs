// COMBINED WORLD GRID (owner): ONE World Grid from the Season 0 archive and the
// Season 1 bests, in the game and on the gateway, no tabs. Dry run first; the owner
// approves; APPLY switches it on behind a stored switch; REVERT switches it off.
//   W1 per pilot and per difficulty the grid uses max(Season 0 best, Season 1 best), never the sum;
//   W2 difficulties combine with the weighted rule exactly as the ALL board and country totals do today;
//      before APPLY every public route answers exactly as the code on main does;
//   W3 country totals are recomputed from the consolidated pilots (checked independently of the worker);
//   W4 unmatched archive entries are flagged with a reason and left out, never guessed: pilot gone,
//      privacy-deleted (never brought back, also after a privacy deletion made later), conflicting
//      identity, invalid score; restricted pilots stay excluded, name-banned pilots show as PILOT (as today);
//   W5 the checks: "no current score lost: PASS" on real data, and each synthetic bug is reported as FAIL
//      (a lost score, a summed best, a resurrected pilot, a wrong country total, a dropped archive best,
//      a restricted pilot counted);
//   W6 the dry run writes nothing (leaderboard and backup storage deep-equal, no write at all);
//   W7 APPLY is refused without the admin session/password (+ CSRF header for a cookie session), without
//      exactly "APPLY <dry-run id>", without a checked backup from the last 60 minutes, with a dry run
//      older than 60 minutes, or when the archive changed since the dry run -- and then nothing changes;
//   W8 APPLY takes a verified safety backup, switches the World Grid (EARTH / MARS / JUPITER boards, ALL, WORLD countries) to the
//      consolidated data, runs the checks against the live routes, shows in the owner summary;
//   W9 APPLY and REVERT are reversible: the bests and the archive are never rewritten; after REVERT every
//      public route answers exactly as before APPLY; the switch survives a restart;
//   W10 after APPLY new runs still count: a run above the Season 0 best raises the grid, one below does not;
//   W11 if the check after the switch fails, the switch is turned back off by itself;
//   W12 the game's leaderboard (#43 tabs, none added) shows the combined grid once applied, and is unchanged before;
//   W13 the gateway World Grid shows ONE combined grid (no tabs) once applied, and is unchanged before;
//   W14 the Season 1 message no longer says "Fresh boards for everyone" (true before and after APPLY);
//   W15 admin page: WORLD GRID section (dry run, typed APPLY, REVERT, report in plain words, BACK UP NOW
//      when the backup is missing), guide note, owner summary; property handlers only;
//   W16 deploy: wrangler.jsonc as on main, no new export/class/migration; one storage accessor for pilots;
//   W17 a realistic dataset (Season 0 archive + Season 1, 10 countries): every check PASS.
//   W0 NEW STORAGE ONLY: on the old layout every WORLD GRID route refuses ("Move the storage first") and writes
//      nothing; every other check runs on the new layout (one SQL row per pilot, #44), reached through the real
//      storage move, on a real SQLite (node:sqlite) with Cloudflare's row counters (as tests/test-storage-fix.mjs);
//   W18 free plan: no new writes per run after APPLY, no full read on a cold start (restart + leaderboard read a
//      few hundred rows at 5,000 pilots), rows read / written by dry run, APPLY, REVERT and a leaderboard read;
//   W19 every combined board query uses an index (no table scan, no sort of the whole table);
//   W20 an upload's rank below the top 100 is exact on the combined board (counted on both indexes);
//   W21 a backup restore brings the switch back as it was in the backup (the Season 0 table is rebuilt).
// Ends with negative controls: each defect re-inserted into the sources MUST be caught.
// WG_REPORT=<file> also writes the realistic dry-run report to that file.
import fs from 'fs'; import path from 'path'; import util from 'util'; import vm from 'vm'; import v8 from 'v8'; import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { levelFor } from './level-rule.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const GATE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const WRANGLER = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');
const T0 = Date.UTC(2026, 9, 5, 12, 0);
const W = { easy: 0.09, medium: 0.21, hard: 1 };
const DIFFS = ['easy', 'medium', 'hard'];
const pidHash = async (id) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('flux-pid:' + id))).subarray(0, 8).toString('hex');

/* ---------------- fake Durable Object runtime (as tests/test-storage-fix.mjs: real SQLite + row counters) ---------------- */
process.removeAllListeners('warning');   // node:sqlite is "experimental" on this Node
const { DatabaseSync } = await import('node:sqlite');
const MB2 = 2 * 1024 * 1024;
class FakeSql {
  constructor(meter) { this.db = new DatabaseSync(':memory:'); this.m = meter; this.stmts = new Map(); this.plans = new Map(); this.log = null; }
  stmt(q) { let st = this.stmts.get(q); if (!st) { st = this.db.prepare(q); this.stmts.set(q, st); } return st; }
  count(t) { try { return this.db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; } catch (e) { return 0; } }
  scanPenalty(q, args) {   // a query that scans a whole table without LIMIT reads every row of it
    if (!/^\s*SELECT/i.test(q) || /\bLIMIT\b/i.test(q)) return 0;
    let plan = this.plans.get(q);
    if (!plan) { try { plan = this.db.prepare('EXPLAIN QUERY PLAN ' + q).all(...args).map((r) => r.detail); } catch (e) { plan = []; } this.plans.set(q, plan); }
    let n = 0; for (const d of plan) { const m = /^SCAN (\w+)/.exec(d); if (m) n += this.count(m[1] === 'p' ? 'pilots' : m[1] === 'w' ? 'wg0' : m[1]); }
    return n;
  }
  idxFactor(q) {   // index entries written with each changed row (estimate)
    if (/\bwg0\b/.test(q) && /^\s*(INSERT|REPLACE|DELETE)/i.test(q)) return 3;
    if (!/\bpilots\b/.test(q)) return 0;
    if (/^\s*(INSERT|REPLACE|DELETE)/i.test(q)) return 3;
    const m = /SET (.*) WHERE/i.exec(q); if (!m) return 0;
    let f = 0; for (const re of [/\be_[st]\b/, /\bm_[st]\b/, /\bh_[st]\b/, /\bt12\b/]) if (re.test(m[1])) f++;
    if (/\brs\b/.test(m[1])) f += 2;
    return f;
  }
  exec(q, ...args) {
    args = args.map((x) => (x === undefined ? null : x));
    if (this.log) this.log.push({ q, args });
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
  constructor(map, { limit = MB2 } = {}) { this.map = map || new Map(); this.limit = limit; this.meter = { read: 0, written: 0 }; this.sql = new FakeSql(this.meter); this.failPut = null; }
  get writes() { return this.meter.written; }
  async get(k) { this.meter.read++; return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v };
    const keys = Object.keys(obj);
    if (keys.length > 128) throw new Error('put: more than 128 keys');
    for (const kk of keys) { const n = v8.serialize(obj[kk]).length; if (n > this.limit) throw new Error('put: value over the ' + this.limit + '-byte limit (' + kk + ', ' + n + ' bytes)'); }
    if (this.failPut && this.failPut(obj)) throw new Error('storage failure');
    this.meter.written += keys.length;
    for (const kk of keys) this.map.set(kk, structuredClone(obj[kk]));
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
  transactionSync(fn) { this.sql.db.exec('BEGIN'); try { const r = fn(); this.sql.db.exec('COMMIT'); return r; } catch (e) { this.sql.db.exec('ROLLBACK'); throw e; } }
}
class FakeState {
  constructor(storage) { this.storage = storage; this.lock = Promise.resolve(); }
  blockConcurrencyWhile(fn) { const r = this.lock.then(fn); this.lock = r.then(() => {}, () => {}); return r; }
}
const newB = () => new FakeStorage(new Map(), { limit: 128 * 1024 });
function makeEnv(mod, g, b) {
  const inst = new Map(), env = { ADMIN_TOKEN: 'pw', _g: g, _b: b || newB() };
  env.LEADERBOARD_DO = { idFromName: (n) => n, get(id) {
    if (!inst.has(id)) { const st = new FakeState(id === 'global' ? env._g : id === 'backups' ? env._b : new FakeStorage()); inst.set(id, { st, o: new mod.LeaderboardDO(st, env) }); }
    const x = inst.get(id);
    return { fetch: async (url, init) => { await x.st.lock; return x.o.fetch(new Request(url, init)); } }; } };
  env.restart = () => inst.clear();
  env.obj = (id) => { env.LEADERBOARD_DO.get(id); return inst.get(id).o; };
  return env;
}
/* The leaderboard's whole state: key-value storage + every SQL table. */
const snapG = (g) => ({ kv: new Map([...g.map].map(([k, v]) => [k, structuredClone(v)])), sql: Object.fromEntries(g.sql.tables().map((t) => [t, g.sql.dump(t)])) });
const sameG = (g, s) => { const n = snapG(g); return sameMap(n.kv, s.kv) && util.isDeepStrictEqual(n.sql, s.sql); };
const tablesChanged = (g, s) => { const n = snapG(g).sql; return [...new Set([...Object.keys(n), ...Object.keys(s.sql)])].filter((t) => !util.isDeepStrictEqual(n[t], s.sql[t])).sort(); };
/* The stored data as a Map (current records from the pilot rows, the archive from its values): for expectGrid. */
function stateOf(g) {
  const m = new Map([...g.map].filter(([k]) => k.startsWith('archive:')).map(([k, v]) => [k, structuredClone(v)]));
  m.set('players', Object.fromEntries((g.sql.dump('pilots') || []).map((r) => [r.id, JSON.parse(r.rec)])));
  return m;
}
const cloneMap = (m) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
const sameMap = (a, b) => a.size === b.size && [...a.keys()].every((k) => b.has(k) && util.isDeepStrictEqual(a.get(k), b.get(k)));
const diffKeys = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => !a.has(k) || !b.has(k) || !util.isDeepStrictEqual(a.get(k), b.get(k)));

/* ---------------- datasets ---------------- */
const best = (score, d, at = 1) => ({ score, level: levelFor(score, d), updatedAt: at });
function putArchive(m, arch, chunks = 1) {
  const per = Math.ceil(arch.length / chunks) || 1, parts = [];
  for (let i = 0; i < arch.length; i += per) parts.push(arch.slice(i, i + per));
  m.set('archive:season0', { season: 0, archivedAt: 1780000000000, players: arch.length, scores: arch.reduce((n, a) => n + Object.keys(a.bests || {}).length, 0), chunks: parts.length });
  parts.forEach((c, i) => m.set('archive:season0:' + i, c));
}
/* A small hand-made case with every situation named. */
async function smallSeed() {
  const m = new Map(), players = {}, arch = [];
  const pl = (n, name, cc, bests) => { players[P(n)] = { playerId: P(n), name, country: cc, updatedAt: 1790000000000 + n, bests }; };
  const ar = (n, name, cc, bests) => arch.push({ playerId: typeof n === 'number' ? P(n) : n, name, country: cc, bests });
  pl(1, 'ALPHA', 'US', { hard: best(3000, 'hard'), easy: best(60000, 'easy') });   // both: hard from S0 (higher), easy from S1 (higher)
  ar(1, 'ALPHA', 'US', { hard: best(5000, 'hard'), easy: best(40000, 'easy') });
  pl(2, 'BRAVO', 'PH', {});                                                         // Season 0 only (record kept, bests cleared by the reset)
  ar(2, 'BRAVO', 'PH', { medium: best(20000, 'medium') });
  pl(3, 'CHARLIE', 'JP', { medium: best(9000, 'medium') });                         // Season 1 only
  ar(4, 'GONE', 'DE', { hard: best(90000, 'hard') });                               // pilot removed: flagged, not brought back
  ar(5, 'ERASED', 'DE', { hard: best(80000, 'hard') });                             // privacy-deleted (restore log): flagged
  pl(6, 'BADGUY', 'US', { hard: best(1000, 'hard') });                              // restricted
  ar(6, 'BADGUY', 'US', { hard: best(99000, 'hard') });
  pl(7, 'TWIN', 'KR', { hard: best(2000, 'hard') });                                // conflicting identity in the archive
  ar(7, 'TWIN', 'KR', { hard: best(7000, 'hard') });
  ar(7, 'TWIN', 'JP', { hard: best(70000, 'hard') });
  pl(8, 'MOVER', 'BR', { easy: best(1000, 'easy') });                               // changed country and name since Season 0
  ar(8, 'OLDNAME', 'PT', { medium: best(30000, 'medium'), bogus: best(1, 'medium') });   // + an unknown difficulty: flagged
  pl(9, 'RUDE', 'NZ', { hard: best(4000, 'hard') });                                // name-banned: shown as PILOT, counted
  ar(9, 'RUDE', 'NZ', { hard: best(6000, 'hard') });
  pl(10, 'HUGE', 'IS', {});
  ar(10, 'HUGE', 'IS', { hard: { score: 9999999, level: 9, updatedAt: 1 } });       // over the score limit: flagged
  ar('bad id!', 'NOID', 'US', { hard: best(5000, 'hard') });                        // invalid id: flagged
  pl(11, 'NOCC', '', { medium: best(5000, 'medium') });                             // no country: "XX" as today
  ar(11, 'NOCC', '', { medium: best(8000, 'medium') });
  m.set('players', players); m.set('season', 1); m.set('nameRulesV1', 1);
  putArchive(m, arch, 2);
  const p6 = await pidHash(P(6)), p5 = await pidHash(P(5));
  m.set('restricted', { [p6]: { at: 1, reason: 'cheat' } });
  m.set('nameBans', { RUDE: { at: 1 } });
  m.set('restoreLog', [{ at: 1, pid: p5, tag: 'X', name: '', reason: '(erased on privacy request)' }]);
  m.set('entitlements', { [P(1)]: ['solar'] });
  return m;
}
/* A realistic dataset: Season 0 archive + Season 1, ten countries. */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
async function realisticSeed(seed = 20260928, scale = 1) {
  const rnd = mulberry32(seed), m = new Map(), players = {}, arch = [];
  const CC = [['US', 120], ['BR', 80], ['PH', 60], ['IN', 50], ['DE', 35], ['JP', 30], ['KR', 20], ['NZ', 10], ['IS', 6], ['LU', 4]].map(([c, n]) => [c, n * scale]);
  const S0 = { easy: [20000, 320000], medium: [9000, 130000], hard: [2500, 42000] };   // old, higher Easy / Medium rates
  const S1 = { easy: [4000, 140000], medium: [3000, 85000], hard: [2500, 48000] };
  const PROB = { easy: 0.55, medium: 0.7, hard: 0.4 };
  const pick = (r) => Math.round(r[0] + (r[1] - r[0]) * rnd() ** 2);
  const bestsFrom = (R) => { const b = {}; for (const d of DIFFS) if (rnd() < PROB[d]) { const s = pick(R[d]); b[d] = best(s, d, 1780000000000 + Math.floor(rnd() * 1e9)); } if (!Object.keys(b).length) { const s = pick(R.medium); b.medium = best(s, 'medium'); } return b; };
  let n = 0; const meta = { both: 0, archiveOnly: 0, currentOnly: 0, moved: 0 }, bothIds = [];
  for (const [cc, size] of CC) for (let i = 0; i < size; i++) {
    n++; const id = P(n), name = 'ACE' + n, k = rnd();
    if (k < 0.55) {            // played both seasons
      const moved = rnd() < 0.04; if (moved) meta.moved++;
      arch.push({ playerId: id, name: n % 25 === 0 ? 'OLD' + n : name, country: moved ? 'CA' : cc, bests: bestsFrom(S0) });   // some renamed since Season 0
      players[id] = { playerId: id, name, country: cc, updatedAt: 1790000000000 + n, bests: bestsFrom(S1) }; meta.both++; bothIds.push(id);
    } else if (k < 0.8) {      // Season 0 only: the record was kept, its bests cleared by the Season 1 reset
      arch.push({ playerId: id, name, country: cc, bests: bestsFrom(S0) });
      players[id] = { playerId: id, name, country: cc, updatedAt: 1780000000000 + n, bests: {} }; meta.archiveOnly++;
    } else {                   // new in Season 1
      players[id] = { playerId: id, name, country: cc, updatedAt: 1790000000000 + n, bests: bestsFrom(S1) }; meta.currentOnly++;
    }
  }
  // Removed since Season 0 (REMOVE SCORE drops the record; the archive entry stays): flagged, not brought back.
  for (let j = 0; j < 8; j++) { n++; arch.push({ playerId: P(n), name: 'GONE' + j, country: CC[j % CC.length][0], bests: bestsFrom(S0) }); }
  // Privacy-deleted (restore log says so) with an archive entry left behind: flagged, never brought back.
  const erased = [];
  for (let j = 0; j < 3; j++) { n++; arch.push({ playerId: P(n), name: 'ERASED' + j, country: 'US', bests: bestsFrom(S0) }); erased.push(P(n)); }
  // Restricted (both seasons) and a name ban.
  const restrictedIds = [bothIds[2], bothIds[150]];
  // One conflicting duplicate, one invalid score.
  arch.push({ playerId: P(7), name: 'ACE7', country: 'MX', bests: { hard: best(44000, 'hard') } });
  n++; players[P(n)] = { playerId: P(n), name: 'ODD' + n, country: 'LU', updatedAt: 1, bests: { hard: best(3000, 'hard') } };
  arch.push({ playerId: P(n), name: 'ODD' + n, country: 'LU', bests: { hard: { score: -50, level: 1, updatedAt: 1 }, easy: best(50000, 'easy') } });
  m.set('players', players); m.set('season', 1); m.set('nameRulesV1', 1);
  putArchive(m, arch, 3);
  const restricted = {}; for (const id of restrictedIds) restricted[await pidHash(id)] = { at: 1, reason: 'test' };
  m.set('restricted', restricted);
  m.set('nameBans', { ACE12: { at: 1 } });
  m.set('restoreLog', await Promise.all(erased.map(async (id) => ({ at: 1, pid: await pidHash(id), tag: 'X', name: '', reason: '(erased on privacy request)' }))));
  m.set('entitlements', { [P(1)]: ['solar'], [P(2)]: ['cosmic', 'toxic'] });
  return { m, meta, restrictedIds, erased };
}
/* The consolidated grid, computed HERE from the stored data (not by the worker). */
function expectGrid(m, { restrictedIds = [], conflicted = [], invalid = [] } = {}) {
  const players = m.get('players'), meta = m.get('archive:season0'), arch = [];
  for (let i = 0; i < meta.chunks; i++) arch.push(...m.get('archive:season0:' + i));
  const pilots = [];
  for (const id of Object.keys(players)) {
    if (restrictedIds.includes(id)) continue;
    const r = players[id], b = {};
    for (const d of DIFFS) if (r.bests[d]) b[d] = r.bests[d].score;
    if (!conflicted.includes(id)) for (const a of arch) if (a.playerId === id) for (const d of DIFFS) {
      const s = a.bests[d] && a.bests[d].score;
      if (Number.isFinite(s) && s >= 0 && s <= 5000000 && !invalid.includes(id + ':' + d) && !(b[d] >= s)) b[d] = s;
    }
    if (!Object.keys(b).length) continue;
    const w = Math.max(...Object.entries(b).map(([d, s]) => Math.round(s * W[d])));
    pilots.push({ id, cc: /^[A-Z]{2}$/.test(r.country || '') ? r.country : 'XX', w, b });
  }
  const countries = {};
  for (const p of pilots) { const c = countries[p.cc] || (countries[p.cc] = { t: 0, n: 0 }); c.t += p.w; c.n++; }
  return { pilots, countries };
}

async function suite({ workerMod, gameHtml, gateHtml, adminHtml, quiet = false, mainMod = null }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + String(x).slice(0, 300) + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, WG = workerMod.LeaderboardDO.worldGrid || {};
  const src = workerMod.__src || WORKER_SRC;
  const realNow = Date.now; let now = T0; Date.now = () => now;
  const realErr = console.error; console.error = () => {};
  const mk = (g, b = newB(), mod = workerMod) => {
    const env = makeEnv(mod, g, b);
    const req = async (p, body, headers = {}, method = 'POST') => {
      const res = await mod.default.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, {});
      const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: res.status, data, text, headers: res.headers };
    };
    const admin = (route, body) => req('/api/admin/' + route, body, H);
    const board = async (d = '', limit = 100) => (await req('/api/leaderboard?limit=' + limit + (d ? '&difficulty=' + d : ''), null, {}, 'GET')).data;
    const publicView = async (strip = false) => {
      const out = {};
      for (const d of ['', 'easy', 'medium', 'hard']) { const x = await board(d); if (strip) { delete x.combined; delete x.gridCombined; } out['lb:' + d] = x; }
      for (const id of [P(1), P(2), P(3)]) out['rc:' + id] = (await req('/api/restore-check', { playerId: id })).data;
      return out;
    };
    const direct = async (p, body) => { const r = await env.LEADERBOARD_DO.get('global').fetch('https://do.internal' + p, { method: 'POST', body: JSON.stringify(body || {}) }); return { status: r.status, data: await r.json() }; };
    /* THE STORAGE MOVE (#44), through the real admin routes: backup -> dry run -> MIGRATE. */
    const move = async () => {
      await admin('backup-now'); const dr = await admin('migrate-storage-dry-run');
      let r = null; for (let i = 0; i < 50; i++) { r = await admin('migrate-storage', { confirm: dr.data && dr.data.confirm }); if (r.status !== 200 || !r.data.more) break; }
      return r;
    };
    return { env, req, admin, board, publicView, direct, move };
  };
  /* A leaderboard on the NEW layout: seeded as the old one, moved, then an hour later (the move's backup is too old for APPLY). */
  const mkV2 = async (m, mod = workerMod) => {
    const S = mk(new FakeStorage(cloneMap(m)), newB(), mod);
    const r = await S.move();
    if (!(r && r.status === 200 && r.data.switched) || S.env._g.map.get('storageLayout') !== 'v2') throw new Error('the storage move did not switch: ' + (r && r.text.slice(0, 200)));
    now += 61 * 60000;
    return S;
  };
  const gridOf = (lb) => ({ countries: Object.fromEntries((lb.countries || []).map((c) => [c.country, { t: c.totalScore, n: c.playerCount }])) });
  const sameCountries = (lb, exp) => util.isDeepStrictEqual(gridOf(lb).countries, exp.countries);

  try {
    /* ================= W1-W5 the consolidation (pure) ================= */
    if (!quiet) console.log('== W1-W5 consolidation ==');
    const sm = await smallSeed();
    /* W0: the old layout refuses. */
    { const O = mk(new FakeStorage(cloneMap(sm))); await O.board(); const s0 = snapG(O.env._g), w0 = O.env._g.meter.written;
      const rs = [await O.admin('world-grid-dry-run'), await O.admin('world-grid-apply', {}), await O.admin('world-grid-apply', { id: 'WG-abcdefg-12345678', confirm: 'APPLY WG-abcdefg-12345678' }), await O.admin('world-grid-revert')];
      ck('W0 on the OLD storage layout every WORLD GRID route refuses: "Move the storage first", and nothing is written',
        rs.every((x) => x.status === 409 && x.data.moveStorageFirst === true && /^Move the storage first/.test(x.data.error)) && sameG(O.env._g, s0) && O.env._g.meter.written === w0 && !O.env._b.map.size, rs.map((x) => x.status + ' ' + x.text.slice(0, 60)).join(' | '));
      const sw = new Map(cloneMap(sm)); sw.set('worldGrid', { combined: true, dryRunId: 'WG-abcdefg-12345678', appliedAt: 1 });
      const O2 = mk(new FakeStorage(sw)), lb = await O2.board('hard'), sum = await O2.admin('summary');
      ck('W0 ...the old layout serves Season 1 only, whatever the stored switch says, and the owner summary says "move the storage first"',
        !('combined' in lb) && lb.top.every((t) => t.score !== 5000) && sum.data.worldGrid && sum.data.worldGrid.layout === 'old' && sum.data.worldGrid.combined === false, JSON.stringify(sum.data.worldGrid)); }
    const S = await mkV2(sm);
    const dr = await S.admin('world-grid-dry-run');
    ck('W5 (setup) the dry run answers with a report', dr.status === 200 && dr.data && dr.data.ok && /^WG-[0-9a-z]+-[0-9a-f]{8}$/.test(dr.data.id) && dr.data.confirm === 'APPLY ' + dr.data.id, dr.status + ' ' + dr.text.slice(0, 200));
    const rep = dr.data || {};
    const chk = (id) => (rep.checks || []).find((k) => k.id === id) || {};
    ck('W5 "no current score lost: PASS" on the hand-made case (and every other check passes)', chk('no-current-score-lost').ok === true && rep.allPass === true && /no current score lost: PASS/.test(rep.text || ''), JSON.stringify(rep.checks));
    // The pure function, on the same input the leaderboard builds.
    const input = { archive: [], pilots: Object.values(sm.get('players')), restrictedIds: new Set([P(6)]), erasedIds: new Set([P(5)]), weights: W };
    for (let i = 0; i < sm.get('archive:season0').chunks; i++) input.archive.push(...sm.get('archive:season0:' + i));
    const res = WG.consolidateWorldGrid ? WG.consolidateWorldGrid(input) : null;
    const byId = res ? new Map(res.pilots.map((p) => [p.playerId, p])) : new Map();
    const a1 = byId.get(P(1)) || { bests: {} };
    ck('W1 max, never the sum: a Season 0 hard best above the Season 1 one wins (5,000 not 8,000)', a1.bests.hard && a1.bests.hard.score === 5000 && a1.bests.hard.season === 0, JSON.stringify(a1.bests.hard));
    ck('W1 ...and a Season 1 best above the Season 0 one stays (easy 60,000 not 100,000)', a1.bests.easy && a1.bests.easy.score === 60000 && a1.bests.easy.season === 1, JSON.stringify(a1.bests.easy));
    ck('W1 a Season 0 only pilot is back with their Season 0 best; a Season 1 only pilot keeps theirs', (byId.get(P(2)) || { bests: {} }).bests.medium?.score === 20000 && (byId.get(P(3)) || { bests: {} }).bests.medium?.score === 9000);
    const rowA = res && res.rows.find((x) => x.r.playerId === P(1));
    ck('W2 difficulties combine with the weighted rule as today: ALPHA = max(5,000 x1, 60,000 x0.09) = 5,400', rowA && rowA.score === 5400 && rowA.difficulty === 'easy' && rowA.points === 60000, rowA && rowA.score);
    const codeOf = (id) => (res ? res.flagged.filter((f) => f.playerId === id).map((f) => f.code + (f.difficulty ? ':' + f.difficulty : '')).sort().join(',') : '');
    ck('W4 an archive entry whose pilot is gone is flagged "pilot-gone" and not brought back', codeOf(P(4)) === 'pilot-gone' && !byId.has(P(4)));
    ck('W4 a privacy-deleted pilot is flagged "privacy-deleted", never brought back, and their old name is not repeated', codeOf(P(5)) === 'privacy-deleted' && !byId.has(P(5)) && res.flagged.find((f) => f.playerId === P(5)).name === '');
    ck('W4 conflicting identity (archived twice, different data): flagged, not merged (no guessing)', codeOf(P(7)) === 'conflicting-identity,conflicting-identity' && byId.get(P(7)).bests.hard.score === 2000);
    ck('W4 invalid archive scores and ids are flagged: over the limit, unknown difficulty, bad id', codeOf(P(10)) === 'invalid-score:hard' && codeOf(P(8)) === 'invalid-score:bogus' && res.flagged.some((f) => f.code === 'invalid-id') && !byId.get(P(10)).bests.hard);
    ck('W4 a restricted pilot is listed as flagged "restricted" and is on no board and in no country total', codeOf(P(6)) === 'restricted' && !res.rows.some((x) => x.r.playerId === P(6)) && res.countries.US.playerCount === 1);
    ck('W4 a pilot who changed name and country since Season 0 counts under the CURRENT name and country', byId.get(P(8)).country === 'BR' && byId.get(P(8)).name === 'MOVER' && byId.get(P(8)).bests.medium.score === 30000 && res.notes.countryChanged >= 1 && res.notes.nameChanged >= 1 && res.countries.BR && !res.countries.PT);
    const exp = { PH: { t: Math.round(20000 * 0.21), n: 1 }, JP: { t: Math.round(9000 * 0.21), n: 1 }, US: { t: 5400, n: 1 }, KR: { t: 2000, n: 1 }, BR: { t: Math.round(30000 * 0.21), n: 1 }, NZ: { t: 6000, n: 1 }, XX: { t: Math.round(8000 * 0.21), n: 1 } };
    ck('W3 country totals are the sum of the consolidated weighted bests (checked by hand)', res && util.isDeepStrictEqual(Object.fromEntries(Object.entries(res.countries).map(([k, c]) => [k, { t: c.totalScore, n: c.playerCount }])), exp), JSON.stringify(res && res.countries));
    ck('W5 the report lists every flagged entry with its reason, and never a playerId', (rep.flagged || []).length === res.flagged.length && rep.flagged.every((f) => f.reason && f.code) && !rep.text.includes(P(1)) && !JSON.stringify(rep).includes('aaaaaaaa-bbbb'));
    // Synthetic bugs: each must be reported as FAIL by the independent checks.
    const bug = (label, id, mutate) => {
      if (!res || !WG.checkWorldGrid) { ck('W5 ' + label, false, 'no worldGrid export'); return; }
      const r2 = structuredClone({ ...res, pilots: res.pilots, rows: res.rows, countries: res.countries, flagged: res.flagged });
      mutate(r2);
      const k = WG.checkWorldGrid(input, r2).find((c) => c.id === id);
      ck('W5 ' + label, k && k.ok === false, k && k.detail);
    };
    bug('a bug that loses a current score is reported: "no current score lost: FAIL"', 'no-current-score-lost', (r) => { r.pilots.find((p) => p.playerId === P(3)).bests.medium.score = 100; });
    bug('a pilot dropped from the ALL board is reported as a lost score', 'no-current-score-lost', (r) => { r.rows = r.rows.filter((x) => x.r.playerId !== P(3)); });
    bug('a summed best (Season 0 + Season 1) is reported: "no pilot counted twice: FAIL"', 'no-double-count', (r) => { r.pilots.find((p) => p.playerId === P(1)).bests.hard.score = 8000; });
    bug('a pilot listed twice is reported', 'no-double-count', (r) => { r.pilots.push(structuredClone(r.pilots[0])); });
    bug('an archived best dropped without a flag is reported', 'archive-accounted', (r) => { delete r.pilots.find((p) => p.playerId === P(2)).bests.medium; });
    bug('a wrong country total is reported', 'country-totals', (r) => { r.countries.US.totalScore += 1; });
    bug('a restricted pilot on the board is reported', 'restricted-excluded', (r) => { r.rows.push({ r: { playerId: P(6), bests: {} }, score: 1 }); });
    bug('a pilot brought back from the archive is reported', 'deleted-not-resurrected', (r) => { r.pilots.push({ playerId: P(4), name: 'GONE', country: 'DE', bests: { hard: { score: 90000, season: 0 } } }); r.flagged = r.flagged.filter((f) => f.playerId !== P(4)); });

    /* ================= W2 before APPLY: exactly as main ================= */
    if (!quiet) console.log('== W2 before APPLY nothing changes ==');
    const RS = await realisticSeed();
    if (mainMod) {
      const A = await mkV2(RS.m, mainMod), B = await mkV2(RS.m);
      const va = await A.publicView(), vb = await B.publicView(true);
      now += 1000;
      const sub = { playerId: P(1), name: 'ACE1', score: 47000, level: levelFor(47000, 'hard'), difficulty: 'hard', country: 'US', season: 1 };
      const sa = await A.req('/api/submit-score', sub), sb = await B.req('/api/submit-score', sub);
      ck('W2 before APPLY every public route answers exactly as the code on main (all/easy/medium/hard boards, restore-check, an upload)',
        util.isDeepStrictEqual(va, vb) && sa.text === sb.text && util.isDeepStrictEqual(await A.publicView(), await B.publicView(true)), sa.text.slice(0, 80) + ' | ' + sb.text.slice(0, 80));
      ck('W2 ...byte for byte: no combined field before APPLY', !('combined' in (await B.board())) && !('gridCombined' in (await B.board())));
    } else ck('W2 before APPLY (main not available: fixed checks only)', !('combined' in (await (await mkV2(RS.m)).board())));

    /* ================= W17 realistic dataset: dry run ================= */
    if (!quiet) console.log('== W17 realistic dataset ==');
    const R = await mkV2(RS.m), g = R.env._g, b = R.env._b;
    const before = await R.publicView();
    const beforeBoard = await R.board('', 100);
    const d1 = await R.admin('world-grid-dry-run');
    const rr = d1.data || {};
    ck('W17 realistic dataset: every check PASS, "no current score lost: PASS"', rr.allPass === true && /no current score lost: PASS/.test(rr.text || '') && (rr.checks || []).length === 6 && rr.layout === 'new' && /Storage: the new layout/.test(rr.text || ''), (rr.checks || []).filter((k) => !k.ok).map((k) => k.label + ': ' + k.detail).join(' | '));
    const c = rr.counts || {};
    ck('W17 the counts add up: archive bests = merged + flagged; pilots after = before + back from Season 0',
      c.archiveScores === c.mergedScores + c.flaggedScores && c.pilotsAfter === c.pilotsBefore + c.onlyArchive && c.onlyArchive === RS.meta.archiveOnly && c.restrictedExcluded === 2, JSON.stringify(c));
    ck('W17 flagged: 8 pilots gone, 3 privacy-deleted, 1 conflicting identity (2 entries), 1 invalid score, 2 restricted',
      ['pilot-gone', 'privacy-deleted', 'conflicting-identity', 'invalid-score', 'restricted'].map((k) => (rr.flagged || []).filter((f) => f.code === k).length).join() === '8,3,2,1,2', (rr.flagged || []).map((f) => f.code).join(','));
    ck('W17 the report has per-country before/after totals and ranks, top pilots before and after, in plain words',
      (rr.countries || []).length >= 10 && rr.countries.every((x) => x.after && x.after.rank && 'totalScore' in x.after) && rr.topBefore.length === 10 && rr.topAfter.length === 10 && /COUNTRIES \(before -> after\)/.test(rr.text) && /TOP PILOTS AFTER/.test(rr.text) && /FLAGGED \(\d+\)/.test(rr.text));
    const reportText = rr.text || '';

    /* ================= W6 the dry run writes nothing ================= */
    const gSnap = snapG(g), bSnap = cloneMap(b.map), gw = g.writes, bw = b.writes, gr = g.meter.read;
    const d2 = await R.admin('world-grid-dry-run');
    ck('W6 the dry run writes nothing: key-value storage, every SQL table and the backups deep-equal, no row written at all', d2.status === 200 && sameG(g, gSnap) && sameMap(b.map, bSnap) && g.writes === gw && b.writes === bw, diffKeys(g.map, gSnap.kv).join(',') + ' ' + tablesChanged(g, gSnap).join(',') + ' writes ' + (g.writes - gw));
    const nPilots = (g.sql.dump('pilots') || []).length, dryRead = g.meter.read - gr;
    ck('W6 ...it reads every pilot row once plus the archive (' + nPilots + ' pilots), and says so in its report', d2.data.cost && d2.data.cost.dryRun.rowsWritten === 0 && d2.data.cost.dryRun.rowsRead >= nPilots && d2.data.cost.dryRun.rowsRead <= nPilots + 20 && dryRead <= nPilots + 20 && /FREE PLAN COST/.test(d2.data.text), JSON.stringify(d2.data.cost && d2.data.cost.dryRun) + ' metered ' + dryRead);
    ck('W6 ...and the public routes did not change', util.isDeepStrictEqual(await R.publicView(), before));

    /* ================= W7 APPLY refusals ================= */
    if (!quiet) console.log('== W7 APPLY refusals ==');
    const id1 = rr.id, st = [];
    for (const t of [{}, { id: id1 }, { id: id1, confirm: 'APPLY' }, { id: id1, confirm: 'apply ' + id1 }, { id: id1, confirm: id1 }, { id: id1, confirm: 'APPLY ' + id1 + ' ' }, { id: 'WG-x', confirm: 'APPLY WG-x' }]) st.push((await R.admin('world-grid-apply', t)).status);
    ck('W7 APPLY is refused without exactly "APPLY <dry-run id>" (nothing written, no backup made)', st.every((x) => x === 400) && sameG(g, gSnap) && sameMap(b.map, bSnap), st.join(','));
    const nb = await R.admin('world-grid-apply', { id: id1, confirm: 'APPLY ' + id1 });
    ck('W7 APPLY is refused without a checked backup from the last 60 minutes, and offers BACK UP NOW (needBackup)', nb.status === 409 && nb.data.needBackup === true && /BACK UP NOW/.test(nb.data.error) && sameG(g, gSnap), nb.status + ' ' + nb.text.slice(0, 160));
    await R.admin('backup-now');
    const bkSnap = cloneMap(b.map);
    now += 61 * 60000;
    const old = await R.admin('world-grid-apply', { id: id1, confirm: 'APPLY ' + id1 });
    ck('W7 a backup older than 60 minutes does not count', old.status === 409 && old.data.needBackup === true && sameG(g, gSnap), old.status);
    await R.admin('backup-now');
    const stale = await R.admin('world-grid-apply', { id: id1, confirm: 'APPLY ' + id1 });
    ck('W7 a dry run older than 60 minutes is refused (run a new one)', stale.status === 409 && stale.data.stale === true && sameG(g, gSnap), stale.status + ' ' + stale.text.slice(0, 120));
    void bkSnap;
    // The archive changes after the dry run (a privacy deletion): refused.
    { const X = await mkV2(sm); const dx = await X.admin('world-grid-dry-run'); await X.admin('backup-now');
      const f = await X.admin('find-player', { query: 'BRAVO' }); await X.admin('privacy-delete', { pid: f.data.matches[0].pid });
      const ax = await X.admin('world-grid-apply', { id: dx.data.id, confirm: 'APPLY ' + dx.data.id });
      ck('W7 if the archive changed since the dry run (privacy deletion), APPLY is refused', ax.status === 409 && ax.data.stale === true && !X.env._g.map.has('worldGrid'), ax.status + ' ' + ax.text.slice(0, 120)); }
    // Password / session / CSRF.
    const noPw = []; for (const r of ['world-grid-dry-run', 'world-grid-apply', 'world-grid-revert']) noPw.push((await R.req('/api/admin/' + r, { id: id1, confirm: 'APPLY ' + id1 })).status, (await R.req('/api/admin/' + r, {}, { 'x-admin-token': 'nope' })).status);
    ck('W7 every WORLD GRID route needs the admin password (401), and nothing changed', noPw.every((x) => x === 401) && sameG(g, gSnap), noPw.join(','));
    { const L = await mkV2(sm);
      const lg = await L.req('/api/admin/login', { password: 'pw' }, { 'X-FLUX-Admin': '1' });
      const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
      const noHdr = await L.req('/api/admin/world-grid-dry-run', {}, { Cookie: cookie });
      const withHdr = await L.req('/api/admin/world-grid-dry-run', {}, { Cookie: cookie, 'X-FLUX-Admin': '1' });
      const revNoHdr = await L.req('/api/admin/world-grid-revert', {}, { Cookie: cookie });
      ck('W7 with the FLUX COMMAND login session: works with the CSRF header, refused (403) without it', lg.status === 200 && /^flux_admin=/.test(cookie) && noHdr.status === 403 && revNoHdr.status === 403 && withHdr.status === 200 && withHdr.data.allPass === true, [lg.status, noHdr.status, revNoHdr.status, withHdr.status].join(',')); }
    ck('W7 the routes are in the admin map, behind the admin password', /"\/api\/admin\/world-grid-dry-run":\s*\(\) => adminDO\(request, env, "\/world-grid-dry-run"/.test(src) && /"\/api\/admin\/world-grid-apply":\s*\(\) => adminWorldGridApply\(request, env\)/.test(src)
      && /"\/api\/admin\/world-grid-revert":\s*\(\) => adminDO\(request, env, "\/world-grid-revert"/.test(src) && /async function adminWorldGridApply\(request, env\) \{\n  const denied = requireAdmin\(request, env\); if \(denied\) return denied;/.test(src));

    /* ================= W8 APPLY ================= */
    if (!quiet) console.log('== W8 APPLY ==');
    await R.admin('backup-now');   // (the other leaderboards made above moved the clock)
    const d3 = (await R.admin('world-grid-dry-run')).data;
    const safetyBefore = [...b.map.values()].filter((m) => m && m.kind === 'safety').length;
    const bestsBefore = g.sql.dump('pilots'), archBefore = [...g.map.keys()].filter((k) => k.startsWith('archive:')).map((k) => [k, structuredClone(g.map.get(k))]);
    const preApply = snapG(g);
    const ap = await R.admin('world-grid-apply', { id: d3.id, confirm: 'APPLY ' + d3.id });
    ck('W8 APPLY with a recent checked backup and the typed phrase succeeds', ap.status === 200 && ap.data.ok === true && ap.data.applied === d3.id, ap.status + ' ' + ap.text.slice(0, 200));
    const applyChecks = (ap.data.checks || []).map((k) => '  ' + k.label.toLowerCase() + ': ' + (k.ok ? 'PASS' : 'FAIL') + '  (' + k.detail + ')').join('\n');
    const safeties = [...b.map.values()].filter((m) => m && m.kind === 'safety');
    const saf = safeties.find((m) => m.id === ap.data.safetyId);
    ck('W8 a verified safety backup of the leaderboard just before the switch was taken', safeties.length === safetyBefore + 1 && saf && saf.verified === true, saf && saf.id);
    ck('W8 the post-apply checks ran against the live routes, all PASS', (ap.data.checks || []).length === 8 && ap.data.checks.every((k) => k.ok) && ap.data.checks.some((k) => k.id === 'live-grid') && ap.data.checks.some((k) => k.id === 'live-no-current-score-lost'), JSON.stringify(ap.data.checks || []).slice(0, 300));
    const after = await R.board('', 100);
    const E = expectGrid(stateOf(g), { restrictedIds: RS.restrictedIds, conflicted: [P(7)], invalid: [] });
    ck('W8 the live World Grid is combined: combined true, country totals = sum of consolidated weighted bests (computed here)', after.combined === true && sameCountries(after, E), JSON.stringify(gridOf(after).countries).slice(0, 200));
    const expTop = E.pilots.map((p) => p.w).sort((x, y) => y - x).slice(0, 100);
    ck('W8 the ALL board is the consolidated grid: the top 100 scores match, each pilot once', util.isDeepStrictEqual(after.top.map((t) => t.score), expTop) && new Set(after.top.map((t) => t.pid)).size === after.top.length);
    ck('W8 the leaderboard response keeps its shape (top, countries, leadingCountry, difficulty, weighted, weights) + combined', ['top', 'countries', 'leadingCountry', 'difficulty', 'weighted', 'weights', 'combined', 'gridCombined'].every((k) => k in after) && after.top.every((t) => ['pid', 'tag', 'name', 'country', 'score', 'points', 'level', 'difficulty'].every((k) => k in t)) && !JSON.stringify(after).includes('aaaaaaaa-bbbb'));
    const easyAfter = await R.board('easy', 100);
    const hardAfter = await R.board('hard', 100);
    const expD = (d) => E.pilots.filter((p) => p.b[d] !== undefined).map((p) => p.b[d]).sort((x, y) => y - x).slice(0, 100);
    ck('W8 the EARTH / MARS / JUPITER boards (easy / medium / hard) are consolidated too: max(Season 0, Season 1) per pilot, each pilot once',
      util.isDeepStrictEqual(easyAfter.top.map((t) => t.score), expD('easy')) && util.isDeepStrictEqual(hardAfter.top.map((t) => t.score), expD('hard')) && new Set(hardAfter.top.map((t) => t.pid)).size === hardAfter.top.length
      && easyAfter.combined === true && sameCountries(easyAfter, E) && !util.isDeepStrictEqual(easyAfter.top, before['lb:easy'].top));
    const both = await R.req('/api/leaderboard?limit=100&boards=1', null, {}, 'GET');
    ck('W8 ?boards=1 (one request for the game\'s tabs) serves the consolidated boards', util.isDeepStrictEqual(both.data.boards.medium.map((t) => t.score), expD('medium')) && both.data.combined === true);
    const sum = await R.admin('summary');
    ck('W8 the FLUX COMMAND owner summary says the combined grid is live', sum.status === 200 && sum.data.worldGrid && sum.data.worldGrid.combined === true && sum.data.worldGrid.appliedAt === now);
    const banned = after.top.find((t) => t.name === 'PILOT');
    ck('W4 a name-banned pilot is still counted and shown as PILOT (as today)', !!banned || after.top.every((t) => t.name !== 'ACE12'));
    const chkLive = await R.direct('/world-grid-check');
    ck('W8 the live check passes after APPLY', chkLive.data.ok === true && chkLive.data.combined === true);

    /* ================= W9 reversible ================= */
    if (!quiet) console.log('== W9 reversible ==');
    const changed = diffKeys(g.map, preApply.kv).sort(), tchanged = tablesChanged(g, preApply);
    ck('W9 APPLY rewrote no best and no archive entry: only the switch and the derived country figures changed', util.isDeepStrictEqual(g.sql.dump('pilots'), bestsBefore) && archBefore.every(([k, v]) => util.isDeepStrictEqual(g.map.get(k), v)) && changed.join() === 'worldGrid' && tchanged.join() === 'v2meta,wg0', changed.join() + ' | ' + tchanged.join());
    R.env.restart();
    ck('W9 the switch survives a restart', (await R.board()).combined === true && sameCountries(await R.board('', 100), E));
    const rv = await R.admin('world-grid-revert');
    ck('W9 REVERT switches back', rv.status === 200 && rv.data.ok && rv.data.wasCombined === true && rv.data.worldGrid.combined === false);
    const reverted = await R.publicView();
    ck('W9 after REVERT every public route answers exactly as before APPLY', util.isDeepStrictEqual(reverted, before) && util.isDeepStrictEqual(await R.board('', 100), beforeBoard));
    ck('W9 after APPLY + REVERT the bests and the archive are unchanged, and the country figures are as before', util.isDeepStrictEqual(g.sql.dump('pilots'), bestsBefore) && archBefore.every(([k, v]) => util.isDeepStrictEqual(g.map.get(k), v)) && util.isDeepStrictEqual((await R.board('', 100)).countries, beforeBoard.countries) && diffKeys(g.map, preApply.kv).join() === 'worldGrid', diffKeys(g.map, preApply.kv).join(','));
    ck('W9 the owner summary says Season 1 only again', (await R.admin('summary')).data.worldGrid.combined === false);
    const d4 = (await R.admin('world-grid-dry-run')).data;
    const ap2 = await R.admin('world-grid-apply', { id: d4.id, confirm: 'APPLY ' + d4.id });
    ck('W9 APPLY works again after REVERT (same grid)', ap2.status === 200 && sameCountries(await R.board('', 100), E));

    /* ================= W10 new runs after APPLY ================= */
    if (!quiet) console.log('== W10 new runs ==');
    const players = stateOf(g).get('players'), meta0 = g.map.get('archive:season0'), arch0 = [];
    for (let i = 0; i < meta0.chunks; i++) arch0.push(...g.map.get('archive:season0:' + i));
    const s0only = arch0.find((a) => players[a.playerId] && !Object.keys(players[a.playerId].bests).length && a.bests.hard && !RS.restrictedIds.includes(a.playerId));
    const oldHard = s0only.bests.hard.score, p0 = players[s0only.playerId];
    now += 20000;
    const low = await R.req('/api/submit-score', { playerId: p0.playerId, name: p0.name, score: 2600, level: levelFor(2600, 'hard'), difficulty: 'hard', country: p0.country, season: 1 });
    const g1 = await R.board('', 100);
    const E1 = expectGrid(stateOf(g), { restrictedIds: RS.restrictedIds, conflicted: [P(7)] });
    ck('W10 after APPLY a run below the pilot\'s Season 0 best keeps the Season 0 best on the grid', low.status === 200 && sameCountries(g1, E1) && E1.pilots.find((p) => p.id === p0.playerId).b.hard === oldHard, low.status + ' ' + low.text.slice(0, 100));
    now += 20000;
    const hi = oldHard + 1000;
    const high = await R.req('/api/submit-score', { playerId: p0.playerId, name: p0.name, score: hi, level: levelFor(hi, 'hard'), difficulty: 'hard', country: p0.country, season: 1 });
    const E2 = expectGrid(stateOf(g), { restrictedIds: RS.restrictedIds, conflicted: [P(7)] });
    ck('W10 a run above it raises the grid (the new best counts, once)', high.status === 200 && sameCountries(await R.board('', 100), E2) && E2.pilots.find((p) => p.id === p0.playerId).b.hard === hi, high.text.slice(0, 100));
    ck('W10 the live checks still pass after new runs', (await R.direct('/world-grid-check')).data.ok === true);
    // A privacy deletion after APPLY: gone from the grid, the archive and the country totals.
    const victim = arch0.find((a) => players[a.playerId] && a.bests.hard && Object.keys(players[a.playerId].bests).length && !RS.restrictedIds.includes(a.playerId) && a.playerId !== P(7));
    const vpid = await pidHash(victim.playerId);
    const pd = await R.admin('privacy-delete', { pid: vpid });
    const E3 = expectGrid(stateOf(g), { restrictedIds: RS.restrictedIds, conflicted: [P(7)] });
    const lb3 = await R.board('', 100);
    ck('W4 a privacy deletion after APPLY: the pilot is gone from the grid and the totals, never brought back from the archive', pd.status === 200 && !lb3.top.some((t) => t.pid === vpid) && sameCountries(lb3, E3) && !JSON.stringify([...g.map.entries()].filter(([k]) => k.startsWith('archive:season0:'))).includes(victim.playerId) && (await R.direct('/world-grid-check')).data.ok === true);

    /* ================= W20 a rank below the top 100 on the combined board ================= */
    if (!quiet) console.log('== W20 ranks below the top 100 ==');
    { const st = stateOf(g), Ex = expectGrid(st, { restrictedIds: RS.restrictedIds, conflicted: [P(7)] });
      const hard = Ex.pilots.filter((p) => p.b.hard !== undefined).sort((x, y) => y.b.hard - x.b.hard);
      const pick = hard.find((p, i) => i >= 110 && i < hard.length - 5 && hard[i - 1].b.hard > p.b.hard && st.get('players')[p.id]);
      let ok = false, info = 'hard board ' + hard.length + ' pilots';
      if (pick) {
        const rec = st.get('players')[pick.id], want = hard.filter((p) => p.b.hard > pick.b.hard).length + 1, wantC = hard.filter((p) => p.b.hard > pick.b.hard && p.cc === pick.cc).length + 1;
        now += 20000;
        const r = await R.req('/api/submit-score', { playerId: pick.id, name: rec.name, score: 1, level: 1, difficulty: 'hard', country: rec.country, season: 1 });
        ok = r.status === 200 && r.data.isNewBest === false && r.data.rank === want && r.data.countryRank === wantC && r.data.best === (rec.bests.hard ? rec.bests.hard.score : 1) && r.data.above && r.data.above.score > pick.b.hard;
        info = 'want #' + want + ' (' + pick.cc + ' #' + wantC + '), got ' + r.text.slice(0, 160);
      }
      ck('W20 an upload from a pilot ranked below 100 on the combined JUPITER board gets its exact world and country rank', ok, info); }

    /* ================= W21 backup restore ================= */
    if (!quiet) console.log('== W21 backup restore ==');
    { const bkOn = (await R.admin('backup-now')).data.snapshot;
      await R.admin('world-grid-revert');
      const bkOff = (await R.admin('backup-now')).data.snapshot;
      const r1 = await R.admin('backup-restore', { id: bkOn.id, confirm: 'RESTORE ' + bkOn.id });
      const on1 = await R.board('', 100), ck1 = await R.direct('/world-grid-check');
      const r2 = await R.admin('backup-restore', { id: bkOff.id, confirm: 'RESTORE ' + bkOff.id });
      const off2 = await R.board('', 100), ck2 = await R.direct('/world-grid-check');
      ck('W21 restoring a backup taken while the grid was combined brings it back combined (Season 0 table rebuilt from the restored archive), checks PASS; one taken after REVERT brings Season 1 only',
        r1.status === 200 && on1.combined === true && ck1.data.ok === true && r2.status === 200 && !off2.combined && ck2.data.ok === true && ck2.data.combined === false,
        [r1.status, on1.combined, ck1.data.ok, r2.status, off2.combined, ck2.data.ok].join(',') + ' ' + JSON.stringify((ck1.data.checks || []).filter((k) => !k.ok)).slice(0, 200));
      const d5 = (await R.admin('world-grid-dry-run')).data; await R.admin('backup-now');
      await R.admin('world-grid-apply', { id: d5.id, confirm: d5.confirm }); }

    /* ================= W18 + W19 free plan (5,000 pilots) ================= */
    if (!quiet) console.log('== W18 free plan / W19 indexes ==');
    const cost = {};
    { const BIG = await realisticSeed(4242, 12), Z = await mkV2(BIG.m), zg = Z.env._g, N = (zg.sql.dump('pilots') || []).length;
      const ids = Object.keys(BIG.m.get('players')), pl = BIG.m.get('players');
      const meter = async (fn) => { const r0 = zg.meter.read, w0 = zg.meter.written; const out = await fn(); return { out, read: zg.meter.read - r0, written: zg.meter.written - w0 }; };
      const run = async (id, score, d) => { now += 20000; return meter(() => Z.req('/api/submit-score', { playerId: id, name: pl[id] ? pl[id].name : 'NEWBIE', score, level: levelFor(score, d), difficulty: d, country: pl[id] ? pl[id].country : 'FR', season: 1 })); };
      const withHard = ids.filter((id) => pl[id].bests.hard && !BIG.restrictedIds.includes(id));
      await Z.board();
      const runsBefore = [await run(withHard[5], 1, 'hard'), await run(withHard[6], pl[withHard[6]].bests.hard.score + 7, 'hard'), await run('brand-new-' + 1, 3000, 'hard')];
      const dry = await meter(() => Z.admin('world-grid-dry-run'));
      await Z.admin('backup-now');
      const ap = await meter(() => Z.admin('world-grid-apply', { id: dry.out.data.id, confirm: dry.out.data.confirm }));
      const warm = await Z.board();
      const runsAfter = [await run(withHard[15], 1, 'hard'), await run(withHard[16], pl[withHard[16]].bests.hard.score + 7, 'hard'), await run('brand-new-' + 2, 3000, 'hard')];
      Z.env.restart();
      zg.sql.log = [];
      const cold = await meter(() => Z.req('/api/leaderboard?limit=25&boards=1&v=cold' + now, null, {}, 'GET'));
      const log = zg.sql.log; zg.sql.log = null;
      const memo = await meter(() => Z.req('/api/leaderboard?limit=25&boards=1&v=memo' + now, null, {}, 'GET'));
      const rv = await meter(() => Z.admin('world-grid-revert'));
      const plans = log.filter((x) => /\bwg0\b/.test(x.q) && /^\s*SELECT/i.test(x.q)).map((x) => zg.sql.db.prepare('EXPLAIN QUERY PLAN ' + x.q).all(...x.args).map((r) => r.detail));
      cost.pilots = N; cost.archived = BIG.m.get('archive:season0').players;
      cost.dryRun = { rowsRead: dry.read, rowsWritten: dry.written };
      cost.apply = { rowsRead: ap.read, rowsWritten: ap.written, season0Rows: ap.out.data.season0Rows };
      cost.revert = { rowsRead: rv.read, rowsWritten: rv.written };
      cost.coldStartPlusLeaderboard = { rowsRead: cold.read, rowsWritten: cold.written };
      cost.leaderboardFromMemory = { rowsRead: memo.read };
      cost.runBefore = runsBefore.map((x) => x.written); cost.runAfter = runsAfter.map((x) => x.written);
      cost.runReadBefore = runsBefore.map((x) => x.read); cost.runReadAfter = runsAfter.map((x) => x.read);
      ck('W18 after APPLY a run writes exactly the rows it wrote before APPLY (no new writes per run: no best, new best, new pilot)',
        ap.out.status === 200 && warm.combined === true && runsAfter.every((x) => x.out.status === 200) && util.isDeepStrictEqual(cost.runBefore, cost.runAfter), JSON.stringify({ before: cost.runBefore, after: cost.runAfter }));
      ck('W18 no full read on a cold start: a restart + the game\'s leaderboard request read a few hundred rows at ' + N + ' pilots, never every pilot',
        cold.out.status === 200 && cold.out.data.combined === true && cold.read < 1500 && cold.read < N / 3 && cold.written === 0, JSON.stringify(cost.coldStartPlusLeaderboard));
      ck('W18 the dry run reads each pilot once + the archive and writes nothing; APPLY and REVERT cost what the report says (one-off, owner-triggered)',
        dry.written === 0 && dry.read <= N + 30 && ap.written <= 4 * cost.archived + 10 && ap.read <= 8 * N + cost.archived + 200 && ap.read < 5000000 * 0.01 && rv.written <= 3 && rv.read <= N + 30, JSON.stringify(cost));
      ck('W19 every combined board query uses an index: no table scan, no sort of the whole table',
        plans.length >= 3 && plans.every((p) => p.every((d) => !/^SCAN /.test(d) && !/TEMP B-TREE/.test(d))), JSON.stringify(plans.slice(0, 3)));
      if (!quiet) console.log('  cost: ' + JSON.stringify(cost)); }
    if (process.env.WG_REPORT && !quiet) {
      fs.mkdirSync(path.dirname(process.env.WG_REPORT), { recursive: true });
      fs.writeFileSync(process.env.WG_REPORT, reportText + '\nAFTER APPLY (the same dataset, through the real admin route; checks against the live /leaderboard incl. ?boards=1)\n' + applyChecks + '\n\nMEASURED ON 5,000 PILOTS (tests, real SQLite, Cloudflare-style row counters)\n' + JSON.stringify(cost, null, 2) + '\n');
      console.log('  (report written to ' + process.env.WG_REPORT + ')');
    }

    /* ================= W11 the check after the switch fails ================= */
    if (!quiet) console.log('== W11 automatic switch-back ==');
    { const X = await mkV2(sm); await X.board(); await X.admin('backup-now');
      const dx = (await X.admin('world-grid-dry-run')).data;
      const inst = X.env.obj('global'); inst.handleWorldGridCheck = async () => new Response(JSON.stringify({ ok: false, checks: [{ id: 'live-grid', label: 'x', ok: false, detail: 'injected' }] }), { status: 200 });
      const ax = await X.admin('world-grid-apply', { id: dx.id, confirm: 'APPLY ' + dx.id });
      ck('W11 if the check after the switch fails, APPLY switches back by itself and says so', ax.status === 500 && ax.data.reverted === true && X.env._g.map.get('worldGrid').combined === false && !(await X.board()).combined, ax.status + ' ' + ax.text.slice(0, 160)); }

    /* ================= W12 the game ================= */
    if (!quiet) console.log('== W12 the game ==');
    const lbCombined = (await R.req('/api/leaderboard?limit=25&boards=1', null, {}, 'GET')).data;
    await R.admin('world-grid-revert');
    const lbSeason = (await R.req('/api/leaderboard?limit=25&boards=1', null, {}, 'GET')).data;
    { const dd = (await R.admin('world-grid-dry-run')).data; await R.admin('backup-now'); await R.admin('world-grid-apply', { id: dd.id, confirm: dd.confirm }); }
    const renderGame = async (data, tab) => {
      const { store } = makeStore({ fluxPlayerId: 'player-x', fluxCallsign: 'NOVA', fluxProfileComplete: '1', fluxSeason: '1', fluxRunsPlayed: '4', fluxCountry: 'US' });
      const gm = boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store, fetchImpl: (u) => String(u).includes('/api/leaderboard') ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(data)) }) : Promise.reject(new TypeError('offline')) });
      vm.runInContext("var __lb={}; document.createElement=function(){ return { className:'', innerHTML:'', querySelector:function(s){ return __lb[s]||(__lb[s]={innerHTML:'',onclick:null}); }, querySelectorAll:function(){ return []; }, remove:function(){} }; }; openLeaderboard(" + JSON.stringify(tab) + ");", gm.ctx);
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
      return { html: String(vm.runInContext("(__lb['#lbBody']||{}).innerHTML", gm.ctx)), tabs: String(vm.runInContext("(__lb['#lbTabsBox']||{}).innerHTML", gm.ctx)), errors: gm.errors };
    };
    const noTabs = (h) => !/role="tab|class="[^"]*\btabs?\b|lbTab/i.test(h);
    const tabCount = (t) => (t.match(/role="tab"/g) || []).length;
    const gc = await renderGame(lbCombined, 'hard'), gw0 = await renderGame(lbCombined, 'world'), gs = await renderGame(lbSeason, 'hard');
    ck('W12 after APPLY the game leaderboard shows the combined grid on its own tabs (EARTH / MARS / JUPITER / WORLD, none added): the label and the consolidated JUPITER board',
      gc.errors.length === 0 && /BEST OF SEASON 0 \+ SEASON 1 · EACH PILOT COUNTED ONCE/.test(gc.html) && /BEST OF SEASON 0 \+ SEASON 1/.test(gw0.html) && tabCount(gc.tabs) === 4 && tabCount(gs.tabs) === 4
      && gc.html.includes(lbCombined.boards.hard[0].score.toLocaleString('en-US')) && gc.html !== gs.html, gc.errors.join(';') + ' ' + gc.html.slice(0, 200));
    ck('W12 before APPLY the game leaderboard is as today (no combined label)', gs.errors.length === 0 && !/SEASON 0/.test(gs.html) && /class="lbList"/.test(gs.html));
    ck('W12 the game adds no event listener (17 sites, as pinned by the regression suite)', (gameHtml.match(/addEventListener\(/g) || []).length === 17);

    /* ================= W13 the gateway ================= */
    if (!quiet) console.log('== W13 the gateway ==');
    const renderGate = (data) => {
      const { store } = makeStore({});
      const gw2 = boot(scriptsOf(gateHtml), { origin: ORIGIN, path: '/', store, fetchImpl: () => new Promise(() => {}) });
      vm.runInContext('window.renderGrid(' + JSON.stringify(data) + ')', gw2.ctx);
      const note = gw2.els.gridCombinedNote || {};
      return { html: String((gw2.els.gridRankArea || {}).innerHTML || ''), scorers: String((gw2.els.gridScorersArea || {}).innerHTML || ''), note: { hidden: note.hidden, text: String(note.textContent || '') }, errors: gw2.errors };
    };
    const wc = renderGate(await R.board('', 50)), ws = renderGate({ ...before['lb:'], combined: false, gridCombined: false });
    ck('W13 after APPLY the gateway World Grid is ONE combined grid: the note shows, one country table, no tabs',
      wc.errors.length === 0 && wc.note.hidden === false && /Season 0 and Season 1 combined: each pilot's best of both counts once\./.test(wc.note.text) && (wc.html.match(/class="rankTable"/g) || []).length === 1 && noTabs(wc.html + wc.scorers)
      && (wc.html.match(/class="rankRow/g) || []).length === Math.min(50, lbCombined.countries.length), wc.errors.join(';') + JSON.stringify(wc.note));
    ck('W13 before APPLY the gateway is as today (note hidden and empty)', ws.errors.length === 0 && ws.note.hidden === true && ws.note.text === '' && (ws.html.match(/class="rankTable"/g) || []).length === 1);
    // GATEWAY CLEAN TAPS (owner): +4 for the flag guard (window scroll; flag bar pointerdown / pointermove / pointercancel) -> 23
    ck('W13 the gateway adds no event listener (23 sites: 19 + the 4 of the flag clean-tap guard)', (gateHtml.match(/addEventListener\(/g) || []).length === 23
      && /window\.addEventListener\('scroll', function\(\)\{ lastScrollAt = Date\.now\(\);/.test(gateHtml) && /heroFlagBarEl\.addEventListener\('pointerdown'/.test(gateHtml) && /heroFlagBarEl\.addEventListener\('pointermove'/.test(gateHtml) && /heroFlagBarEl\.addEventListener\('pointercancel'/.test(gateHtml) && /<p class="gridCombinedNote" id="gridCombinedNote" hidden><\/p>/.test(gateHtml));

    /* ================= W14 the Season 1 message ================= */
    if (!quiet) console.log('== W14 the Season 1 message ==');
    const MSG = 'Season 1: new point rates on Easy and Medium.';
    { const { store, mem } = makeStore({ fluxBest_easy: '4000', fluxRunsPlayed: '3', fluxPlayerId: 'p-9', fluxCallsign: 'VEGA', fluxProfileComplete: '1' });
      const gm = boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store, fetchImpl: () => Promise.reject(new TypeError('offline')) });
      const t = String((gm.els.fluxNameToast || {}).textContent || '');
      ck('W14 the one-time message no longer says "Fresh boards for everyone"; a returning player sees the reworded one, true before and after APPLY',
        !/Fresh boards|starts now/i.test(gameHtml.replace(/\/\*[\s\S]*?\*\//g, '')) && t === MSG && mem.fluxSeasonNotice === '1', t); }
    ck('W14 the admin guide quotes the new message', adminHtml.includes('"' + MSG + '"') && !/Season 1 starts now/.test(adminHtml));

    /* ================= W15 admin page ================= */
    if (!quiet) console.log('== W15 admin page ==');
    const js = scriptsOf(adminHtml).join('\n');
    const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'), adminHtml.indexOf('<details id="advanced">'));
    ck('W15 admin.html has a WORLD GRID section: DRY RUN, REVERT, the report (checks, counts, countries, top pilots, flagged)',
      /<h2>WORLD GRID<\/h2>/.test(adminHtml) && /id="wgDry"/.test(adminHtml) && /id="wgRevert"/.test(adminHtml) && /id="wgReport"/.test(adminHtml) && /call\('world-grid-dry-run'\)/.test(js) && /call\('world-grid-revert'\)/.test(js)
      && /function showWgReport\(/.test(js) && /'Countries'/.test(js) && /'Top pilots after'/.test(js) && /'Flagged \('/.test(js) && /k\.ok \? 'PASS' : 'FAIL'/.test(js));
    ck('W15 APPLY is only offered after a passing dry run, behind the typed phrase (button disabled until it matches)',
      /if \(r\.allPass\) \{/.test(js) && /post\('world-grid-apply', \{ id: r\.id, confirm: inp\.value \}\)/.test(js) && /applyBtn\.disabled = true;\n      inp\.oninput = function \(\) \{ applyBtn\.disabled = inp\.value !== r\.confirm; \};/.test(js)
      && js.indexOf("post('world-grid-apply'") > js.indexOf('function showWgReport('));
    ck('W15 a missing backup offers BACK UP NOW right there', /if \(o\.data\.needBackup\) \{[\s\S]{0,200}btn\('BACK UP NOW', 'go'[\s\S]{0,120}call\('backup-now'\)/.test(js));
    ck('W15 the owner summary shows whether the combined grid is live', /var wg = d\.worldGrid/.test(js) && /'World Grid'/.test(js) && /COMBINED: Season 0 \+ Season 1/.test(js));
    ck('W15 the GUIDE explains the combined grid, the steps (backup, dry run, approve, apply, check), REVERT and flagged entries',
      /<h3>Combined World Grid<\/h3>/.test(guide) && /BACK UP NOW<\/b>/.test(guide) && /no current score lost<\/b>/.test(guide) && /APPLY NOW<\/b>/.test(guide) && /REVERT<\/b>/.test(guide) && /<b>Flagged<\/b>/.test(guide) && /never added together|never guessed/.test(guide));
    ck('W15 property handlers only (exactly two addEventListener, as B10 pins), text only (no innerHTML)', (adminHtml.match(/addEventListener\(/g) || []).length === 2 && !/innerHTML/.test(adminHtml) && /\$\('wgDry'\)\.onclick = guard\(wgDryRun\);/.test(js) && /\$\('wgRevert'\)\.onclick = guard\(wgRevert\);/.test(js));
    { const { store } = makeStore({}); const ga = boot(scriptsOf(adminHtml), { origin: ORIGIN, path: '/admin.html', store, fetchImpl: () => new Promise(() => {}) }); ck('W15 the admin page script runs without errors', ga.errors.length === 0, ga.errors.join(';')); }

    /* ================= W16 deploy ================= */
    const cfg = JSON.parse(WRANGLER.replace(/^\s*\/\/.*$/mg, ''));
    let mainCfg = null;
    try { const r = spawnSync('git', ['show', 'origin/main:wrangler.jsonc'], { cwd: ROOT, encoding: 'utf8' }); if (r.status === 0 && r.stdout) mainCfg = r.stdout; } catch (e) {}
    const strip16 = (t) => { const c = JSON.parse(t.replace(/^\s*\/\/.*$/mg, '')); delete c.routes; delete c.workers_dev; return JSON.stringify(c); };   // CUSTOM DOMAIN: the domain lines are not a World Grid change
    ck('W16 wrangler.jsonc identical to main (apart from the domain lines); no new export, class or migration', (mainCfg === null || strip16(mainCfg) === strip16(WRANGLER)) && JSON.stringify(cfg.migrations) === JSON.stringify([{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }]) && Object.keys(workerMod).filter((k) => k !== '__src').sort().join() === 'LeaderboardDO,default', mainCfg === null ? 'git not available' : '');
    { const a0 = src.indexOf('/* ------------------------ COMBINED WORLD GRID ------------------------ */'), sec = a0 >= 0 ? src.slice(a0, src.indexOf('  async handleLeaderboard(url) {', a0)) : '';
      ck('W16 the combined grid reads pilots only from the new layout (pilot rows page by page, per-board indexes), never the old "players" value',
        sec.length > 1000 && !/this\.players|pilotRecords|storage\.get\("players"\)/.test(sec) && /this\.v2\.scanPilots\(/.test(sec) && /wgRefuse\(\)/.test(sec)
        && /rowsD\(d, limit, smin\) \{\n    if \(!this\.comb\) return this\.db\.board\(d, limit, smin\);/.test(src)); }
  } catch (e) { ck('suite ran to the end', false, String(e.stack || e).slice(0, 600)); }
  finally { Date.now = realNow; console.error = realErr; }
  return { F, failed };
}

async function loadMain() {
  try {
    const r = spawnSync('git', ['show', 'origin/main:worker.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0 || !r.stdout) return null;
    const tmp = path.join(__dirname, '.wg-main-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, r.stdout);
    try { return await import(pathToFileURL(tmp).href); } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  } catch (e) { return null; }
}
const mainMod = await loadMain();
const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ workerMod: realMod, gameHtml: GAME_HTML, gateHtml: GATE_HTML, adminHtml: ADMIN_HTML, mainMod });

if (process.env.WG_SKIP_CONTROLS) { console.log(main.F ? 'FAILED ' + main.F : 'main suite passed (controls skipped)'); process.exit(main.F ? 1 : 0); }
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { worker = (s) => s, game = (s) => s, gate = (s) => s, admin = (s) => s }) {
  const w2 = worker(WORKER_SRC), g2 = game(GAME_HTML), t2 = gate(GATE_HTML), a2 = admin(ADMIN_HTML);
  if (w2 === WORKER_SRC && g2 === GAME_HTML && t2 === GATE_HTML && a2 === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-wg-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ workerMod: Object.assign({ __src: w2 }, mod), gameHtml: g2, gateHtml: t2, adminHtml: a2, quiet: true, mainMod });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('merge adds the two bests instead of taking the higher', 'W1 max, never the sum', { worker: rep('if (!c || b.score > c.score) m.bests[d] = { score: b.score, level: b.level, updatedAt: b.updatedAt || 0, season: 0 };', 'm.bests[d] = { score: b.score + (c ? c.score : 0), level: b.level, updatedAt: b.updatedAt || 0, season: 0 };') });
await control('merge lets a lower Season 0 best replace a Season 1 best (a current score is lost)', 'W1 ...and a Season 1 best', { worker: rep('if (!c || b.score > c.score) m.bests[d] = {', 'if (true) m.bests[d] = {') });
await control('merge brings back pilots who are gone', 'W4 an archive entry whose pilot is gone', { worker: rep('if (!m) { flag(a, erased.has(id) ? "privacy-deleted" : "pilot-gone"); continue; }', 'if (!m) { const nr = { playerId: id, name: a.name, country: a.country, updatedAt: 0, bests: Object.create(null) }; for (const d of Object.keys(a.bests || {})) if (wgValidBest(d, a.bests[d])) nr.bests[d] = { ...a.bests[d], season: 0 }; out.set(id, nr); continue; }') });
await control('privacy-deleted pilots are reported as merely gone', 'W4 a privacy-deleted pilot', { worker: rep('flag(a, erased.has(id) ? "privacy-deleted" : "pilot-gone")', 'flag(a, "pilot-gone")') });
await control('conflicting archive entries are guessed (the first one wins)', 'W4 conflicting identity', { worker: rep('if (!list.every((x) => JSON.stringify(x) === JSON.stringify(list[0]))) { for (const a of list) flag(a, "conflicting-identity"); continue; }', '') });
await control('invalid archive scores are merged', 'W4 invalid archive scores', { worker: rep('if (!wgValidBest(d, b)) { flag(a, "invalid-score", d); continue; }', 'if (!b) continue;') });
await control('restricted pilots counted in the consolidated grid', 'W4 a restricted pilot', { worker: rep('const rows = boardRows(m.pilots.filter((p) => !restricted.has(p.playerId)), null, weights);', 'const rows = boardRows(m.pilots, null, weights);') });
await control('the grid counts a pilot under the Season 0 country', 'W4 a pilot who changed name and country', { worker: rep('    if (String(a.country || "") !== String(m.country || "")) notes.countryChanged++;', '    if (String(a.country || "") !== String(m.country || "")) { notes.countryChanged++; m.country = a.country; }') });
await control('difficulties summed instead of the weighted best', 'W2 difficulties combine', { worker: rep('    if (b && (!best || w > best.weighted)) best = { ...b, difficulty: d, weighted: w };', '    if (b) best = { ...b, difficulty: d, weighted: (best ? best.weighted : 0) + w };') });
await control('the checks miss a lost current score', 'W5 a bug that loses a current score', { worker: rep('if (!ob || !(ob.score >= b.score)) lost.push(', 'if (false) lost.push(') });
await control('the checks miss a summed best', 'W5 a summed best', { worker: rep('if (!sources.includes(ob.score) || ob.score !== Math.max(...sources)) twice.push(', 'if (false) twice.push(') });
await control('the checks miss a dropped archive best', 'W5 an archived best dropped', { worker: rep('else unaccounted.push(', 'else void (') });
await control('the checks miss a wrong country total', 'W5 a wrong country total', { worker: rep('if (!s || !c || s.t !== c.totalScore || s.n !== c.playerCount) bad4.push(', 'if (false) bad4.push(') });
await control('the checks miss a resurrected pilot', 'W5 a pilot brought back', { worker: rep('for (const p of res.pilots) if (!cur.has(p.playerId)) bad6.push(', 'for (const p of []) if (!cur.has(p.playerId)) bad6.push(') });
await control('APPLY without the typed phrase', 'W7 APPLY is refused without exactly', { worker: rep('if (b.confirm !== "APPLY " + id) return json(', 'if (false) return json(') });
await control('APPLY without a recent checked backup', 'W7 APPLY is refused without a checked backup', { worker: rep('if (!recent) return json({ error: "No checked backup', 'if (false) return json({ error: "No checked backup') });
await control('APPLY accepts a backup of any age', 'W7 a backup older than 60 minutes', { worker: rep('const WORLD_GRID_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;', 'const WORLD_GRID_BACKUP_MAX_AGE_MS = 1e15;') });
await control('APPLY accepts an old dry run', 'W7 a dry run older than 60 minutes', { worker: rep('if (!(made <= now + 60000 && now - made <= WORLD_GRID_DRY_RUN_MAX_AGE_MS)) return', 'if (false) return') });
await control('APPLY ignores an archive change since the dry run', 'W7 if the archive changed', { worker: rep('if ((await this.worldGridFingerprint(input.archive)) !== id.slice(-8)) return', 'if (false) return') });
await control('dry-run route without the password', 'W7 every WORLD GRID route needs the admin password', { worker: rep('() => adminDO(request, env, "/world-grid-dry-run", {}),', '() => forwardToDO(request, env, "/world-grid-dry-run", { method: "POST" }),') });
await control('APPLY without a safety backup', 'W8 a verified safety backup', { worker: rep('try { const r = await backupDO(env, "/safety", post({ note: "before the combined World Grid " + id })); const d = await r.json(); safety = r.ok && d.ok ? d.snapshot : null; } catch (e) { safety = null; }', 'safety = { id: "none" };') });
await control('APPLY without the check on the live routes', 'W8 the post-apply checks ran', { worker: rep('  const ck = await lb("/world-grid-check", {});\n', '  const ck = { r: { ok: true }, d: { ok: true, checks: [] } };\n') });
await control('the owner summary does not show the World Grid', 'W8 the FLUX COMMAND owner summary', { worker: rep('    worldGrid: lb && lb.worldGrid ?', '    worldGridX: lb && lb.worldGrid ?') });
await control('the old layout serves the WORLD GRID routes', 'W0 on the OLD storage layout', { worker: rep('return this.layout === "v2" ? null : json({ ok: false, moveStorageFirst: true', 'return true ? null : json({ ok: false, moveStorageFirst: true') });
await control('the leaderboard ignores REVERT (the Season 0 table alone switches it on)', 'W9 after REVERT', { worker: rep('return !!(g && g.combined && this.wgId && this.wgId === g.dryRunId); }', 'return !!(g && this.wgId); }') });
await control('the dry run writes to storage', 'W6 the dry run writes nothing', { worker: rep('    const { report, input } = await this.worldGridReport(Date.now());', '    const { report, input } = await this.worldGridReport(Date.now());\n    await this.state.storage.put({ worldGridLastDryRun: report.id });') });
await control('APPLY does not rebuild the country totals', 'W8 the live World Grid is combined', { worker: rep('    this.worldGrid = next;\n    this.v2.regrid();\n    return json({ ok: true, worldGrid: this.worldGridState(), season0Rows', '    this.worldGrid = next;\n    return json({ ok: true, worldGrid: this.worldGridState(), season0Rows') });
await control('the switch is ignored by the leaderboard', 'W8 the live World Grid is combined', { worker: rep('get comb() { const g = this.o.worldGrid; return !!(g && g.combined && this.wgId && this.wgId === g.dryRunId); }', 'get comb() { return false; }') });
await control('the planet boards stay Season 1 only', 'W8 the EARTH / MARS / JUPITER boards', { worker: rep('this.rowsD(d, BOARD_MAX, null).map((r) => this.itemD(r, d))', 'this.db.board(d, BOARD_MAX, null).map((r) => this.itemD(r, d))') });
await control('the combined boards skip the Season 0 index (the check after APPLY catches it and switches back)', 'W8 APPLY with a recent checked backup', { worker: rep('    take(arch);\n', '') });
await control('APPLY writes the merged bests into the pilot rows', 'W9 APPLY rewrote no best', { worker: rep('    this.worldGrid = next;\n    this.v2.regrid();\n    return json({ ok: true, worldGrid: this.worldGridState(), season0Rows', '    this.worldGrid = next;\n    this.v2.scanPilots((r) => { this.v2.db.updatePilot(r.seq, { rec: v2enc(this.v2.recOf(r)) }); });\n    this.v2.regrid();\n    return json({ ok: true, worldGrid: this.worldGridState(), season0Rows') });
await control('the switch is not stored (lost on restart)', 'W9 the switch survives a restart', { worker: rep('    await this.state.storage.put({ [WORLD_GRID_KEY]: next });\n    this.worldGrid = next;\n    this.v2.regrid();\n    return json({ ok: true, worldGrid: this.worldGridState(), season0Rows', '    this.worldGrid = next;\n    this.v2.regrid();\n    return json({ ok: true, worldGrid: this.worldGridState(), season0Rows') });
await control('REVERT leaves the combined country totals', 'W9 after REVERT', { worker: rep('    this.worldGrid = next;\n    this.v2.regrid();\n    return json({ ok: true, wasCombined', '    this.worldGrid = next;\n    return json({ ok: true, wasCombined') });
await control('a run writes one more row once the grid is combined', 'W18 after APPLY a run writes', { worker: rep('      if (cooled) this.db.kvDel("cool", playerId);\n', '      if (cooled) this.db.kvDel("cool", playerId);\n      if (this.comb) this.db.kvPut("v2meta", "wgrun", String(now));\n') });
await control('a cold start reads every pilot once the grid is combined', 'W18 no full read on a cold start', { worker: rep('(sum.grid || "s") === this.gridTag()) {', '(sum.grid || "s") === this.gridTag() && !this.comb) {') });
await control('the Season 0 table has no index for JUPITER', 'W19 every combined board query uses an index', { worker: rep('  "CREATE INDEX IF NOT EXISTS wg0_h ON wg0 (h_s DESC, h_t) WHERE h_s IS NOT NULL",\n', '') });
await control('a rank below 100 ignores the Season 0 bests', 'W20 an upload from a pilot ranked below 100', { worker: rep('const a = this.db.boardKeys(d, RANK_EXACT_MAX, me.s), b = this.db.wgKeys(d, RANK_EXACT_MAX, me.s);', 'const a = this.db.boardKeys(d, RANK_EXACT_MAX, me.s), b = [];') });
await control('a restore keeps the switch but not the Season 0 table', 'W21 restoring a backup', { worker: rep('  async wgEnsure() {\n    const g = this.o.worldGrid;', '  async wgEnsure() {\n    const g = null;') });
await control('REVERT does not switch back', 'W9 REVERT switches back', { worker: rep('const next = { ...prev, combined: false, revertedAt: now,', 'const next = { ...prev, revertedAt: now,') });
await control('a failed check after APPLY leaves the switch on', 'W11 if the check after the switch fails', { worker: rep('    await lb("/world-grid-revert", { reason: "the check after APPLY failed" });\n', '') });
await control('a privacy deletion leaves the cached archive in memory', 'W7 if the archive changed', { worker: rep('    await this.state.storage.put(puts);\n    this.archiveCache = null; this.rowsCache = null;\n  }', '    await this.state.storage.put(puts);\n  }') });
await control('game: no combined label', 'W12 after APPLY the game', { game: rep("if(o.data && o.data.combined) html=", "if(false) html=") });
await control('game: a Season 0 tab added', 'W12 after APPLY the game', { game: rep("  return '<div class=\"lbTabs\" role=\"tablist\">'+FLUX_LB_TABS.map(", "  return '<div class=\"lbTabs\" role=\"tablist\"><button role=\"tab\">SEASON 0</button>'+FLUX_LB_TABS.map(") });
await control('gateway: no combined note', 'W13 after APPLY the gateway', { gate: rep("combinedNote.hidden = !data.combined;", "combinedNote.hidden = true;") });
await control('gateway: the note always shows', 'W13 before APPLY the gateway', { gate: rep("combinedNote.hidden = !data.combined;", "combinedNote.hidden = false;") });
await control('game: the old "Fresh boards" message', 'W14 the one-time message', { game: rep("const FLUX_SEASON_MSG='Season 1: new point rates on Easy and Medium.';", "const FLUX_SEASON_MSG='Season 1 starts now! Fresh boards for everyone.';") });
await control('admin: WORLD GRID section missing', 'W15 admin.html has a WORLD GRID section', { admin: rep('<h2>WORLD GRID</h2>', '<h2>GRID</h2>') });
await control('admin: APPLY enabled without the typed phrase', 'W15 APPLY is only offered', { admin: rep('applyBtn.disabled = true;', 'applyBtn.disabled = false;') });
await control('admin: no BACK UP NOW when the backup is missing', 'W15 a missing backup offers BACK UP NOW', { admin: rep("if (o.data.needBackup) {", "if (false) {") });
await control('admin: an event listener instead of a property handler', 'W15 property handlers only', { admin: rep("$('wgDry').onclick = guard(wgDryRun);", "$('wgDry').addEventListener('click', guard(wgDryRun));") });
await control('admin: guide loses the note', 'W15 the GUIDE explains', { admin: rep('<h3>Combined World Grid</h3>', '<h3>Grid</h3>') });
const total = main.F + NC;
console.log('\n' + (total ? 'COMBINED WORLD GRID FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'COMBINED WORLD GRID PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
