// FOUNDING PILOT BY HAND (owner): one pilot that was missed gets the next Founding Pilot number, from
// FLUX COMMAND, with CHECK (writes nothing) -> typed GIVE <id> -> a checked backup from the last 60 min.
//   G1  a pilot REMOVED before switch-ON: CHECK says "removed" and finds it in the newest backup; GIVE
//       brings it back (name, country, scores, restore code), gives it the next number, counter +1,
//       Solar Inferno on /api/entitlements and /api/restore-check, back on the boards, post-check PASS;
//   G2  a pilot removed, then played again (new row, no number): CHECK says "came-back"; GIVE numbers it;
//   G3  a pilot on the exclusion list: CHECK says "excluded"; GIVE takes it off the list and numbers it;
//   G4  CHECK refuses (canGive false, no phrase): already a founder, restricted, not found, a bad line;
//   G5  safety: CHECK writes nothing (every value and table identical); GIVE needs the admin login, the
//       exact phrase, a checked backup < 60 min, and the same pilot as the check (changed -> refused);
//       a number is never given twice (a second GIVE is refused);
//   G6  FLUX COMMAND: the panel, its handlers (no new addEventListener), sign-out clears it, the guide.
//   G7  consistency check (EXCEPTIONS): lists the pilots that should have a number but have none (not
//       restricted, not excluded, not removed), counts removed pilots, and is empty once they are given;
//   G8  HELP: the game menu sends one topic (no text, no personal data); the owner sees name + #TAG +
//       topic under EXCEPTIONS, marks it DONE; bad topics / ids refused, a repeat is one request,
//       rate limited, deleted with a privacy deletion; the privacy pages say so.
// Ends with negative controls: each defect re-inserted into the source MUST be caught.
import fs from 'fs'; import path from 'path'; import util from 'util'; import v8 from 'v8'; import nodeCrypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { levelFor } from './level-rule.mjs';
process.removeAllListeners('warning');   // node:sqlite is "experimental" on this Node
const { DatabaseSync } = await import('node:sqlite');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const PRIV = ['privacy.html', path.join('welcome', 'privacy.html')].map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'));
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


const tagOf = (id) => tagFromPid(pidHashSync(id), 7);

