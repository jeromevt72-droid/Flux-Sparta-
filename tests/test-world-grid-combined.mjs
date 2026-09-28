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
//   W8 APPLY takes a verified safety backup, switches the World Grid (ALL board + countries) to the
//      consolidated data, runs the checks against the live routes, shows in the owner summary;
//   W9 APPLY and REVERT are reversible: the bests and the archive are never rewritten; after REVERT every
//      public route answers exactly as before APPLY; the switch survives a restart;
//   W10 after APPLY new runs still count: a run above the Season 0 best raises the grid, one below does not;
//   W11 if the check after the switch fails, the switch is turned back off by itself;
//   W12 the game's leaderboard shows ONE combined grid (no tabs) once applied, and is unchanged before;
//   W13 the gateway World Grid shows ONE combined grid (no tabs) once applied, and is unchanged before;
//   W14 the Season 1 message no longer says "Fresh boards for everyone" (true before and after APPLY);
//   W15 admin page: WORLD GRID section (dry run, typed APPLY, REVERT, report in plain words, BACK UP NOW
//      when the backup is missing), guide note, owner summary; property handlers only;
//   W16 deploy: wrangler.jsonc as on main, no new export/class/migration; one storage accessor for pilots;
//   W17 a realistic dataset (Season 0 archive + Season 1, 10 countries): every check PASS.
// Ends with negative controls: each defect re-inserted into the sources MUST be caught.
// WG_REPORT=<file> also writes the realistic dry-run report to that file.
import fs from 'fs'; import path from 'path'; import util from 'util'; import vm from 'vm'; import { spawnSync } from 'child_process';
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

