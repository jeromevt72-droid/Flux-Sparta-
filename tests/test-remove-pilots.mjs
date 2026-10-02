// REMOVE PILOTS (owner): take test pilots (e.g. TITAN #QGAC1ZN, TITAN #WMKTZRQ, TESTER #VNXB79C) off the
// leaderboard with a backup, a dry run and a typed approval, while the real pilot (TITAN #KH2K8J7) stays.
// Runs on the NEW storage layout (one SQLite row per pilot) with the combined World Grid applied
// (Season 0 bests in the wg0 table), with the fake Durable Object of tests/test-storage-fix.mjs (node:sqlite).
//   R1  exact match only: one exact NAME + full #TAG; a name alone, a partial #TAG, a wrong name, a name
//       shared by two pilots with the same short #TAG (ambiguous) and a duplicate line are refused, never guessed;
//   R2  the dry run writes nothing (leaderboard + backup storage deep-equal) and reports bests, Season 0 bests,
//       country, purchases (loud warning for skins), country totals before -> after (= a brute-force recount),
//       boards affected; the protected real pilot is not in it;
//   R3  REMOVE NOW is refused (and nothing changes) without exactly "REMOVE <dry-run id>", without a checked
//       backup from the last 60 minutes (needBackup), when a listed pilot changed since the dry run, or when a
//       line is not exactly one pilot;
//   R4  removal: pilot rows + their wg0 rows gone, purchases and cooldowns kept, a safety backup taken first,
//       country totals equal a brute-force recount, every other pilot unchanged (the real TITAN too);
//   R5  the post-check answers PASS on every line;
//   R6  REMOVE SCORE also deletes the pilot's wg0 row: posting again never brings its Season 0 bests back;
//   R7  auth: both routes need the admin password / session (401), and the admin map + requireAdmin are in place;
//   R8  admin page: REMOVE PILOTS panel under FIND A PLAYER, real page script drives dry run -> typed phrase ->
//       REMOVE NOW -> post-check; REMOVE NOW disabled until the phrase is exact; undo note + guide;
//       addEventListener( stays 17 in the game and 2 in admin.html; text only (no innerHTML).
// Ends with negative controls: each defect re-inserted into worker.js / admin.html MUST be caught.
import fs from 'fs'; import path from 'path'; import util from 'util'; import v8 from 'v8'; import nodeCrypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { levelFor } from './level-rule.mjs';
process.removeAllListeners('warning');   // node:sqlite is "experimental" on this Node
const { DatabaseSync } = await import('node:sqlite');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');
const T0 = Date.UTC(2026, 9, 5, 12, 0);
const W = { easy: 0.09, medium: 0.21, hard: 1 }, C = { easy: 'e', medium: 'm', hard: 'h' };
const DIFFS = ['easy', 'medium', 'hard'];
const MIN = 60000;

/* ---------------- fake Durable Object runtime (as tests/test-storage-fix.mjs) ---------------- */
class FakeSql {
  constructor(meter) { this.db = new DatabaseSync(':memory:'); this.m = meter; this.stmts = new Map(); }
  stmt(q) { let s = this.stmts.get(q); if (!s) { s = this.db.prepare(q); this.stmts.set(q, s); } return s; }
  exec(q, ...args) {
    args = args.map((a) => (a === undefined ? null : a));
    const write = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q);
    const before = write ? this.db.prepare('SELECT total_changes() AS c').get().c : 0;
    const rows = this.stmt(q).all(...args).map((r) => ({ ...r }));
    const ch = write ? this.db.prepare('SELECT total_changes() AS c').get().c - before : 0;
    this.m.read += write ? ch : rows.length; this.m.written += ch;
    return { toArray: () => rows, one: () => rows[0], rowsRead: write ? ch : rows.length, rowsWritten: ch, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  }
  tables() { return this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name); }
  dump(t) { try { return this.db.prepare('SELECT * FROM ' + t + ' ORDER BY ' + (t === 'pilots' ? 'seq' : 'id')).all().map((r) => ({ ...r })); } catch (e) { return null; } }
}
class FakeStorage {
  constructor(map, { limit = 2 * 1024 * 1024 } = {}) { this.map = map || new Map(); this.limit = limit; this.meter = { read: 0, written: 0 }; this.sql = new FakeSql(this.meter); }
  async get(k) { this.meter.read++; return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v }, keys = Object.keys(obj);
    if (keys.length > 128) throw new Error('put: more than 128 keys');
    for (const kk of keys) if (v8.serialize(obj[kk]).length > this.limit) throw new Error('put: value over the limit (' + kk + ')');
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
  return env;
}
const snap = (st) => ({ kv: new Map([...st.map].map(([k, v]) => [k, structuredClone(v)])), sql: Object.fromEntries(st.sql.tables().map((t) => [t, st.sql.dump(t)])) });
const same = (a, b) => util.isDeepStrictEqual(a.sql, b.sql) && a.kv.size === b.kv.size && [...a.kv.keys()].every((k) => b.kv.has(k) && util.isDeepStrictEqual(a.kv.get(k), b.kv.get(k)));

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
const [TW1, TW2] = collidingIds();

