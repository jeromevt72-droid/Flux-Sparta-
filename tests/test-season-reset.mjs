// SEASON 1 (owner): every score is reset ONCE, the old bests are archived for the
// admin page, pages older than Season 1 cannot post old-rate scores, the phone
// clears its own old bests once, and returning players see one message.
//   S1 the reset runs on the first request after the deploy: every board (Easy, Medium, Hard, All) is empty;
//   S2 the archive holds every player's bests (all difficulties: score, level, date + playerId, name, country), chunked;
//   S3 pilots, names, countries, skins/purchases, restrictions, name bans, restore log, analytics, cooldowns untouched;
//   S4 country figures are recomputed (empty after the reset; a Season 1 score counts alone);
//   S5 it happens only once: a second load, a DO restart and concurrent first requests never archive or clear again,
//      and Season 1 scores survive; a failure part-way retries without losing a score;
//   S6 a submission without season >= 1 is refused (409), one with season 1 is accepted;
//   S7 admin: the archive route needs the admin password, lists every archived score highest first with a count,
//      never a playerId; a privacy deletion also removes the pilot from the archive; admin.html section + guide;
//   C1 the page clears the saved easy/medium/hard bests once (share-card/menu best too) and keeps everything else;
//   C2 every upload carries season:1; a queued pre-season upload is dropped, never sent; a 409 drops quietly;
//   C3 the message is shown once, only to players who had played before; never during a run;
//   S8 a pilot who owns Solar Inferno (or every skin, or bought without a score) still owns it after the reset,
//      through /api/entitlements and the restore code (/api/restore-check), also after a restart;
//   C4 the phone of a Solar Inferno owner keeps the skin, its purchase record and the pilot.
// Ends with negative controls: each defect re-inserted into the source MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { levelFor } from './level-rule.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const MSG = 'Season 1: new point rates on Easy and Medium.';   // COMBINED WORLD GRID: reworded, true before and after the grids are combined
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');

/* ---------------- fake Durable Object runtime ---------------- */
class FakeStorage {
  constructor(map) { this.map = map || new Map(); this.failPut = null; this.puts = 0; }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v };
    if (Object.keys(obj).length > 128) throw new Error('put: more than 128 keys');
    for (const [kk, vv] of Object.entries(obj)) if (kk.startsWith('archive:') && JSON.stringify(vv).length > 128 * 1024) throw new Error('put: value over 128 KiB (' + kk + ')');
    if (this.failPut && this.failPut(obj)) throw new Error('storage failure');
    this.puts++;
    for (const [kk, vv] of Object.entries(obj)) this.map.set(kk, structuredClone(vv));   // one put: all or nothing
  }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
}
// blockConcurrencyWhile as Cloudflare runs it: nothing else runs until fn settles.
class FakeState {
  constructor(storage) { this.storage = storage; this.lock = Promise.resolve(); }
  blockConcurrencyWhile(fn) { const r = this.lock.then(fn); this.lock = r.then(() => {}, () => {}); return r; }
}
const tick = () => new Promise((r) => setTimeout(r, 1));
// A storage whose get() yields, so unguarded concurrent loads would really interleave.
class SlowStorage extends FakeStorage { async get(k) { await tick(); return super.get(k); } }

