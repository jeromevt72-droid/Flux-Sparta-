// BACKUPS: the leaderboard is backed up every day, each backup is checked, and a
// restore brings back EXACTLY what was backed up -- proven here by restoring.
//   B1 a backup copies every key of the leaderboard storage (players + bests on all difficulties,
//      Season 1 marker + Season 0 archive chunks, purchases incl. Solar Inferno, restore log, bans,
//      restrictions, flags, countries, cooldowns, keys the code does not know about), chunked
//      well under the per-value limit, with a manifest (time, keys, bytes, SHA-256 per chunk and
//      overall, schema, season, counts); it is read back and marked verified;
//   B2 dry run: reports exactly what a restore would change (keys added / changed / removed,
//      pilots, purchases, counts now vs after) and writes NOTHING;
//   B3 real restore: refused without the typed "RESTORE <id>"; takes a safety backup of the current
//      state FIRST (a failed safety backup or a failed write changes nothing); afterwards the storage
//      is identical to the original, key by key, and the public routes (/api/leaderboard all / easy /
//      medium / hard, /api/entitlements, /api/restore-check) answer exactly as before -- also after
//      a complete wipe and after a restart;
//   B4 the cron takes one backup per UTC day (a second run the same day does nothing), a failure is
//      recorded, shown and retried (a few times), and the next day works again;
//   B5 retention: the newest 14 daily, up to 4 weekly (never older than 28 days), others 28 days;
//   B6 a damaged or missing chunk is detected: the dry run, the restore and the download all refuse,
//      the leaderboard is not touched, and the daily re-check marks it failed;
//   B7 every backup route needs the admin password;
//   B8 download = a JSON file with the manifest; it can be uploaded back (checked against its own
//      checksum; a changed file is refused) and restored;
//   B9 privacy: a privacy deletion also erases the pilot from every backup, so no restore brings them
//      back; the Privacy Policy says so and retention stays under its 30 days;
//   B10 admin page BACKUPS section + GUIDE; deploy needs nothing made by hand: no new binding, class,
//      migration, bucket or namespace (wrangler.jsonc as on main); the existing cron is reused;
//   B11 the backup store is a separate instance ("backups") of LeaderboardDO: backup paths never run on
//      the leaderboard instance and leaderboard routes never run on the backups instance.
// Ends with negative controls: each defect re-inserted into worker.js / admin.html MUST be caught.
import fs from 'fs'; import path from 'path'; import util from 'util'; import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { levelFor } from './level-rule.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const PRIVACY = fs.readFileSync(path.join(ROOT, 'public', 'privacy.html'), 'utf8');
const WRANGLER = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');
const DAY = 86400000, T0 = Date.UTC(2026, 9, 5, 0, 10);   // a Monday, 00:10 UTC
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/* ---------------- fake Durable Object runtime ---------------- */
const enc = new TextEncoder();
class FakeStorage {
  constructor(map, { limit = false } = {}) { this.map = map || new Map(); this.limit = limit; this.writes = 0; this.failPut = null; this.failList = false; }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v };
    const keys = Object.keys(obj);
    if (keys.length > 128) throw new Error('put: more than 128 keys');
    if (this.limit) for (const kk of keys) { const x = obj[kk], n = typeof x === 'string' ? enc.encode(x).length : enc.encode(JSON.stringify(x) || '').length; if (n > 128 * 1024) throw new Error('put: value over 128 KiB (' + kk + ', ' + n + ')'); }
    if (this.failPut && this.failPut(obj)) throw new Error('storage failure');
    this.writes++;
    for (const kk of keys) this.map.set(kk, structuredClone(obj[kk]));
  }
  async delete(k) { const ks = [].concat(k); if (ks.length > 128) throw new Error('delete: more than 128 keys'); this.writes++; for (const x of ks) this.map.delete(x); }
  async list(o = {}) {
    if (this.failList) throw new Error('list failure');
    let keys = [...this.map.keys()].sort();
    if (o.prefix) keys = keys.filter((k) => k.startsWith(o.prefix));
    if (o.start !== undefined) keys = keys.filter((k) => k >= o.start);
    if (o.startAfter !== undefined) keys = keys.filter((k) => k > o.startAfter);
    if (o.end !== undefined) keys = keys.filter((k) => k < o.end);
    if (o.limit) keys = keys.slice(0, o.limit);
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async transaction(fn) {   // all or nothing, like the runtime
    const before = new Map(this.map), w = this.writes;
    try { return await fn(this); } catch (e) { this.map = before; this.writes = w; throw e; }
  }
}
class FakeState {
  constructor(storage) { this.storage = storage; this.lock = Promise.resolve(); }
  blockConcurrencyWhile(fn) { const r = this.lock.then(fn); this.lock = r.then(() => {}, () => {}); return r; }
}
function makeEnv(mod, g, b, withBackup = true) {
  const inst = new Map();
  const env = { ADMIN_TOKEN: 'pw', _g: g, _b: b };
  // ONE class, one binding: "global" = the leaderboard, "backups" = the backup store (its own storage), others fresh.
  const broken = { get: async () => { throw new Error('backup instance down'); } };
  env.LEADERBOARD_DO = { idFromName: (n) => n, get(id) {
    if (!inst.has('lb:' + id)) inst.set('lb:' + id, new mod.LeaderboardDO(new FakeState(id === 'global' ? env._g : id === 'backups' ? (withBackup ? env._b : broken) : new FakeStorage()), env));
    const o = inst.get('lb:' + id); return { fetch: (url, init) => o.fetch(new Request(url, init)) }; } };
  env._inst = inst;
  env.restart = () => inst.clear();   // every Durable Object is thrown away; storage survives
  return env;
}