/* ---------------- fake Durable Object runtime (as test-backup-restore.mjs) ---------------- */
class FakeStorage {
  constructor(map) { this.map = map || new Map(); this.writes = 0; this.failPut = null; }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v };
    if (Object.keys(obj).length > 128) throw new Error('put: more than 128 keys');
    if (this.failPut && this.failPut(obj)) throw new Error('storage failure');
    this.writes++;
    for (const kk of Object.keys(obj)) this.map.set(kk, structuredClone(obj[kk]));
  }
  async delete(k) { this.writes++; for (const x of [].concat(k)) this.map.delete(x); }
  async list(o = {}) {
    let keys = [...this.map.keys()].sort();
    if (o.prefix) keys = keys.filter((k) => k.startsWith(o.prefix));
    if (o.startAfter !== undefined) keys = keys.filter((k) => k > o.startAfter);
    if (o.limit) keys = keys.slice(0, o.limit);
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async transaction(fn) { const before = new Map(this.map); try { return await fn(this); } catch (e) { this.map = before; throw e; } }
}
class FakeState {
  constructor(storage) { this.storage = storage; this.lock = Promise.resolve(); }
  blockConcurrencyWhile(fn) { const r = this.lock.then(fn); this.lock = r.then(() => {}, () => {}); return r; }
}
function makeEnv(mod, g, b) {
  const inst = new Map(), env = { ADMIN_TOKEN: 'pw', _g: g, _b: b };
  env.LEADERBOARD_DO = { idFromName: (n) => n, get(id) {
    if (!inst.has(id)) inst.set(id, new mod.LeaderboardDO(new FakeState(id === 'global' ? env._g : id === 'backups' ? env._b : new FakeStorage()), env));
    const o = inst.get(id); return { fetch: (url, init) => o.fetch(new Request(url, init)) }; } };
  env._inst = inst;
  env.restart = () => inst.clear();
  return env;
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
async function realisticSeed(seed = 20260928) {
  const rnd = mulberry32(seed), m = new Map(), players = {}, arch = [];
  const CC = [['US', 120], ['BR', 80], ['PH', 60], ['IN', 50], ['DE', 35], ['JP', 30], ['KR', 20], ['NZ', 10], ['IS', 6], ['LU', 4]];
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
      arch.push({ playerId: id, name, country: moved ? 'CA' : cc, bests: bestsFrom(S0) });
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
  const mk = (g, b = new FakeStorage(), mod = workerMod) => {
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
    return { env, req, admin, board, publicView, direct };
  };
  const gridOf = (lb) => ({ countries: Object.fromEntries((lb.countries || []).map((c) => [c.country, { t: c.totalScore, n: c.playerCount }])) });
  const sameCountries = (lb, exp) => util.isDeepStrictEqual(gridOf(lb).countries, exp.countries);

  try {
    /* ================= W1-W5 the consolidation (pure) ================= */
    if (!quiet) console.log('== W1-W5 consolidation ==');
    const sm = await smallSeed();
    const S = mk(new FakeStorage(cloneMap(sm)));
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
      const A = mk(new FakeStorage(cloneMap(RS.m)), new FakeStorage(), mainMod), B = mk(new FakeStorage(cloneMap(RS.m)));
      const va = await A.publicView(), vb = await B.publicView(true);
      now += 1000;
      const sub = { playerId: P(1), name: 'ACE1', score: 47000, level: levelFor(47000, 'hard'), difficulty: 'hard', country: 'US', season: 1 };
      const sa = await A.req('/api/submit-score', sub), sb = await B.req('/api/submit-score', sub);
      ck('W2 before APPLY every public route answers exactly as the code on main (all/easy/medium/hard boards, restore-check, an upload)',
        util.isDeepStrictEqual(va, vb) && sa.text === sb.text && util.isDeepStrictEqual(await A.publicView(), await B.publicView(true)), sa.text.slice(0, 80) + ' | ' + sb.text.slice(0, 80));
      ck('W2 ...and says so: combined false', (await B.board()).combined === false && (await B.board()).gridCombined === false);
    } else ck('W2 before APPLY (main not available: fixed checks only)', (await mk(new FakeStorage(cloneMap(RS.m))).board()).combined === false);

    /* ================= W17 realistic dataset: dry run ================= */
    if (!quiet) console.log('== W17 realistic dataset ==');
    const g = new FakeStorage(cloneMap(RS.m)), b = new FakeStorage();
    const R = mk(g, b);
    const before = await R.publicView();
    const beforeBoard = await R.board('', 100);
    const d1 = await R.admin('world-grid-dry-run');
    const rr = d1.data || {};
    ck('W17 realistic dataset: every check PASS, "no current score lost: PASS"', rr.allPass === true && /no current score lost: PASS/.test(rr.text || '') && (rr.checks || []).length === 6, (rr.checks || []).filter((k) => !k.ok).map((k) => k.label + ': ' + k.detail).join(' | '));
    const c = rr.counts || {};
    ck('W17 the counts add up: archive bests = merged + flagged; pilots after = before + back from Season 0',
      c.archiveScores === c.mergedScores + c.flaggedScores && c.pilotsAfter === c.pilotsBefore + c.onlyArchive && c.onlyArchive === RS.meta.archiveOnly && c.restrictedExcluded === 2, JSON.stringify(c));
    ck('W17 flagged: 8 pilots gone, 3 privacy-deleted, 1 conflicting identity (2 entries), 1 invalid score, 2 restricted',
      ['pilot-gone', 'privacy-deleted', 'conflicting-identity', 'invalid-score', 'restricted'].map((k) => (rr.flagged || []).filter((f) => f.code === k).length).join() === '8,3,2,1,2', (rr.flagged || []).map((f) => f.code).join(','));
    ck('W17 the report has per-country before/after totals and ranks, top pilots before and after, in plain words',
      (rr.countries || []).length >= 10 && rr.countries.every((x) => x.after && x.after.rank && 'totalScore' in x.after) && rr.topBefore.length === 10 && rr.topAfter.length === 10 && /COUNTRIES \(before -> after\)/.test(rr.text) && /TOP PILOTS AFTER/.test(rr.text) && /FLAGGED \(\d+\)/.test(rr.text));
    if (process.env.WG_REPORT && !quiet) { fs.mkdirSync(path.dirname(process.env.WG_REPORT), { recursive: true }); fs.writeFileSync(process.env.WG_REPORT, rr.text + '\n'); console.log('  (report written to ' + process.env.WG_REPORT + ')'); }

    /* ================= W6 the dry run writes nothing ================= */
    const gSnap = cloneMap(g.map), bSnap = cloneMap(b.map), gw = g.writes, bw = b.writes;
    const d2 = await R.admin('world-grid-dry-run');
    ck('W6 the dry run writes nothing: leaderboard and backup storage deep-equal, no write at all', d2.status === 200 && sameMap(g.map, gSnap) && sameMap(b.map, bSnap) && g.writes === gw && b.writes === bw, diffKeys(g.map, gSnap).join(',') + ' writes ' + (g.writes - gw));
    ck('W6 ...and the public routes did not change', util.isDeepStrictEqual(await R.publicView(), before));

    /* ================= W7 APPLY refusals ================= */
    if (!quiet) console.log('== W7 APPLY refusals ==');
    const id1 = rr.id, st = [];
    for (const t of [{}, { id: id1 }, { id: id1, confirm: 'APPLY' }, { id: id1, confirm: 'apply ' + id1 }, { id: id1, confirm: id1 }, { id: id1, confirm: 'APPLY ' + id1 + ' ' }, { id: 'WG-x', confirm: 'APPLY WG-x' }]) st.push((await R.admin('world-grid-apply', t)).status);
    ck('W7 APPLY is refused without exactly "APPLY <dry-run id>" (nothing written, no backup made)', st.every((x) => x === 400) && sameMap(g.map, gSnap) && sameMap(b.map, bSnap), st.join(','));
    const nb = await R.admin('world-grid-apply', { id: id1, confirm: 'APPLY ' + id1 });
    ck('W7 APPLY is refused without a checked backup from the last 60 minutes, and offers BACK UP NOW (needBackup)', nb.status === 409 && nb.data.needBackup === true && /BACK UP NOW/.test(nb.data.error) && sameMap(g.map, gSnap), nb.status + ' ' + nb.text.slice(0, 160));
    await R.admin('backup-now');
    const bkSnap = cloneMap(b.map);
    now += 61 * 60000;
    const old = await R.admin('world-grid-apply', { id: id1, confirm: 'APPLY ' + id1 });
    ck('W7 a backup older than 60 minutes does not count', old.status === 409 && old.data.needBackup === true && sameMap(g.map, gSnap), old.status);
    await R.admin('backup-now');
    const stale = await R.admin('world-grid-apply', { id: id1, confirm: 'APPLY ' + id1 });
    ck('W7 a dry run older than 60 minutes is refused (run a new one)', stale.status === 409 && stale.data.stale === true && sameMap(g.map, gSnap), stale.status + ' ' + stale.text.slice(0, 120));
    void bkSnap;
    // The archive changes after the dry run (a privacy deletion): refused.
    { const X = mk(new FakeStorage(cloneMap(sm)), new FakeStorage()); const dx = await X.admin('world-grid-dry-run'); await X.admin('backup-now');
      const f = await X.admin('find-player', { query: 'BRAVO' }); await X.admin('privacy-delete', { pid: f.data.matches[0].pid });
      const ax = await X.admin('world-grid-apply', { id: dx.data.id, confirm: 'APPLY ' + dx.data.id });
      ck('W7 if the archive changed since the dry run (privacy deletion), APPLY is refused', ax.status === 409 && ax.data.stale === true && !X.env._g.map.has('worldGrid'), ax.status + ' ' + ax.text.slice(0, 120)); }
    // Password / session / CSRF.
    const noPw = []; for (const r of ['world-grid-dry-run', 'world-grid-apply', 'world-grid-revert']) noPw.push((await R.req('/api/admin/' + r, { id: id1, confirm: 'APPLY ' + id1 })).status, (await R.req('/api/admin/' + r, {}, { 'x-admin-token': 'nope' })).status);
    ck('W7 every WORLD GRID route needs the admin password (401), and nothing changed', noPw.every((x) => x === 401) && sameMap(g.map, gSnap), noPw.join(','));
    { const L = mk(new FakeStorage(cloneMap(sm)));
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
    const d3 = (await R.admin('world-grid-dry-run')).data;
    const safetyBefore = [...b.map.values()].filter((m) => m && m.kind === 'safety').length;
    const bestsBefore = structuredClone(g.map.get('players')), archBefore = [...g.map.keys()].filter((k) => k.startsWith('archive:')).map((k) => [k, structuredClone(g.map.get(k))]);
    const preApply = cloneMap(g.map);
    const ap = await R.admin('world-grid-apply', { id: d3.id, confirm: 'APPLY ' + d3.id });
    ck('W8 APPLY with a recent checked backup and the typed phrase succeeds', ap.status === 200 && ap.data.ok === true && ap.data.applied === d3.id, ap.status + ' ' + ap.text.slice(0, 200));
    const safeties = [...b.map.values()].filter((m) => m && m.kind === 'safety');
    const saf = safeties.find((m) => m.id === ap.data.safetyId);
    ck('W8 a verified safety backup of the leaderboard just before the switch was taken', safeties.length === safetyBefore + 1 && saf && saf.verified === true && saf.keyCount === preApply.size, saf && saf.id);
    ck('W8 the post-apply checks ran against the live routes, all PASS', (ap.data.checks || []).length === 8 && ap.data.checks.every((k) => k.ok) && ap.data.checks.some((k) => k.id === 'live-grid') && ap.data.checks.some((k) => k.id === 'live-no-current-score-lost'), JSON.stringify(ap.data.checks || []).slice(0, 300));
    const after = await R.board('', 100);
    const E = expectGrid(RS.m, { restrictedIds: RS.restrictedIds, conflicted: [P(7)], invalid: [] });
    ck('W8 the live World Grid is combined: combined true, country totals = sum of consolidated weighted bests (computed here)', after.combined === true && sameCountries(after, E), JSON.stringify(gridOf(after).countries).slice(0, 200));
    const expTop = E.pilots.map((p) => p.w).sort((x, y) => y - x).slice(0, 100);
    ck('W8 the ALL board is the consolidated grid: the top 100 scores match, each pilot once', util.isDeepStrictEqual(after.top.map((t) => t.score), expTop) && new Set(after.top.map((t) => t.pid)).size === after.top.length);
    ck('W8 the leaderboard response keeps its shape (top, countries, leadingCountry, difficulty, weighted, weights) + combined', ['top', 'countries', 'leadingCountry', 'difficulty', 'weighted', 'weights', 'combined', 'gridCombined'].every((k) => k in after) && after.top.every((t) => ['pid', 'tag', 'name', 'country', 'score', 'points', 'level', 'difficulty'].every((k) => k in t)) && !JSON.stringify(after).includes('aaaaaaaa-bbbb'));
    const easyAfter = await R.board('easy', 100);
    const hardAfter = await R.board('hard', 100);
    ck('W8 the Easy, Medium and Hard boards stay Season 1 only (their pilot lists; the countries are the World Grid)', util.isDeepStrictEqual(easyAfter.top, before['lb:easy'].top) && util.isDeepStrictEqual(hardAfter.top, before['lb:hard'].top) && easyAfter.combined === false && easyAfter.gridCombined === true && sameCountries(easyAfter, E));
    const sum = await R.admin('summary');
    ck('W8 the FLUX COMMAND owner summary says the combined grid is live', sum.status === 200 && sum.data.worldGrid && sum.data.worldGrid.combined === true && sum.data.worldGrid.appliedAt === now);
    const banned = after.top.find((t) => t.name === 'PILOT');
    ck('W4 a name-banned pilot is still counted and shown as PILOT (as today)', !!banned || after.top.every((t) => t.name !== 'ACE12'));
    const chkLive = await R.direct('/world-grid-check');
    ck('W8 the live check passes after APPLY', chkLive.data.ok === true && chkLive.data.combined === true);

    /* ================= W9 reversible ================= */
    if (!quiet) console.log('== W9 reversible ==');
    const changed = diffKeys(g.map, preApply).sort();
    ck('W9 APPLY rewrote no best and no archive entry: only the switch and the derived country figures changed', util.isDeepStrictEqual(g.map.get('players'), bestsBefore) && archBefore.every(([k, v]) => util.isDeepStrictEqual(g.map.get(k), v)) && changed.join() === 'countries,worldGrid', changed.join());
    R.env.restart();
    ck('W9 the switch survives a restart', (await R.board()).combined === true && sameCountries(await R.board('', 100), E));
    const rv = await R.admin('world-grid-revert');
    ck('W9 REVERT switches back', rv.status === 200 && rv.data.ok && rv.data.wasCombined === true && rv.data.worldGrid.combined === false);
    const reverted = await R.publicView();
    ck('W9 after REVERT every public route answers exactly as before APPLY', util.isDeepStrictEqual(reverted, before) && util.isDeepStrictEqual(await R.board('', 100), beforeBoard));
    ck('W9 after APPLY + REVERT the bests and the archive are unchanged, and the country figures are as before', util.isDeepStrictEqual(g.map.get('players'), bestsBefore) && archBefore.every(([k, v]) => util.isDeepStrictEqual(g.map.get(k), v)) && util.isDeepStrictEqual(g.map.get('countries'), preApply.get('countries')), diffKeys(g.map, preApply).join(','));
    ck('W9 the owner summary says Season 1 only again', (await R.admin('summary')).data.worldGrid.combined === false);
    const d4 = (await R.admin('world-grid-dry-run')).data;
    const ap2 = await R.admin('world-grid-apply', { id: d4.id, confirm: 'APPLY ' + d4.id });
    ck('W9 APPLY works again after REVERT (same grid)', ap2.status === 200 && sameCountries(await R.board('', 100), E));

    /* ================= W10 new runs after APPLY ================= */
    if (!quiet) console.log('== W10 new runs ==');
    const players = g.map.get('players'), meta0 = g.map.get('archive:season0'), arch0 = [];
    for (let i = 0; i < meta0.chunks; i++) arch0.push(...g.map.get('archive:season0:' + i));
    const s0only = arch0.find((a) => players[a.playerId] && !Object.keys(players[a.playerId].bests).length && a.bests.hard && !RS.restrictedIds.includes(a.playerId));
    const oldHard = s0only.bests.hard.score, p0 = players[s0only.playerId];
    now += 20000;
    const low = await R.req('/api/submit-score', { playerId: p0.playerId, name: p0.name, score: 2600, level: levelFor(2600, 'hard'), difficulty: 'hard', country: p0.country, season: 1 });
    const g1 = await R.board('', 100);
    const E1 = expectGrid(g.map, { restrictedIds: RS.restrictedIds, conflicted: [P(7)] });
    ck('W10 after APPLY a run below the pilot\'s Season 0 best keeps the Season 0 best on the grid', low.status === 200 && sameCountries(g1, E1) && E1.pilots.find((p) => p.id === p0.playerId).b.hard === oldHard, low.status + ' ' + low.text.slice(0, 100));
    now += 20000;
    const hi = oldHard + 1000;
    const high = await R.req('/api/submit-score', { playerId: p0.playerId, name: p0.name, score: hi, level: levelFor(hi, 'hard'), difficulty: 'hard', country: p0.country, season: 1 });
    const E2 = expectGrid(g.map, { restrictedIds: RS.restrictedIds, conflicted: [P(7)] });
    ck('W10 a run above it raises the grid (the new best counts, once)', high.status === 200 && sameCountries(await R.board('', 100), E2) && E2.pilots.find((p) => p.id === p0.playerId).b.hard === hi, high.text.slice(0, 100));
    ck('W10 the live checks still pass after new runs', (await R.direct('/world-grid-check')).data.ok === true);
    // A privacy deletion after APPLY: gone from the grid, the archive and the country totals.
    const victim = arch0.find((a) => players[a.playerId] && a.bests.hard && Object.keys(players[a.playerId].bests).length && !RS.restrictedIds.includes(a.playerId) && a.playerId !== P(7));
    const vpid = await pidHash(victim.playerId);
    const pd = await R.admin('privacy-delete', { pid: vpid });
    const E3 = expectGrid(g.map, { restrictedIds: RS.restrictedIds, conflicted: [P(7)] });
    const lb3 = await R.board('', 100);
    ck('W4 a privacy deletion after APPLY: the pilot is gone from the grid and the totals, never brought back from the archive', pd.status === 200 && !lb3.top.some((t) => t.pid === vpid) && sameCountries(lb3, E3) && !JSON.stringify([...g.map.entries()].filter(([k]) => k.startsWith('archive:season0:'))).includes(victim.playerId) && (await R.direct('/world-grid-check')).data.ok === true);

    /* ================= W11 the check after the switch fails ================= */
    if (!quiet) console.log('== W11 automatic switch-back ==');
    { const X = mk(new FakeStorage(cloneMap(sm)), new FakeStorage()); await X.board(); await X.admin('backup-now');
      const dx = (await X.admin('world-grid-dry-run')).data;
      const inst = X.env._inst.get('global'); inst.handleWorldGridCheck = async () => new Response(JSON.stringify({ ok: false, checks: [{ id: 'live-grid', label: 'x', ok: false, detail: 'injected' }] }), { status: 200 });
      const ax = await X.admin('world-grid-apply', { id: dx.id, confirm: 'APPLY ' + dx.id });
      ck('W11 if the check after the switch fails, APPLY switches back by itself and says so', ax.status === 500 && ax.data.reverted === true && X.env._g.map.get('worldGrid').combined === false && (await X.board()).combined === false, ax.status + ' ' + ax.text.slice(0, 160)); }

    /* ================= W12 the game ================= */
    if (!quiet) console.log('== W12 the game ==');
    const lbCombined = await R.board('', 25), lbSeason = before['lb:'];
    const renderGame = async (data) => {
      const { store } = makeStore({ fluxPlayerId: 'player-x', fluxCallsign: 'NOVA', fluxProfileComplete: '1', fluxSeason: '1', fluxRunsPlayed: '4' });
      const gm = boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store, fetchImpl: (u) => String(u).includes('/api/leaderboard') ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(data)) }) : Promise.reject(new TypeError('offline')) });
      vm.runInContext("var __lbBody={innerHTML:''}; document.createElement=function(){ return { className:'', innerHTML:'', querySelector:function(s){ return s==='#lbBody' ? __lbBody : { onclick:null }; }, remove:function(){} }; }; openLeaderboard();", gm.ctx);
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
      return { html: String(vm.runInContext('__lbBody.innerHTML', gm.ctx)), errors: gm.errors };
    };
    const gc = await renderGame(lbCombined), gs = await renderGame(lbSeason);
    const noTabs = (h) => !/role="tab|class="[^"]*\btabs?\b|lbTab/i.test(h);
    ck('W12 after APPLY the game leaderboard shows ONE combined grid: the label, one pilot list, no tabs', gc.errors.length === 0 && /BEST OF SEASON 0 \+ SEASON 1/.test(gc.html) && /EACH PILOT COUNTED ONCE/.test(gc.html) && (gc.html.match(/class="lbList"/g) || []).length === 2 && noTabs(gc.html)
      && (gc.html.match(/class="lbRow/g) || []).length === lbCombined.top.length + Math.min(8, lbCombined.countries.length), gc.errors.join(';') + ' ' + gc.html.slice(0, 200));
    ck('W12 before APPLY the game leaderboard is as today (no combined label, no tabs)', gs.errors.length === 0 && !/SEASON 0/.test(gs.html) && /ALL DIFFICULTIES/.test(gs.html) && noTabs(gs.html) && (gs.html.match(/class="lbRow/g) || []).length === lbSeason.top.length + Math.min(8, lbSeason.countries.length));
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
    ck('W13 the gateway adds no event listener (19 sites, as on main)', (gateHtml.match(/addEventListener\(/g) || []).length === 19 && /<p class="gridCombinedNote" id="gridCombinedNote" hidden><\/p>/.test(gateHtml));

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
    ck('W16 wrangler.jsonc identical to main; no new export, class or migration', (mainCfg === null || mainCfg === WRANGLER) && JSON.stringify(cfg.migrations) === JSON.stringify([{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }]) && Object.keys(workerMod).filter((k) => k !== '__src').sort().join() === 'LeaderboardDO,default', mainCfg === null ? 'git not available' : '');
    ck('W16 the combined grid reads pilots through one accessor (pilotRecords), so the per-pilot storage change touches one place',
      /pilotRecords\(\) \{ return Object\.values\(this\.players\); \}/.test(src) && /const archive = await this\.archivePilots\(\), pilots = this\.pilotRecords\(\);/.test(src) && /mergeWorldGrid\(\{ archive: await this\.archivePilots\(\), pilots: this\.pilotRecords\(\) \}\)/.test(src));
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
await control('the grid is combined even before APPLY', 'W2 before APPLY', { worker: rep('    if (!this.gridCombined) return this.pilotRecords();\n', '') });
await control('the dry run writes to storage', 'W6 the dry run writes nothing', { worker: rep('    const { report } = await this.worldGridReport(Date.now());', '    const { report } = await this.worldGridReport(Date.now());\n    await this.state.storage.put({ worldGridLastDryRun: report.id });') });
await control('APPLY without the typed phrase', 'W7 APPLY is refused without exactly', { worker: rep('if (b.confirm !== "APPLY " + id) return json(', 'if (false) return json(') });
await control('APPLY without a recent checked backup', 'W7 APPLY is refused without a checked backup', { worker: rep('if (!recent) return json({ error: "No checked backup', 'if (false) return json({ error: "No checked backup') });
await control('APPLY accepts a backup of any age', 'W7 a backup older than 60 minutes', { worker: rep('const WORLD_GRID_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;', 'const WORLD_GRID_BACKUP_MAX_AGE_MS = 1e15;') });
await control('APPLY accepts an old dry run', 'W7 a dry run older than 60 minutes', { worker: rep('if (!(made <= now + 60000 && now - made <= WORLD_GRID_DRY_RUN_MAX_AGE_MS)) return', 'if (false) return') });
await control('APPLY ignores an archive change since the dry run', 'W7 if the archive changed', { worker: rep('if ((await this.worldGridFingerprint(input.archive)) !== id.slice(-8)) return', 'if (false) return') });
await control('dry-run route without the password', 'W7 every WORLD GRID route needs the admin password', { worker: rep('() => adminDO(request, env, "/world-grid-dry-run", {}),', '() => forwardToDO(request, env, "/world-grid-dry-run", { method: "POST" }),') });
await control('APPLY without a safety backup', 'W8 a verified safety backup', { worker: rep('try { const r = await backupDO(env, "/safety", post({ note: "before the combined World Grid " + id })); const d = await r.json(); safety = r.ok && d.ok ? d.snapshot : null; } catch (e) { safety = null; }', 'safety = { id: "none" };') });
await control('APPLY without the check on the live routes', 'W8 the post-apply checks ran', { worker: rep('  const ck = await lb("/world-grid-check", {});\n', '  const ck = { r: { ok: true }, d: { ok: true, checks: [] } };\n') });
await control('APPLY does not recompute the country totals', 'W8 the live World Grid is combined', { worker: rep('    this.worldGrid = next;\n    await this.recomputeCountries();\n    return json({ ok: true, worldGrid: this.worldGridState() });', '    this.worldGrid = next;\n    return json({ ok: true, worldGrid: this.worldGridState() });') });
await control('the switch is ignored by the leaderboard', 'W8 the live World Grid is combined', { worker: rep('get gridCombined() { return !!(this.worldGrid && this.worldGrid.combined); }', 'get gridCombined() { return false; }') });
await control('the per-difficulty boards are combined too', 'W8 the Easy, Medium and Hard boards stay', { worker: rep('for (const r of difficulty ? this.pilotRecords() : await this.gridRecords()) {', 'for (const r of await this.gridRecords()) {') });
await control('the owner summary does not show the World Grid', 'W8 the FLUX COMMAND owner summary', { worker: rep('    worldGrid: lb && lb.worldGrid ?', '    worldGridX: lb && lb.worldGrid ?') });
await control('APPLY writes the merged bests into the pilot records', 'W9 APPLY rewrote no best', { worker: rep('    await this.state.storage.put({ [WORLD_GRID_KEY]: next });\n    this.worldGrid = next;\n    await this.recomputeCountries();\n    return json({ ok: true, worldGrid', '    await this.state.storage.put({ [WORLD_GRID_KEY]: next, players: Object.fromEntries(res.pilots.map((p) => [p.playerId, p])) });\n    this.worldGrid = next;\n    await this.recomputeCountries();\n    return json({ ok: true, worldGrid') });
await control('the switch is not stored (lost on restart)', 'W9 the switch survives a restart', { worker: rep('    await this.state.storage.put({ [WORLD_GRID_KEY]: next });\n    this.worldGrid = next;\n    await this.recomputeCountries();\n    return json({ ok: true, worldGrid', '    this.worldGrid = next;\n    await this.recomputeCountries();\n    return json({ ok: true, worldGrid') });
await control('REVERT does not switch back', 'W9 REVERT switches back', { worker: rep('const next = { ...prev, combined: false, revertedAt: now,', 'const next = { ...prev, revertedAt: now,') });
await control('REVERT leaves the combined country totals', 'W9 after REVERT', { worker: rep('    this.worldGrid = next;\n    await this.recomputeCountries();\n    return json({ ok: true, wasCombined', '    this.worldGrid = next;\n    return json({ ok: true, wasCombined') });
await control('a failed check after APPLY leaves the switch on', 'W11 if the check after the switch fails', { worker: rep('    await lb("/world-grid-revert", { reason: "the check after APPLY failed" });\n', '') });
await control('a privacy deletion leaves the cached archive in memory', 'W7 if the archive changed', { worker: rep('    await this.state.storage.put(puts);\n    this.archiveCache = null;\n  }', '    await this.state.storage.put(puts);\n  }') });
await control('game: no combined label', 'W12 after APPLY the game', { game: rep("    if(data.combined) html+='<div class=\"lbSectionLabel lbCombined\">", "    if(false) html+='<div class=\"lbSectionLabel lbCombined\">") });
await control('game: the combined grid in tabs', 'W12 after APPLY the game', { game: rep("    if(data.combined) html+='<div class=\"lbSectionLabel lbCombined\">", "    if(data.combined) html+='<div class=\"lbTabs\"><button role=\"tab\">SEASON 0</button><button role=\"tab\">SEASON 1</button></div>';\n    if(data.combined) html+='<div class=\"lbSectionLabel lbCombined\">") });
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