async function suite(mod, adminHtml = ADMIN_HTML, quiet = false, game = GAME_HTML) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const say = (t) => { if (!quiet) console.log(t); };
  const realNow = Date.now; let now = T0; Date.now = () => now;
  const realErr = console.error; console.error = () => {};
  const mk = (g) => {
    const env = makeEnv(mod, g), worker = mod.default;
    const req = async (p, body, headers = {}, method = 'POST') => {
      now += 1100;
      const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, {});
      const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: res.status, data, text };
    };
    const admin = (route, body, hdr = H) => { now += 2100; return req('/api/admin/' + route, body, hdr); };
    const doFetch = async (p, body) => { const r = await env.LEADERBOARD_DO.get('global').fetch('https://do.internal' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, data: await r.json().catch(() => null) }; };
    const seed = async (from, to) => { for (let i = from; i <= to; i += 400) await doFetch('/import', { records: Array.from({ length: Math.min(400, to - i + 1) }, (_, k) => recFor(i + k)) }); };
    const submit = (id, score, name) => req('/api/submit-score', { playerId: id, name, score, level: levelFor(score, 'easy'), difficulty: 'easy', country: 'PH', season: 1 });
    const ent = (id) => req('/api/entitlements?playerId=' + encodeURIComponent(id), null, {}, 'GET');
    const rc = (id) => req('/api/restore-check', { playerId: id });
    const lb = () => req('/api/leaderboard?limit=50&boards=1&v=' + now, null, {}, 'GET');
    const removeP = async (lines) => { await admin('backup-now'); const d = await admin('remove-pilots-dry-run', { lines }); return admin('remove-pilots', { lines, id: d.data.id, confirm: d.data.confirm }); };
    const check = (line) => admin('founding-grant-check', { line });
    const give = (line, c, extra = {}) => admin('founding-grant', { line, id: c.data && c.data.id, confirm: c.data && c.data.confirm, ...extra });
    return { env, admin, seed, submit, ent, rc, lb, removeP, check, give, g };
  };
  const fnd = (g) => (g.sql.dump('fnd') || []).map((r) => ({ id: r.id, ...JSON.parse(r.v) }));
  try {
    say('== G1-G3 removed / came back / excluded ==');
    const S = mk(newStorage());
    await S.seed(1, 20);
    const IP = 'ipad-pilot-0001', OR = 'orbit-pilot-002', BZ = 'blaze-pilot-003', CO = 'comet-pilot-004';
    await S.submit(IP, 5400, 'NOVA'); await S.submit(OR, 4100, 'ORBIT'); await S.submit(BZ, 3900, 'BLAZE'); await S.submit(CO, 3700, 'COMET');
    now += 3 * 60 * 1000;
    const L = { IP: 'NOVA #' + tagOf(IP), OR: 'ORBIT #' + tagOf(OR), BZ: 'BLAZE #' + tagOf(BZ), CO: 'COMET #' + tagOf(CO) };
    const rm = await S.removeP([L.IP, L.OR]);
    await S.admin('founding-exclude', { tag: tagOf(BZ) });
    await S.admin('restrict', { pid: pidHashSync(CO), reason: 'test' });
    await S.admin('backup-now');
    const on = await S.admin('founding-switch', { on: true, confirm: 'FOUNDING ON' });
    const given0 = on.data && on.data.given;
    ck('setup: 2 removed, 1 excluded, 1 restricted; switch-ON numbered the 20 others', rm.status === 200 && on.status === 200 && given0 === 20 && !fnd(S.g).some((r) => [IP, OR, BZ, CO].includes(r.id)), JSON.stringify({ rm: rm.status, given0 }));
    now += 3 * 60 * 1000;
    const back = await S.submit(OR, 4300, 'ORBIT');
    ck('setup: ORBIT played again after removal and got no number (removed pilots never take a spot by themselves)', back.status === 200 && back.data.founding === undefined, back.text.slice(0, 120));
    const ex0 = await S.admin('exceptions'), fx = ex0.data && ex0.data.founding;
    ck('G7 EXCEPTIONS lists the pilot that should have a number (ORBIT, came back) and not the excluded, restricted or removed ones; counts 1 removed', fx && fx.count === 1 && fx.gaps.length === 1 && fx.gaps[0].tag === tagOf(OR) && /joined later/.test(fx.gaps[0].why) && fx.removed === 1 && fx.left === 980, JSON.stringify(fx));

    /* G1 removed */
    const snap0 = snapshot(S.g), bsnap0 = structuredClone(S.env._b.map);
    const c1 = await S.check(L.IP);
    ck('G5 CHECK writes nothing (every leaderboard value and table, every backup, identical)', util.isDeepStrictEqual(snapshot(S.g), snap0) && util.isDeepStrictEqual(S.env._b.map, bsnap0), '');
    const d1 = c1.data || {};
    ck('G1 CHECK on a removed pilot: "removed", found in the newest backup, would get #21, steps say it comes back first', c1.status === 200 && d1.status === 'removed' && d1.canGive === true && d1.restore === true && /^[0-9a-z-]+/i.test(d1.backup && d1.backup.id) && d1.wouldGet === 21 && /bring the pilot back from backup/.test(d1.steps[0]) && d1.confirm === 'GIVE ' + d1.id && d1.pilot.name === 'NOVA' && d1.pilot.bests.easy === 5400, JSON.stringify({ s: d1.status, g: d1.wouldGet, b: d1.backup }));
    ck('G1 ...and it explains why it had no number (removed before the offer numbered the pilots)', /removed \(REMOVE PILOTS or REMOVE SCORE\)/.test(d1.why || ''), d1.why);
    ck('G1 CHECK never sends the backed-up row to the page', !('restoreRow' in d1), '');
    const noLogin = await S.admin('founding-grant', { line: L.IP, id: d1.id, confirm: d1.confirm }, {});
    const badPhrase = await S.give(L.IP, { data: { id: d1.id, confirm: 'GIVE' } });
    const lower = await S.give(L.IP, { data: { id: d1.id, confirm: d1.confirm.toLowerCase() } });
    now += 61 * 60 * 1000;
    const stale = await S.give(L.IP, c1);
    ck('G5 GIVE is refused without the login, without the exact phrase, and without a checked backup < 60 min; nothing written', noLogin.status === 401 && badPhrase.status === 400 && lower.status === 400 && stale.status === 409 && stale.data.needBackup === true && util.isDeepStrictEqual(snapshot(S.g), snap0), [noLogin.status, badPhrase.status, lower.status, stale.status].join(','));
    await S.admin('backup-now');
    const g1 = await S.give(L.IP, c1);
    const e1 = await S.ent(IP), r1 = await S.rc(IP), lb1 = await S.lb();
    const onBoard = Object.values((lb1.data && lb1.data.boards) || {}).flat().some((x) => x.name === 'NOVA' && x.score === 5400);
    ck('G1 GIVE brings the pilot back and gives it #21; the post-check passes', g1.status === 200 && g1.data.given === 21 && g1.data.restored === true && g1.data.pass === true && g1.data.checks.length >= 5 && g1.data.checks.every((x) => x.ok) && g1.data.safetyId && g1.data.backupId, g1.text.slice(0, 200));
    ck('G1 it owns Solar Inferno with its number: entitlements and its restore code', e1.data.skus.includes('solar') && e1.data.founding === 21 && r1.data.found === true && r1.data.skus.includes('solar') && r1.data.founding === 21, e1.text);
    ck('G1 it is back on the boards with its score from before, and its old cooldown row is gone', onBoard && !(S.g.sql.dump('cool') || []).some((r) => r.id === IP), '');
    ck('G1 counter: 21 given, 979 spots left; the log says it was given by hand', g1.data.given === 21 && g1.data.left === 979 && e1.data.foundingLeft === 979 && /#21 given by hand to NOVA #/.test(JSON.stringify(g1.data.log)), JSON.stringify(g1.data.log && g1.data.log.slice(-1)));
    const again = await S.give(L.IP, c1);
    const c1b = await S.check(L.IP);
    ck('G5 a number is never given twice: the same GIVE again is refused; CHECK now says "already a Founding Pilot"', again.status === 409 && c1b.data.status === 'numbered' && c1b.data.canGive === false && c1b.data.confirm === '' && fnd(S.g).filter((r) => r.id === IP).length === 1, again.status + ' ' + c1b.data.status);

    /* G2 came back */
    const c2 = await S.check(L.OR);
    ck('G2 CHECK on a pilot removed and then played again: "came-back", no restore, would get #22', c2.data.status === 'came-back' && c2.data.canGive === true && c2.data.restore === false && c2.data.wouldGet === 22 && /played again/.test(c2.data.why), c2.data.status + ' ' + c2.data.why);
    const g2 = await S.give(L.OR, c2);
    ck('G2 GIVE numbers it #22 (its current scores kept)', g2.status === 200 && g2.data.given === 22 && g2.data.restored === false && g2.data.pass === true && (await S.ent(OR)).data.founding === 22, g2.text.slice(0, 160));

    /* G3 excluded */
    const c3 = await S.check(L.BZ);
    now += 3 * 60 * 1000;
    await S.submit(BZ, 4500, 'BLAZE');
    await S.admin('backup-now');
    const changed = await S.give(L.BZ, c3);
    ck('G5 GIVE is refused when the pilot changed since the check (a new score), nothing written', c3.data.status === 'excluded' && changed.status === 409 && changed.data.changed === true && !fnd(S.g).some((r) => r.id === BZ), changed.status + ' ' + (changed.data && changed.data.error));
    const c3b = await S.check(L.BZ);
    const g3 = await S.give(L.BZ, c3b);
    const st3 = await S.admin('founding-status');
    ck('G3 CHECK on an excluded pilot: "excluded"; GIVE takes it off the list and gives it #23', c3b.data.status === 'excluded' && /exclusion list/.test(c3b.data.why) && g3.status === 200 && g3.data.given === 23 && !st3.data.excluded.some((x) => x.tag === tagOf(BZ)), JSON.stringify(st3.data.excluded));

    /* G4 refusals */
    const c4a = await S.check('PILOT1 #' + tagOf(P(1)));
    const c4b = await S.check(L.CO);
    const c4c = await S.check('GHOST #ABCDEFG');
    const c4d = await S.check('TITAN');
    const c4e = await S.give(L.CO, c4b);
    ck('G4 refused: already a founder (#1), restricted, not found (says how to fix), a bad line; no phrase offered', c4a.data.status === 'numbered' && /#1 /.test(c4a.data.why) && c4b.data.status === 'restricted' && c4c.data.status === 'not-found' && /never uploaded a score/.test(c4c.data.why) && c4d.status === 400 && [c4a, c4b, c4c].every((x) => x.data.canGive === false && x.data.confirm === '') && [400, 409].includes(c4e.status), [c4a.data.status, c4b.data.status, c4c.data.status, c4d.status, c4e.status].join(','));
    const ex1 = await S.admin('exceptions');
    ck('G7 ...and is empty once they are given', ex1.data.founding && ex1.data.founding.count === 0 && ex1.data.founding.removed === 0, JSON.stringify(ex1.data.founding));
    const fin = await S.admin('summary');
    ck('G1 the FLUX COMMAND first screen counter follows (23 given)', fin.data.founding && fin.data.founding.given === 23, JSON.stringify(fin.data.founding));

    /* G8 HELP */
    say('== G8 HELP ==');
    const help = (body) => S.env && mod.default.fetch(new Request(ORIGIN + '/api/help', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.' + (now % 200) }, body: JSON.stringify(body) }), S.env, {}).then(async (r) => ({ status: r.status, text: await r.text() }));
    now += 61000;
    const h1 = await help({ playerId: IP, topic: 'badge', name: 'NOVA' });
    now += 1000; const h2 = await help({ playerId: IP, topic: 'badge', name: 'NOVA' });
    const hBad = await help({ playerId: IP, topic: 'free text here', name: 'NOVA' });
    const hBad2 = await help({ playerId: 'not a valid id!', topic: 'bug' });
    const hNote = await help({ playerId: OR, topic: 'lost', name: 'ORBIT', note: 'my email is kid@example.com' });
    const ex2 = await S.admin('exceptions'), hl = (ex2.data && ex2.data.help) || [];
    ck('G8 a tap sends one topic; the owner sees name + #TAG + topic; a repeat is one request (asked 2 times); bad topic / id refused', h1.status === 200 && h2.status === 200 && hBad.status === 400 && hBad2.status === 400 && hl.length === 2 && hl.some((x) => x.tag === tagOf(IP) && x.name === 'NOVA' && x.topic === 'badge' && x.times === 2 && x.label === 'Founding Pilot badge missing'), JSON.stringify(hl));
    ck('G8 nothing personal is kept: no player id, no extra text, only topic, name, #TAG, times', hNote.status === 200 && !JSON.stringify(hl).includes('kid@example.com') && !JSON.stringify(hl).includes(IP) && hl.every((x) => Object.keys(x).sort().join() === 'at,id,label,last,name,pid,tag,times,topic'), JSON.stringify(hl[0]));
    const lim = []; for (let k = 0; k < 4; k++) lim.push((await help({ playerId: BZ, topic: ['bug', 'other', 'lost', 'badge'][k], name: 'BLAZE' })).status);
    ck('G8 rate limited: a 4th tap within a minute from one pilot is refused (429)', lim.slice(0, 3).every((x) => x === 200) && lim[3] === 429, lim.join(','));
    const done = await S.admin('help-done', { id: hl.find((x) => x.tag === tagOf(IP)).id });
    await S.admin('privacy-delete', { pid: pidHashSync(OR), removePurchases: false });
    const ex3 = await S.admin('exceptions'), hl3 = ex3.data.help || [];
    ck('G8 DONE removes a request; a privacy deletion removes that pilot\'s requests', done.status === 200 && !hl3.some((x) => x.tag === tagOf(IP)) && !hl3.some((x) => x.tag === tagOf(OR)) && hl3.length === 3, hl3.map((x) => x.name + ':' + x.topic).join(','));
    const gsec = (game.match(/<div id="help"[\s\S]*?<\/div><\/div>/) || [''])[0];
    ck('G8 the game menu has HELP; its panel has 4 topic buttons and nowhere to type (no input, no textarea)', /<button class="linkBtn" id="helpBtn">\? HELP<\/button>/.test(game) && (gsec.match(/data-topic="/g) || []).length === 4 && !/<input|<textarea/.test(gsec) && /no email, nothing else about you/.test(gsec), gsec.length);
    ck('G8 the game sends only playerId, topic and pilot name, on a tap (property handlers; 17 addEventListener( kept)', /body:JSON\.stringify\(\{playerId:playerId,topic:topic,name:callsign\}\)/.test(game) && (game.match(/addEventListener\(/g) || []).length === 17 && /document\.querySelectorAll\('#helpTopics button'\)\.forEach\(function\(b\)\{ b\.onclick=/.test(game), '');
    ck('G8 both privacy pages say what HELP sends and that it is deleted within 90 days', PRIV.every((h) => /under HELP in the menu/.test(h) && /within 90 days/.test(h)), '');
    ck('G8 FLUX COMMAND shows help requests (CHECK for a missing badge, FIND, DONE) and the guide explains them', /function renderHelp\(box, list\)/.test(adminHtml) && /call\('help-done', \{ id: x\.id \}\)/.test(adminHtml) && /<b>Help requests:<\/b>/.test(adminHtml), '');
    ck('G7 FLUX COMMAND shows the Founding Pilot gaps under EXCEPTIONS with a CHECK button each', /if \(fgaps\) renderFoundingGaps\(box, fgaps\);/.test(adminHtml) && /function renderFoundingGaps\(box, f\)/.test(adminHtml), '');

    /* G6 FLUX COMMAND */
    say('== G6 FLUX COMMAND ==');
    ck('G6 the panel: NAME #TAG, CHECK, the phrase field and GIVE NUMBER (disabled until the phrase is typed)', /id="fgLine"/.test(adminHtml) && /id="fgCheck"/.test(adminHtml) && /id="fgConfirm"/.test(adminHtml) && /<button id="fgGive" class="danger" disabled>GIVE NUMBER<\/button>/.test(adminHtml), '');
    ck('G6 handlers are properties (addEventListener( stays 2); GIVE is enabled only by the exact phrase', (adminHtml.match(/addEventListener\(/g) || []).length === 2 && /\$\('fgConfirm'\)\.oninput = function \(\) \{ \$\('fgGive'\)\.disabled = !fgPlan \|\| this\.value\.trim\(\) !== fgPlan\.confirm; \};/.test(adminHtml), '');
    ck('G6 sign-out clears the panel', /'fgReport', 'fgResult'\]\.forEach/.test(adminHtml) && /'fgLine', 'fgConfirm'\]\.forEach/.test(adminHtml), '');
    ck('G6 the guide says how (backup, CHECK, the reasons, GIVE, undo)', /A pilot was missed \(give a number by hand\)/.test(adminHtml) && /removed and then played again/.test(adminHtml) && /RESTORE NOW with that safety backup/.test(adminHtml), '');
  } catch (e) { ck('suite ran', false, String(e.stack || e).slice(0, 400)); }
  finally { Date.now = realNow; console.error = realErr; }
  return { F, failed };
}

let NC = 0;
const t0 = Date.now();
const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const res = await suite(realMod);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
async function control(label, expect, { worker = (s) => s, admin = (s) => s, game = (s) => s }) {
  const w2 = worker(WORKER_SRC), a2 = admin(ADMIN_HTML), g2 = game(GAME_HTML);
  if (w2 === WORKER_SRC && a2 === ADMIN_HTML && g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  let mod = realMod, tmp = null;
  if (w2 !== WORKER_SRC) { tmp = path.join(__dirname, '.nc-fgrant-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2); mod = await import(pathToFileURL(tmp).href); }
  try {
    const r = await suite(mod, a2, true, g2);
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { if (tmp) try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('GIVE without the backup check', 'G5 GIVE is refused without the login', { worker: rep('  const bk = await sfLatestBackup(env);\n  if (!bk.fresh) return json({ ok: false, needBackup: true, backup: bk,\n    error: "Nothing was changed: giving a number', '  const bk = { fresh: true, id: "none" };\n  if (!bk.fresh) return json({ ok: false, needBackup: true, backup: bk,\n    error: "Nothing was changed: giving a number') });
await control('GIVE without the typed phrase', 'G5 GIVE is refused without the login', { worker: rep('if (String(b.confirm || "").trim() !== "GIVE " + id) return', 'if (false) return') });
await control('GIVE ignores a change since the check', 'G5 GIVE is refused when the pilot changed', { worker: (s) => rep('if (pre.d.id !== id) return', 'if (false) return')(rep('if (p.lookBackups || p.id !== b.id) return', 'if (p.lookBackups) return')(s)) });
await control('CHECK writes the grant', 'G5 CHECK writes nothing', { worker: rep('    if (x.status === "invalid" || x.status === "ambiguous") return { ...out, status: x.status, canGive: false, why: x.why };\n    const row = x.row', '    this.db.kvPut("cool", "probe-" + Date.now(), "1");\n    if (x.status === "invalid" || x.status === "ambiguous") return { ...out, status: x.status, canGive: false, why: x.why };\n    const row = x.row') });
await control('a removed pilot is not brought back', 'G1 GIVE brings the pilot back', { worker: rep('        this.putPilot(sum, null, bRow.rec, bRow.id, bRow.pid, c != null ? c : bRow.ls == null ? null : bRow.ls);', '') });
await control('the backups are never searched', 'G1 CHECK on a removed pilot', { worker: rep('      case "/find-pilot": return this.findPilot(', '      case "/find-pilot-x": return this.findPilot(') });
await control('the counter is not moved', 'G1 GIVE brings the pilot back', { worker: rep('      sum.fo = { ...(sum.fo || foOf(cfg)), given: n };', '') });
await control('the exclusion list keeps the pilot', 'G3 CHECK on an excluded pilot', { worker: rep('    if (row) delete excl[row.pid];', '') });
await control('a removed-then-returned pilot is not told apart', 'G2 CHECK on a pilot removed and then played again', { worker: rep('else if (bRow && bRow.seq !== row.seq) {', 'else if (false) {') });
await control('a restricted pilot can be given a number', 'G4 refused', { worker: rep('} else if (restricted) { status = "restricted";', '} else if (false) { status = "restricted";') });
await control('a founder can be numbered twice', 'G5 a number is never given twice', { worker: rep('    if (f && !f.off) { status = "numbered";', '    if (false) { status = "numbered";') });
await control('GIVE enabled without the phrase', 'G6 handlers are properties', { admin: rep("$('fgGive').disabled = !fgPlan || this.value.trim() !== fgPlan.confirm;", "$('fgGive').disabled = !fgPlan;") });
await control('sign-out keeps the panel', 'G6 sign-out clears the panel', { admin: rep("'fgReport', 'fgResult'].forEach", "].forEach") });
await control('the gap check lists excluded pilots', 'G7 EXCEPTIONS lists', { worker: rep('if (have.has(r.id) || r.rs || ownGet(o.restricted, r.pid) || ownGet(cfg.excl, r.pid)) continue;', 'if (have.has(r.id) || r.rs || ownGet(o.restricted, r.pid)) continue;') });
await control('the gap check is not shown under EXCEPTIONS', 'G7 EXCEPTIONS lists', { worker: rep('    const g = await forwardToDO(request, env, "/founding-gaps", { method: "POST" });', '    const g = { ok: false };') });
await control('HELP accepts any topic', 'G8 a tap sends one topic', { worker: rep('const topic = typeof body.topic === "string" && ownGet(HELP_TOPICS, body.topic) ? body.topic : "";', 'const topic = typeof body.topic === "string" ? body.topic.slice(0, 40) : "";') });
await control('HELP keeps extra text', 'G8 nothing personal is kept', { worker: (w) => rep('name: String(b.name || "PILOT").slice(0, 24), topic: b.topic,', 'name: String(b.name || "PILOT").slice(0, 24), note: b.note, topic: b.topic,')(rep('body: JSON.stringify({ pid, topic, name: cleanName(body.name) }) }));', 'body: JSON.stringify({ pid, topic, name: cleanName(body.name), note: body.note }) }));')(w)) });
await control('HELP is not rate limited', 'G8 rate limited', { worker: rep('  help:    { ip: 10,  player: 3 },', '  help:    { ip: 1000,  player: 1000 },') });
await control('a privacy deletion keeps help requests', 'G8 DONE removes a request', { worker: rep('  try { await helpDO(env, "/help-purge"', '  try { if (0) await helpDO(env, "/help-purge"') });
await control('the HELP panel gets a text box', 'G8 the game menu has HELP', { game: rep('<div id="helpTopics">', '<div id="helpTopics"><input id="helpText" placeholder="Tell us more">') });
const total = res.F + NC;
console.log('\n' + (total ? 'FOUNDING GRANT FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'FOUNDING GRANT PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
