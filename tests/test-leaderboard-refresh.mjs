// LEADERBOARD REFRESH (owner): planets, per-difficulty boards, WORLD tab, rank line.
//   P1 the difficulties are shown as EARTH (Easy) / MARS (Medium) / JUPITER (Hard) with the small
//      Easy / Medium / Hard under or beside the name (menu, game over, HUD); internal keys unchanged;
//   P2 planet colours (#3F8CFF / #E4572E / #F2C27A) only on menus, tabs and labels, never orbs, ball
//      or skins; a planet icon beside every planet name (colour is never the only clue);
//   T1 leaderboard tabs EARTH · MARS · JUPITER · WORLD; T2 it opens on the difficulty just played;
//   B1 the pilot's own row is highlighted in the top 10, B2 otherwise pinned with rank and "X points to #N"
//      (from the fetched rows, else from the server's upload reply); B3 an unplayed tab says so;
//   B4 WORLD / MY COUNTRY switch (same board, the pilot's country, ranks within the country);
//   A1 no All board and no "weighted" text shown to players (game and Gateway); old URL still answered;
//   W1 WORLD tab: #1 country in a spotlight, the pilot's country highlighted or pinned with "N behind #X";
//   M1 the menu's World Grid card (from the cached board) opens the WORLD tab;
//   G1 game over: ONE rank line "#3 on Mars in <flag> · #41 worldwide", "N points behind <pilot>" only within 500;
//   N1 "FLUX Sparta" on the title screen, share card, share text and link preview; N2 never "This is Sparta";
//   S1 server: rank, country rank and the pilot just above in the upload reply, for that pilot only, from the
//      cached sorted board (refreshed when a score, a restriction or a name ban changes);
//   S2 FREE PLAN: leaderboard / rank reads write nothing (storage put count unchanged), a score is still ONE
//      put, and the game + Gateway fetch ONE shared URL (?boards=1) through the once-a-minute cache;
//   GP gameplay unchanged: a seeded frame trace on every difficulty equals main's.
// Ends with negative controls: each defect re-inserted into the source MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { levelFor } from './level-rule.mjs';
import { seeded } from './sim-player.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const GATE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example';
const P = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');
const tick = () => new Promise((r) => setTimeout(r, 2));
/* GP: frame trace of main's game (origin/main before this change): 3 difficulties x 2 seeds x 2400 frames.
   Recompute only for an intended gameplay change. */
const GAMEPLAY_TRACE = 'a10f5daa3edb0f02a0c4e0a5';
/* GP: the gameplay constants and functions, byte for byte as on main (difficulty table, level thresholds and
   multipliers, weights, speed curve, skins + orb palette, orb gap/outline, points cap, countdowns, launcher,
   physics update, misses/lives, launch speed, audio + haptics). Hash of their source text on origin/main. */
const GAMEPLAY_NAMES = ['DIFFICULTY', 'LEVEL_SCORE_THRESHOLDS', 'LEVEL_SCORE_MULT', 'DIFF_WEIGHT', 'SPEED_CURVE', 'SKINS', 'ORB_GAP', 'ORB_OUTLINE', 'RUN_SCORE_CAP',
  'levelScoreAt', 'levelForScore', 'fieldCapAt', 'setPaddle', 'playGameOver', 'haptic', 'newGame', 'addTarget', 'easyPickColour', 'capScore', 'registerMiss',
  'launchSpeed', 'speedAfterLostBall', 'update', 'currentPalette', 'weighted'];
const GAMEPLAY_SRC = 'efed3c820765102876a18e0a';   // LIGHTNING ZONE (owner-requested): spawnGrowingOrb() / update() changed (growing orb only in the upper half); the seeded frame trace below is unchanged