/* A realistic Season 1 leaderboard. */
const NPLAYERS = 420;
function seed(pad = 0, n = NPLAYERS) {   // n: fewer pilots for the many-day cron runs (speed)
  const m = new Map(), players = {}, cc = ['US', 'PH', 'JP', 'DE', 'BR', 'KE', 'IN', 'FR'];
  for (let i = 1; i <= n; i++) {
    const s = 700 + 37 * i;
    players[P(i)] = { playerId: P(i), name: 'PILOT' + i, country: cc[i % cc.length], updatedAt: 1790000000000 + i,
      bests: { easy: { score: s, level: levelFor(s, 'easy'), updatedAt: 1790000000100 + i },
               ...(i % 3 ? { medium: { score: s * 2, level: levelFor(s * 2, 'medium'), updatedAt: 1790000000200 + i } } : {}),
               ...(i % 2 ? { hard: { score: s * 3, level: levelFor(s * 3, 'hard'), updatedAt: 1790000000300 + i } } : {}) } };
  }
  players[P(5)].note = undefined;                     // a stored undefined must survive too
  players[P(6)].bests = {};                           // a pilot with no Season 1 score yet
  m.set('players', players);
  m.set('nameRulesV1', 1);
  m.set('season', 1);
  const arch = [];
  for (let c = 0; c < 3; c++) arch.push(Array.from({ length: 40 }, (_, j) => ({ playerId: P(c * 40 + j + 1), name: 'OLD' + j, country: 'US', bests: { medium: { score: 9000 + j, level: 5, updatedAt: 1700000000000 + j } } })));
  m.set('archive:season0', { season: 0, archivedAt: 1780000000000, players: 120, scores: 120, chunks: 3 });
  arch.forEach((a, i) => m.set('archive:season0:' + i, a));
  m.set('countries', { US: { country: 'US', totalScore: 123456, playerCount: 52, topScore: 40000, topName: 'PILOT400', leaderId: P(400) }, PH: { country: 'PH', totalScore: 99, playerCount: 1, topScore: 99, topName: 'PILOT1', leaderId: P(1) } });
  m.set('entitlements', { [P(2)]: ['cosmic'], [P(3)]: ['solar', 'toxic'], [P(7)]: ['solar'], buyerOnly: ['solar'] });
  m.set('seenSessions', { cs_live_1: 1790000000000, cs_live_2: 1790000000001, cs_live_3: 1790000000002 });
  m.set('lastSubmit', { [P(1)]: 1790000000000, [P(3)]: 1790000000500 });
  m.set('restricted', { deadbeefdeadbeef: { at: 1, reason: 'spam' } });
  m.set('nameBans', { PILOT9: { at: 1 } });
  m.set('flags', [{ id: 'f1:easy', pid: 'f1f1f1f1f1f1f1f1', name: 'PILOT1', difficulty: 'easy', score: 1, at: 1790000000000 }]);
  m.set('restoreLog', [{ at: 1, pid: 'abcdabcdabcdabcd', tag: 'TAG1234', name: 'PILOT1', reason: 'checked by email 🚀' }]);
  m.set('future:a-pad', 'x'.repeat(pad));             // shifts every chunk boundary by one character
  m.set('future:emoji', '🚀🌟'.repeat(n === NPLAYERS ? 20000 : 50));          // 80,000 UTF-16 units of surrogate pairs across chunk boundaries
  m.set('future:unknown', { kept: true, list: [1, 2, 3], n: NaN, inf: -Infinity });   // a key the code does not know about
  return m;
}
const cloneMap = (m) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
const sameMap = (a, b) => a.size === b.size && [...a.keys()].every((k) => b.has(k) && util.isDeepStrictEqual(a.get(k), b.get(k)));
const diffKeys = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => !a.has(k) || !b.has(k) || !util.isDeepStrictEqual(a.get(k), b.get(k)));