function makeEnv(LeaderboardDO, storage) {
  const instances = new Map(); let chain = Promise.resolve();
  const env = { ADMIN_TOKEN: 'pw', _storage: storage, LEADERBOARD_DO: { idFromName: (n) => n, _instances: instances, get(id) {
    if (!instances.has(id)) instances.set(id, new LeaderboardDO(new FakeState(id === 'global' ? env._storage : new FakeStorage())));
    const o = instances.get(id);
    return { fetch(url, init) { const run = () => o.fetch(new Request(url, init)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } }; } } };
  // "Restart": the DO object is thrown away; storage survives.
  env.restart = () => { instances.delete('global'); };
  return env;
}

/* A realistic Season 0 DO: players with bests on every difficulty (one legacy
   single-score record), restricted and banned players, purchases, restore log,
   analytics, cooldowns. */
function seedSeason0(n = 6) {
  const m = new Map(), players = {};
  const cc = ['US', 'PH', 'JP', 'DE', 'BR', 'KE'];
  for (let i = 1; i <= n; i++) {
    const s = 1000 * i;
    players[P(i)] = { playerId: P(i), name: 'PILOT' + i, country: cc[i % cc.length], updatedAt: 1700000000000 + i,
      bests: { easy: { score: s, level: levelFor(s, 'easy'), updatedAt: 1700000000100 + i },
               medium: { score: s * 2, level: levelFor(s * 2, 'medium'), updatedAt: 1700000000200 + i },
               ...(i % 2 ? { hard: { score: s * 3, level: levelFor(s * 3, 'hard'), updatedAt: 1700000000300 + i } } : {}) } };
  }
  players.legacy1 = { playerId: 'legacy1', name: 'OLDTIMER', country: 'US', score: 7777, level: levelFor(7777, 'medium'), difficulty: 'medium', updatedAt: 1690000000000 };
  players.nobest = { playerId: 'nobest', name: 'NOBEST', country: 'PH', updatedAt: 1690000000001, bests: {} };
  m.set('players', players);
  m.set('nameRulesV1', 1);
  m.set('countries', { US: { country: 'US', totalScore: 99999, playerCount: 3, topScore: 50000, topName: 'X', leaderId: P(1) } });
  m.set('entitlements', { [P(2)]: ['cosmic'], buyerOnly: ['solar'] });
  m.set('seenSessions', { cs_1: 1 });
  m.set('lastSubmit', { [P(1)]: 1700000000000 });
  m.set('restricted', { deadbeefdeadbeef: { at: 1, reason: 'test' } });
  m.set('nameBans', { PILOT3: { at: 1 } });
  m.set('flags', [{ id: 'f1', pid: 'x', name: 'PILOT1', difficulty: 'easy', score: 1, at: Date.now() }]);
  m.set('restoreLog', [{ at: 1, pid: 'abcd', tag: 'TAG1234', name: 'PILOT1', reason: 'checked' }]);
  m.set('an:days', [20000]); m.set('an:day:20000', { all: { opens: 5 } });
  return m;
}
const NOT_SCORES = ['nameRulesV1', 'entitlements', 'seenSessions', 'lastSubmit', 'restricted', 'nameBans', 'flags', 'restoreLog', 'an:days', 'an:day:20000'];

async function suite({ gameHtml, workerMod, adminHtml, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, DO = workerMod.LeaderboardDO;
  let skew = 0; const realNow = Date.now;
  Date.now = () => realNow() + skew;   // step past the 10 s submit cooldown
  const realErr = console.error; console.error = () => {};   // the injected storage failures are logged by the worker on purpose
  const mk = (storage) => {
    const env = makeEnv(DO, storage);
    const call = async (p, body, headers = {}, method = 'POST') => { const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, {}); let d = null; try { d = await res.json(); } catch (e) {} return { status: res.status, data: d }; };
    const submit = (id, score, difficulty = 'medium', extra = { season: 1 }, country = 'US') => { skew += 20000; return call('/api/submit-score', { playerId: id, name: 'NEWSTAR', score, level: levelFor(score, difficulty), difficulty, country, ...extra }); };
    const board = async (d) => (await call('/api/leaderboard' + (d ? '?difficulty=' + d + '&limit=100' : '?limit=100'), null, {}, 'GET')).data;
    return { env, call, submit, board, storage };
  };
  const archiveOf = async (storage) => {
    const meta = await storage.get('archive:season0'); const players = [];
    for (let i = 0; meta && i < meta.chunks; i++) players.push(...((await storage.get('archive:season0:' + i)) || []));
    return { meta, players };
  };

  /* ================= server ================= */
  try {
    if (!quiet) console.log('== server: the reset ==');
    const storage = new FakeStorage(seedSeason0());
    const before = new Map([...storage.map].map(([k, v]) => [k, structuredClone(v)]));
    const S = mk(storage);
    const lb0 = await S.board();
    const all = await S.board(), e = await S.board('easy'), m = await S.board('medium'), h = await S.board('hard');
    ck('S1 after the first request every board is empty (All, Easy, Medium, Hard)', lb0.top.length === 0 && all.top.length === 0 && e.top.length === 0 && m.top.length === 0 && h.top.length === 0,
      [all.top.length, e.top.length, m.top.length, h.top.length].join(','));
    ck('S1 the season marker is stored', (await storage.get('season')) === 1);
    const stored = await storage.get('players');
    ck('S1 every player\'s bests are cleared (all difficulties)', Object.values(stored).every((r) => r.bests && Object.keys(r.bests).length === 0));

    const { meta, players } = await archiveOf(storage);
    const want = [];
    for (const [id, r] of Object.entries(before.get('players'))) {
      const bests = r.bests || (Number.isFinite(r.score) ? { [r.difficulty]: { score: r.score, level: r.level, updatedAt: r.updatedAt } } : {});
      for (const [d, b] of Object.entries(bests)) want.push([id, r.name, r.country, d, b.score, b.level, b.updatedAt].join('|'));
    }
    const got = []; for (const p of players) for (const [d, b] of Object.entries(p.bests)) got.push([p.playerId, p.name, p.country, d, b.score, b.level, b.updatedAt].join('|'));
    ck('S2 the archive holds every best: playerId, name, country, difficulty, score, level, date (legacy record included)', want.length === 16 && JSON.stringify(want.sort()) === JSON.stringify(got.sort()), got.length + '/' + want.length);
    ck('S2 the archive summary counts players and scores', meta && meta.season === 0 && meta.players === 7 && meta.scores === 16 && meta.chunks >= 1 && Number.isFinite(meta.archivedAt), JSON.stringify(meta));
    ck('S2 a player with no best is not archived', !players.some((p) => p.playerId === 'nobest'));

    const untouched = NOT_SCORES.filter((k) => JSON.stringify(before.get(k)) !== JSON.stringify(storage.map.get(k)));
    ck('S3 skins/purchases, restrictions, name bans, flags, restore log, analytics, cooldowns unchanged', untouched.length === 0, untouched.join(','));
    const ids = Object.keys(before.get('players'));
    const same = ids.every((id) => { const a = before.get('players')[id], b = stored[id]; return b && b.playerId === (a.playerId || id) && b.name === a.name && b.country === a.country && b.updatedAt === a.updatedAt; });
    ck('S3 every pilot kept: same ids, names, countries, dates', same && Object.keys(stored).length === ids.length);

    ck('S4 country figures recomputed: none left after the reset', Array.isArray(all.countries) && all.countries.length === 0 && Object.keys(await storage.get('countries')).length === 0, JSON.stringify(all.countries));
    const s1 = await S.submit(P(1), 3000, 'hard')   // Hard: weight 1, so the ALL board and country show the real 3,000;
    const after = await S.board();
    const us = after.countries.find((c) => c.country === 'US');
    ck('S4 a Season 1 score counts alone (country total = that score, one player)', s1.status === 200 && after.countries.length === 1 && us && us.totalScore === 3000 && us.playerCount === 1, JSON.stringify(after.countries));
    ck('S3 a pilot\'s Season 1 score keeps their tag and the tag map', s1.data && /^[0-9A-Z]{7}$/.test(s1.data.tag || '') && after.top[0].tag === s1.data.tag);

    if (!quiet) console.log('== server: only once ==');
    const archivedAt = meta.archivedAt, puts = storage.puts;
    const inst = S.env.LEADERBOARD_DO._instances.get('global'); inst.ready = false;       // second load of the same object
    const again = await S.board();
    S.env.restart();                                                                    // DO restart: new object, same storage
    const again2 = await S.board('hard');
    const a2 = await archiveOf(storage);
    ck('S5 a second load and a restart do not wipe Season 1 scores', again.top.length === 1 && again.top[0].score === 3000 && again2.top.length === 1 && again2.top[0].score === 3000);
    ck('S5 ...and never archive again (archive unchanged, no extra writes)', a2.meta.archivedAt === archivedAt && a2.players.length === players.length && storage.puts === puts, (storage.puts - puts) + ' writes');

    // Concurrent first requests on a fresh deploy (storage yields, so they would interleave without the lock).
    const slow = new SlowStorage(seedSeason0());
    const obj = new DO(new FakeState(slow));
    const rs = await Promise.all([1, 2, 3, 4].map(() => obj.fetch(new Request('https://do.internal/leaderboard'))));
    const ac = await archiveOf(slow);
    ck('S5 concurrent first requests: one archive, all scores in it, every board empty', rs.every((r) => r.status === 200) && ac.meta && ac.meta.scores === 16 && ac.players.length === 7 && Object.values(await slow.get('players')).every((r) => Object.keys(r.bests).length === 0));

    // A storage failure on the final write: nothing is lost, the next request finishes it.
    const fs1 = new FakeStorage(seedSeason0());
    fs1.failPut = (o) => 'players' in o;   // the write that clears the boards fails
    const Fv = mk(fs1);
    const r1 = await Fv.call('/api/leaderboard', null, {}, 'GET');
    const kept = await fs1.get('players');
    ck('S5 a failed reset keeps every Season 0 best (nothing half-done)', r1.status >= 500 && (await fs1.get('season')) === undefined && Object.values(kept).filter((r) => r.bests && Object.keys(r.bests).length).length === 6);
    fs1.failPut = null; Fv.env.restart();
    const r2 = await Fv.board(); const af = await archiveOf(fs1);
    ck('S5 ...and the next request completes it with the complete archive', r2.top.length === 0 && (await fs1.get('season')) === 1 && af.meta.scores === 16);

    // Large archive: chunked so no stored value is too big.
    try {
    const big = seedSeason0(1); const bp = big.get('players');
    for (let i = 0; i < 3000; i++) bp['big' + i] = { playerId: 'big' + i, name: 'SWIFT COMET ' + i, country: 'PH', updatedAt: 1, bests: { easy: { score: i + 1, level: 1, updatedAt: 2 }, medium: { score: i + 2, level: 1, updatedAt: 3 }, hard: { score: i + 3, level: 1, updatedAt: 4 } } };
    const bs = new FakeStorage(big); const B = mk(bs); await B.board();
    const ab = await archiveOf(bs);
    const sizes = []; for (let i = 0; i < ab.meta.chunks; i++) sizes.push(JSON.stringify(await bs.get('archive:season0:' + i)).length);
    ck('S2 a large archive is chunked: several values, each well under the 128 KiB limit, nothing lost', ab.meta.chunks > 1 && sizes.every((s) => s <= 64 * 1024) && ab.meta.scores === 9000 + 4 && ab.players.length === 3002, ab.meta.chunks + ' chunks, max ' + Math.max(...sizes));
    } catch (e) { ck('S2 a large archive is chunked: several values, each well under the 128 KiB limit, nothing lost', false, String(e).slice(0, 120)); }

    if (!quiet) console.log('== server: skins, purchases and restore codes survive ==');
    // A pilot who bought Solar Inferno (and has bests), a pilot who owns every skin,
    // and a buyer who never posted a score. Read back through the real public
    // routes the game uses, right after the reset and again after a DO restart.
    const ss = seedSeason0();
    ss.set('entitlements', { [P(4)]: ['solar'], [P(5)]: ['toxic', 'cosmic', 'solar'], [P(9)]: ['solar'] });
    ss.set('seenSessions', { cs_solar_1: 1, cs_all_1: 1 });
    const SS = mk(new FakeStorage(ss));
    const ent = async (id) => (await SS.call('/api/entitlements?playerId=' + encodeURIComponent(id), null, {}, 'GET')).data;
    const rc = async (id) => (await SS.call('/api/restore-check', { playerId: id })).data;
    const sb = await SS.board();
    const e4 = await ent(P(4)), e5 = await ent(P(5)), e9 = await ent(P(9));
    ck('S8 the reset ran (boards empty) before the skins are read', sb.top.length === 0 && (await SS.storage.get('season')) === 1);
    ck('S8 a pilot who owns Solar Inferno still owns it after the reset (/api/entitlements)', e4 && JSON.stringify(e4.skus) === '["solar"]', JSON.stringify(e4));
    ck('S8 a pilot who owns every skin keeps all three (/api/entitlements)', e5 && JSON.stringify(e5.skus) === '["toxic","cosmic","solar"]', JSON.stringify(e5));
    ck('S8 a buyer who never posted a score keeps Solar Inferno (/api/entitlements)', e9 && JSON.stringify(e9.skus) === '["solar"]', JSON.stringify(e9));
    const r4 = await rc(P(4)), r9 = await rc(P(9));
    ck('S8 the Solar Inferno pilot\'s restore code still works: found, same name and country, Solar Inferno, no old bests', r4 && r4.found === true && r4.name === 'PILOT4' && r4.country === 'BR' && JSON.stringify(r4.skus) === '["solar"]' && Object.keys(r4.bests || {}).length === 0 && /^[0-9A-Z]{7}$/.test(r4.tag || ''), JSON.stringify(r4));
    ck('S8 the buyer-only pilot\'s restore code still works and brings Solar Inferno', r9 && r9.found === true && JSON.stringify(r9.skus) === '["solar"]', JSON.stringify(r9));
    const post = await SS.submit(P(4), 2500, 'hard');
    ck('S8 the Solar Inferno pilot can post a Season 1 score with the same identity', post.status === 200 && post.data && post.data.tag === r4.tag, post.status + ' ' + JSON.stringify(post.data));
    SS.env.restart();
    const e4b = await ent(P(4)), r4b = await rc(P(4));
    ck('S8 after a restart Solar Inferno is still owned and restorable, with the Season 1 score', e4b && JSON.stringify(e4b.skus) === '["solar"]' && r4b && JSON.stringify(r4b.skus) === '["solar"]' && r4b.bests && r4b.bests.hard && r4b.bests.hard.score === 2500);
    ck('S8 purchase records (seen checkout sessions) untouched', JSON.stringify(await SS.storage.get('seenSessions')) === JSON.stringify({ cs_solar_1: 1, cs_all_1: 1 }));

    if (!quiet) console.log('== server: old pages refused ==');
    const O = mk(new FakeStorage(seedSeason0()));
    await O.board();
    const none = await O.submit(P(9), 2600, 'medium', {});
    const zero = await O.submit(P(9), 2600, 'medium', { season: 0 });
    const str = await O.submit(P(9), 2600, 'medium', { season: '1' });
    const b9 = await O.board();
    ck('S6 a score without season (an old page or queued upload) is refused with 409, and says why', none.status === 409 && none.data && none.data.staleSeason === true && /season/i.test(none.data.error || ''), none.status + ' ' + JSON.stringify(none.data));
    ck('S6 season 0 or a non-number is refused too; nothing reaches the boards', zero.status === 409 && str.status === 409 && b9.top.length === 0);
    const ok = await O.submit(P(9), 2600, 'medium', { season: 1 });
    ck('S6 a score with season 1 is accepted', ok.status === 200 && ok.data && ok.data.ok === true && (await O.board()).top.length === 1);
    const cheat = await O.submit(P(10), 45000, 'medium', { season: 1, level: 1 });
    ck('S6 the level rule still applies to Season 1 scores', cheat.status === 422, cheat.status);

    if (!quiet) console.log('== admin ==');
    const A = mk(new FakeStorage(seedSeason0()));
    await A.board();
    const noPw = await A.call('/api/admin/season-archive', {});
    const badPw = await A.call('/api/admin/season-archive', {}, { 'x-admin-token': 'nope' });
    ck('S7 the archive route needs the admin password', noPw.status === 401 && badPw.status === 401 && !JSON.stringify(noPw.data).includes('PILOT'), noPw.status + '/' + badPw.status);
    const ar = await A.call('/api/admin/season-archive', {}, H);
    const rows = (ar.data && ar.data.rows) || [];
    const sorted = rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score);
    ck('S7 it lists every archived score, highest first, with a count', ar.status === 200 && ar.data.count === 16 && rows.length === 16 && sorted && ar.data.players === 7, ar.status + ' ' + (ar.data && ar.data.count));
    const r0 = rows[0] || {};
    ck('S7 each row: difficulty, name, #tag, country, score, level, date', r0.difficulty === 'hard' && r0.name === 'PILOT5' && /^[0-9A-Z]{7,12}$/.test(r0.tag) && r0.country === 'KE' && r0.score === 15000 && r0.level === levelFor(15000, 'hard') && r0.updatedAt === 1700000000305, JSON.stringify(r0));
    ck('S7 never a playerId', !JSON.stringify(ar.data).includes(P(1)) && !JSON.stringify(ar.data).includes('legacy1') && rows.every((r) => !('playerId' in r)));
    const find = await A.call('/api/admin/find-player', { query: 'PILOT2' }, H);
    const pid2 = find.data.matches[0].pid;
    const del = await A.call('/api/admin/privacy-delete', { pid: pid2 }, H);
    const ar2 = await A.call('/api/admin/season-archive', {}, H);
    ck('S7 a privacy deletion also removes the pilot from the archive', del.status === 200 && ar2.data.count === 14 && ar2.data.players === 6 && !ar2.data.rows.some((r) => r.name === 'PILOT2'), ar2.data && ar2.data.count);

    const workerSrc = workerMod.__src || WORKER_SRC;
    ck('S7 the route is in the admin map, behind the admin password', /"\/api\/admin\/season-archive":\s*\(\)\s*=>\s*adminDO\(request, env, "\/admin-season-archive"/.test(workerSrc));
  } catch (e) { ck('server section ran', false, String(e.stack || e).slice(0, 400)); }
  finally { Date.now = realNow; console.error = realErr; }

  try {
    const sec = adminHtml.slice(adminHtml.indexOf('SEASON 0 SCORES'), adminHtml.indexOf('<details id="guide"'));
    const js = scriptsOf(adminHtml).join('\n');
    const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'), adminHtml.indexOf('<details id="advanced">'));
    ck('S7 admin.html has a read-only SEASON 0 SCORES (archived) section using the admin API', /<h2>SEASON 0 SCORES \(ARCHIVED\)<\/h2>/.test(adminHtml) && /id="s0Load"/.test(sec) && /await call\('season-archive'\)/.test(js) && /\$\('s0Load'\)\.onclick = guard\(loadSeason0\)/.test(js)
      && !/DELETE|REMOVE|RESTORE/.test(sec));
    // The rendering, with a real row set: count line + one table row per score, text only.
    const { store } = makeStore({});
    const g = boot(scriptsOf(adminHtml), { origin: ORIGIN, path: '/admin.html', store });
    ck('S7 the admin section writes text only (no innerHTML)', !/innerHTML/.test(js.slice(js.indexOf('season 0 archive'), js.indexOf('function guard('))) && g.errors.length === 0, g.errors.join(';'));
    ck('S7 the GUIDE explains the Season 1 reset and the archive', /<h3>Season 1 reset<\/h3>/.test(guide) && /SEASON 0 SCORES \(ARCHIVED\)/.test(guide) && /once/.test(guide) && /read-only/.test(guide));
  } catch (e) { ck('admin page section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= client ================= */
  const GAME = scriptsOf(gameHtml);
  const bootGame = (init, fetchImpl) => {
    const { store, mem } = typeof init.getItem === 'function' ? init : makeStore(init);
    const calls = [];
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, fetchImpl: (u, o = {}) => { calls.push({ u: String(u), body: o.body ? JSON.parse(o.body) : null });
      if (fetchImpl) return fetchImpl(u, o);
      return String(u).includes('submit-score') ? Promise.resolve(new Response(JSON.stringify({ ok: true, public: true, rank: 1 }), { status: 200 })) : Promise.reject(new TypeError('offline')); } });
    const run = (c) => vm.runInContext(c, g.ctx);
    const toast = () => { const t = g.els.fluxNameToast; return t ? String(t.textContent || '') : ''; };
    return { g, mem, store, calls, run, toast };
  };
  const drain = async () => { for (let i = 0; i < 6; i++) await tick(); };
  try {
    if (!quiet) console.log('== client: the phone matches the server ==');
    const oldQ = [{ id: 'p:medium:9000:5', playerId: 'player-7', name: 'TITAN', score: 9000, level: 5, difficulty: 'medium', at: 1, attempts: 2 }];
    const keep = { fluxPlayerId: 'player-7', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxPublicTag: 'K7Q2MX8', fluxSkin: 'cosmic',
      fluxBackground: 'solar', fluxEntitlementsV1: JSON.stringify({ v: 1, source: 'server', playerId: 'player-7', skus: ['cosmic'], verifiedAt: 1 }), fluxOwned_cosmic: '1',
      fluxDifficulty: 'easy', fluxRunsPlayed: '12', fluxWelcomeDone: '1', fluxColorHintSeen: '1', fluxNameClaimOffered: '1', fluxLite: '1', fluxAutoName: '1', fluxStatsSrc: 'tiktok' };
    const bests = { fluxBest_easy: '4000', fluxBestLevel_easy: '5', fluxBestRun_easy: JSON.stringify({ score: 4000, level: 5, difficulty: 'easy', playerId: 'player-7', at: 1 }),
      fluxBest_medium: '9000', fluxBestLevel_medium: '5', fluxBestRun_medium: JSON.stringify({ score: 9000, level: 5, difficulty: 'medium', playerId: 'player-7', at: 1 }),
      fluxBest_hard: '12000', fluxBestLevel_hard: '4', fluxBestRun_hard: JSON.stringify({ score: 12000, level: 4, difficulty: 'hard', playerId: 'player-7', at: 1 }) };
    const b = bootGame({ ...keep, ...bests, fluxPendingSubmits: JSON.stringify(oldQ) });
    await drain();
    const left = Object.keys(bests).filter((k) => k in b.mem);
    ck('C1 the saved easy/medium/hard bests are cleared (best-run record + both legacy keys)', left.length === 0, left.join(','));
    ck('C1 the menu / share-card best reads 0 on every difficulty', b.run('best') === 0 && b.run("(function(){ const was=difficulty; const out=['easy','medium','hard'].map(function(d){ difficulty=d; return bestRun().score; }); difficulty=was; return out.join(','); })()") === '0,0,0');
    const changed = Object.keys(keep).filter((k) => b.mem[k] !== keep[k]);
    ck('C1 everything else is kept: pilot, name, country, tag, skins, purchases, settings, first-run flags', changed.length === 0, changed.join(','));
    ck('C1 the season marker is set', b.mem.fluxSeason === '1');
    ck('C2 a queued upload from before Season 1 is dropped, never sent', JSON.parse(b.mem.fluxPendingSubmits || '[]').length === 0 && !b.calls.some((c) => c.u.includes('submit-score')), b.calls.map((c) => c.u).join(','));

    // Second launch: a Season 1 best is kept (the clear happens once).
    b.mem.fluxBest_easy = '600'; b.mem.fluxBestRun_easy = JSON.stringify({ score: 600, level: 1, difficulty: 'easy', playerId: 'player-7', at: 2 });
    const b2 = bootGame({ getItem: b.store.getItem, store: b.store, mem: b.mem });
    await drain();
    ck('C1 only once: a Season 1 best survives the next launch', b2.mem.fluxBest_easy === '600' && JSON.parse(b2.mem.fluxBestRun_easy).score === 600 && b2.run('best') === 600, b2.mem.fluxBest_easy);

    if (!quiet) console.log('== client: uploads say their season ==');
    b2.run("difficulty='easy'; recordBestRun(900, 2);"); await b2.run('submitScore()'); await drain();
    const sent = b2.calls.filter((c) => c.u.includes('submit-score')).map((c) => c.body);
    ck('C2 every upload carries season: 1', sent.length === 1 && sent[0].season === 1 && sent[0].score === 900, JSON.stringify(sent));
    // An old tab (same storage) queues a score without a season after the new page loaded: the new page never sends it.
    const b3 = bootGame({ ...keep, fluxSeason: '1', fluxPendingSubmits: JSON.stringify(oldQ) });
    await b3.run('flushSubmitQueue()'); await drain();
    ck('C2 a pre-season item queued later by an old tab is dropped, not uploaded', JSON.parse(b3.mem.fluxPendingSubmits || '[]').length === 0 && !b3.calls.some((c) => c.u.includes('submit-score')));
    // The server refuses (409 from a newer season): dropped quietly -- no error record, no retry.
    const b4 = bootGame({ ...keep, fluxSeason: '1' }, (u) => String(u).includes('submit-score') ? Promise.resolve(new Response(JSON.stringify({ error: 'A new season has started.', staleSeason: true }), { status: 409 })) : Promise.resolve(new Response('{"skus":[]}', { status: 200 })));
    const timers = []; b4.g.win.setTimeout = (fn, ms) => { timers.push(ms); return timers.length; };
    b4.run("difficulty='medium'; recordBestRun(2600, 2);"); await b4.run('submitScore()'); await b4.run('flushSubmitQueue()'); await drain();
    const posts = b4.calls.filter((c) => c.u.includes('submit-score')).length;
    ck('C2 a 409 refusal drops the item quietly: no error record, no retry loop', posts === 1 && JSON.parse(b4.mem.fluxPendingSubmits || '[]').length === 0 && !('fluxLastSubmitError' in b4.mem) && timers.filter((ms) => ms >= 5000).length === 0, posts + ' posts, ' + (b4.mem.fluxLastSubmitError || 'no error'));

    if (!quiet) console.log('== client: the Season 1 message ==');
    ck('C3 a returning player sees the message once, exactly as written', b.toast() === MSG, b.toast());
    ck('C3 it can be closed with a tap, and does not come back', typeof (b.g.els.fluxNameToast || {}).onclick === 'function' && (b.g.els.fluxNameToast.onclick(), !('fluxSeasonNotice' in b.mem)) && bootGame({ getItem: b.store.getItem, store: b.store, mem: b.mem }).toast() !== MSG);
    const fresh = bootGame({});
    ck('C3 a brand-new player (never played, no best) does not see it', fresh.toast() !== MSG && !('fluxSeasonNotice' in fresh.mem) && fresh.mem.fluxSeason === '1', fresh.toast());
    const playedNoBest = bootGame({ fluxPlayerId: 'p-2', fluxCallsign: 'NOVA', fluxProfileComplete: '1', fluxRunsPlayed: '3' });
    ck('C3 a player who had played before (even without a best) sees it', playedNoBest.toast() === MSG);
    const newWithMarker = bootGame({ ...keep, fluxSeason: '1' });
    ck('C3 a device already on Season 1 does not see it', newWithMarker.toast() !== MSG);
    // Both one-time notices due: the name notice first, then the season message.
    const both = bootGame({ ...bests, fluxRunsPlayed: '2', fluxCallsign: 'JOHN SMITH', fluxProfileComplete: '1', fluxPlayerId: 'p-3' });
    const first = both.toast(); if (both.g.els.fluxNameToast && both.g.els.fluxNameToast.onclick) both.g.els.fluxNameToast.onclick();
    ck('C3 with the name notice also due, the season message follows it', /name rules/.test(first) && both.toast() === MSG, first.slice(0, 30) + ' -> ' + both.toast());
    // Never during a run: starting a run closes it.
    const r = bootGame({ ...bests, fluxRunsPlayed: '2', fluxPlayerId: 'p-4', fluxCallsign: 'VEGA', fluxProfileComplete: '1' });
    let hidden = false; const t = r.g.els.fluxNameToast; const onc = t && t.onclick;
    if (t) t.onclick = function () { hidden = true; return onc.apply(this, arguments); };
    try { r.g.els.startBtn.onclick(); } catch (e) {}
    ck('C3 starting a run closes the message (it never covers play)', hidden && !('fluxSeasonNotice' in r.mem));
    // The phone of a pilot who bought Solar Inferno and is wearing it.
    const solarKeep = { fluxPlayerId: 'player-8', fluxCallsign: 'BLAZE', fluxCountry: 'US', fluxProfileComplete: '1', fluxSkin: 'solar',
      fluxEntitlementsV1: JSON.stringify({ v: 1, source: 'server', playerId: 'player-8', skus: ['solar'], verifiedAt: 1 }), fluxOwned_solar: '1', fluxRunsPlayed: '5' };
    const sp = bootGame({ ...solarKeep, fluxBest_hard: '15000', fluxBestLevel_hard: '5' });
    await drain();
    const lost = Object.keys(solarKeep).filter((k) => sp.mem[k] !== solarKeep[k]);
    ck('C4 a Solar Inferno owner\'s phone keeps the skin, its purchase record and the pilot (restore code) after the season clear', lost.length === 0 && !('fluxBest_hard' in sp.mem) && sp.mem.fluxSeason === '1', lost.join(','));
    const src = GAME.join('\n');
    ck('C3 the message uses the existing notice toast, auto-hides, and adds no listener', /fluxNameToast\(FLUX_SEASON_MSG, \d{4,5},/.test(src) && (gameHtml.match(/addEventListener\(/g) || []).length === 17);
  } catch (e) { ck('client section ran', false, String(e.stack || e).slice(0, 400)); }
  return { F, failed };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ gameHtml: GAME_HTML, workerMod: realMod, adminHtml: ADMIN_HTML });

console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { game = (s) => s, worker = (s) => s, admin = (s) => s }) {
  const g2 = game(GAME_HTML), w2 = worker(WORKER_SRC), a2 = admin(ADMIN_HTML);
  if (g2 === GAME_HTML && w2 === WORKER_SRC && a2 === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-season-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ gameHtml: g2, workerMod: Object.assign({ __src: w2 }, mod), adminHtml: a2, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('reset runs on every load (no season marker check)', 'S5 a second load', { worker: rep('if (!((await this.state.storage.get("season")) >= SEASON)) await this.startSeason();', 'await this.startSeason();') });
await control('reset never runs', 'S1 after the first request', { worker: rep('if (!((await this.state.storage.get("season")) >= SEASON)) await this.startSeason();', '') });
await control('archive not written', 'S2 the archive holds', { worker: rep('await this.state.storage.put(puts);\n    }\n    const scores', '}\n    const scores') });
await control('archive drops the date', 'S2 the archive holds', { worker: rep('bests[d] = { score: b.score, level: b.level, updatedAt: b.updatedAt || 0 };', 'bests[d] = { score: b.score, level: b.level };') });
await control('archive in one huge value', 'S2 a large archive', { worker: rep('const SEASON_ARCHIVE_CHUNK_BYTES = 64 * 1024;', 'const SEASON_ARCHIVE_CHUNK_BYTES = 64 * 1024 * 1024;') });
await control('reset rebuilds records and loses names', 'S3 every pilot kept', { worker: rep('cleared[id] = Object.assign(Object.create(null), this.players[id], { bests: Object.create(null) });', 'cleared[id] = { playerId: id, bests: Object.create(null) };') });
await control('reset also clears purchases', 'S3 skins', { worker: rep('await this.state.storage.put({ players: cleared, countries: {}, [SEASON_ARCHIVE_KEY]: meta, season: SEASON });', 'await this.state.storage.put({ players: cleared, countries: {}, entitlements: {}, [SEASON_ARCHIVE_KEY]: meta, season: SEASON });') });
await control('reset wipes the stored purchases table', 'S8 after a restart Solar Inferno', { worker: rep('await this.state.storage.put({ players: cleared, countries: {}, [SEASON_ARCHIVE_KEY]: meta, season: SEASON });', 'await this.state.storage.put({ players: cleared, countries: {}, entitlements: {}, [SEASON_ARCHIVE_KEY]: meta, season: SEASON });') });
await control('reset drops skins in memory only', 'S8 a pilot who owns Solar Inferno', { worker: rep('    this.players = cleared;\n    this.invalidateTags();', '    this.players = cleared;\n    this.entitlements = Object.create(null);\n    this.invalidateTags();') });
await control('reset removes only Solar Inferno', 'S8 a pilot who owns Solar Inferno', { worker: rep('    this.players = cleared;\n    this.invalidateTags();', '    this.players = cleared;\n    for (const k of Object.keys(this.entitlements)) this.entitlements[k] = this.entitlements[k].filter((x) => x !== "solar");\n    this.invalidateTags();') });
await control('reset deletes pilots who have a best (restore code dead)', 'S8 the Solar Inferno pilot\'s restore code', { worker: rep('for (const id of Object.keys(this.players)) cleared[id] = Object.assign(Object.create(null), this.players[id], { bests: Object.create(null) });', 'for (const id of Object.keys(this.players)) if (!Object.keys(this.players[id].bests || {}).length) cleared[id] = Object.assign(Object.create(null), this.players[id], { bests: Object.create(null) });') });
await control('page clears the Solar Inferno purchase', 'C4 a Solar Inferno owner', { game: rep("if(had) localStorage.setItem('fluxSeasonNotice','1');", "if(had) localStorage.setItem('fluxSeasonNotice','1'); localStorage.removeItem('fluxOwned_solar');") });
await control('country figures not recomputed', 'S4 country figures', { worker: (s) => rep('await this.state.storage.put({ players: cleared, countries: {}, [SEASON_ARCHIVE_KEY]: meta, season: SEASON });\n    this.players = cleared;\n    this.invalidateTags();\n    await this.recomputeCountries();', 'await this.state.storage.put({ players: cleared, [SEASON_ARCHIVE_KEY]: meta, season: SEASON });\n    this.players = cleared;\n    this.invalidateTags();')(s) });
await control('marker written before the archive (a failure loses scores)', 'S5 a failed reset', { worker: rep('  async startSeason() {\n', '  async startSeason() {\n    await this.state.storage.put({ season: SEASON });\n') });
await control('old pages not refused', 'S6 a score without season', { worker: rep('if (!(Number.isFinite(body.season) && body.season >= SEASON)) {', 'if (false) {') });
await control('archive route without the password', 'S7 the archive route needs', { worker: rep('() => adminDO(request, env, "/admin-season-archive", {}),', '() => forwardToDO(request, env, "/admin-season-archive", { method: "POST" }),') });
await control('archive rows unsorted', 'S7 it lists every', { worker: rep('rows.sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);\n    return json({ ok: true, season: 0', 'return json({ ok: true, season: 0') });
await control('archive leaks the playerId', 'S7 never a playerId', { worker: rep('rows.push({ difficulty: d, pid, tag,', 'rows.push({ playerId: p.playerId, difficulty: d, pid, tag,') });
await control('privacy delete leaves the archive', 'S7 a privacy deletion', { worker: rep('    await this.eraseFromSeasonArchive(id);', '') });
await control('admin page loses the section', 'S7 admin.html', { admin: rep('<h2>SEASON 0 SCORES (ARCHIVED)</h2>', '<h2>OLD SCORES</h2>') });
await control('guide loses the season note', 'S7 the GUIDE', { admin: rep('<h3>Season 1 reset</h3>', '<h3>Reset</h3>') });
await control('page keeps the old bests', 'C1 the saved', { game: rep("if(v!==null){ if(k.indexOf('fluxBestLevel_')!==0 && v!=='0') had=true; localStorage.removeItem(k); }", "if(v!==null){ if(k.indexOf('fluxBestLevel_')!==0 && v!=='0') had=true; }") });
await control('page clears the skin too', 'C1 everything else', { game: rep("if(had) localStorage.setItem('fluxSeasonNotice','1');", "if(had) localStorage.setItem('fluxSeasonNotice','1'); localStorage.removeItem('fluxSkin');") });
await control('page clears on every launch', 'C1 only once', { game: rep("localStorage.setItem('fluxSeason',String(FLUX_SEASON));", '') });
await control('uploads without season', 'C2 every upload', { game: rep('        season:item.season\n', '') });
await control('old queued item sent', 'C2 a pre-season item', { game: rep("if(!(item && item.season>=FLUX_SEASON)){ saveQueue(loadQueue().filter(function(x){ return x && x.season>=FLUX_SEASON; })); continue; }", '') });
await control('old queue kept at the season start', 'C2 a queued upload', { game: (s) => rep("if(!(item && item.season>=FLUX_SEASON)){ saveQueue(loadQueue().filter(function(x){ return x && x.season>=FLUX_SEASON; })); continue; }", '')(rep('if(keep.length!==q.length) localStorage.setItem', 'if(false) localStorage.setItem')(s)) });
await control('409 treated as an error', 'C2 a 409', { game: rep("if(res.status===409) return { kind:'stale' };", '') });
await control('message for everyone, even brand-new players', 'C3 a brand-new player', { game: rep("if(had) localStorage.setItem('fluxSeasonNotice','1');", "localStorage.setItem('fluxSeasonNotice','1');") });
await control('message never cleared', 'C3 it can be closed', { game: rep("fluxSeasonToast.on=false; try{ localStorage.removeItem('fluxSeasonNotice'); }catch(e){}", 'fluxSeasonToast.on=false;') });
await control('message stays over a run', 'C3 starting a run', { game: rep("if(fluxSeasonToast.on){ try{ const t=document.getElementById('fluxNameToast'); if(t && t.onclick) t.onclick(); }catch(x){} }", '') });
await control('message text changed', 'C3 a returning player', { game: rep("const FLUX_SEASON_MSG='Season 1: new point rates on Easy and Medium.';", "const FLUX_SEASON_MSG='Season 1!';") });
const total = main.F + NC;
console.log('\n' + (total ? 'SEASON RESET FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'SEASON RESET PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