/* ---------------- dataset ---------------- */
const best = (score, d, at = 1790000000000) => ({ score, level: levelFor(score, d), updatedAt: at });
function seed() {
  const m = new Map(), players = {}, arch = [];
  const pl = (id, name, cc, bests, n = 0) => { players[id] = { playerId: id, name, country: cc, updatedAt: 1790000000000 + n, bests }; };
  pl(P(1), 'TITAN', 'FR', { hard: best(42000, 'hard'), medium: best(30000, 'medium') }, 1);   // the REAL pilot
  pl(P(2), 'TITAN', 'FR', { easy: best(52000, 'easy') }, 2);                                     // test pilot, owns skins
  pl(P(3), 'TITAN', 'FR', { medium: best(9000, 'medium') }, 3);                                  // test pilot, has a cooldown
  pl(P(4), 'TESTER', 'FR', { hard: best(1500, 'hard') }, 4);                                     // test pilot, Season 0 leader of FR
  pl(TW1, 'TWIN', 'GB', { hard: best(3000, 'hard') }, 5);                                        // same name + short tag
  pl(TW2, 'TWIN', 'GB', { hard: best(3100, 'hard') }, 6);
  const CC = ['US', 'PH', 'JP', 'FR', 'BR'];
  for (let i = 10; i < 70; i++) pl(P(i), 'PILOT' + i, CC[i % CC.length], i % 7 === 0 ? {} : { [DIFFS[i % 3]]: best(1000 + i * 137, DIFFS[i % 3], 1790000000000 + i) }, i);
  m.set('players', players); m.set('season', 1); m.set('nameRulesV1', 1);
  arch.push({ playerId: P(1), name: 'TITAN', country: 'FR', bests: { hard: best(45000, 'hard', 1700000000001) } });
  arch.push({ playerId: P(2), name: 'TITAN', country: 'FR', bests: { medium: best(31000, 'medium', 1700000000002) } });
  arch.push({ playerId: P(4), name: 'TESTER', country: 'FR', bests: { hard: best(60000, 'hard', 1700000000004) } });
  for (let i = 10; i < 40; i += 3) arch.push({ playerId: P(i), name: 'PILOT' + i, country: CC[i % CC.length], bests: { easy: best(20000 + i * 11, 'easy', 1700000000000 + i) } });
  m.set('archive:season0', { season: 0, archivedAt: 1780000000000, players: arch.length, scores: arch.length, chunks: 1 });
  m.set('archive:season0:0', arch);
  m.set('entitlements', { [P(2)]: ['cosmic', 'toxic'], [P(1)]: ['solar'] });
  m.set('lastSubmit', { [P(3)]: 1790000005000, [P(1)]: 1790000006000 });
  m.set('restricted', {});
  return m;
}
/* Brute force, from the SQL tables only: per pilot max(Season 1, Season 0) per difficulty, weighted, best one. */
function recount(g) {
  const w0 = new Map((g.sql.dump('wg0') || []).map((r) => [r.id, r])), out = {};
  for (const r of g.sql.dump('pilots') || []) {
    if (r.rs) continue;
    const rec = JSON.parse(r.rec); let b = null;
    for (const d of DIFFS) {
      const s1 = rec.bests && rec.bests[d] ? rec.bests[d].score : null, z = w0.get(r.id), s0 = z ? z[C[d] + '_s'] : null;
      const s = Math.max(s1 == null ? -1 : s1, s0 == null ? -1 : s0);
      if (s < 0) continue;
      const wv = Math.round(s * W[d]); if (b == null || wv > b) b = wv;
    }
    if (b == null) continue;
    const o = out[r.cc] || (out[r.cc] = { totalScore: 0, playerCount: 0 }); o.totalScore += b; o.playerCount++;
  }
  return out;
}