async function suite({ workerMod, adminHtml, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default;
  const realNow = Date.now; let now = T0; Date.now = () => now;
  const realErr = console.error; console.error = () => {};   // the injected failures are logged by the worker on purpose
  const mk = (g, b, withBackup) => {
    const env = makeEnv(workerMod, g, b, withBackup);
    const req = async (p, body, headers = {}, method = 'POST') => {
      const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, {});
      const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: res.status, data, text, headers: res.headers };
    };
    const admin = (route, body) => req('/api/admin/' + route, body, H);
    const cron = async () => { const w = []; await worker.scheduled({}, env, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
    const publicView = async () => {
      const out = {};
      for (const d of ['', 'easy', 'medium', 'hard']) out['lb:' + d] = (await req('/api/leaderboard?limit=100' + (d ? '&difficulty=' + d : ''), null, {}, 'GET')).text;
      for (const id of [P(1), P(2), P(3), P(7), 'buyerOnly', P(999)]) {
        out['ent:' + id] = (await req('/api/entitlements?playerId=' + id, null, {}, 'GET')).text;
        out['rc:' + id] = (await req('/api/restore-check', { playerId: id })).text;
      }
      return out;
    };
    return { env, req, admin, cron, publicView };
  };
  const metasOf = (b) => [...b.map].filter(([k]) => k.startsWith('m:')).map(([, v]) => v).sort((x, y) => y.createdAt - x.createdAt);
  const textOf = (b, m) => Array.from({ length: m.chunks }, (_, i) => b.map.get('c:' + m.id + ':' + m.gen + ':' + i)).join('');
  const sha = async (t) => Buffer.from(await crypto.subtle.digest('SHA-256', enc.encode(t))).toString('hex');

  try {
    /* ================= B1 backup ================= */
    if (!quiet) console.log('== B1 a backup copies everything, in checked chunks ==');
    const g = new FakeStorage(seed()), b = new FakeStorage(new Map(), { limit: true });
    const S = mk(g, b);
    const view0 = await S.publicView();
    const orig = cloneMap(g.map);
    ck('B1 (setup) the seeded leaderboard serves every board', JSON.parse(view0['lb:hard']).top.length > 50 && JSON.parse(view0['ent:' + P(3)]).skus.includes('solar'));
    const nopw = await S.req('/api/admin/backup-now', {}), badpw = await S.req('/api/admin/backup-now', {}, { 'x-admin-token': 'nope' });
    ck('B7 BACK UP NOW needs the admin password', nopw.status === 401 && badpw.status === 401 && metasOf(b).length === 0);
    const bn = await S.admin('backup-now');
    ck('B1 BACK UP NOW makes a verified backup', bn.status === 200 && bn.data.ok && bn.data.snapshot.verified === true, bn.text.slice(0, 200));
    const m1 = metasOf(b)[0] || {};
    ck('B1 the manifest counts every key of the storage (listed, not a fixed list: unknown keys included)', m1.keyCount === orig.size, m1.keyCount + ' vs ' + orig.size);
    const t1 = textOf(b, m1);
    ck('B1 the manifest records time, bytes, schema, season, SHA-256 of every chunk and of the whole',
      m1.createdAt === now && m1.schema === 1 && m1.season === 1 && m1.bytes === enc.encode(t1).length && m1.sha256 === await sha(t1)
      && m1.chunkSha.length === m1.chunks && (await Promise.all(Array.from({ length: m1.chunks }, (_, i) => sha(b.map.get('c:' + m1.id + ':' + m1.gen + ':' + i))))).every((h, i) => h === m1.chunkSha[i]));
    const chunkVals = [...b.map].filter(([k]) => k.startsWith('c:')).map(([, v]) => v);
    ck('B1 split into several chunks, each well under the 128 KiB value limit, none splitting a character',
      m1.chunks >= 4 && chunkVals.every((v) => typeof v === 'string' && enc.encode(v).length <= 100 * 1024 && !LONE.test(v)), m1.chunks + ' chunks, max ' + Math.max(...chunkVals.map((v) => enc.encode(v).length)));
    const s1 = m1.summary || {};
    ck('B1 the manifest counts pilots, bests per difficulty, purchases (Solar Inferno too), restore log, bans, season',
      s1.players === NPLAYERS && s1.bests.easy === NPLAYERS - 1 && s1.bests.hard === 210 && s1.bests.medium === 280 && s1.skins.solar === 3 && s1.skins.cosmic === 1 && s1.purchasePilots === 4
      && s1.restoreLog === 1 && s1.nameBans === 1 && s1.restricted === 1 && s1.season === 1 && s1.season0Scores === 120, JSON.stringify(s1));
    const lst = await S.admin('backups');
    ck('B1 the admin list shows it: date, size, keys, verified', lst.status === 200 && lst.data.snapshots.length === 1 && lst.data.snapshots[0].verified === true && lst.data.snapshots[0].bytes === m1.bytes && !('chunkSha' in lst.data.snapshots[0]));
    ck('B1 taking a backup did not change the leaderboard', sameMap(g.map, orig));
    // Every chunk boundary shifted by one character: still no split pair, still verified.
    { const g2 = new FakeStorage(seed(1)), b2 = new FakeStorage(new Map(), { limit: true }); const S2 = mk(g2, b2); const r = await S2.admin('backup-now');
      const vals = [...b2.map].filter(([k]) => k.startsWith('c:')).map(([, v]) => v);
      ck('B1 with every chunk boundary shifted by one, no chunk splits a character either', r.data && r.data.ok && vals.every((v) => !LONE.test(v))); }

    /* ================= B2 dry run ================= */
    if (!quiet) console.log('== B2 dry run: exact report, nothing written ==');
    now += 60000;
    const NEWP = 'bbbbbbbb-bbbb-4ccc-8ddd-000000000001';
    const sub = await S.req('/api/submit-score', { playerId: NEWP, name: 'NEWSTAR', score: 5000, level: levelFor(5000, 'medium'), difficulty: 'medium', country: 'JP', season: 1 });
    await g.delete('restoreLog');
    await g.put('junk:after', { x: 1 });
    const e2 = await g.get('entitlements'); e2[P(3)] = ['toxic']; await g.put('entitlements', e2);
    S.env.restart();
    const viewMut = await S.publicView();
    ck('B2 (setup) the leaderboard really changed', sub.status === 200 && viewMut['lb:medium'] !== view0['lb:medium'] && viewMut['ent:' + P(3)] !== view0['ent:' + P(3)], sub.text.slice(0, 100));
    const liveBefore = cloneMap(g.map), gw = g.writes, bw = b.writes;
    const dr = await S.admin('backup-dry-run', { id: m1.id });
    const d = (dr.data && dr.data.diff) || {};
    ck('B2 the dry run reports the keys a restore would add, change and remove',
      dr.status === 200 && dr.data.dryRun && d.keysAdded.join() === 'restoreLog' && d.keysRemoved.join() === 'junk:after'
      && ['players', 'entitlements', 'lastSubmit', 'countries'].every((k) => d.keysChanged.includes(k)) && !d.keysChanged.includes('season') && d.counts.unchanged === orig.size - 1 - d.keysChanged.length, JSON.stringify(d).slice(0, 300));
    ck('B2 ...pilots and purchases: the new pilot would go, one purchase record changes',
      d.players.removed === 1 && d.players.added === 0 && d.purchases.changed === 1 && d.purchases.removed === 0, JSON.stringify([d.players, d.purchases]));
    ck('B2 ...counts now vs after: pilots, bests, Solar Inferno owners, restore log',
      dr.data.before.players === NPLAYERS + 1 && dr.data.after.players === NPLAYERS && dr.data.before.skins.solar === 2 && dr.data.after.skins.solar === 3
      && dr.data.before.restoreLog === 0 && dr.data.after.restoreLog === 1 && dr.data.after.bests.medium === 280 && dr.data.before.bests.medium === 281 && dr.data.identical === false && dr.data.confirm === 'RESTORE ' + m1.id);
    ck('B2 the dry run wrote nothing: leaderboard storage and backup storage untouched', sameMap(g.map, liveBefore) && g.writes === gw && b.writes === bw, [g.writes - gw, b.writes - bw].join(','));
    ck('B7 the dry run needs the admin password', (await S.req('/api/admin/backup-dry-run', { id: m1.id })).status === 401);

    /* ================= B3 real restore ================= */
    if (!quiet) console.log('== B3 real restore: typed confirmation, safety backup first, identical result ==');
    const nMetas = metasOf(b).length;
    const tries = [{}, { id: m1.id }, { id: m1.id, confirm: 'RESTORE' }, { id: m1.id, confirm: 'restore ' + m1.id }, { id: m1.id, confirm: m1.id }, { id: m1.id, confirm: 'RESTORE ' + m1.id + ' ' }];
    const refused = [];
    for (const t of tries) refused.push((await S.admin('backup-restore', t)).status);
    ck('B3 the real restore is refused without exactly "RESTORE <id>" typed (nothing written, no safety backup made)',
      refused.every((s) => s === 400) && sameMap(g.map, liveBefore) && metasOf(b).length === nMetas, refused.join(','));
    ck('B7 the real restore needs the admin password, even with the confirmation', (await S.req('/api/admin/backup-restore', { id: m1.id, confirm: 'RESTORE ' + m1.id })).status === 401 && sameMap(g.map, liveBefore));
    // The safety backup cannot be written: nothing is restored.
    b.failPut = (o) => Object.keys(o).some((k) => k.startsWith('c:') && k.includes('-safety'));
    const rf = await S.admin('backup-restore', { id: m1.id, confirm: 'RESTORE ' + m1.id });
    b.failPut = null;
    ck('B3 if the safety backup cannot be made, nothing is restored', rf.status >= 500 && sameMap(g.map, liveBefore), rf.status + ' ' + (rf.data && rf.data.error));
    // The leaderboard write fails part-way: the transaction leaves it as it was, the safety backup exists.
    g.failPut = (o) => 'players' in o;   // after the extra key was already deleted
    const rw = await S.admin('backup-restore', { id: m1.id, confirm: 'RESTORE ' + m1.id });
    g.failPut = null;
    const safW = metasOf(b).find((m) => m.kind === 'safety' && m.verified);
    ck('B3 a write failure part-way changes nothing (one transaction) and names the safety backup', rw.status >= 500 && sameMap(g.map, liveBefore) && safW && rw.data.safetyId === safW.id, rw.status + ' ' + rw.text.slice(0, 160));
    S.env.restart();
    const before3 = metasOf(b).map((m) => m.id);
    const rr = await S.admin('backup-restore', { id: m1.id, confirm: 'RESTORE ' + m1.id });
    const saf = metasOf(b).find((m) => m.kind === 'safety' && !before3.includes(m.id));
    ck('B3 the restore succeeds and reports it checked the result', rr.status === 200 && rr.data.ok && rr.data.verified && rr.data.restored === m1.id, rr.text.slice(0, 200));
    let safOk = false;
    try { const t = textOf(b, saf), live = new Map(JSON.parse(t).entries); safOk = saf.verified && saf.keyCount === liveBefore.size && [...liveBefore.keys()].every((k) => live.has(k)) && live.has('junk:after') && !live.has('restoreLog'); } catch (e) {}
    ck('B3 a verified safety backup of the state just before was taken first', safOk && rr.data.safetyId === saf.id && saf.createdAt <= now, saf && saf.id);
    ck('B3 the leaderboard storage is identical to the original: same keys, every value deep-equal (undefined, NaN, -Infinity, emoji included)', sameMap(g.map, orig), diffKeys(g.map, orig).join(','));
    ck('B3 the public routes answer exactly as before (all/easy/medium/hard boards, entitlements, restore-check)', util.isDeepStrictEqual(await S.publicView(), view0));
    S.env.restart();
    ck('B3 ...and after a restart too', util.isDeepStrictEqual(await S.publicView(), view0));
    const dr2 = await S.admin('backup-dry-run', { id: m1.id });
    ck('B3 a dry run now reports "identical"', dr2.data && dr2.data.identical === true && dr2.data.diff.counts.changed === 0);
    // Total loss: every key wiped, then restored.
    g.map.clear(); S.env.restart();
    const wiped = await S.publicView();
    ck('B3 (setup) after a wipe the boards are empty', JSON.parse(wiped['lb:']).top.length === 0);
    const rr2 = await S.admin('backup-restore', { id: m1.id, confirm: 'RESTORE ' + m1.id });
    ck('B3 after a complete wipe the restore brings back every key, identical', rr2.status === 200 && rr2.data.verified && sameMap(g.map, orig), diffKeys(g.map, orig).join(','));
    ck('B3 ...and the public routes answer exactly as before', util.isDeepStrictEqual(await S.publicView(), view0));
    // Undo: restore the safety backup -> the mutated state is back.
    const ru = await S.admin('backup-restore', { id: saf.id, confirm: 'RESTORE ' + saf.id });
    ck('B3 a restore can be undone with its safety backup', ru.status === 200 && sameMap(g.map, liveBefore), diffKeys(g.map, liveBefore).join(','));
    await S.admin('backup-restore', { id: m1.id, confirm: 'RESTORE ' + m1.id });

    /* ================= B6 damaged backups ================= */
    if (!quiet) console.log('== B6 a damaged backup is detected and never restored ==');
    const bad = await S.admin('backup-now');
    const mb = metasOf(b).find((m) => m.id === bad.data.snapshot.id);
    const ci = Array.from({ length: mb.chunks }, (_, i) => i).find((i) => /"score":\d/.test(b.map.get('c:' + mb.id + ':' + mb.gen + ':' + i)));
    const ck1 = 'c:' + mb.id + ':' + mb.gen + ':' + ci, good1 = b.map.get(ck1);
    b.map.set(ck1, good1.replace(/"score":(\d)/, (x, n) => '"score":' + ((+n + 1) % 10)));   // one digit of one score
    await g.put('junk:now', 1); S.env.restart();
    const liveNow = cloneMap(g.map);
    const bd = await S.admin('backup-dry-run', { id: mb.id }), br = await S.admin('backup-restore', { id: mb.id, confirm: 'RESTORE ' + mb.id }), bl = await S.admin('backup-download', { id: mb.id });
    ck('B6 a changed chunk is detected: dry run, restore and download all refuse', bd.status === 409 && bd.data.verified === false && br.status === 409 && bl.status === 409 && /damaged|checksum/.test(bd.data.error), [bd.status, br.status, bl.status].join(','));
    ck('B6 the refused restore left the leaderboard untouched and made no safety backup', sameMap(g.map, liveNow) && !metasOf(b).some((m) => m.kind === 'safety' && m.createdAt === now && m.note.includes(mb.id)));
    ck('B6 the list now shows it as failed', (await S.admin('backups')).data.snapshots.find((m) => m.id === mb.id).verified === false);
    b.map.set(ck1, good1); b.map.delete('c:' + mb.id + ':' + mb.gen + ':2');
    const bm = await S.admin('backup-dry-run', { id: mb.id });
    ck('B6 a missing chunk is detected too', bm.status === 409 && /missing/.test(bm.data.error), bm.text.slice(0, 120));
    await g.delete('junk:now');

    /* ================= B8 download / upload ================= */
    if (!quiet) console.log('== B8 download and upload ==');
    const dl = await S.admin('backup-download', { id: m1.id });
    const file = dl.data || {};
    ck('B8 download: a JSON file (attachment) with the manifest and the snapshot, matching its checksum',
      dl.status === 200 && /attachment; filename="flux-backup-/.test(dl.headers.get('content-disposition') || '') && /no-store/.test(dl.headers.get('cache-control') || '')
      && file.format === 'flux-leaderboard-backup' && file.manifest.sha256 === m1.sha256 && (await sha(JSON.stringify(file.snapshot))) === m1.sha256 && file.manifest.keyCount === orig.size);
    ck('B7 download needs the admin password', (await S.req('/api/admin/backup-download', { id: m1.id })).status === 401);
    const tampered = structuredClone(file); tampered.snapshot.entries.find((e) => e[0] === 'players')[1][P(1)].bests.easy.score = 999999;
    const up1 = await S.admin('backup-import', { backup: tampered });
    ck('B8 a changed file is refused on upload', up1.status === 400 && /checksum/.test(up1.data.error));
    ck('B7 upload needs the admin password', (await S.req('/api/admin/backup-import', { backup: file })).status === 401);
    // Off-site recovery: the server's backups are all lost; the downloaded file brings the leaderboard back.
    for (const k of [...b.map.keys()]) b.map.delete(k);
    g.map.clear(); S.env.restart();
    const up = await S.admin('backup-import', { backup: JSON.parse(dl.text) });
    const upId = up.data && up.data.snapshot && up.data.snapshot.id;
    const ur = upId ? await S.admin('backup-restore', { id: upId, confirm: 'RESTORE ' + upId }) : {};
    ck('B8 with every server backup lost, the downloaded file is uploaded, checked and restored: identical again',
      up.status === 200 && up.data.snapshot.kind === 'imported' && up.data.snapshot.verified && ur.status === 200 && sameMap(g.map, orig), (up.text || '').slice(0, 120));

    /* ================= B9 privacy ================= */
    if (!quiet) console.log('== B9 a privacy deletion reaches every backup ==');
    now += 60000; await S.admin('backup-now');
    const tag3 = (await S.req('/api/restore-check', { playerId: P(3) })).data.tag;
    const find = await S.admin('find-player', { query: 'PILOT3 #' + tag3 });
    const pid3 = find.data.matches.find((x) => x.name === 'PILOT3').pid;
    const rl = await g.get('restoreLog'); rl.push({ at: 2, pid: pid3, tag: 'X', name: 'PILOT3', reason: 'mum emailed jane@example.com' }); await g.put('restoreLog', rl); S.env.restart();
    await S.admin('backup-now');
    const withP3 = metasOf(b).filter((m) => textOf(b, m).includes(P(3)));
    const del = await S.admin('privacy-delete', { pid: pid3, removePurchases: true });
    const after = metasOf(b);
    ck('B9 the privacy deletion reports the backups it cleaned', del.status === 200 && del.data.ok && del.data.backups && del.data.backups.ok && del.data.backups.changed === withP3.length && withP3.length >= 3, JSON.stringify(del.data && del.data.backups));
    ck('B9 no backup holds the pilot any more (scores, purchases, Season 0 archive, restore-log name and reason), and every one is still verified',
      after.every((m) => m.verified && !textOf(b, m).includes(P(3)) && !textOf(b, m).includes('jane@example.com')), after.map((m) => m.id + ':' + m.verified).join(','));
    const r9 = await S.admin('backup-restore', { id: withP3[withP3.length - 1].id, confirm: 'RESTORE ' + withP3[withP3.length - 1].id });
    const rc9 = await S.req('/api/restore-check', { playerId: P(3) }), ent9 = await S.req('/api/entitlements?playerId=' + P(3), null, {}, 'GET');
    ck('B9 restoring an older backup never brings the deleted pilot back', r9.status === 200 && rc9.data.found === false && ent9.data.skus.length === 0 && !JSON.stringify([...g.map]).includes(P(3)));
    ck('B9 other pilots in those backups are untouched', (await S.req('/api/restore-check', { playerId: P(2) })).data.found === true && JSON.parse((await S.req('/api/entitlements?playerId=' + P(7), null, {}, 'GET')).text).skus.includes('solar'));
    ck('B9 the Privacy Policy says backups exist, how long they are kept, and that a deletion reaches them; retention stays under 30 days',
      /<strong>Backups\.<\/strong>/.test(PRIVACY) && /last 14 daily copies/.test(PRIVACY) && /at most 28 days/.test(PRIVACY) && /removed from every backup copy/.test(PRIVACY)
      && /const BACKUP_MAX_AGE_DAYS = 28;/.test(workerMod.__src || WORKER_SRC) && /const BACKUP_KEEP_DAILY = 14;/.test(workerMod.__src || WORKER_SRC));

    /* ================= B4 cron ================= */
    if (!quiet) console.log('== B4 one automatic backup per day ==');
    const gc = new FakeStorage(seed(0, 40)), bc = new FakeStorage(new Map(), { limit: true }); const C = mk(gc, bc);
    now = T0 + 40 * DAY;   // 00:10 UTC
    await C.cron();
    const dailies = () => metasOf(bc).filter((m) => m.kind === 'daily');
    ck('B4 the first cron run of the day takes the daily backup, verified', dailies().length === 1 && dailies()[0].verified && dailies()[0].day === new Date(now).toISOString().slice(0, 10));
    now += 30 * 60000; await C.cron(); now += 8 * 3600000; await C.cron();
    ck('B4 later runs the same day do nothing (no duplicate)', dailies().length === 1, dailies().length);
    const st4 = (await C.admin('backups')).data;
    ck('B4 the admin page shows the last backup status', st4.status.daily.ok === true && st4.status.daily.attempts === 1 && st4.stale === false && st4.log[0].event === 'daily backup ok');
    now = T0 + 41 * DAY + 5 * 60000; gc.failList = true; await C.cron();
    const st5 = (await C.admin('backups')).data;
    ck('B4 a failed daily backup is recorded and shown (status, log)', dailies().length === 1 && st5.status.daily.ok === false && st5.status.daily.error && st5.log[0].event === 'daily backup FAILED', JSON.stringify(st5.status.daily));
    for (let i = 0; i < 6; i++) { now += 30 * 60000; await C.cron(); }
    const st6 = (await C.admin('backups')).data;
    ck('B4 it is retried on the next runs, a few times a day at most', st6.status.daily.attempts === 4, st6.status.daily.attempts);
    gc.failList = false; now = T0 + 42 * DAY; await C.cron();
    ck('B4 the next day works again', dailies().length === 2 && (await C.admin('backups')).data.status.daily.ok === true);
    { const e0 = new FakeStorage(seed()); const E = mk(e0, null, false); let threw = false; try { await E.cron(); } catch (e) { threw = true; }
      ck('B4 if the backup instance fails, the cron still runs its other jobs (stats clean-up) and does not fail', !threw && E.env._inst.has('lb:analytics')); }

    /* ================= B5 retention ================= */
    if (!quiet) console.log('== B5 retention ==');
    now = T0 + 42 * DAY + 3600000; await C.admin('backup-now');
    for (let day = 43; day <= 90; day++) { now = T0 + day * DAY + ((day * 7) % 50) * 60000; await C.cron(); }
    const all = metasOf(bc), ds = all.filter((m) => m.kind === 'daily'), weekly = ds.filter((m) => m.weekly);
    const newest14 = ds.slice(0, 14).map((m) => m.id), extra = ds.filter((m) => !newest14.includes(m.id));
    ck('B5 exactly the newest 14 daily backups are kept (plus weekly ones)', ds.length >= 14 && ds.slice(0, 14).every((m, i) => m.day === new Date(T0 + (90 - i) * DAY).toISOString().slice(0, 10)) && extra.every((m) => m.weekly), ds.map((m) => m.day.slice(5) + (m.weekly ? 'w' : '')).join(' '));
    ck('B5 weekly backups: at most 4, one per week, none older than 28 days', weekly.length <= 4 && extra.length >= 1 && new Set(weekly.map((m) => Math.floor((Math.floor(m.createdAt / DAY) + 3) / 7))).size === weekly.length && all.every((m) => now - m.createdAt <= 28 * DAY), weekly.map((m) => m.day).join(','));
    ck('B5 a manual backup older than 28 days is removed; no chunk is left behind', !all.some((m) => m.kind === 'manual') && [...bc.map.keys()].filter((k) => k.startsWith('c:')).length === all.reduce((n, m) => n + m.chunks, 0));
    // The daily re-check marks a damaged stored backup as failed.
    const victim = ds[3]; bc.map.set('c:' + victim.id + ':' + victim.gen + ':0', 'x');
    now = T0 + 91 * DAY; await C.cron();
    const lv = (await C.admin('backups')).data;
    ck('B6 the daily re-check marks a damaged stored backup as failed and logs it', lv.snapshots.find((m) => m.id === victim.id).verified === false && lv.log.some((x) => x.event === 'stored backup failed its check' && x.id === victim.id));

    /* ================= B10 admin page + deploy ================= */
    if (!quiet) console.log('== B10 admin page and deploy ==');
    const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'), adminHtml.indexOf('<details id="advanced">'));
    ck('B10 admin.html has a BACKUPS section: list, status, BACK UP NOW, DRY RUN, DOWNLOAD, upload',
      /<h2>BACKUPS<\/h2>/.test(adminHtml) && /id="bkNow"/.test(adminHtml) && /id="bkLoad"/.test(adminHtml) && /call\('backups'\)/.test(adminHtml) && /call\('backup-now'\)/.test(adminHtml)
      && /call\('backup-dry-run', \{ id: m\.id \}\)/.test(adminHtml) && /\/api\/admin\/backup-download/.test(adminHtml) && /call\('backup-import'/.test(adminHtml) && /VERIFIED ✓/.test(adminHtml) && /FAILED ✗/.test(adminHtml));
    ck('B10 the real restore is only offered after a dry run, behind the typed phrase (button disabled until it matches)',
      /function showDryRun\(/.test(adminHtml) && /call\('backup-restore', \{ id: m\.id, confirm: inp\.value \}\)/.test(adminHtml) && /go\.disabled = true;/.test(adminHtml) && /inp\.oninput = function \(\) \{ go\.disabled = inp\.value !== r\.confirm; \};/.test(adminHtml)
      && adminHtml.indexOf("call('backup-restore'") > adminHtml.indexOf('function showDryRun('));
    ck('B10 the GUIDE explains backups, the dry run, when to use the real restore, downloads and privacy',
      /<h3>Backups and restore<\/h3>/.test(guide) && /DRY RUN<\/b> changes nothing/.test(guide) && /only for a real accident/.test(guide) && /safety copy/.test(guide) && /DOWNLOAD<\/b>/.test(guide) && /privacy deletion<\/b> also removes/.test(guide) && /made after it are lost/.test(guide));
    ck('B10 the page adds no event listeners (property handlers) and writes text only', (adminHtml.match(/addEventListener\(/g) || []).length === 2 && !/innerHTML/.test(adminHtml));
    const cfg = JSON.parse(WRANGLER.replace(/^\s*\/\/.*$/mg, ''));
    ck('B10 deploy: no new binding, class or migration (backups are an instance of LeaderboardDO, like "analytics"); no bucket or namespace to make by hand',
      JSON.stringify(cfg.durable_objects.bindings) === JSON.stringify([{ name: 'LEADERBOARD_DO', class_name: 'LeaderboardDO' }]) && JSON.stringify(cfg.migrations) === JSON.stringify([{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }])
      && !cfg.r2_buckets && !cfg.d1_databases && cfg.kv_namespaces.length === 1 && Object.keys(workerMod).filter((k) => k !== '__src').sort().join() === 'LeaderboardDO,default'
      && /idFromName\("backups"\)/.test(workerMod.__src || WORKER_SRC));
    { let mainCfg = null;
      try { const r = spawnSync('git', ['show', 'origin/main:wrangler.jsonc'], { cwd: ROOT, encoding: 'utf8' }); if (r.status === 0 && r.stdout) mainCfg = r.stdout; } catch (e) {}
      // Only the parts this check is about (FREE PLAN changes the "assets" routing, not these).
      const strip = (t) => { const c = JSON.parse(t.replace(/^\s*\/\/.*$/mg, '')); return JSON.stringify([c.durable_objects, c.migrations, c.triggers, c.kv_namespaces, c.r2_buckets, c.d1_databases]); };
      ck('B10 wrangler.jsonc has the same bindings, migrations and triggers as main (checked against origin/main when git is available)', mainCfg === null || strip(mainCfg) === strip(WRANGLER), mainCfg === null ? 'git not available: fixed checks above only' : ''); }
    // The two roles never mix.
    const G = mk(new FakeStorage(seed(0, 20)), new FakeStorage(new Map(), { limit: true }));
    await G.publicView();
    const lbGet = (id) => G.env.LEADERBOARD_DO.get(id);
    const onGlobal = await lbGet('global').fetch('https://do.internal/bk/snapshot', { method: 'POST', headers: { 'x-flux-instance': 'backups' }, body: '{}' });
    const noHeader = await lbGet('backups').fetch('https://do.internal/bk/list', { method: 'POST', body: '{}' });
    ck('B11 backup paths refuse to run on the leaderboard instance (it is never marked or written) and need the internal header', onGlobal.status === 409 && !G.env._g.map.has('bk:role') && ![...G.env._g.map.keys()].some((k) => /^(m|c):/.test(k)) && noHeader.status === 404, onGlobal.status + ',' + noHeader.status);
    await G.admin('backup-now');
    const lbOnBackups = await lbGet('backups').fetch('https://do.internal/leaderboard');
    const subOnBackups = await lbGet('backups').fetch('https://do.internal/submit', { method: 'POST', body: '{}' });
    ck('B11 the backups instance never serves leaderboard routes (and never loads or creates a leaderboard there)', lbOnBackups.status === 404 && subOnBackups.status === 404 && !G.env._b.map.has('players') && !G.env._b.map.has('season') && G.env._b.map.get('bk:role') === 'backups');
    G.env.restart();
    ck('B11 ...also after a restart', (await lbGet('backups').fetch('https://do.internal/leaderboard')).status === 404 && (await G.admin('backups')).data.snapshots.length === 1);
    ck('B10 the existing 30-minute cron is reused (no new trigger)', JSON.stringify(cfg.triggers) === JSON.stringify({ crons: ['*/30 * * * *'] }));
    ck('B7 every backup route checks the admin password first', ['backups', 'backup-now', 'backup-dry-run', 'backup-restore', 'backup-download', 'backup-import'].every((r) => (workerMod.__src || WORKER_SRC).includes('"/api/admin/' + r + '":')));
    const s7 = []; for (const r of ['backups', 'backup-now', 'backup-dry-run', 'backup-restore', 'backup-download', 'backup-import']) s7.push((await C.req('/api/admin/' + r, { id: ds[0].id, confirm: 'RESTORE ' + ds[0].id })).status);
    ck('B7 ...and every one answers 401 without it', s7.every((x) => x === 401), s7.join(','));
  } catch (e) { ck('suite ran to the end', false, String(e.stack || e).slice(0, 500)); }
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
  const tmp = path.join(__dirname, '.nc-backup-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ workerMod: Object.assign({ __src: w2 }, mod), adminHtml: a2, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('backup reads a fixed key list instead of listing storage', 'B1 the manifest counts every key', { worker: rep('const entries = await bkListAll(this.state.storage);\n      text = bkEncode(entries);', 'const entries = [];\n      for (const k of ["players", "entitlements", "seenSessions", "restoreLog", "nameBans", "restricted", "flags", "countries", "season"]) { const v = await this.state.storage.get(k); if (v !== undefined) entries.push([k, v]); }\n      text = bkEncode(entries);') });
await control('backup reads only the first page of keys', 'B1 the manifest counts every key', { worker: (s) => rep('if (n < BACKUP_LIST_PAGE) return entries;', 'return entries;')(rep('const BACKUP_LIST_PAGE = 500;', 'const BACKUP_LIST_PAGE = 5;')(s)) });
await control('chunks too big for one stored value', 'B1 BACK UP NOW makes a verified backup', { worker: rep('const BACKUP_CHUNK_CHARS = 30000;', 'const BACKUP_CHUNK_CHARS = 3000000;') });
await control('a chunk boundary may split a character', 'B1 ', { worker: rep('if (j < text.length) { const c = text.charCodeAt(j - 1); if (c >= 0xd800 && c <= 0xdbff) j--; }', '') });
await control('stored undefined / NaN are lost by the copy', 'B1 BACK UP NOW makes a verified backup', { worker: (s) => rep('    if (v === undefined) return { [BK_MARK]: "undefined" };\n', '')(rep('    if (typeof v === "number" && !Number.isFinite(v)) return { [BK_MARK]: String(v) };\n', '')(s)) });
await control('backup not read back and checked', 'B6 a changed chunk is detected', { worker: rep('  async verify(id) {\n    const meta = await this.state.storage.get("m:" + id);', '  async verify(id) {\n    const meta = await this.state.storage.get("m:" + id);\n    if (meta) { const parts = []; for (let i = 0; i < meta.chunks; i++) parts.push(await this.state.storage.get(this.chunkKey(id, meta.gen, i))); if (parts.every((p) => typeof p === "string")) return { ok: true, error: "", meta, text: parts.join("") }; }') });
await control('dry run writes (restores)', 'B2 the dry run wrote nothing', { worker: rep('const liveText = await this.dumpLive(), live = bkDecode(liveText), snap = bkDecode(v.text);', 'const liveText = await this.dumpLive(), live = bkDecode(liveText), snap = bkDecode(v.text);\n    await this.lb("/backup-restore", { method: "POST", body: v.text });') });
await control('restore without the typed confirmation', 'B3 the real restore is refused', { worker: rep('    if (confirm !== "RESTORE " + id) return json', '    if (false) return json') });
await control('restore without a safety backup', 'B3 a verified safety backup', { worker: rep('const safety = await this.takeSnapshot("safety", "before restoring " + id, liveText);', 'const safety = { verified: true, id: "none" };') });
await control('restore goes ahead when the safety backup failed', 'B3 if the safety backup cannot be made', { worker: rep('const safety = await this.takeSnapshot("safety", "before restoring " + id, liveText);', 'let safety; try { safety = await this.takeSnapshot("safety", "before restoring " + id, liveText); } catch (e) { safety = { verified: true, id: "none" }; }') });
await control('restore not in one transaction', 'B3 a write failure part-way', { worker: rep('if (typeof st.transaction === "function") await st.transaction(apply); else await apply(st);', 'await apply(st);') });
await control('restore keeps keys that are not in the backup', 'B3 the leaderboard storage is identical', { worker: rep('for (let i = 0; i < gone.length; i += BACKUP_PUT_KEYS) await st.delete(gone.slice(i, i + BACKUP_PUT_KEYS));', '') });
await control('restore does not reload the leaderboard memory', 'B3 the public routes answer exactly as before', { worker: rep('this.ready = false; this.tagCache = null; this.pidCache = new Map();\n    });\n    await this.load();', '});') });
await control('restore goes ahead with a damaged backup', 'B6 a changed chunk is detected', { worker: rep('const { resp, v } = await this.checked(id); if (resp) return resp;\n    const liveText = await this.dumpLive();\n    const safety', 'const v = await this.verify(id); if (!v.meta) return json({ error: "No such backup." }, 404);\n    if (!v.text) { const parts = []; for (let i = 0; i < v.meta.chunks; i++) parts.push(await this.state.storage.get(this.chunkKey(id, v.meta.gen, i))); v.text = parts.join(""); }\n    const liveText = await this.dumpLive();\n    const safety') });
await control('cron backs up on every run', 'B4 later runs the same day do nothing', { worker: rep('if (d && (d.ok || d.attempts >= BACKUP_DAILY_ATTEMPTS)) return', 'if (false) return') });
await control('cron never takes the daily backup', 'B4 the first cron run', { worker: rep('    if (env.LEADERBOARD_DO) ctx.waitUntil(backupDO(env, "/daily"', '    if (false) ctx.waitUntil(backupDO(env, "/daily"') });
await control('a failed daily is not retried', 'B4 it is retried', { worker: rep('if (d && (d.ok || d.attempts >= BACKUP_DAILY_ATTEMPTS)) return', 'if (d) return') });
await control('retention keeps too many', 'B5 exactly the newest 14', { worker: rep('const BACKUP_KEEP_DAILY = 14;', 'const BACKUP_KEEP_DAILY = 30;') });
await control('weekly backups kept too long', 'B5 weekly backups', { worker: rep('const BACKUP_MAX_AGE_DAYS = 28;', 'const BACKUP_MAX_AGE_DAYS = 60;') });
await control('backup route without the password', 'B7 BACK UP NOW needs the admin password', { worker: rep('async function adminBackup(request, env, doPath) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminBackup(request, env, doPath) {') });
await control('privacy deletion leaves the backups', 'B9 ', { worker: rep('  if (!env.LEADERBOARD_DO) return live;\n', '  return live;\n') });
await control('privacy deletion leaves the Season 0 archive (live and backups)', 'B9 no backup holds the pilot', { worker: rep('    await this.eraseFromSeasonArchive(id);   // SEASON 1', '    this.restoreLog = this.restoreLog;   // SEASON 1') });
await control('backup paths run on the leaderboard instance', 'B11 backup paths refuse', { worker: rep('if ((await st.get("players")) !== undefined || (await st.get("season")) !== undefined) return', 'if (false) return') });
await control('backups instance serves leaderboard routes', 'B11 the backups instance never serves', { worker: rep('    if (this.role) return json({ error: "Not found" }, 404);\n', '') });
await control('upload accepts a changed file', 'B8 a changed file is refused', { worker: rep('if ((await bkSha(text)) !== f.manifest.sha256 || entries.length !== f.manifest.keyCount) return', 'if (false) return') });
await control('admin page loses the BACKUPS section', 'B10 admin.html has a BACKUPS section', { admin: rep('<h2>BACKUPS</h2>', '<h2>COPIES</h2>') });
await control('admin page restore without the typed phrase', 'B10 the real restore is only offered', { admin: rep('go.disabled = true;', 'go.disabled = false;') });
await control('guide loses the backup note', 'B10 the GUIDE explains', { admin: rep('<h3>Backups and restore</h3>', '<h3>Copies</h3>') });
const total = main.F + NC;
console.log('\n' + (total ? 'BACKUP / RESTORE FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'BACKUP / RESTORE PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
