// FOUNDING PILOT (owner): the first 1,000 pilots (creation order, test pilots excluded) get the whole
// Solar Inferno package free forever, through the same entitlement path a purchase uses.
//   FP1  OFF by default changes nothing: every public answer, every admin answer the owner had, rows
//        read and written (runs, a new pilot, the leaderboard, a cold start) equal main's worker;
//   FP2  the dry run writes nothing (live values and every SQL table identical) and reports who WOULD
//        be numbered (count, first / last by #TAG, left out and why) and the rows it would write;
//   FP3  ON needs the admin login, the typed "FOUNDING ON" and a verified backup from the last 60 min;
//        it numbers existing pilots by seq, skipping restricted, removed, privacy-deleted and excluded
//        pilots, exactly 1,000 (never more), reports the rows written (1,002); resumable in batches;
//   FP4  atomic: concurrent ON / CONTINUE calls still give #1..#1,000 once each, to the right pilots;
//   FP5  new pilots get the next number at creation until full, then none; OFF stops it;
//   FP6  /api/entitlements and /api/restore-check return "solar" (+ the number) for a founder only; a
//        restore code, a restart and a backup restore bring it back; take back is explicit + typed;
//   FP7  Stripe purchases unaffected: the grant is never in the purchase records, admin grant / revoke
//        of a real purchase work as before, the purchase tools see Stripe purchases only;
//   FP8  free plan: no new request per run, no extra row written per run (one grant per new founder),
//        cold start reads unchanged; leaderboard rows carry the badge (fp), the summary the counter;
//   FP10 discoverability: the one-time message is a card with TRY IT NOW (puts the whole package on)
//        and LATER, seen only once a button is pressed (a run just hides it); THEMES & SKINS says
//        FOUNDING PILOT · FREE with EQUIP; a NEW dot on THEMES & SKINS until it is opened once;
//   FP9  the game: the full package unlocks (orb colours, launcher, backdrop), badge on the menu and on
//        board rows, the one-time message (exact text, once, never during a run), the spots-left line
//        (hidden at 0 / OFF); FLUX COMMAND section, first-screen counter, guide; listener counts kept.
// Ends with negative controls: each defect re-inserted into the source MUST be caught.
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
const GATE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');
const T0 = Date.UTC(2026, 9, 5, 9, 0);
const MSG = (n) => "You're Founding Pilot #" + n + '! Solar Inferno is yours.';

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
async function suite({ mod, main, game = GAME_HTML, adminHtml = ADMIN_HTML, gate = GATE_HTML, quiet = false, parts = null }) {
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
    const submit = (id, score, o = {}) => req('/api/submit-score', { playerId: id, name: o.name || 'NEWBIE', score, level: levelFor(score, 'easy'), difficulty: 'easy', country: 'US', season: 1 });
    const ent = (id) => req('/api/entitlements?playerId=' + encodeURIComponent(id), null, {}, 'GET');
    const rc = (id) => req('/api/restore-check', { playerId: id });
    const lb = () => req('/api/leaderboard?limit=50&boards=1&v=' + now, null, {}, 'GET');
    const meter = async (fn) => { const a = { ...g.meter }; const out = await fn(); return { out, read: g.meter.read - a.read, written: g.meter.written - a.written }; };
    return { env, req, admin, doFetch, seed, submit, ent, rc, lb, meter, g };
  };
  const fndRows = (g) => (g.sql.dump('fnd') || []).map((r) => ({ id: r.id, ...JSON.parse(r.v) }));
  const pidOf = (i) => pidHashSync(P(i)), tagOf = (i) => tagFromPid(pidOf(i), 7);

  try {
    /* ================= FP1 OFF changes nothing (vs main) ================= */
    if (on('A') && main) {
      say('== FP1 OFF by default: identical to main ==');
      const run = async (m) => {
        now = T0;
        const S = mk(m, newStorage()), out = {}, cost = {};
        await S.seed(1, 60);
        await S.admin('restrict', { pid: pidOf(3), reason: 'test' });
        for (const id of [P(1), P(2), P(3), P(99)]) { out['ent:' + id] = (await S.ent(id)).text; out['rc:' + id] = (await S.rc(id)).text; }
        await S.doFetch('/grant', { playerId: P(2), sku: 'cosmic', sessionId: 'cs_test_1' });
        out['ent:after-grant'] = (await S.ent(P(2))).text;
        out.lb = (await S.lb()).text; out.lbAll = (await S.req('/api/leaderboard?limit=25', null, {}, 'GET')).text;
        let x = await S.meter(() => S.submit(P(5), 50000)); out.runBest = x.out.text; cost.runBest = [x.read, x.written];
        x = await S.meter(() => S.submit(P(5), 10)); out.runNoBest = x.out.text; cost.runNoBest = [x.read, x.written];
        x = await S.meter(() => S.submit(P(500), 900)); out.runNew = x.out.text; cost.runNew = [x.read, x.written];
        x = await S.meter(() => S.lb()); cost.lb = [x.read, x.written];
        S.env.restart();
        x = await S.meter(() => S.ent(P(7))); out.coldEnt = x.out.text; cost.cold = [x.read, x.written];
        const sum = (await S.admin('summary')).data || {}; delete sum.at; delete sum.founding; delete sum.usage; out.summary = JSON.stringify(sum);
        out.find = (await S.admin('find-player', { query: 'PILOT1' })).text;
        out.state = JSON.stringify([...S.g.map.keys()].sort()) + JSON.stringify(S.g.sql.tables().filter((t) => t !== 'fnd').map((t) => S.g.sql.dump(t)));
        return { out, cost };
      };
      const a = await run(main), b = await run(mod);
      const diff = Object.keys(a.out).filter((k) => a.out[k] !== b.out[k]);
      ck('FP1 OFF: every public and admin answer equals main\'s (entitlements, restore-check, boards, runs, a new pilot, summary, find)', diff.length === 0, diff.join(', ') || Object.keys(a.out).length + ' answers');
      ck('FP1 OFF: rows read and written equal main\'s (a run with / without a best, a new pilot, the leaderboard, a cold start)', util.isDeepStrictEqual(a.cost, b.cost), JSON.stringify(b.cost));
      report.costOff = b.cost;
    }

    /* ================= FP2 / FP3 dry run, ON ================= */
    if (on('B')) {
      say('== FP2 dry run · FP3 ON ==');
      now = T0;
      const S = mk(mod, newStorage());
      await S.seed(1, 1040);
      await S.admin('restrict', { pid: pidOf(3), reason: 'spam' });
      await S.admin('restrict', { pid: pidOf(8), reason: 'spam' });
      await S.admin('remove-score', { pid: pidOf(5) });                       // removed: no pilot row
      await S.admin('privacy-delete', { pid: pidOf(6), removePurchases: true });   // privacy-deleted
      const ex1 = await S.admin('founding-exclude', { tag: '#' + tagOf(11) });
      const ex2 = await S.admin('founding-exclude', { tag: tagOf(12) });
      ck('FP3 the exclusion list takes a #TAG (with or without #) and shows the pilot', ex1.status === 200 && ex2.status === 200 && ex2.data.excluded.length === 2 && ex2.data.excluded.some((x) => x.tag === tagOf(11) && x.name === 'PILOT11'), JSON.stringify(ex2.data && ex2.data.excluded));
      const exBad = await S.admin('founding-exclude', { tag: '#ZZZZZZZ' });
      ck('FP3 an unknown #TAG is refused', exBad.status === 404, exBad.text);
      const exRm = await S.admin('founding-exclude', { tag: tagOf(12), remove: true });
      ck('FP3 a #TAG can be removed from the exclusion list', exRm.status === 200 && exRm.data.excluded.length === 1, exRm.text.slice(0, 120));
      await S.admin('founding-exclude', { tag: tagOf(12) });
      const st0 = await S.admin('founding-status');
      ck('FP3 OFF by default after deploy (counter 0 / 1,000)', st0.status === 200 && st0.data.on === false && st0.data.given === 0 && st0.data.cap === 1000 && st0.data.left === 1000, st0.text.slice(0, 160));
      const lb0 = await S.lb(), e0 = await S.ent(P(1));
      ck('FP3 OFF: no spots-left figure anywhere, no solar', lb0.data.foundingLeft === undefined && e0.data.foundingLeft === undefined && e0.data.founding === undefined && e0.data.skus.length === 0, e0.text);
      const before = snapshot(S.g), m0 = { ...S.g.meter };
      const dr = await S.admin('founding-dry-run');
      const after = snapshot(S.g);
      ck('FP2 the dry run writes nothing (every stored value and every SQL table identical, 0 rows written)', util.isDeepStrictEqual(before, after) && S.g.meter.written === m0.written, 'written ' + (S.g.meter.written - m0.written));
      const want = []; for (let i = 1; i <= 1040 && want.length < 1000; i++) if (![3, 5, 6, 8, 11, 12].includes(i)) want.push(i);
      const d = dr.data || {};
      ck('FP2 the dry run reports who WOULD be numbered: 1,000, #1 to #1,000, first and last by #TAG', dr.status === 200 && d.wouldNumber === 1000 && d.from === 1 && d.to === 1000 &&
        d.first[0].tag === tagOf(1) && d.first[0].n === 1 && d.last[4].tag === tagOf(want[999]) && d.last[4].n === 1000, JSON.stringify({ n: d.wouldNumber, first: d.first && d.first[0], last: d.last && d.last[4] }));
      const why = Object.fromEntries((d.skipped || []).map((x) => [x.tag, x.why]));
      ck('FP2 ...and who is left out and why (restricted, exclusion list); removed / privacy-deleted pilots are never counted', d.excludedCount === 4 && why[tagOf(3)] === 'restricted' && why[tagOf(8)] === 'restricted' && why[tagOf(11)] === 'on your exclusion list' && why[tagOf(12)] === 'on your exclusion list' && !why[tagOf(5)] && !why[tagOf(6)], JSON.stringify(why));
      ck('FP2 ...and the rows it would write (one per pilot + 2)', d.rowsWouldWrite === 1002 && d.leftAfter === 0, d.rowsWouldWrite);
      const noAuth = await S.req('/api/admin/founding-switch', { on: true, confirm: 'FOUNDING ON' });
      const noAuth2 = [];
      for (const r of ['founding-status', 'founding-dry-run', 'founding-continue', 'founding-exclude', 'founding-take-back']) noAuth2.push((await S.req('/api/admin/' + r, { tag: tagOf(1) })).status);
      ck('FP3 every FOUNDING PILOT route needs the admin login (401 without it)', noAuth.status === 401 && noAuth2.every((s) => s === 401), noAuth.status + ' ' + noAuth2.join(','));
      const noTyped = await S.admin('founding-switch', { on: true, confirm: 'founding' });
      ck('FP3 ON is refused without the typed "FOUNDING ON"', noTyped.status === 400 && /FOUNDING ON/.test(noTyped.data.error) && fndRows(S.g).length === 0, noTyped.text);
      const noBk = await S.admin('founding-switch', { on: true, confirm: 'FOUNDING ON' });
      ck('FP3 ON is refused without a verified backup from the last 60 minutes', noBk.status === 409 && noBk.data.needBackup === true && fndRows(S.g).length === 0, noBk.text.slice(0, 120));
      const bk = await S.admin('backup-now');
      now += 61 * 60 * 1000;
      const old = await S.admin('founding-switch', { on: true, confirm: 'FOUNDING ON' });
      ck('FP3 ...also when the newest backup is older than 60 minutes', bk.status === 200 && old.status === 409 && old.data.needBackup === true, old.text.slice(0, 120));
      await S.admin('backup-now');
      const ents0 = S.g.sql.dump('ents');
      const m1 = { ...S.g.meter };
      const sw = await S.admin('founding-switch', { on: true, confirm: 'FOUNDING ON', limit: 300 });
      const w = S.g.meter.written - m1.written;
      const rows = fndRows(S.g), byId = new Map(rows.map((r) => [r.id, r]));
      const right = want.every((i, k) => byId.get(P(i)) && byId.get(P(i)).n === k + 1);
      ck('FP3 ON numbers the existing pilots in creation order, skipping restricted, removed, privacy-deleted and excluded pilots', sw.status === 200 && right && !byId.has(P(3)) && !byId.has(P(5)) && !byId.has(P(6)) && !byId.has(P(8)) && !byId.has(P(11)) && !byId.has(P(12)), sw.text.slice(0, 160));
      const ns = rows.map((r) => r.n).sort((a, b) => a - b);
      ck('FP3 exactly 1,000 numbers, #1..#1,000 once each, never more (pilots #1,001+ get none)', rows.length === 1000 && ns[0] === 1 && ns[999] === 1000 && new Set(ns).size === 1000 && !byId.has(P(1040)), rows.length);
      ck('FP3 resumable: batches of 300 in one request (the admin page repeats while "more"), counter given 1,000 / left 0', sw.data.numbered === 1000 && sw.data.given === 1000 && sw.data.left === 0 && sw.data.more === false, JSON.stringify({ n: sw.data.numbered, given: sw.data.given, more: sw.data.more }));
      ck('FP3 the grant is recorded with source "founding" (never a Stripe purchase); the purchase table is untouched', rows.every((r) => r.src === 'founding') && util.isDeepStrictEqual(ents0, S.g.sql.dump('ents')), rows[0] && JSON.stringify(rows[0]));
      ck('FP3 rows written reported and minimal: one per pilot + 2 (the counter in the summary row + the settings value)', sw.data.rowsWritten === w && w <= 1000 + 2 * 4 + 6, 'reported ' + sw.data.rowsWritten + ', measured ' + w);
      report.onRowsWritten = w;
      const again = await S.admin('founding-continue', {});
      ck('FP3 a number is never given twice: CONTINUE after full numbers nobody', again.status === 200 && again.data.numbered === 0 && fndRows(S.g).length === 1000, again.text.slice(0, 100));
      const sum = await S.admin('summary');
      ck('FP8 the FLUX COMMAND first screen gets the counter (given / 1,000, spots left)', sum.data.founding && sum.data.founding.on === true && sum.data.founding.given === 1000 && sum.data.founding.cap === 1000 && sum.data.founding.left === 0, JSON.stringify(sum.data.founding));
      /* FP6 entitlements */
      const e1 = await S.ent(P(1)), e9 = await S.ent(P(1040)), r1 = await S.rc(P(1)), r3 = await S.rc(P(3));
      ck('FP6 /api/entitlements returns solar + the number for a founder', e1.data.skus.includes('solar') && e1.data.founding === 1 && e1.data.foundingLeft === 0, e1.text);
      ck('FP6 ...and nothing for a pilot without a number (restricted, #1,001+)', !e9.data.skus.includes('solar') && e9.data.founding === undefined && !(r3.data.skus || []).includes('solar'), e9.text);
      ck('FP6 /api/restore-check (the restore code) brings solar and the number back', r1.data.found === true && r1.data.skus.includes('solar') && r1.data.founding === 1, r1.text);
      S.env.restart();
      const e1b = await S.ent(P(2));
      ck('FP6 ...after a restart too (every device asks the server)', e1b.data.skus.includes('solar') && e1b.data.founding === 2, e1b.text);
      /* FP8 leaderboard badge + cost */
      const L = await S.lb(), rowsAll = Object.values(L.data.boards).flat(), founders = new Set(fndRows(S.g).map((r) => pidHashSync(r.id)));
      const fpOk = rowsAll.length > 0 && rowsAll.some((x) => !x.fp) && rowsAll.every((x) => (x.fp === 1) === founders.has(x.pid));
      ck('FP8 leaderboard rows carry the badge flag (fp) for founders only; foundingLeft 0 while ON and full', fpOk && L.data.foundingLeft === 0, rowsAll.filter((x) => x.fp).length + ' of ' + rowsAll.length);
      /* FP7 Stripe */
      await S.doFetch('/grant', { playerId: P(1), sku: 'solar', sessionId: 'cs_live_a' });
      await S.doFetch('/grant', { playerId: P(1040), sku: 'solar', sessionId: 'cs_live_b' });
      const paid1 = await S.doFetch('/entitlements?paid=1&playerId=' + P(1), null);
      ck('FP7 a Stripe purchase on a founder is recorded as before; the purchase tools see Stripe purchases only', util.isDeepStrictEqual(JSON.parse(S.g.sql.dump('ents').find((r) => r.id === P(1)).v), ['solar']) && paid1.data.skus.join() === 'solar' && paid1.data.founding === undefined, JSON.stringify(paid1.data));
      await S.doFetch('/revoke', { playerId: P(1), sku: 'solar' });
      await S.doFetch('/revoke', { playerId: P(1040), sku: 'solar' });
      const e1c = await S.ent(P(1)), e9c = await S.ent(P(1040)), p1c = await S.doFetch('/entitlements?paid=1&playerId=' + P(1), null);
      ck('FP7 revoking that purchase removes the purchase only: the Founding Pilot grant stays; a non-founder loses solar', e1c.data.skus.includes('solar') && p1c.data.skus.length === 0 && !e9c.data.skus.includes('solar'), e1c.text + ' ' + e9c.text);
      /* FP6 take back */
      const tbNo = await S.admin('founding-take-back', { tag: tagOf(4), confirm: 'yes' });
      const tb = await S.admin('founding-take-back', { tag: tagOf(4), confirm: 'TAKE BACK #' + tagOf(4) });
      const e4 = await S.ent(P(4)), st1 = await S.admin('founding-status');
      ck('FP6 TAKE BACK is the owner\'s explicit, typed action; the number stays used (given stays 1,000)', tbNo.status === 400 && tb.status === 200 && tb.data.takenBack === 3 && !e4.data.skus.includes('solar') && e4.data.founding === undefined && st1.data.given === 1000, tb.text.slice(0, 100));
      /* backups: restore brings the grants and the counter back */
      const bk2 = await S.admin('backup-now');
      const fnd0 = S.g.sql.dump('fnd');
      S.g.sql.db.exec('DELETE FROM fnd'); S.env.restart();
      const lost = await S.ent(P(1));
      const res = await S.admin('backup-restore', { id: bk2.data.snapshot.id, confirm: 'RESTORE ' + bk2.data.snapshot.id });
      const e1r = await S.ent(P(1)), str = await S.admin('founding-status');
      ck('FP6 the grants are in every backup: a restore brings them and the counter back', !lost.data.skus.includes('solar') && res.status === 200 && util.isDeepStrictEqual(fnd0, S.g.sql.dump('fnd')) && e1r.data.founding === 1 && str.data.on === true && str.data.given === 1000, res.text.slice(0, 160));
      /* privacy */
      const pd = await S.admin('privacy-delete', { pid: pidOf(2), removePurchases: true });
      ck('FP6 a privacy deletion (with purchases) erases the grant too; the number is not reused', pd.status === 200 && !fndRows(S.g).some((r) => r.id === P(2)) && (await S.admin('founding-status')).data.given === 1000, pd.text.slice(0, 100));
      const off = await S.admin('founding-switch', { on: false });
      const lbOff = await S.lb(), eOff = await S.ent(P(1));
      ck('FP5 OFF hides the spots-left figure; numbers already given stay', off.status === 200 && off.data.on === false && lbOff.data.foundingLeft === undefined && eOff.data.foundingLeft === undefined && eOff.data.skus.includes('solar'), eOff.text);
      const bad = await S.admin('founding-exclude', { tag: tagOf(1) });
      ck('FP3 excluding a pilot who already has a number says so and takes nothing away', bad.status === 200 && /already Founding Pilot #1/.test(bad.data.note) && (await S.ent(P(1))).data.skus.includes('solar'), bad.data.note);
    }

    /* ================= FP4 atomic under concurrent calls ================= */
    if (on('C')) {
      say('== FP4 concurrency ==');
      now = T0;
      const S = mk(mod, newStorage());
      await S.seed(1, 1300);
      await S.admin('backup-now');
      const calls = []; for (let k = 0; k < 6; k++) calls.push(S.doFetch(k % 2 ? '/founding-continue' : '/founding-switch', { on: true, limit: 250 }));
      const out = await Promise.all(calls);
      for (let k = 0; k < 8; k++) await S.doFetch('/founding-continue', { limit: 250 });
      const rows = fndRows(S.g), ns = rows.map((r) => r.n), ok = rows.every((r) => r.id === P(r.n));
      ck('FP4 concurrent ON / CONTINUE calls: #1..#1,000 once each, to pilots 1..1,000 in order, never past 1,000', rows.length === 1000 && new Set(ns).size === 1000 && Math.max(...ns) === 1000 && ok, rows.length + ' rows; statuses ' + out.map((o) => o.status).join(','));
      const st = await S.admin('founding-status');
      ck('FP4 the counter equals the grants (1,000)', st.data.given === 1000 && st.data.left === 0, st.text.slice(0, 80));
    }

    /* ================= FP5 new pilots; FP8 run costs ================= */
    if (on('D')) {
      say('== FP5 new pilots · FP8 costs ==');
      now = T0;
      const S = mk(mod, newStorage());
      await S.seed(1, 990);
      await S.admin('restrict', { pid: pidOf(10), reason: 'x' });
      await S.admin('backup-now');
      const base = await S.meter(() => S.submit(P(20), 60000));     // existing pilot, OFF
      const sw = await S.admin('founding-switch', { on: true, confirm: 'FOUNDING ON' });
      ck('FP5 ON numbers the 989 existing (unrestricted) pilots', sw.status === 200 && sw.data.given === 989 && sw.data.left === 11, sw.text.slice(0, 120));
      const lb1 = await S.lb();
      ck('FP5 the leaderboard read says the spots left while ON (11)', lb1.data.foundingLeft === 11, lb1.data.foundingLeft);
      const run = await S.meter(() => S.submit(P(21), 60000));       // existing pilot, ON
      ck('FP8 a run by an existing pilot writes exactly the rows it wrote with the offer OFF', run.written === base.written, base.written + ' vs ' + run.written);
      ck('FP5 a founder\'s run reply names the number (badge / one-time message at the run\'s end, no extra request)', run.out.data.founding === 20, run.out.text.slice(0, 200));
      await S.admin('restrict', { pid: pidHashSync('new-r'), reason: 'pre-restricted' });
      const r0 = await S.submit('new-r', 500);
      const got = [];
      let firstNew = null;
      for (let k = 0; k < 14; k++) {
        const id = 'new-pilot-' + k, x = await S.meter(() => S.submit(id, 500 + k));
        if (k === 0) firstNew = x;
        got.push(x.out.data.founding || 0);
      }
      ck('FP5 new pilots get the next numbers at creation (#990..#1,000), then none once full; a restricted new pilot none', r0.data.founding === undefined && got.slice(0, 11).join() === '990,991,992,993,994,995,996,997,998,999,1000' && got.slice(11).every((n) => n === 0), got.join(','));
      const off = await mk(mod, newStorage());
      now = T0 + 9e6; await off.seed(1, 3);
      const offNew = await off.meter(() => off.submit('other-new', 700));
      ck('FP8 a new founder\'s first run writes exactly ONE row more (its grant) than a new pilot with the offer OFF', firstNew.written === offNew.written + 1, offNew.written + ' -> ' + firstNew.written);
      report.newFounderRun = [firstNew.read, firstNew.written];
      const eN = await S.ent('new-pilot-0'), lb2 = await S.lb();
      ck('FP5 a new founder owns Solar Inferno; spots left 0 when full', eN.data.skus.includes('solar') && eN.data.founding === 990 && lb2.data.foundingLeft === 0, eN.text);
      S.env.restart();
      const cold = await S.meter(() => S.ent('nobody-here'));
      const S2 = mk(main || mod, newStorage()); await S2.seed(1, 990); S2.env.restart();
      const cold2 = await S2.meter(() => S2.ent('nobody-here'));
      ck('FP8 a cold start reads the same rows with the offer ON as main does (the counter rides in the summary row)', cold.read === cold2.read, cold2.read + ' vs ' + cold.read);
      /* OFF stops new numbers */
      const T = mk(mod, newStorage()); now = T0 + 2e7; await T.seed(1, 5); await T.admin('backup-now');
      await T.admin('founding-switch', { on: true, confirm: 'FOUNDING ON' });
      const a1 = await T.submit('t-new-1', 300);
      await T.admin('founding-switch', { on: false });
      const a2 = await T.submit('t-new-2', 300);
      ck('FP5 OFF: new pilots get no number; ON again continues with the next one', a1.data.founding === 6 && a2.data.founding === undefined, a1.data.founding + ' / ' + a2.data.founding);
      await T.admin('founding-switch', { on: true, confirm: 'FOUNDING ON' });
      ck('FP5 ...the pilot who joined while OFF is numbered next when ON again (creation order)', (await T.ent('t-new-2')).data.founding === 7, '');
      /* REMOVE PILOTS (#49): a removed test pilot never takes a spot, even when it plays again (one that played, one imported) */
      const R = mk(mod, newStorage()); now = T0 + 3e7; await R.seed(1, 5);
      await R.submit('test-pilot', 400, { name: 'TITAN' }); now += 2 * 60 * 1000;
      const rLines = ['TITAN #' + tagFromPid(pidHashSync('test-pilot'), 7), 'PILOT2 #' + tagOf(2)];
      await R.admin('backup-now');
      const rd = await R.admin('remove-pilots-dry-run', { lines: rLines });
      const rr = await R.admin('remove-pilots', { lines: rLines, id: rd.data && rd.data.id, confirm: rd.data && rd.data.confirm });
      await R.admin('backup-now');
      const rOn = await R.admin('founding-switch', { on: true, confirm: 'FOUNDING ON' });
      const notNumbered = !fndRows(R.g).some((r) => r.id === 'test-pilot' || r.id === P(2));
      now += 2 * 60 * 1000; const back1 = await R.submit('test-pilot', 450, { name: 'TITAN' }), back2 = await R.submit(P(2), 460, { name: 'PILOT2' });
      now += 2 * 60 * 1000; const back3 = await R.submit('test-pilot', 470, { name: 'TITAN' });
      const eT = await R.ent('test-pilot'), eP = await R.ent(P(2));
      ck('FP5 pilots removed with REMOVE PILOTS are not numbered at ON, and get no number when they play again (played or imported)',
        rr.status === 200 && rOn.status === 200 && rOn.data.given === 4 && notNumbered && back1.status === 200 && back2.status === 200 && back3.status === 200 &&
        [back1, back2, back3].every((x) => x.data.founding === undefined) && eT.data.founding === undefined && eP.data.founding === undefined &&
        !eT.data.skus.includes('solar') && fndRows(R.g).length === 4,
        JSON.stringify({ rr: rr.status, on: rOn.data && rOn.data.given, b: [back1, back2, back3].map((x) => x.status + ':' + x.data.founding), fnd: fndRows(R.g).length }));
    }

    /* ================= FP9 the game ================= */
    if (on('E')) {
      say('== FP9 the game ==');
      const scripts = scriptsOf(game);
      const start = async (ents, extra = {}) => {
        const calls = [];
        const fetchImpl = (u) => { calls.push(String(u)); const body = String(u).includes('/api/entitlements') ? ents : {}; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), clone() { return this; }, headers: { get: () => null } }); };
        const { store } = makeStore({ fluxPlayerId: 'pilot-a', fluxCallsign: 'ACE', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: '5', ...extra });
        const g = boot(scripts, { origin: 'https://x.test', path: '/play/', store, fetchImpl });
        const toasts = [], notes = []; g.ctx.fluxFoundingCard = (m) => { toasts.push(m); }; g.ctx.fluxNameToast = (m) => { notes.push(m); };
        vm.runInContext('fluxSeasonToast.on=false', g.ctx);   // the harness never times the season message out
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
        return { g, store, toasts, notes, calls, run: (c) => vm.runInContext(c, g.ctx) };
      };
      const A = await start({ playerId: 'pilot-a', skus: ['solar'], founding: 7, foundingLeft: 993 });
      ck('FP9 the game boots without errors', A.g.errors.length === 0, A.g.errors.join(' | '));
      const pkg = A.run(`(function(){ const own=ownsSkin('solar'); equipSkin('solar'); setBackground('solar');
        const bgs=Object.entries(SKINS).filter(function(e){ return e[1].bg && ownsSkin(e[0]); }).map(function(e){ return e[0]; });
        return { own:own, skin:activeSkin, colors:colors===SKINS.solar.colors, five:colors.length===5, launcher:launcherColour(), backdrop:skinBackdropOn(), bg:activeBackground, bgs:bgs }; })()`);
      ck('FP9 a founder owns the COMPLETE Solar Inferno package: skin with its 5 orb colours, the orange launcher, the backdrop', pkg.own && pkg.skin === 'solar' && pkg.colors && pkg.five && pkg.launcher === '#ff7a18' && pkg.backdrop && pkg.bg === 'solar' && pkg.bgs.includes('solar'), JSON.stringify(pkg));
      ck('FP9 the menu shows the badge "FOUNDING PILOT #7"', A.g.els.foundingBadge && A.g.els.foundingBadge.textContent === 'FOUNDING PILOT #7', A.g.els.foundingBadge && A.g.els.foundingBadge.textContent);
      ck('FP9 the menu line "Founding Pilot spots left: 993"', A.g.els.foundingLeft && A.g.els.foundingLeft.textContent === 'Founding Pilot spots left: 993', A.g.els.foundingLeft && A.g.els.foundingLeft.textContent);
      A.run('fluxFoundingRefresh(); fluxFoundingRefresh();');
      ck('FP9 the one-time message, exact text, shown once', A.toasts.length === 1 && A.toasts[0] === MSG(7), JSON.stringify(A.toasts));
      const A2 = await start({ playerId: 'pilot-a', skus: ['solar'], founding: 7, foundingLeft: 993 }, { fluxFoundingShown: 'pilot-a' });
      ck('FP9 ...and never again for that pilot (next open)', A2.toasts.length === 0, JSON.stringify(A2.toasts));
      const B = await start({ playerId: 'pilot-a', skus: [], foundingLeft: 0 });
      const none = B.run(`({ own:ownsSkin('solar'), skin:(equipSkin('solar'),activeSkin) })`);
      ck('FP9 no number: no solar, no badge, no message; spots-left line hidden at 0', !none.own && none.skin !== 'solar' && B.g.els.foundingBadge.textContent === '' && B.g.els.foundingLeft.textContent === '' && B.toasts.length === 0, JSON.stringify(none));
      const C = await start({ playerId: 'pilot-a', skus: [] });
      ck('FP9 spots-left line hidden while the offer is OFF (no figure in the answer)', C.g.els.foundingLeft.textContent === '', C.g.els.foundingLeft.textContent);
      const view = A.run(`({ a:fluxFoundingView(0,5).line, b:fluxFoundingView(0,0).line, c:fluxFoundingView(0,null).line, d:fluxFoundingView(3,null).badge, e:fluxFoundingView(0,1000).line })`);
      ck('FP9 line rules: shown while spots remain, hidden at 0 and when OFF', view.a === 'Founding Pilot spots left: 5' && view.b === '' && view.c === '' && view.d === 'FOUNDING PILOT #3' && view.e === 'Founding Pilot spots left: 1,000', JSON.stringify(view));
      /* never during a run */
      const D = await start({ playerId: 'pilot-a', skus: ['solar'] });
      const hiddenCl = { contains: (c) => c === 'hidden', toggle() {}, add() {}, remove() {} };
      const elOf = (id) => D.run("document.getElementById('" + id + "')");
      elOf('start').classList = hiddenCl; elOf('gameover').classList = hiddenCl;
      D.run(`fluxFoundingRun({ founding: 12 }, { playerId: playerId }); fluxFoundingRefresh();`);
      const during = D.toasts.length;
      elOf('gameover').classList = { contains: () => false, toggle() {}, add() {}, remove() {} };
      D.run('fluxFoundingRefresh();');
      ck('FP9 never during a run: the message waits for the game-over screen / menu', during === 0 && D.toasts.length === 1 && D.toasts[0] === MSG(12), during + ' then ' + JSON.stringify(D.toasts));
      /* FP10 discoverability */
      const cls = () => { const set = new Set(); return { set, contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); return set.has(c); } }; };
      const E1 = await start({ playerId: 'pilot-a', skus: ['solar'], founding: 7, foundingLeft: 993 });
      const fwT = E1.run(`({ t:document.getElementById('fwTry').textContent, l:document.getElementById('fwLater').textContent })`);
      ck('FP10 the message is a card with TRY IT NOW and LATER (exact text, once)', /<button type="button" id="fwTry">TRY IT NOW<\/button><button type="button" id="fwLater">LATER<\/button>/.test(game) && E1.toasts.length === 1 && E1.toasts[0] === MSG(7), JSON.stringify(E1.toasts) + JSON.stringify(fwT));
      E1.run(`document.getElementById('fwTry').onclick()`);
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
      const t1 = E1.run(`({ skin:activeSkin, bg:activeBackground, launcher:launcherColour(), seen:localStorage.getItem('fluxFoundingShown') })`);
      ck('FP10 TRY IT NOW puts the whole package on now (orb colours, orange launcher, backdrop) and marks it seen', t1.skin === 'solar' && t1.bg === 'solar' && t1.launcher === '#ff7a18' && t1.seen === 'pilot-a' && /Solar Inferno is on/.test(E1.notes.join('|')), JSON.stringify(t1));
      const E1b = await start({ playerId: 'pilot-a', skus: ['solar'], founding: 7 }, { fluxFoundingShown: 'pilot-a' });
      ck('FP10 ...and the card never comes back after a choice', E1b.toasts.length === 0, JSON.stringify(E1b.toasts));
      const E2 = await start({ playerId: 'pilot-a', skus: ['solar'], founding: 8 });
      E2.run(`document.getElementById('fwLater').onclick()`);
      const t2 = E2.run(`({ skin:activeSkin, bg:activeBackground, seen:localStorage.getItem('fluxFoundingShown') })`);
      ck('FP10 LATER changes nothing in the game and marks it seen', t2.skin !== 'solar' && t2.bg !== 'solar' && t2.seen === 'pilot-a', JSON.stringify(t2));
      const E3 = await start({ playerId: 'pilot-a', skus: ['solar'], founding: 9 });
      E3.run(`document.getElementById('startBtn').onclick()`);
      const t3 = E3.run(`({ on:!!fluxFoundingToast.on, seen:localStorage.getItem('fluxFoundingShown') })`);
      E3.run('fluxFoundingRefresh();');
      ck('FP10 a run starting only hides it (not a choice): it comes back on the next menu', t3.on === false && t3.seen === null && E3.toasts.length === 2, JSON.stringify(t3) + ' ' + E3.toasts.length);
      const E4 = await start({ playerId: 'pilot-a', skus: ['solar'], founding: 7 });
      const sk = E4.run("document.getElementById('skinsBtn')"); sk.classList = cls();
      E4.run('fluxFoundingRefresh();');
      const dot1 = sk.classList.contains('newDot');
      E4.run(`document.getElementById('skinsBtn').onclick()`);
      const dot2 = sk.classList.contains('newDot'), seenK = E4.run(`localStorage.getItem('fluxSkinsSeen')`);
      E4.run('fluxFoundingRefresh();');
      const E5 = await start({ playerId: 'pilot-a', skus: [] });
      const sk5 = E5.run("document.getElementById('skinsBtn')"); sk5.classList = cls(); E5.run('fluxFoundingRefresh();');
      ck('FP10 NEW dot on THEMES & SKINS for a Founding Pilot until opened once, then gone for good; none without a number', dot1 && !dot2 && seenK === 'pilot-a' && !sk.classList.contains('newDot') && !sk5.classList.contains('newDot'), [dot1, dot2, seenK].join(','));
      ck('FP10 THEMES & SKINS: Solar Inferno says FOUNDING PILOT · FREE with EQUIP for a Founding Pilot (not COMING SOON)', /\$\{founder\?'FOUNDING PILOT · FREE':owned\?/.test(game) && /else if\(founder\)\{btn\.textContent='EQUIP';/.test(game), '');
      ck('FP10 the D-36 menu row is unchanged (the dot is a class on the button, no new element)', /id="skinsBtn">[^<]*<\/button><\/div>/.test(game), '');
      /* no extra request per run */
      const n0 = D.calls.length; D.run(`fluxFoundingRun({ founding: 12 }, { playerId: playerId }); fluxFoundingRun({ founding: 12 }, { playerId: playerId });`);
      await new Promise((r) => setTimeout(r, 5));
      ck('FP9 a founder\'s run reply makes no request once Solar Inferno is owned (no extra request per run)', D.calls.length === n0, D.calls.slice(n0).join(','));
      const mainGame = execFileSync('git', ['show', 'origin/main:public/play/index.html'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const cnt = (h, re) => (scriptsOf(h).join('\n').match(re) || []).length;
      ck('FP9 no new fetch, timer or polling in the game (fetch / setInterval counts equal main\'s)', cnt(game, /\bfetch\((?!'\/api\/help')/g) === cnt(mainGame, /\bfetch\((?!'\/api\/help')/g) && cnt(game, /setInterval\(/g) === cnt(mainGame, /setInterval\(/g), cnt(game, /\bfetch\(/g) + ' fetch');
      /* board rows */
      const data = { boards: { medium: [{ pid: 'p1', tag: 'AAAAAAA', name: 'ACE', country: 'US', score: 900, fp: 1 }, { pid: 'p2', tag: 'BBBBBBB', name: 'BOB', country: 'US', score: 800 }] }, countries: [] };
      const html = A.run('fluxBoardHtml(fluxBoardView(' + JSON.stringify(data) + ",'medium','world',{ pid:'zz', country:'US' }))");
      ck('FP9 a founder\'s leaderboard row shows the FOUNDING PILOT badge; other rows do not', (html.match(/FOUNDING PILOT/g) || []).length === 1 && /ACE<small class="lbTag"> #AAAAAAA<\/small><small class="lbFounder">FOUNDING PILOT<\/small>/.test(html), html.slice(0, 200));
      ck('FP9 the Gateway\'s pilot rows show the badge too', /p\.fp\?' <span[^>]*>FOUNDING PILOT<\/span>'/.test(gate), '');
      const px = (re, h) => { const m = re.exec(h); return m ? Number(m[1]) : 0; };
      const sizes = { menu: px(/\.foundingBadge\{[^}]*font-size:([\d.]+)px/, game), rows: px(/\.lbFounder\{[^}]*font-size:([\d.]+)px/, game), gateway: px(/p\.fp\?' <span style="[^"]*font-size:([\d.]+)px[^"]*">FOUNDING PILOT/, gate) };
      ck('FP9 the FOUNDING PILOT badge text is at least 11 px everywhere (menu, board rows, Gateway)', Object.values(sizes).every((v) => v >= 11), JSON.stringify(sizes));
      const iStart = game.indexOf('<button id="startBtn">'), iFor = game.indexOf('id="playingFor"'), iLeft = game.indexOf('id="foundingLeft"');
      ck('FP9 menu order: ENTER THE FLUX, then "Playing for" directly below it, then the spots-left line', /ENTER THE FLUX<\/button><button type="button" id="playingFor"/.test(game) && iStart > 0 && iStart < iFor && iFor < iLeft, [iStart, iFor, iLeft].join(' < '));
      ck('FP9 the share card shows no pilot name or tag, so no badge is added there', !/FOUNDING/.test((/function drawShareCard[\s\S]*?\n}\n/.exec(game) || [''])[0]), '');
      ck('FP9 the game keeps 17 addEventListener( (property handlers only)', (game.match(/addEventListener\(/g) || []).length === 17, (game.match(/addEventListener\(/g) || []).length);
    }

    /* ================= FP9 FLUX COMMAND ================= */
    if (on('F')) {
      say('== FP9 FLUX COMMAND ==');
      ck('FP9 FLUX COMMAND has a FOUNDING PILOT section: ON / OFF, counter, dry run, exclusion list', /<h2>FOUNDING PILOT<\/h2>/.test(adminHtml) && /id="fpOn"/.test(adminHtml) && /id="fpOff"/.test(adminHtml) && /id="fpDry"/.test(adminHtml) && /id="fpTag"/.test(adminHtml) && /call\('founding-status'\)/.test(adminHtml), '');
      ck('FP9 TURN ON stays disabled until "FOUNDING ON" is typed, and is checked again on press', /id="fpOn" class="danger" disabled/.test(adminHtml) && /\$\('fpConfirm'\)\.oninput = function \(\) \{ \$\('fpOn'\)\.disabled = this\.value\.trim\(\) !== 'FOUNDING ON'; \};/.test(adminHtml) && /if \(inp\.value\.trim\(\) !== 'FOUNDING ON'\) \{ say/.test(adminHtml), '');
      ck('FP9 a refusal for a missing backup offers BACK UP NOW', /if \(o\.data && o\.data\.needBackup === true\) \{\n        var res = \$\('fpReport'\)/.test(adminHtml), '');
      ck('FP9 the first screen shows the counter', /fc\.appendChild\(el\('div', 'meta', fpCounterText\(d\.founding\)\)\)/.test(adminHtml), '');
      ck('FP9 the guide explains the offer', /<h3>Founding Pilot<\/h3>/.test(adminHtml), '');
      ck('FP9 admin.html keeps 2 addEventListener( (property handlers only)', (adminHtml.match(/addEventListener\(/g) || []).length === 2, (adminHtml.match(/addEventListener\(/g) || []).length);
    }
  } catch (e) { ck('suite ran without an exception', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)); }
  Date.now = realNow; console.error = realErr;
  return { F, failed, report };
}

/* ---------------- main + negative controls ---------------- */
const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const tmpMain = path.join(__dirname, '.fp-main-' + process.pid + '.mjs');
let mainMod = null;
try {
  fs.writeFileSync(tmpMain, execFileSync('git', ['show', 'origin/main:worker.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  mainMod = await import(pathToFileURL(tmpMain).href);
} catch (e) { console.log('  (origin/main not available: FP1 compares against nothing)'); }
finally { try { fs.unlinkSync(tmpMain); } catch (e) {} }
const t0 = Date.now();
const res = await suite({ mod: realMod, main: mainMod });
console.log('\n== costs (fake row counter; the Cloudflare dashboard is the authority) ==\n' + JSON.stringify(res.report));

if (process.env.FP_NO_NC) process.exit(res.F ? 1 : 0);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, parts, { worker = (s) => s, game = (s) => s, admin = (s) => s, gate = (s) => s }) {
  const w2 = worker(WORKER_SRC), g2 = game(GAME_HTML), a2 = admin(ADMIN_HTML), gt2 = gate(GATE_HTML);
  if (w2 === WORKER_SRC && g2 === GAME_HTML && a2 === ADMIN_HTML && gt2 === GATE_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  let mod = realMod, tmp = null;
  if (w2 !== WORKER_SRC) { tmp = path.join(__dirname, '.nc-founding-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2); mod = await import(pathToFileURL(tmp).href); }
  try {
    const r = await suite({ mod, main: mainMod, game: g2, adminHtml: a2, gate: gt2, quiet: true, parts });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { if (tmp) try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('OFF answers differ (foundingLeft always sent)', 'FP1 OFF: every public', ['A'], { worker: rep('return fo && fo.on ? Math.max(0, FOUNDING_CAP - fo.given) : null;', 'return fo ? Math.max(0, FOUNDING_CAP - fo.given) : (this.sum ? 1000 : null);') });
await control('the dry run writes the grants', 'FP2 the dry run writes nothing', ['B'], { worker: rep('const cfg = this.fCfg(), p = this.fPlan(cfg, FOUNDING_CAP), t = p.take;', 'const cfg = this.fCfg(), p = this.fPlan(cfg, FOUNDING_CAP), t = p.take; this.db.tx(() => { for (const x of t) this.db.kvPut("fnd", x.id, v2enc({ n: x.n })); });') });
await control('the 1,000 cap ignored', 'FP3 exactly 1,000', ['B'], { worker: rep('if (cfg.given + take.length >= FOUNDING_CAP) { full = true; break scan; }', '') });
await control('restricted pilots numbered', 'FP3 ON numbers the existing pilots', ['B'], { worker: rep(': r.rs || ownGet(this.o.restricted, r.pid) ? "restricted"', ': false ? "restricted"') });
await control('the exclusion list ignored', 'FP3 ON numbers the existing pilots', ['B'], { worker: rep(': ownGet(cfg.excl, r.pid) ? "on your exclusion list"', ': false ? "on your exclusion list"') });
await control('numbered out of creation order', 'FP2 the dry run reports who WOULD', ['B'], { worker: rep('else take.push({ id: r.id, tag: r.tag, name: r.dname, n: cfg.given + take.length + 1 });', 'else take.unshift({ id: r.id, tag: r.tag, name: r.dname, n: cfg.given + take.length + 1 });') });
await control('ON without the typed phrase', 'FP3 ON is refused without the typed', ['B'], { worker: rep('if (String(b.confirm || "").trim() !== FOUNDING_CONFIRM) return json(', 'if (false) return json(') });
await control('ON without a recent backup', 'FP3 ON is refused without a verified backup', ['B'], { worker: rep('    if (!bk.fresh) return json({ ok: false, needBackup: true, backup: bk,\n      error: "Switching ON', '    if (false) return json({ ok: false, needBackup: true, backup: bk,\n      error: "Switching ON') });
await control('founding routes without the admin login', 'FP3 every FOUNDING PILOT route needs the admin login', ['B'], { worker: rep('async function adminFounding(request, env, action) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminFounding(request, env, action) {') });
await control('the grant written as a Stripe purchase (ents)', 'FP3 the grant is recorded', ['B'], { worker: rep('for (const x of take) this.db.kvPut("fnd", x.id, v2enc({ n: x.n, at: now, src: FOUNDING_SRC }));', 'for (const x of take) { this.db.kvPut("fnd", x.id, v2enc({ n: x.n, at: now, src: FOUNDING_SRC })); this.db.kvPut("ents", x.id, v2enc(["solar"])); }') });
await control('entitlements without the grant', 'FP6 /api/entitlements returns solar', ['B'], { worker: rep('return json({ playerId, skus: fnd && !skus.includes("solar") ? skus.concat(["solar"]) : skus,', 'return json({ playerId, skus,') });
await control('restore-check without the grant', 'FP6 /api/restore-check', ['B'], { worker: rep('if (fnd && !skus.includes("solar")) skus = skus.concat(["solar"]);', '') });
await control('grants not in backups', 'FP6 the grants are in every backup', ['B'], { worker: rep('const V2_TABLES = ["pilots", "ents", "seen", "cool", "fnd"];', 'const V2_TABLES = ["pilots", "ents", "seen", "cool"];') });
await control('the purchase tools see the free grant', 'FP7 a Stripe purchase on a founder', ['B'], { worker: rep('if (!pub || url.searchParams.get("paid") === "1") return json({ playerId, skus });', 'if (!pub) return json({ playerId, skus });') });
await control('take back without the typed phrase', 'FP6 TAKE BACK', ['B'], { worker: rep('if (String(b.confirm || "").trim() !== "TAKE BACK #" + t) return json(', 'if (false) return json(') });
await control('board rows without the badge flag', 'FP8 leaderboard rows carry', ['B'], { worker: rep('for (const x of items) { const v = f.get(x.id); if (v && !v.off) x.fp = 1; }', '') });
await control('numbering not atomic (a wait between the plan and the write)', 'FP4 concurrent', ['C'], { worker: rep('  fNumber(cfg, limit, now) {\n    const p = this.fPlan(', '  async fNumber(cfg, limit, now) {\n    await new Promise((r) => setTimeout(r, 2));\n    const p = this.fPlan(') });
await control('new pilots not numbered', 'FP5 new pilots get the next numbers', ['D'], { worker: rep('const fnum = !row && fo && fo.on', 'const fnum = false && fo && fo.on') });
await control('new pilots numbered past 1,000', 'FP5 new pilots get the next numbers', ['D'], { worker: rep('fo.done && fo.given < FOUNDING_CAP && !cooled', 'fo.done && !cooled') });
await control('a removed pilot leaves no cooldown row', 'FP5 pilots removed with REMOVE PILOTS', ['D'], { worker: rep('this.db.kvPut("cool", row.id, row.ls != null ? row.ls : v2enc(0));   // the cooldown is kept (as REMOVE SCORE), always a row', 'if (row.ls != null) this.db.kvPut("cool", row.id, row.ls);') });
await control('the counter kept outside the summary row (a cold start reads it)', 'FP8 a cold start reads the same rows', ['D'], { worker: rep('    this.v2.init();\n    if (this.v2.foLost) {', '    this.v2.init();\n    if (await st.get(FOUNDING_KEY), this.v2.foLost) {') });
await control('every run rewrites the settings value', 'FP8 a run by an existing pilot', ['D'], { worker: rep('    const saving = Object.keys(kv).length ? o.state.storage.put(kv) : null;   // same moment', '    if (this.sum.fo) kv[FOUNDING_KEY] = { ...(o.fcfg || {}), ...this.sum.fo };\n    const saving = Object.keys(kv).length ? o.state.storage.put(kv) : null;   // same moment') });
await control('the message text changed', 'FP9 the one-time message', ['E'], { game: rep("return \"You're Founding Pilot #\"+n+\"! Solar Inferno is yours.\";", "return \"Founding Pilot #\"+n+\"! Solar Inferno is yours.\";") });
await control('the message shown every time', 'FP9 ...and never again', ['E'], { game: rep('    if(localStorage.getItem(FLUX_FOUNDING_SHOWN_KEY)===playerId) return;\n', '') });
await control('the message shown during a run', 'FP9 never during a run', ['E'], { game: rep("    if(!shown('start') && !shown('gameover')) return;            // a run is on: next time\n", '') });
await control('the spots-left line shown at 0', 'FP9 line rules', ['E'], { game: rep("line:Number.isFinite(left) && left>0 ?", "line:Number.isFinite(left) && left>=0 ?") });
await control('board-row badge back to 9 px', 'FP9 the FOUNDING PILOT badge text is at least 11 px', ['E'], { game: rep('.lbFounder{display:block;margin-top:1px;color:#ff9a4a;font-size:11px;', '.lbFounder{display:block;margin-top:1px;color:#ff9a4a;font-size:9px;') });
await control('Gateway badge back to .62em', 'FP9 the FOUNDING PILOT badge text is at least 11 px', ['E'], { gate: rep('color:#ff9a4a;font-size:11px;font-weight:900', 'color:#ff9a4a;font-size:.62em;font-weight:900') });
await control('spots-left line above "Playing for"', 'FP9 menu order', ['E'], { game: rep('</button><button type="button" id="playingFor" class="playingFor hidden">Playing for <span id="playingForWho">🇺🇸 United States</span> · <u>change</u></button><div id="foundingLeft" class="foundingLeft hidden" aria-live="polite"></div>', '</button><div id="foundingLeft" class="foundingLeft hidden" aria-live="polite"></div><button type="button" id="playingFor" class="playingFor hidden">Playing for <span id="playingForWho">🇺🇸 United States</span> · <u>change</u></button>') });
await control('TRY IT NOW only marks it seen', 'FP10 TRY IT NOW puts the whole package on', ['E'], { game: rep("  equipSkin('solar'); setBackground('solar');\n  return true;", "  return true;") });
await control('the card is marked seen as soon as it shows', 'FP10 a run starting only hides it', ['E'], { game: rep("    fluxFoundingToast.on=true;\n    fluxFoundingCard(fluxFoundingMsg(n));", "    fluxFoundingToast.on=true; localStorage.setItem(FLUX_FOUNDING_SHOWN_KEY,playerId);\n    fluxFoundingCard(fluxFoundingMsg(n));") });
await control('LATER never marks it seen', 'FP10 LATER changes nothing', ['E'], { game: rep("document.getElementById('fwLater').onclick=function(){ fluxFoundingChoose(); };", "document.getElementById('fwLater').onclick=function(){ fluxFoundingCardHide(); };") });
await control('the NEW dot never goes away', 'FP10 NEW dot', ['E'], { game: rep("  b.onclick=function(e){ try{ localStorage.setItem(FLUX_SKINS_SEEN_KEY,playerId); }catch(x){}", "  b.onclick=function(e){ try{ }catch(x){}") });
await control('the shop keeps COMING SOON for founders', 'FP10 THEMES & SKINS', ['E'], { game: rep("${founder?'FOUNDING PILOT · FREE':owned?", "${owned?") });
await control('board rows lose the badge', 'FP9 a founder\'s leaderboard row', ['E'], { game: rep("(fp?'<small class=\"lbFounder\">FOUNDING PILOT</small>':'')", "''") });
await control('the menu badge missing', 'FP9 the menu shows the badge', ['E'], { game: rep("badge:n>0 ? 'FOUNDING PILOT #'+n : ''", "badge:''") });
await control('a request at every founder run', 'FP9 a founder\'s run reply makes no request', ['E'], { game: rep("if(!ownsSkin('solar') && typeof syncEntitlements==='function') syncEntitlements();", "if(typeof syncEntitlements==='function') syncEntitlements();") });
await control('a listener instead of a handler property', 'FP9 the game keeps 17', ['E'], { game: rep("['startBtn','againBtn'].forEach(function(id){", "document.addEventListener('x',function(){});['startBtn','againBtn'].forEach(function(id){") });
await control('TURN ON enabled without the phrase', 'FP9 TURN ON stays disabled', ['F'], { admin: rep('<button id="fpOn" class="danger" disabled>', '<button id="fpOn" class="danger">') });
await control('the first screen loses the counter', 'FP9 the first screen shows the counter', ['F'], { admin: rep("fc.appendChild(el('div', 'meta', fpCounterText(d.founding)));", '') });
const total = res.F + NC;
console.log('\n' + (total ? 'FOUNDING PILOT FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'FOUNDING PILOT PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