/* ---------------- fake Durable Object runtime (test-season-reset pattern) ---------------- */
class FakeStorage {
  constructor(map) { this.map = map || new Map(); this.puts = 0; }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { const obj = typeof k === 'object' ? k : { [k]: v }; this.puts++; for (const [kk, vv] of Object.entries(obj)) this.map.set(kk, structuredClone(vv)); }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
}
class FakeState {
  constructor(storage) { this.storage = storage; this.lock = Promise.resolve(); }
  blockConcurrencyWhile(fn) { const r = this.lock.then(fn); this.lock = r.then(() => {}, () => {}); return r; }
}
function makeEnv(LeaderboardDO, storage) {
  const instances = new Map(); let chain = Promise.resolve();
  const env = { ADMIN_TOKEN: 'pw', LEADERBOARD_DO: { idFromName: (n) => n, get(id) {
    if (!instances.has(id)) instances.set(id, new LeaderboardDO(new FakeState(id === 'global' ? storage : new FakeStorage())));
    const o = instances.get(id);
    return { fetch(url, init) { const run = () => o.fetch(new Request(url, init)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } }; } } };
  return env;
}
const CC = ['FR', 'US', 'PH', 'JP', 'DE'];
function seed(n = 40) {
  const m = new Map(), players = {};
  for (let i = 1; i <= n; i++) {
    const med = 1000 + i * 137, bests = { medium: { score: med, level: levelFor(med, 'medium'), updatedAt: 1700000000000 + i } };
    if (i % 3 === 0) bests.hard = { score: 500 + i * 50, level: levelFor(500 + i * 50, 'hard'), updatedAt: 1700000000000 + i };
    players[P(i)] = { playerId: P(i), name: 'PILOT' + i, country: CC[i % CC.length], updatedAt: 1700000000000 + i, bests };
  }
  m.set('players', players); m.set('nameRulesV1', 1); m.set('season', 1);
  return m;
}

async function suite({ gameHtml, gateHtml, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const scripts = scriptsOf(gameHtml);
  const realErr = console.error; console.error = () => {};
  let skew = 0; const realNow = Date.now; Date.now = () => realNow() + skew;

  /* ================= server ================= */
  try {
    const storage = new FakeStorage(seed());
    const env = makeEnv(workerMod.LeaderboardDO, storage), worker = workerMod.default;
    const call = async (p, body, method = 'POST') => { const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, { waitUntil() {} }); let d = null; try { d = await res.json(); } catch (e) {} return { status: res.status, data: d }; };
    const get = async (q) => (await call('/api/leaderboard' + q, null, 'GET')).data;
    const submit = (id, score, difficulty = 'medium', country = 'FR', name = 'NEWSTAR') => { skew += 70000; return call('/api/submit-score', { playerId: id, name, score, level: levelFor(score, difficulty), difficulty, country, season: 1 }); };
    await get('?limit=50');                                    // loads the DO
    const puts0 = storage.puts;
    const b = await get('?limit=50&boards=1');
    for (const q of ['?limit=50&boards=1', '?limit=25', '?difficulty=medium&limit=100', '?difficulty=hard', '?limit=50']) await get(q);
    ck('S2 leaderboard reads (all boards, every difficulty, old URLs) write nothing', storage.puts === puts0, storage.puts - puts0);
    const want = (d) => Object.values(storage.map.get('players')).filter((r) => r.bests[d]).sort((x, y) => y.bests[d].score - x.bests[d].score || x.bests[d].updatedAt - y.bests[d].updatedAt).map((r) => r.name);
    ck('S1 ?boards=1 carries the three difficulty boards in real points, sorted, with totals', b && b.boards && ['easy', 'medium', 'hard'].every((d) => Array.isArray(b.boards[d])) &&
      JSON.stringify(b.boards.medium.map((r) => r.name)) === JSON.stringify(want('medium').slice(0, 50)) && JSON.stringify(b.boards.hard.map((r) => r.name)) === JSON.stringify(want('hard')) &&
      b.boards.easy.length === 0 && b.totals.medium === 40 && b.totals.hard === 13 && b.boards.medium.every((r) => !('playerId' in r)), b && b.totals && JSON.stringify(b.totals));
    const old = await get('?limit=50');
    ck('A1 old cached pages still get their answer (top + countries, no boards)', old && Array.isArray(old.top) && old.top.length > 0 && Array.isArray(old.countries) && old.countries.length === 5 && !old.boards && old.weighted === true);
    // A new pilot from FR lands in the middle of Medium.
    const me = P(900), putsBefore = storage.puts;
    const r = await submit(me, 3500, 'medium', 'FR');
    const board = want('medium'), rank = board.indexOf('NEWSTAR') + 1;
    const frBoard = Object.values(storage.map.get('players')).filter((x) => x.bests.medium && x.country === 'FR').sort((x, y) => y.bests.medium.score - x.bests.medium.score).map((x) => x.name);
    const aboveName = board[rank - 2], aboveRec = Object.values(storage.map.get('players')).find((x) => x.name === aboveName);
    ck('S1 the upload reply gives this pilot\'s rank, country rank, totals and the pilot just above', r.status === 200 && r.data.rank === rank && r.data.total === 41 &&
      r.data.countryRank === frBoard.indexOf('NEWSTAR') + 1 && r.data.countryTotal === frBoard.length && r.data.above && r.data.above.name === aboveName &&
      r.data.above.score === aboveRec.bests.medium.score && r.data.above.rank === rank - 1 && !('playerId' in r.data.above) && typeof r.data.above.tag === 'string', JSON.stringify(r.data));
    ck('S2 an accepted score writes exactly as before: one put for the score, one for the country totals (no rank writes)', storage.puts - putsBefore === 2, storage.puts - putsBefore);
    // Another pilot passes: the next read shows it (the cached board is refreshed on change).
    const r2 = await submit(P(901), 3600, 'medium', 'US', 'PASSER');
    const b2 = await get('?limit=50&boards=1&x=2');
    const names2 = b2.boards.medium.map((x) => x.name);
    ck('S1 a new score reorders the cached board at once (rank read again after a change)', names2.indexOf('PASSER') >= 0 && names2.indexOf('PASSER') === names2.indexOf('NEWSTAR') - 1 && r2.data.rank === rank && r2.data.above && r2.data.above.name === aboveName, names2.slice(0, 5).join(','));
    const r3 = await submit(me, 3550, 'medium', 'FR');
    ck('S1 the pilot\'s own reply after being passed: one rank lower, PASSER just above', r3.data.rank === rank + 1 && r3.data.above && r3.data.above.name === 'PASSER' && r3.data.above.score === 3600, JSON.stringify(r3.data));
    // A restriction removes a pilot from the cached boards.
    const pidTop = b2.boards.medium[0].pid;
    const b3 = await (async () => { const inst = env.LEADERBOARD_DO.get('global'); const res = await inst.fetch('https://do.internal/admin-restrict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: pidTop, reason: 't' }) }); await res.text(); return get('?limit=50&boards=1&x=3'); })();
    ck('S1 a restricted pilot leaves the cached board at once', !b3.boards.medium.some((x) => x.pid === pidTop) && b3.totals.medium === 41, b3.totals.medium);
    ck('S1 ranks are read from the cached sorted board (no sort per reply)', /this\.rowsCache/.test(workerMod.__src || WORKER_SRC) && /idx\.at\.get\(playerId\)/.test(workerMod.__src || WORKER_SRC));
  } catch (e) { ck('S server block ran', false, e.stack); }

  /* ================= client ================= */
  const bootGame = (init = {}, fetchImpl) => { const { store, mem } = makeStore(init); const g = boot(scripts, { origin: ORIGIN, path: '/play/', store, fetchImpl }); return { g, mem, run: (s) => vm.runInContext(s, g.ctx) }; };
  const endRun = (g, run, pts) => { const timers = []; g.win.setTimeout = (fn) => { timers.push(fn); return timers.length; }; g.ctx.newGame(); run('score=' + pts + '; level=' + levelFor(pts, run('difficulty')) + ';'); g.ctx.endGame(); for (let i = 0; i < 5 && timers.length; i++) timers.splice(0).forEach((fn) => { try { fn(); } catch (e) {} }); };
  const ME = { fluxPlayerId: P(1), fluxProfileComplete: '1', fluxCallsign: 'TITAN', fluxCountry: 'FR', fluxSeason: '1' };
  try {
    // P1
    const btns = (id) => { const m = gameHtml.match(new RegExp('id="' + id + '">([\\s\\S]*?)</div>')); return m ? m[1] : ''; };
    const okBtns = (h) => /data-d="easy"><svg class="pl"[^]*?<\/svg>EARTH<small>Easy<\/small>/.test(h) && /data-d="medium"><svg class="pl"[^]*?<\/svg>MARS<small>Medium<\/small>/.test(h) && /data-d="hard"><svg class="pl"[^]*?<\/svg>JUPITER<small>Hard<\/small>/.test(h);
    ck('P1 menu and game-over choices read EARTH / MARS / JUPITER with small Easy / Medium / Hard and an icon', okBtns(btns('difficulty')) && okBtns(btns('gameoverDifficulty')));
    const labs = ['easy', 'medium', 'hard'].map((d) => { const { g, run } = bootGame({ ...ME, fluxDifficulty: d }); g.ctx.updateHud(); const hud = g.win.document.getElementById('hudDiff').textContent; endRun(g, run, 1234); const el = (id) => g.win.document.getElementById(id); return [hud, el('finalMode').textContent, run('difficulty')].join('/'); });
    ck('P1 HUD and game over show the planet (internal key unchanged)', labs.join(',') === 'EARTH/EARTH/easy,MARS/MARS/medium,JUPITER/JUPITER/hard', labs.join(','));
    ck('P1 the small Easy / Medium / Hard beside HUD and game-over labels (CSS from data-sub, with the icon)', /\.plTag\[data-d\]::after\{content:attr\(data-sub\)/.test(gameHtml) && /\.plTag\[data-d\]::before\{content:""/.test(gameHtml) &&
      /el\.setAttribute\('data-sub',p\.sub\.toUpperCase\(\)\)/.test(gameHtml) && /<b id="finalMode" class="plTag" data-d="medium" data-sub="MEDIUM">MARS<\/b>/.test(gameHtml));
    // P2 colours only on menus/tabs/labels
    const bad = [];
    for (const hex of ['3F8CFF', 'E4572E', 'F2C27A']) {
      for (const line of gameHtml.split('\n')) {
        if (!new RegExp(hex, 'i').test(line)) continue;
        const ok = /LEADERBOARD REFRESH: planets\./.test(line) || /LEADERBOARD REFRESH: tabs EARTH/.test(line) || /^const FLUX_PLANET_SVG=/.test(line) || /class="difficulty" id="(gameover)?[dD]ifficulty"/.test(line);
        if (/^const SKINS=|cosmic:\{name:'COSMIC'/.test(line.trim()) && hex === '3F8CFF') continue;   // pre-existing in main: the Cosmic skin's launcher, unchanged
        if (!ok) bad.push(hex + ': ' + line.trim().slice(0, 70));
      }
    }
    ck('P2 the planet colours appear only in the menu / tab / label styles and the planet icons (never orbs, ball, skins)', bad.length === 0, bad.join(' | '));
    const { g: g0, run: run0 } = bootGame(ME);
    const tabs = run0("fluxTabsHtml('medium')");
    ck('P2 every tab has its planet icon (WORLD: a globe)', (tabs.match(/<svg class="pl"/g) || []).length === 4);
    // T1 / T2
    ck('T1 tabs read EARTH · MARS · JUPITER · WORLD in that order, the chosen one marked', /EARTH<small>Easy<\/small>[^]*MARS<small>Medium<\/small>[^]*JUPITER<small>Hard<\/small>[^]*WORLD<small>Countries<\/small>/.test(tabs) && /data-tab="medium" aria-selected="true" class="lbTab on"/.test(tabs));
    const opened = [];
    for (const d of ['easy', 'hard']) {
      const { g, run } = bootGame({ ...ME, fluxDifficulty: 'medium' });
      g.ctx.fluxTabsHtml = (t) => { opened.push(t); return ''; };
      run("difficulty='" + d + "';"); g.ctx.newGame(); run('score=100;'); g.ctx.endGame();
      g.ctx.openLeaderboard();
    }
    { const { g } = bootGame({ ...ME, fluxDifficulty: 'hard' }); g.ctx.fluxTabsHtml = (t) => { opened.push(t); return ''; }; g.ctx.openLeaderboard({ type: 'click' }); }
    ck('T2 the board opens on the difficulty just played (or last selected); a click event is not a tab', opened.join(',') === 'easy,hard,hard', opened.join(','));
    // B1..B4
    const rows = (n, ccOf, base = 20000) => Array.from({ length: n }, (_, i) => ({ pid: 'p' + i, tag: 'T' + i, name: 'N' + i, country: ccOf(i), score: base - i * 100 }));
    const data = { boards: { easy: [], medium: rows(50, (i) => (i % 2 ? 'US' : 'FR')), hard: rows(50, () => 'JP') }, countries: [] };
    const view = (d, scope, pid, extra = {}) => { const { run } = bootGame({ ...ME, ...extra }); run('var __d=' + JSON.stringify(data)); return run('JSON.stringify(fluxBoardView(__d,' + JSON.stringify(d) + ',' + JSON.stringify(scope) + ',{pid:' + JSON.stringify(pid) + ",country:'FR'}))"); };
    const v1 = JSON.parse(view('medium', 'world', 'p4'));
    ck('B1 in the top 10: the pilot\'s own row is highlighted, nothing pinned', v1.rows.length === 10 && v1.rows[4].mine === true && v1.rows.filter((r) => r.mine).length === 1 && !v1.pinned);
    const v2 = JSON.parse(view('medium', 'world', 'p23'));
    ck('B2 outside the top 10: pinned at the bottom with the rank and "points to #N" (N = the rank just above)', v2.rows.length === 10 && !v2.rows.some((r) => r.mine) && v2.pinned && v2.pinned.rank === 24 && v2.pinned.toRank === 23 && v2.pinned.toPts === 101, JSON.stringify(v2.pinned));
    { const { run } = bootGame(ME); run('var __d=' + JSON.stringify(data)); const h = run("fluxBoardHtml(fluxBoardView(__d,'medium','world',{pid:'p23',country:'FR'}))");
      ck('B2 the pinned row reads "#24 ... 101 points to #23"', /<div class="lbPinned"><div class="lbRow lbMine"><span class="lbRank">#24<\/span>[^]*101 points to #23/.test(h)); }
    // Beyond the fetched rows: the rank from the server's reply to the last upload.
    const snap = JSON.stringify({ pid: P(1), season: 1, d: { hard: { rank: 120, total: 300, countryRank: 9, countryTotal: 20, country: 'FR', best: 5000, above: { rank: 119, name: 'ACE', tag: 'X', score: 5080 }, at: 1 } } });
    const v3 = JSON.parse(view('hard', 'world', 'zzz', { fluxRankSnap: snap, fluxBestRun_hard: JSON.stringify({ score: 5000, level: 3 }) }));
    ck('B2 beyond the fetched rows: pinned with the server\'s rank and "points to" the pilot just above', v3.pinned && v3.pinned.rank === 120 && v3.pinned.toRank === 119 && v3.pinned.toPts === 81 && v3.pinned.score === 5000, JSON.stringify(v3.pinned));
    const v4 = JSON.parse(view('hard', 'world', 'zzz', { fluxBestRun_hard: JSON.stringify({ score: 5000, level: 3 }) }));
    ck('B2 no reply yet: pinned "#51+" with the points to the last row shown', v4.pinned && v4.pinned.rankText === '#51+' && v4.pinned.toRank === 50 && v4.pinned.toPts === data.boards.hard[49].score - 5000 + 1, JSON.stringify(v4.pinned));
    const un = ['easy', 'medium', 'hard'].map((d) => JSON.parse(view(d, 'world', 'nobody')).unplayed);
    ck('B3 an unplayed tab says so, per planet', un[0] === "You haven't reached Earth yet. Play Easy to get on this board." && un[1] === "You haven't reached Mars yet. Play Medium to get on this board." && un[2] === "You haven't reached Jupiter yet. Play Hard to get on this board.", un.join(' | '));
    const v5 = JSON.parse(view('medium', 'country', 'p24'));
    ck('B4 MY COUNTRY: the same board filtered to the pilot\'s country, ranked within it', v5.rows.length === 10 && v5.rows.every((r) => r.country === 'FR') && v5.rows[0].name === 'N0' && v5.rows[1].name === 'N2' && v5.pinned && v5.pinned.rank === 13 && v5.pinned.toRank === 12, JSON.stringify(v5.pinned));
    { const { run } = bootGame(ME); run('var __d=' + JSON.stringify(data)); const h = run("fluxBoardHtml(fluxBoardView(__d,'medium','country',{pid:'p24',country:'FR'}))");
      ck('B4 every difficulty tab has the WORLD / MY COUNTRY switch', /data-scope="world" class="">WORLD<\/button><button type="button" data-scope="country" class="on">MY COUNTRY/.test(h)); }
    // A1
    const shown = (h) => h.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const lits = (h) => scriptsOf(h).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[\s;,){])\/\/.*$/, '$1')).join('\n').match(/(['"])(?:(?!\1)[^\\\n]|\\.)*\1/g) || [];
    const wLits = [...lits(gameHtml), ...lits(gateHtml)].filter((s) => /weighted|ALL DIFFICULTIES|TOP COUNTRIES|TOP SCORERS/i.test(s));
    ck('A1 no All board and no "weighted" text shown to players (game + Gateway: markup and strings)', !/weighted|ALL DIFFICULTIES/i.test(shown(gameHtml)) && !/weighted|TOP SCORERS/i.test(shown(gateHtml)) && wLits.length === 0, wLits.join(' | ').slice(0, 200));
    // W1
    const cs = Array.from({ length: 15 }, (_, i) => ({ country: ['US', 'PH', 'JP', 'DE', 'BR', 'KE', 'IN', 'MX', 'CA', 'GB', 'IT', 'ES', 'FR', 'NL', 'SE'][i], totalScore: 90000 - i * 1000 - (i === 12 ? 250 : 0), playerCount: 3, topName: 'TOPX' }));
    const wv = (cc) => { const { run } = bootGame({ ...ME, fluxCountry: cc }); run('var __c=' + JSON.stringify({ countries: cs })); return { v: JSON.parse(run('JSON.stringify(fluxWorldView(__c,country))')), h: run('fluxWorldHtml(fluxWorldView(__c,country),country)') }; };
    const w1 = wv('FR'), w2 = wv('JP');
    ck('W1 WORLD: #1 country in a spotlight, the pilot\'s country pinned with "N behind #X"', w1.v.spotlight.country === 'US' && /class="lbSpot"/.test(w1.h) && w1.v.pinned && w1.v.pinned.rank === 13 && w1.v.pinned.behind === 1250 && w1.v.pinned.aboveRank === 12 && /1,250 behind #12/.test(w1.h), JSON.stringify(w1.v.pinned));
    ck('W1 a pilot\'s country in the top 10 is highlighted, not pinned', !w2.v.pinned && w2.v.rows.find((r) => r.c.country === 'JP').mine === true && /lbRow lbMine"><span class="lbRank">#3</.test(w2.h));
    // M1
    { const { g, run } = bootGame({ ...ME, fluxLbCache: JSON.stringify({ at: Date.now(), data: { countries: cs, boards: data.boards, top: [] } }) });
      const seen = []; g.ctx.openLeaderboard = (t) => seen.push(t); run('refreshGridCard()');
      const card = String(g.win.document.getElementById('gridCard').innerHTML); const oc = g.win.document.getElementById('gridCard').onclick; if (typeof oc === 'function') oc({});
      ck('M1 the menu\'s World Grid card shows #1, the pilot\'s country and its gap, and opens WORLD', /#1 🇺🇸 US · 90,000/.test(card) && /🇫🇷 #13 · 1,250 behind #12/.test(card) && seen.join() === 'world', card + ' / ' + seen.join()); }
    // G1
    const rl = (above, best = 5000) => { const { run } = bootGame(ME); run("rankSnapSave({ok:true,public:true,difficulty:'medium',rank:41,total:900,countryRank:3,countryTotal:30,country:'FR',best:" + best + ",above:" + JSON.stringify(above) + "},{playerId:playerId,difficulty:'medium',country:'FR'})"); return JSON.parse(run("JSON.stringify(fluxRankLine('medium'))")); };
    const g1 = rl({ rank: 40, name: 'TITAN2', tag: 'X', score: 5280 }), g2 = rl({ rank: 40, name: 'FAR', tag: 'X', score: 5600 }), g3 = rl({ rank: 40, name: 'TIE', tag: 'X', score: 5000 }), g4 = rl({ rank: 40, name: 'EDGE', tag: 'X', score: 5500 });
    ck('G1 the game-over rank line: "#3 on Mars in 🇫🇷 · #41 worldwide" + "280 points behind TITAN2"', g1 && g1.line === '#3 on Mars in 🇫🇷 · #41 worldwide' && g1.behind === '280 points behind TITAN2', JSON.stringify(g1));
    ck('G1 "points behind" only when a pilot is 1-500 points above (not 501, not a tie)', g2 && g2.line === '#3 on Mars in 🇫🇷 · #41 worldwide' && g2.behind === null && g3.behind === null && g4.behind === '500 points behind EDGE', JSON.stringify([g2, g3, g4]));
    // A real upload fills the line at game over (reply -> snapshot -> line).
    { const reply = { ok: true, isNewBest: true, best: 2100, country: 'FR', difficulty: 'medium', public: true, rank: 7, total: 50, countryRank: 2, countryTotal: 9, above: { rank: 6, name: 'NEAR', tag: 'Q', score: 2300 }, tag: 'ME' };
      const fetchImpl = (u) => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, clone() { return this; }, json: () => Promise.resolve(reply), text: () => Promise.resolve(JSON.stringify(reply)) });
      const { g, run, mem } = bootGame({ ...ME, fluxDifficulty: 'medium', fluxRunsPlayed: '5' }, fetchImpl);
      endRun(g, run, 2100);
      for (let i = 0; i < 30; i++) await tick();
      const html = String(g.win.document.getElementById('goRank').innerHTML);
      ck('G1 after the upload the game over shows "#2 on Mars in 🇫🇷 · #7 worldwide · 200 points behind NEAR"', /^#2 on Mars in 🇫🇷 · #7 worldwide<small>200 points behind NEAR<\/small>$/.test(html) && JSON.parse(mem.fluxRankSnap).d.medium.rank === 7, html); }
    ck('G1 exactly one rank line element on the game-over screen', (gameHtml.match(/id="goRank"/g) || []).length === 1);
    // P3 WCAG AA contrast (>= 4.5:1) of every planet label, selected (dark text on the planet colour) and unselected (planet or light text on the dark panel)
    const lum = (hex) => { const v = hex.replace('#', '').match(/../g).map((x) => { const c = parseInt(x, 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const css = (sel) => (gameHtml.split(sel + '{')[1] || '').split('}')[0];
    const col = (decl, k) => ((decl.match(new RegExp('(?:^|;)' + k + ':(#[0-9a-fA-F]{6})')) || [])[1] || '');
    const pairs = [];
    for (const [d, t] of [['easy', 'easy'], ['medium', 'medium'], ['hard', 'hard']]) {
      pairs.push(['menu selected ' + d, col(css('.difficulty button[data-d=' + d + '].selected'), 'color'), col(css('.difficulty button[data-d=' + d + '].selected'), 'background')]);
      pairs.push(['tab selected ' + t, col(css('.lbTab.on'), 'color'), col(css('.lbTab[data-tab=' + t + '].on'), 'background')]);
      pairs.push(['label ' + d, col(css('.plTag[data-d=' + d + ']'), 'color'), '#080d29']);
    }
    pairs.push(['menu unselected', col(css('.difficulty button'), 'color'), col(css('.difficulty button'), 'background')]);
    pairs.push(['tab unselected', col(css('.lbTab'), 'color'), col(css('.lbTab'), 'background')]);
    pairs.push(['tab selected world', col(css('.lbTab.on'), 'color'), col(css('.lbTab[data-tab=world].on'), 'background')]);
    const low = pairs.filter((x) => !x[1] || !x[2] || cr(x[1], x[2]) < 4.5).map((x) => x[0] + ' ' + x[1] + '/' + x[2] + (x[1] && x[2] ? ' ' + cr(x[1], x[2]).toFixed(2) : ''));
    ck('P3 every planet label passes WCAG AA 4.5:1, selected and unselected (Jupiter gold with dark text)', pairs.length === 12 && low.length === 0 && !/\.(difficulty button small|lbTab small|plTag\[data-d\]::after)\{[^}]*opacity/.test(gameHtml), low.join(' | '));
    ck('P3 planet icons are inline SVG, never emoji (tabs, menu, WORLD globe)', !/[\u{1F30D}\u{1F30E}\u{1F30F}\u{1FA90}]/u.test(tabs) && (tabs.match(/<svg class="pl"/g) || []).length === 4);
    // Q1 old queued uploads (FREE PLAN queue with stats + run id) keep working and feed the rank line
    { const bodies = []; const reply = { ok: true, isNewBest: true, best: 7000, country: 'FR', difficulty: 'hard', public: true, rank: 12, total: 80, countryRank: 2, countryTotal: 5, above: { rank: 11, name: 'UP', tag: 'Q', score: 7100 }, tag: 'ME' };
      const fetchImpl = (u, o) => { if (String(u).includes('submit-score')) bodies.push(JSON.parse(o.body)); return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, clone() { return this; }, json: () => Promise.resolve(reply), text: () => Promise.resolve(JSON.stringify(reply)) }); };
      const item = { id: P(1) + ':hard:7000:3', playerId: P(1), name: 'TITAN', score: 7000, level: levelFor(7000, 'hard'), difficulty: 'hard', country: 'FR', season: 1, attempts: 1, runId: 'r0123456789abcdef', stats: { src: 'x', events: [{ t: 'run_end', d: {} }] } };
      const { g, run, mem } = bootGame({ ...ME, fluxPendingSubmits: JSON.stringify([item]) }, fetchImpl);
      await run('flushSubmitQueue()'); for (let i = 0; i < 20; i++) await tick();
      const b0 = bodies[0] || {}, sn = mem.fluxRankSnap ? JSON.parse(mem.fluxRankSnap).d.hard : null;
      ck('Q1 an old queued upload (difficulty key "hard", its run id and stats) is sent unchanged and its rank reply is kept', b0.difficulty === 'hard' && b0.runId === item.runId && b0.score === 7000 && sn && sn.rank === 12 && sn.above.name === 'UP', JSON.stringify(b0).slice(0, 160)); }
    // N1 / N2
    const title = (h) => (h.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const meta = (h, k) => ((h.match(new RegExp('<meta (?:property|name)="' + k + '" content="([^"]*)"')) || [])[1] || '');
    ck('N1 "FLUX Sparta" in <title>, og:title and twitter:title of both pages', [gameHtml, gateHtml].every((h) => /FLUX Sparta/.test(title(h)) && /FLUX Sparta/.test(meta(h, 'og:title')) && /FLUX Sparta/.test(meta(h, 'twitter:title'))));
    { const { g } = bootGame(ME); const t = g.ctx.shareText({ score: 1200, added: 0, country: 'FR' });
      ck('N1 "FLUX Sparta" on the title screen, the share card image and the share text', /<h1>FLUX <span class="h1Sparta">Sparta<\/span><\/h1>/.test(gameHtml) && /const SHARE_CARD_TITLE='FLUX Sparta'/.test(gameHtml) && /x\.fillText\(SHARE_CARD_TITLE,/.test(gameHtml) && /FLUX Sparta/.test(t), t); }
    const everywhere = [gameHtml, gateHtml, workerMod.__src || WORKER_SRC, ...fs.readdirSync(path.join(ROOT, 'public')).filter((f) => /\.(html|js|json|webmanifest|txt)$/.test(f)).map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'))];
    ck('N2 never "This is Sparta" anywhere', everywhere.every((s) => !/this\s+is\s+sparta/i.test(s)));
    // S2 client: one shared URL, through the once-a-minute cache
    const url = (gameHtml.match(/FLUX_LB_URL='([^']+)'/) || [])[1];
    ck('S2 the game and the Gateway fetch the SAME board URL (?boards=1), once a minute via the shared cache', url === '/api/leaderboard?limit=50&boards=1' && gateHtml.includes("'/api/leaderboard?limit=50&boards=1'") &&
      (scriptsOf(gameHtml).join('\n').match(/fetch\([^)]*\/api\/leaderboard/g) || []).length === 0 && /fluxLbLoad\(\)\.then\(render\)/.test(gameHtml), url);
    ck('S2 a cached copy without the planet boards is not used as fresh', /c\.data\.boards/.test(gameHtml));
  } catch (e) { ck('C client block ran', false, e.stack); }

  /* ================= gameplay ================= */
  try {
    const t = trace(gameHtml);
    ck('GP gameplay constants and functions byte-identical to main (' + GAMEPLAY_NAMES.length + ' tables / functions)', gameplaySource(gameHtml) === GAMEPLAY_SRC, gameplaySource(gameHtml));
    ck('GP gameplay unchanged: seeded frame trace (3 difficulties x 2 seeds) equals main\'s', t === GAMEPLAY_TRACE, t);
  } catch (e) { ck('GP gameplay trace ran', false, e.stack); }

  Date.now = realNow; console.error = realErr;
  return { F, failed };
}
export function gameplaySource(html) {
  const out = [];
  for (const n of GAMEPLAY_NAMES) {
    const m = new RegExp('(^|\\n)(?:const|let) ' + n + '=|(^|\\n)function ' + n + '\\(').exec(html);
    if (!m) { out.push(n + ':MISSING'); continue; }
    const fn = /function/.test(m[0]); let i = m.index + m[0].length, depth = fn ? 1 : 0, started = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (c === '{' || c === '[' || c === '(') { depth++; started = true; }
      else if (c === '}' || c === ']' || c === ')') depth--;
      if (depth === 0 && (c === ';' || c === '\n' || (fn && started && c === '}'))) break;
    }
    out.push(html.slice(m.index, i + 1));
  }
  return crypto.createHash('sha256').update(out.join('\n#\n')).digest('hex').slice(0, 24);
}
export function trace(html) {
  const scripts = scriptsOf(html), h = crypto.createHash('sha256'), realRandom = Math.random;
  try {
    for (const diff of ['easy', 'medium', 'hard']) for (const s of [3, 11]) {
      Math.random = seeded(s);
      const { store } = makeStore({ fluxPlayerId: 'trace-' + s, fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: '5', fluxDifficulty: diff });
      const g = boot(scripts, { origin: 'https://x.test', path: '/play/', store });
      g.ctx.newGame();
      h.update(vm.runInContext(`var __o=[]; playing=true; paused=false;
        for(let i=0;i<2400;i++){ if(!playing)break; paddle.x+=Math.max(-18,Math.min(18,ball.x-paddle.x)); setPaddle(paddle.x); update(1/60);
          if(i%20===0) __o.push([Math.round(ball.x*100),Math.round(ball.y*100),score,combo,level,misses,targets.length].join(',')); }
        __o.join(';')`, g.ctx));
    }
  } finally { Math.random = realRandom; }
  return h.digest('hex').slice(0, 24);
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
if (process.argv[2] === '--trace') { const h = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : GAME_HTML; console.log(gameplaySource(h)); console.log(trace(process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : GAME_HTML)); process.exit(0); }
console.log('== LEADERBOARD REFRESH ==');
const main = await suite({ gameHtml: GAME_HTML, gateHtml: GATE_HTML, workerMod: realMod });

console.log('\n== negative controls ==');
let NC = 0;
async function control(label, expect, { game = (s) => s, worker = (s) => s, gate = (s) => s }) {
  const g2 = game(GAME_HTML), w2 = worker(WORKER_SRC), a2 = gate(GATE_HTML);
  if (g2 === GAME_HTML && w2 === WORKER_SRC && a2 === GATE_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-lbr-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = w2 === WORKER_SRC ? realMod : await import(pathToFileURL(tmp).href);
    const r = await suite({ gameHtml: g2, gateHtml: a2, workerMod: Object.assign({ __src: w2 }, mod), quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('cached board never refreshed after a score', 'S1 a new score reorders', { worker: (s) => rep('invalidateTags() { this.tagCache = null; this.rowsCache = null; }', 'invalidateTags() { this.tagCache = null; }')(rep('if (hit && hit.players === this.players && hit.restricted === this.restricted) return hit;', 'if (hit) return hit;')(s)) });
await control('cached board ignores restrictions', 'S1 a restricted pilot', { worker: rep('if (hit && hit.players === this.players && hit.restricted === this.restricted) return hit;', 'if (hit && hit.players === this.players) return hit;') });
await control('country rank = world rank', 'S1 the upload reply', { worker: rep('cCount.set(cc, n); cRank[i] = n;', 'cCount.set(cc, n); cRank[i] = i + 1;') });
await control('no pilot above in the reply', 'S1 the upload reply', { worker: rep('above = { rank: i, name:', 'above = null && { rank: i, name:') });
await control('no planet boards in the response', 'S1 ?boards=1', { worker: rep('if (url.searchParams.get("boards") === "1") {', 'if (false) {') });
await control('a leaderboard read writes', 'S2 leaderboard reads', { worker: rep('    return json(out);\n  }\n  async publicTop', '    await this.state.storage.put({ lbReadAt: Date.now() });\n    return json(out);\n  }\n  async publicTop') });
await control('old URL answered with boards only', 'A1 old cached pages', { worker: rep('const out = { top, countries,', 'const out = { top: [], countries,') });
await control('planet names back to EASY', 'P1 HUD', { game: rep("easy:{name:'EARTH',", "easy:{name:'EASY',") });
await control('menu loses the small Medium', 'P1 menu', { game: (s) => s.split('MARS<small>Medium</small>').join('MARS') });
await control('planet colour on an orb', 'P2 the planet colours', { game: rep('const FLUX_LB_TABS=', "const FLUX_ORB_EXTRA='#E4572E';\nconst FLUX_LB_TABS=") });
await control('tabs without icons', 'P2 every tab', { game: rep("(p?planetIcon(t)+p.name", "(p?p.name") });
await control('tab order changed', 'T1 tabs', { game: rep("const FLUX_LB_TABS=['easy','medium','hard','world'];", "const FLUX_LB_TABS=['world','easy','medium','hard'];") });
await control('board always opens on Mars', 'T2 the board opens', { game: rep("function fluxLbDefaultTab(){ return FLUX_PLANETS[difficulty] ? difficulty : 'medium'; }", "function fluxLbDefaultTab(){ return 'medium'; }") });
await control('own row not highlighted', 'B1 in the top 10', { game: rep('score:r.score, mine:i===myI };', 'score:r.score, mine:false };') });
await control('own row not pinned', 'B2 outside the top 10', { game: rep('  if(myI>=FLUX_LB_SHOW){\n', '  if(false){\n') });
await control('points to the wrong rank', 'B2 outside the top 10', { game: rep('toRank:myI, toPts:up.score-rows[myI].score+1 };', 'toRank:myI+1, toPts:up.score-rows[myI].score+1 };') });
await control('server rank ignored beyond the rows', 'B2 beyond the fetched rows', { game: rep('const rank=known>rows.length ? known : 0;', 'const rank=0;') });
await control('unplayed tab silent', 'B3 an unplayed tab', { game: rep('v.unplayed="You haven\'t reached "+p.word+" yet. Play "+p.sub+" to get on this board.";', '') });
await control('MY COUNTRY not filtered', 'B4 MY COUNTRY', { game: rep("const rows=inCountry ? all.filter(function(r){ return r.country===me.country; }) : all;", 'const rows=all;') });
await control('weighted label back on the board', 'A1 no All board', { game: rep("function fluxBoardHtml(v){\n", "function fluxBoardHtml(v){\n  const __w='ALL DIFFICULTIES · WEIGHTED';\n") });
await control('Gateway still says weighted', 'A1 no All board', { gate: rep('Jupiter (Hard) counts the most.', 'Scores are weighted by difficulty.') });
await control('no spotlight', 'W1 WORLD', { game: rep("let h='<div class=\"lbSpot'", "let h='<div class=\"lbTop'") });
await control('gap to the wrong country', 'W1 WORLD', { game: rep('behind:cs[myI-1].totalScore-cs[myI].totalScore, aboveRank:myI };', 'behind:cs[0].totalScore-cs[myI].totalScore, aboveRank:1 };') });
await control('menu card opens the default tab', 'M1 the menu', { game: rep("document.getElementById('gridCard').onclick=function(){ openLeaderboard('world'); };", "document.getElementById('gridCard').onclick=function(){ openLeaderboard(); };") });
await control('points behind at any distance', 'G1 "points behind" only', { game: rep('const FLUX_BEHIND_MAX=500;', 'const FLUX_BEHIND_MAX=5000;') });
await control('reply not kept for the rank line', 'G1 after the upload', { game: rep('rankSnapSave(b,item);', '') });
await control('share text says FLUX only', 'N1 "FLUX Sparta" on the title', { game: rep("+' Beat me in FLUX Sparta:';", "+' Beat me in FLUX:';") });
await control('link preview without the full name', 'N1 "FLUX Sparta" in <title>', { gate: rep('<meta name="twitter:title" content="FLUX Sparta — The world is the scoreboard">', '<meta name="twitter:title" content="FLUX">') });
await control('This is Sparta', 'N2 never', { game: rep('<title>Play FLUX Sparta', '<title>This is Sparta! Play FLUX Sparta') });
await control('a second leaderboard fetch', 'S2 the game and the Gateway', { game: rep('function refreshGridCard(){\n', "function refreshGridCard(){\n  fetch('/api/leaderboard?limit=10');\n") });
await control('Gateway on its own URL', 'S2 the game and the Gateway', { gate: rep("'/api/leaderboard?limit=50&boards=1'", "'/api/leaderboard?limit=50'") });
await control('ball a little faster (gameplay)', 'GP gameplay unchanged', { game: rep('ball={x:W/2,y:paddle.y-28,r:13,vx:rand(-3.5,3.5),vy:-launchSpeed(6.2*DIFFICULTY[difficulty].speed)', 'ball={x:W/2,y:paddle.y-28,r:13,vx:rand(-3.5,3.5),vy:-launchSpeed(6.3*DIFFICULTY[difficulty].speed)') });
await control('light text on Jupiter gold', 'P3 every planet label', { game: rep('.difficulty button[data-d=hard].selected{background:#F2C27A;color:#050a18;', '.difficulty button[data-d=hard].selected{background:#F2C27A;color:#ffffff;') });
await control('faded small labels', 'P3 every planet label', { game: rep('.lbTab small{display:block;margin-top:2px;font-size:11px;font-weight:700;letter-spacing:0}', '.lbTab small{display:block;margin-top:2px;font-size:11px;font-weight:700;letter-spacing:0;opacity:.6}') });
await control('emoji globe on the WORLD tab', 'P3 planet icons', { game: rep("FLUX_WORLD_SVG+'WORLD<small>Countries</small>'", "'\u{1F30D}WORLD<small>Countries</small>'") });
await control('tie counted as behind', 'G1 "points behind" only', { game: rep('s.above.score-s.best>=1 &&', 's.above.score-s.best>=0 &&') });
await control('queued upload sent under the planet name', 'Q1 an old queued upload', { game: rep('level:item.level, difficulty:item.difficulty,', "level:item.level, difficulty:(FLUX_PLANETS[item.difficulty]||{}).name,") });
await control('orb gap changed (gameplay constant)', 'GP gameplay constants', { game: rep('const ORB_GAP=10;', 'const ORB_GAP=11;') });
const total = main.F + NC;
console.log('\n' + (total ? 'LEADERBOARD REFRESH FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'LEADERBOARD REFRESH PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