/* ---------------- the suite ---------------- */
async function suite({ workerMod, adminHtml, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + String(x).slice(0, 300) + ']' : '')); if (!c) { F++; failed.push(l); } };
  const src = workerMod.__src || WORKER_SRC;
  const realNow = Date.now; let now = T0; Date.now = () => now;
  const realErr = console.error; console.error = () => {};
  const mk = async () => {
    const g = new FakeStorage(seed()), env = makeEnv(workerMod, g);
    const req = async (p, body, headers = {}, method = 'POST') => {
      const res = await workerMod.default.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, {});
      const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: res.status, data, text };
    };
    const admin = (route, body) => req('/api/admin/' + route, body, H);
    await admin('backup-now'); const dr = await admin('migrate-storage-dry-run');
    let r = null; for (let i = 0; i < 50; i++) { r = await admin('migrate-storage', { confirm: dr.data && dr.data.confirm }); if (r.status !== 200 || !r.data.more) break; }
    if (g.map.get('storageLayout') !== 'v2') throw new Error('storage move failed: ' + (r && r.text.slice(0, 200)));
    now += 61 * MIN;
    const wd = await admin('world-grid-dry-run'); await admin('backup-now');
    const wa = await admin('world-grid-apply', { id: wd.data.id, confirm: wd.data.confirm });
    if (!(wa.status === 200 && wa.data.ok)) throw new Error('world grid apply failed: ' + wa.text.slice(0, 300));
    const tag = async (id) => (await req('/api/restore-check', { playerId: id })).data.tag;
    return { g, env, req, admin, tag, b: env._b };
  };
  const countriesOf = async (S) => Object.fromEntries((await S.req('/api/leaderboard?limit=100', null, {}, 'GET', true)).data.countries.map((c) => [c.country, { totalScore: c.totalScore, playerCount: c.playerCount }]));
  try {
    const S = await mk(), g = S.g;
    const tReal = await S.tag(P(1)), tA = await S.tag(P(2)), tB = await S.tag(P(3)), tC = await S.tag(P(4)), tTw = await S.tag(TW1);
    const LINES = ['TITAN #' + tA, 'titan #' + tB, 'TESTER  #' + tC];
    ck('R0 (setup) new storage layout + combined World Grid applied; the TWINs share a short #TAG', g.map.get('storageLayout') === 'v2' && (g.sql.dump('wg0') || []).length > 5 && tTw.length === 12 && tReal !== tA && tA !== tB, tTw);

    /* ---- R7 auth ---- */
    const noAuth = [];
    for (const r of ['remove-pilots-dry-run', 'remove-pilots']) noAuth.push((await S.req('/api/admin/' + r, { lines: LINES })).status, (await S.req('/api/admin/' + r, { lines: LINES }, { 'x-admin-token': 'nope' })).status);
    ck('R7 auth required: both routes answer 401 without the admin password / session', noAuth.every((s) => s === 401), noAuth.join(','));
    ck('R7 the routes are in the admin map, the function checks the password first',
      /"\/api\/admin\/remove-pilots-dry-run":\s*\(\) => adminRemovePilots\(request, env, false\)/.test(src) && /"\/api\/admin\/remove-pilots":\s*\(\) => adminRemovePilots\(request, env, true\)/.test(src)
      && /async function adminRemovePilots\(request, env, real\) \{\n  const denied = requireAdmin\(request, env\); if \(denied\) return denied;/.test(src));

    /* ---- R2 dry run writes nothing ---- */
    const g0 = snap(g), b0 = snap(S.b), w0 = g.meter.written, bw0 = S.b.meter.written;
    const brute0 = recount(g), pub0 = await countriesOf(S);
    const d1 = await S.admin('remove-pilots-dry-run', { lines: LINES });
    ck('R2 the dry run writes nothing (leaderboard + backups deep-equal, no row or value written)', d1.status === 200 && same(snap(g), g0) && same(snap(S.b), b0) && g.meter.written === w0 && S.b.meter.written === bw0, d1.status + ' ' + (g.meter.written - w0));
    const D = d1.data || {}, pp = D.pilots || [];
    ck('R2 every line found, exact pilots (A, B, TESTER), id + phrase', D.canRemove === true && pp.length === 3 && pp.every((p) => p.status === 'found') && pp.map((p) => p.tag).join() === [tA, tB, tC].join() && /^[0-9A-Z]{8}$/.test(D.id) && D.confirm === 'REMOVE ' + D.id, JSON.stringify(pp.map((p) => p.status + ':' + p.tag)));
    ck('R2 the protected real pilot TITAN #' + tReal + ' is not in the report', !pp.some((p) => p.tag === tReal || p.pid === undefined) && !JSON.stringify(D).includes(tReal));
    const pA = pp[0], pC = pp[2];
    ck('R2 report: bests per difficulty, Season 0 bests, country, boards',
      pA.bests.easy && pA.bests.easy.score === 52000 && pA.season0.medium && pA.season0.medium.score === 31000 && pA.country === 'FR'
      && pC.season0.hard.score === 60000 && pC.bests.hard.score === 1500 && pC.boards.some((b) => b.board === 'hard') && pC.boards.some((b) => b.board === 'all')
      && D.boardsAffected.includes('all') && D.boardsAffected.includes('easy'), JSON.stringify(pA));
    ck('R2 purchases counted, with a loud warning for the pilot that owns skins', pA.purchases === 2 && pp[1].purchases === 0 && D.warnings.some((w) => w.includes('#' + tA) && /OWNS 2 SKINS/.test(w) && /cosmic, toxic/.test(w)), JSON.stringify(D.warnings));
    const fr = (D.countries || []).find((c) => c.country === 'FR');
    const exp = (() => { const a = recount(g); const gone = new Set([P(2), P(3), P(4)]); const z = { totalScore: 0, playerCount: 0 };
      const w0m = new Map((g.sql.dump('wg0') || []).map((r) => [r.id, r]));
      for (const r of g.sql.dump('pilots')) { if (!gone.has(r.id)) continue; const rec = JSON.parse(r.rec); let b = null;
        for (const d of DIFFS) { const s1 = rec.bests[d] ? rec.bests[d].score : -1, x = w0m.get(r.id), s0 = x && x[C[d] + '_s'] != null ? x[C[d] + '_s'] : -1, s = Math.max(s1, s0); if (s >= 0) { const v = Math.round(s * W[d]); if (b == null || v > b) b = v; } }
        if (b != null) { z.totalScore += b; z.playerCount++; } }
      return { before: a.FR, after: { totalScore: a.FR.totalScore - z.totalScore, playerCount: a.FR.playerCount - z.playerCount } }; })();
    ck('R2 country total before -> after (FR) equals a brute-force recount, and the live total', fr && D.countries.length === 1 && fr.before.totalScore === exp.before.totalScore && fr.before.playerCount === exp.before.playerCount
      && fr.after.totalScore === exp.after.totalScore && fr.after.playerCount === exp.after.playerCount && pub0.FR.totalScore === brute0.FR.totalScore, JSON.stringify(fr) + ' vs ' + JSON.stringify(exp));

    /* ---- R1 exact match only ---- */
    const bad = await S.admin('remove-pilots-dry-run', { lines: ['TITAN', 'TITAN #' + tA.slice(0, 5), 'TITA #' + tA, 'TITAN #' + tReal.slice(0, 6) + 'X', 'TWIN #' + tTw.slice(0, 7), 'TITAN #' + tA, 'TITAN #' + tA, 'PILOT #' + tA] });
    const st = (bad.data.pilots || []).map((p) => p.status);
    ck('R1 exact NAME + full #TAG only: name alone / partial tag invalid, wrong name / wrong tag not found, shared short tag ambiguous, duplicate refused',
      bad.status === 200 && JSON.stringify(st) === JSON.stringify(['invalid', 'invalid', 'not-found', 'not-found', 'ambiguous', 'found', 'duplicate', 'not-found']) && bad.data.canRemove === false, JSON.stringify(st));
    const tw = await S.admin('remove-pilots-dry-run', { lines: ['TWIN #' + tTw] });
    ck('R1 ...the full 12-character #TAG picks exactly one of the two TWINs', tw.data.canRemove === true && tw.data.pilots[0].tag === tTw);
    const badRm = await S.admin('remove-pilots', { lines: ['TITAN #' + tA, 'TITAN'], id: bad.data.id, confirm: 'REMOVE ' + bad.data.id });
    ck('R1 a list with a refused line cannot be removed (nothing changes)', badRm.status === 409 && same(snap(g), g0), badRm.status);

    /* ---- R3 refusals ---- */
    const refuse = [];
    for (const t of [{}, { id: D.id }, { id: D.id, confirm: 'REMOVE' }, { id: D.id, confirm: 'remove ' + D.id }, { id: D.id, confirm: D.id }, { id: D.id, confirm: 'REMOVE ' + D.id + ' ' }, { id: 'x', confirm: 'REMOVE x' }]) refuse.push((await S.admin('remove-pilots', { lines: LINES, ...t })).status);
    ck('R3 refused without exactly "REMOVE <dry-run id>" (400), nothing changed', refuse.every((s) => s === 400) && same(snap(g), g0), refuse.join(','));
    now += 61 * MIN;
    const old = await S.admin('remove-pilots', { lines: LINES, id: D.id, confirm: D.confirm });
    ck('R3 refused without a checked backup from the last 60 minutes (needBackup, Back up now), nothing changed', old.status === 409 && old.data.needBackup === true && /BACK UP NOW/.test(old.data.error) && same(snap(g), g0), old.status + ' ' + old.text.slice(0, 120));
    await S.admin('backup-now');
    now += 30 * MIN;
    await S.req('/api/submit-score', { playerId: P(3), name: 'TITAN', score: 9500, level: levelFor(9500, 'medium'), difficulty: 'medium', country: 'FR', season: 1 });
    const gx = snap(g);
    const chg = await S.admin('remove-pilots', { lines: LINES, id: D.id, confirm: D.confirm });
    ck('R3 refused when a listed pilot changed since the dry run ("run a new dry run"), nothing changed', chg.status === 409 && chg.data.changed === true && /new DRY RUN/.test(chg.data.error) && same(snap(g), gx), chg.status + ' ' + chg.text.slice(0, 120));

    /* ---- R4 / R5 removal ---- */
    const d2 = (await S.admin('remove-pilots-dry-run', { lines: LINES })).data;
    const pilots0 = g.sql.dump('pilots'), wg00 = g.sql.dump('wg0'), ents0 = g.sql.dump('ents'), cool0 = g.sql.dump('cool');
    const bkN0 = ((await S.admin('backups')).data.snapshots || []).length;
    const rm = await S.admin('remove-pilots', { lines: LINES, id: d2.id, confirm: d2.confirm });
    const R = rm.data || {};
    const gone = new Set([P(2), P(3), P(4)]), pilots1 = g.sql.dump('pilots'), wg01 = g.sql.dump('wg0');
    ck('R4 removal answers 200 with the removed pilots and the backups used', rm.status === 200 && R.removed && R.removed.length === 3 && !!R.backupId && !!R.safetyId && d2.id !== D.id, rm.status + ' ' + rm.text.slice(0, 300));
    ck('R4 removal deletes each pilot row AND its Season 0 (wg0) row', !pilots1.some((r) => gone.has(r.id)) && !wg01.some((r) => gone.has(r.id)) && wg00.some((r) => r.id === P(2)) && wg00.some((r) => r.id === P(4)));
    ck('R4 purchases (entitlements) and cooldowns are kept', util.isDeepStrictEqual(g.sql.dump('ents'), ents0) && g.sql.dump('cool').some((r) => r.id === P(3)) && cool0.every((c) => g.sql.dump('cool').some((d) => d.id === c.id && d.v === c.v)));
    const strip = (rows) => rows.filter((r) => !gone.has(r.id)).map(({ tag, ...x }) => x);
    ck('R4 every other pilot unchanged (rows, Season 0 rows), the real TITAN #' + tReal + ' too', util.isDeepStrictEqual(strip(pilots0), strip(pilots1)) && util.isDeepStrictEqual(wg00.filter((r) => !gone.has(r.id)), wg01)
      && pilots1.some((r) => r.id === P(1) && r.tag === tReal) && (await S.req('/api/restore-check', { playerId: P(1) })).data.bests.hard.score === 42000);
    const bkN1 = ((await S.admin('backups')).data.snapshots || []);
    ck('R4 a verified safety backup was taken just before', bkN1.length === bkN0 + 1 && bkN1.some((m) => m.id === R.safetyId && m.verified && m.kind === 'safety'), bkN1.map((m) => m.kind).join(','));
    const brute1 = recount(g), pub1 = await countriesOf(S);
    ck('R4 country totals recomputed = a brute-force recount (every country, public leaderboard)', util.isDeepStrictEqual(pub1, brute1) && pub1.FR.totalScore < pub0.FR.totalScore, JSON.stringify(pub1.FR) + ' vs ' + JSON.stringify(brute1.FR));
    const ids = (R.checks || []).map((c) => c.id + ':' + (c.ok ? 'PASS' : 'FAIL'));
    ck('R5 post-check PASS: gone, Season 0 gone, purchases kept, countries = recount, others unchanged', R.ok === true && JSON.stringify(ids) === JSON.stringify(['gone:PASS', 'season0:PASS', 'kept:PASS', 'countries:PASS', 'others:PASS']), JSON.stringify(R.checks));
    const after = await S.admin('remove-pilots-dry-run', { lines: LINES.concat(['TITAN #' + tReal]) });
    ck('R5 afterwards each removed line is NOT FOUND, the real pilot still FOUND', JSON.stringify(after.data.pilots.map((p) => p.status)) === JSON.stringify(['not-found', 'not-found', 'not-found', 'found']));
    now += 60000;
    await S.req('/api/submit-score', { playerId: P(4), name: 'TESTER', score: 100, level: 1, difficulty: 'hard', country: 'FR', season: 1 });
    const back = (await S.req('/api/restore-check', { playerId: P(4) })).data, lb = (await S.req('/api/leaderboard?limit=100&difficulty=hard', null, {}, 'GET')).data;
    ck('R4 a removed pilot that plays again starts from zero: its Season 0 best does not come back', back.bests.hard.score === 100 && !lb.top.some((x) => x.score === 60000) && !g.sql.dump('wg0').some((r) => r.id === P(4)), JSON.stringify(back.bests));

    /* ---- R6 REMOVE SCORE clears wg0 ---- */
    const t13 = await S.tag(P(13)), f13 = (await S.admin('find-player', { query: 'PILOT13 #' + t13 })).data.matches[0];
    const hadW = g.sql.dump('wg0').some((r) => r.id === P(13));
    const rs = await S.admin('remove-score', { pid: f13.pid });
    ck('R6 REMOVE SCORE also deletes the pilot\'s wg0 row (kept otherwise: 200, purchases/cooldown rules unchanged)', hadW && rs.status === 200 && !g.sql.dump('wg0').some((r) => r.id === P(13)) && !g.sql.dump('pilots').some((r) => r.id === P(13)), rs.status);
    now += 60000;
    await S.req('/api/submit-score', { playerId: P(13), name: 'PILOT13', score: 50, level: 1, difficulty: 'easy', country: 'JP', season: 1 });
    const e13 = (await S.req('/api/leaderboard?limit=100&difficulty=easy', null, {}, 'GET')).data.top.find((x) => x.tag === t13);
    ck('R6 ...so posting again never brings its Season 0 bests back', e13 && e13.score === 50 && util.isDeepStrictEqual(await countriesOf(S), recount(g)), JSON.stringify(e13));

    /* ---- R8 the admin page, real script ---- */
    try {
      const P2 = await mk(); await P2.admin('backup-now');
      const sent = [], replies = [];
      const fetchImpl = async (url, init = {}) => {
        const h = new Headers(init.headers || {}); h.set('x-admin-token', 'pw');
        sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
        const res = await workerMod.default.fetch(new Request(new URL(url, ORIGIN), { method: init.method || 'GET', headers: h, body: init.body }), P2.env, {});
        const txt = await res.clone().text(); try { replies.push({ url: String(url), status: res.status, data: JSON.parse(txt) }); } catch (e) {}
        return res;
      };
      const tick = () => new Promise((r) => setImmediate(r));
      const until = async (fn, n = 600) => { for (let i = 0; i < n; i++) { if (fn()) return true; await tick(); } return false; };
      const gp = boot(scriptsOf(adminHtml), { origin: ORIGIN, path: '/admin.html', store: makeStore({}).store, fetchImpl });
      const E = new Proxy({}, { get: (t, k) => gp.win.document.getElementById(k) });
      const lines = ['TITAN #' + await P2.tag(P(2)), 'TITAN #' + await P2.tag(P(3)), 'TESTER #' + await P2.tag(P(4))];
      E.rpLines.value = lines.join('\n');
      const n0 = sent.length; E.rpDry.onclick();
      await until(() => replies.some((r) => /remove-pilots-dry-run$/.test(r.url)) && E.rpGo.hidden === false);
      const dr = replies.find((r) => /remove-pilots-dry-run$/.test(r.url));
      ck('R8 page: DRY RUN sends the pasted lines, then shows the phrase box with REMOVE NOW disabled', dr && util.isDeepStrictEqual(sent[n0].body, { lines }) && E.rpGo.hidden === false && E.rpRemove.disabled === true && /REMOVE [0-9A-Z]{8}/.test(E.rpAsk.textContent), dr && dr.status);
      E.rpConfirm.value = 'REMOVE'; E.rpConfirm.oninput();
      const offWrong = E.rpRemove.disabled === true;
      E.rpConfirm.value = dr.data.confirm; E.rpConfirm.oninput();
      ck('R8 page: REMOVE NOW stays disabled until the phrase is exact', offWrong && E.rpRemove.disabled === false);
      E.rpRemove.onclick();
      await until(() => replies.some((r) => /remove-pilots$/.test(r.url)) && E.rpGo.hidden === true);
      const rr = replies.find((r) => /remove-pilots$/.test(r.url)), body = sent.find((s) => /remove-pilots$/.test(s.url)).body;
      ck('R8 page: REMOVE NOW sends lines + id + typed phrase, the post-check comes back PASS', rr && rr.status === 200 && rr.data.ok === true && body.id === dr.data.id && body.confirm === dr.data.confirm && util.isDeepStrictEqual(body.lines, lines) && gp.errors.length === 0, rr && rr.status + ' ' + gp.errors.join(';'));
    } catch (e) { ck('R8 page: the page flow ran', false, String(e.stack || e).slice(0, 300)); }
    const A = scriptsOf(adminHtml).join('\n');
    const sec = adminHtml.slice(adminHtml.indexOf('<h2>FIND A PLAYER</h2>'), adminHtml.indexOf('<h2>PLAYER STATS</h2>'));
    ck('R8 the REMOVE PILOTS panel sits under FIND A PLAYER: lines, DRY RUN, phrase, REMOVE NOW, undo note via backup',
      /<h2>REMOVE PILOTS<\/h2>/.test(sec) && /id="rpLines"/.test(sec) && /id="rpDry"/.test(sec) && /id="rpConfirm"/.test(sec) && /id="rpRemove" class="danger" disabled/.test(sec)
      && /no un-remove/.test(sec) && /DRY RUN<\/b> → <b>RESTORE NOW/.test(sec));
    ck('R8 a missing backup offers BACK UP NOW right there; a changed pilot asks for a new dry run', /if \(o\.data\.needBackup === true\) \{[\s\S]{0,260}btn\('BACK UP NOW', 'go'[\s\S]{0,120}call\('backup-now'\)/.test(A) && /if \(o\.data\.changed\)/.test(A));
    const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'));
    ck('R8 guide: "Removing test pilots: REMOVE PILOTS" (backup first, exact name + #TAG, check, undo via backup)',
      /<h3>Removing test pilots: REMOVE PILOTS<\/h3>/.test(guide) && /Back up first/.test(guide) && /TITAN #QGAC1ZN/.test(guide) && /TITAN #KH2K8J7/.test(guide) && /PASS/.test(guide) && /RESTORE NOW/.test(guide));
    ck('R8 addEventListener( pinned: 17 in the game, 2 in admin.html; text only (no innerHTML)', (GAME_HTML.match(/addEventListener\(/g) || []).length === 17 && (adminHtml.match(/addEventListener\(/g) || []).length === 2 && !/innerHTML/.test(A),
      (adminHtml.match(/addEventListener\(/g) || []).length);
  } catch (e) { ck('suite ran to the end', false, String(e.stack || e).slice(0, 600)); }
  finally { Date.now = realNow; console.error = realErr; }
  return { F, failed };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ workerMod: realMod, adminHtml: ADMIN_HTML });

console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { worker = (s) => s, admin = (s) => s }) {
  const w2 = worker(WORKER_SRC), a2 = admin(ADMIN_HTML);
  if (w2 === WORKER_SRC && a2 === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-rp-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ workerMod: Object.assign({ __src: w2 }, mod), adminHtml: a2, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('a name that merely contains the typed name matches', 'R1 exact', { worker: rep('.filter((r) => String(cleanName(v2dec(r.rec).name)).toUpperCase() === name || r.dname === name);', '.filter((r) => String(cleanName(v2dec(r.rec).name)).toUpperCase().includes(name));') });
await control('a shared short #TAG picks the first pilot', 'R1 exact', { worker: rep('if (exact.length === 1) return { line: raw, status: "found", row: exact[0] };', 'if (exact.length || named.length) return { line: raw, status: "found", row: (exact[0] || named[0]) };') });
await control('the dry run writes the summary row', 'R2 the dry run writes nothing', { worker: rep('    const { rows, ...plan } = await this.rpPlan(b.lines);', '    const { rows, ...plan } = await this.rpPlan(b.lines); this.saveSum(this.sum, true);') });
await control('no purchase warning', 'R2 purchases', { worker: rep('if (p.purchases) warnings.push(', 'if (false) warnings.push(') });
await control('no typed phrase check', 'R3 refused without exactly', { worker: rep('if (b.confirm !== "REMOVE " + id) return', 'if (false) return') });
await control('no recent-backup check', 'R3 refused without a checked backup', { worker: rep('  if (!bk.fresh) return json({ ok: false, needBackup: true, backup: bk,\n    error: "Nothing was removed', '  if (false) return json({ ok: false, needBackup: true, backup: bk,\n    error: "Nothing was removed') });
await control('the dry-run id is not compared', 'R3 refused when a listed pilot changed', { worker: rep('if (plan.id !== b.id) return json({ ok: false, changed: true,', 'if (false) return json({ ok: false, changed: true,') });
await control('removal leaves the wg0 row', 'R4 removal deletes', { worker: rep('        this.wgForget(row.id);   // and its Season 0 row goes', '        // and its Season 0 row goes') });
await control('removal deletes purchases', 'R4 purchases', { worker: rep('        this.wgForget(row.id);   // and its Season 0 row goes', '        this.wgForget(row.id); this.db.kvDel("ents", row.id);   // and its Season 0 row goes') });
await control('removal skips the country totals', 'R4 country totals', { worker: rep('        this.dropPilot(sum, row);\n        if (row.ls != null) this.db.kvPut("cool", row.id, row.ls);   // the cooldown is kept (as REMOVE SCORE)', '        this.db.deletePilot(row.seq);\n        if (row.ls != null) this.db.kvPut("cool", row.id, row.ls);   // the cooldown is kept (as REMOVE SCORE)') });
await control('REMOVE SCORE leaves the wg0 row (as before this change)', 'R6 REMOVE SCORE also deletes', { worker: rep('      this.wgForget(row.id);   // its Season 0 row goes too', '      // its Season 0 row goes too') });
await control('no admin password on the routes', 'R7 auth', { worker: rep('async function adminRemovePilots(request, env, real) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminRemovePilots(request, env, real) {\n  const denied = null;') });
await control('page: REMOVE NOW enabled before the phrase is exact', 'R8 page: REMOVE NOW stays disabled', { admin: rep("$('rpConfirm').oninput = function () { $('rpRemove').disabled = !rpDry || $('rpConfirm').value !== rpDry.confirm; };", "$('rpConfirm').oninput = function () { $('rpRemove').disabled = !rpDry; };") });
await control('page: an event listener instead of a property handler', 'R8 addEventListener', { admin: rep("$('rpDry').onclick = guard(rpDryRun);", "$('rpDry').addEventListener('click', guard(rpDryRun));") });
await control('page: no BACK UP NOW offer when the backup is missing', 'R8 a missing backup', { admin: rep('if (o.data.needBackup === true) {', 'if (false) {') });
await control('page: undo note dropped', 'R8 the REMOVE PILOTS panel', { admin: rep('<p class="note"><b>Undo:</b> there is no un-remove.', '<p class="note">') });

console.log(main.F || NC ? '\nFAILED: ' + main.F + ' check(s), ' + NC + ' control(s) not caught' : '\nALL PASS (remove pilots) + every negative control caught');
process.exit(main.F || NC ? 1 : 0);
