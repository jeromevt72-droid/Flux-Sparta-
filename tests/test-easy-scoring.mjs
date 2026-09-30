// Scoring and difficulty weights, in the release gate. Real game page (harness vm) + real worker.js.
// The leaderboard's ALL board and the country totals compare difficulties, so the same player
// must count for less on Easy than on Medium, and on Medium than on Hard.
//   S1 FULL POINTS (owner): every scoring event pays the same on Easy, Medium and Hard
//      (orb, danger, bonus, overload, FLUX MODE, perfect and plain catch);
//   S3 level thresholds: the table x1.5 on Easy (longer runs), x1 on Medium, x0.55 on Hard;
//   S4 the server uses the same thresholds: real runs at their level are accepted, nothing
//      looser (two levels off is refused), 455,000 ceiling kept;
//   W1 the Easy, Medium and Hard boards show players' REAL points;
//   W2 the ALL board ranks each player by their best WEIGHTED score (Hard x1, Medium x0.21,
//      Easy x0.09) and shows it (with the real points beside it, and weighted:true);
//   W3 country totals add each player's best weighted score once; totals stored before the
//      weights are rebuilt once when the server loads them; stored scores are never rewritten;
//   W4 the game and the server use the same weights; the game no longer shows an All board or "weighted" (LEADERBOARD REFRESH, owner);
//   S5 the same simulated player (new beginner, casual, steady; seeded) has a lower weighted
//      mean on Easy than on Medium, and on Medium than on Hard, by at least 10% (at most 90%).
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { runParallel } from './sim-player.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'worker.js'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.jeromevt72.workers.dev';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

function makeEnv(DO) {
  class S { constructor() { this.map = new Map(); } async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
    async put(a, v) { const o = typeof a === 'object' ? a : { [a]: v }; for (const [k, val] of Object.entries(o)) this.map.set(k, structuredClone(val)); } }
  class St { constructor() { this.storage = new S(); } async blockConcurrencyWhile(fn) { return fn(); } }
  const inst = new Map(); let chain = Promise.resolve();
  return { ADMIN_TOKEN: 't', STORE_OPEN: 'false', SITE_URL: ORIGIN, _inst: inst,
    LEADERBOARD_DO: { idFromName: (n) => n, get(id) { if (!inst.has(id)) inst.set(id, new DO(new St())); const o = inst.get(id);
      return { fetch(u, i) { const r = () => o.fetch(new Request(u, i)); const p = chain.then(r, r); chain = p.then(() => {}, () => {}); return p; } }; } } };
}
let pidN = 0;
const board = async (w, env, q = '') => (await (await w.fetch(new Request(ORIGIN + '/api/leaderboard?limit=50' + q), env)).json());
const submit = async (w, env, body) => { skew += 20000;
  const r = await w.fetch(new Request(ORIGIN + '/api/submit-score', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'es-' + (++pidN), name: 'T', country: 'US', season: 1, ...body }) }), env);   // SEASON 1: scores say their season
  return r.status; };

// Simulated players (sim-player.mjs, the model of the PRs' measurements): they follow the ball
// with a delay and a random aim error; 4th+ run; one free revive; at most 30 minutes.
// 40 seeds each; the runs are spread over worker threads.
const PLAYERS = ['new beginner', 'casual', 'steady'];
const SEEDS = 40;

async function suite({ gameHtml, workerMod, workerSrc = WORKER_SRC, quiet = false, sim = true }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const bootGame = (difficulty, seed = 3) => {
    Math.random = seeded(seed);
    const { store } = makeStore({ fluxPlayerId: 'es-' + seed, fluxCallsign: 'T', fluxProfileComplete: '1', fluxDifficulty: difficulty, fluxColorHintSeen: '1', fluxRunsPlayed: '5' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    return { g, run };
  };
  // Points one event pays, on a fixed state (combo 3, orb value 30, no FLUX mode).
  const PREP = 'newGame(); playing=true; paused=false; combo=3; orbValue=30; fluxMode=0; flux=0; score=0;';
  const events = (d) => {
    const { run } = bootGame(d); const out = {};
    const one = (k, code) => { run(PREP); run(code); out[k] = run('score'); };
    one('orb', 'targets[0].r=20; targets[0].danger=false; fuse(targets[0]);');
    one('danger', 'targets[0].r=20; targets[0].danger=true; fuse(targets[0]);');   // orb hit + danger bonus
    one('bonus', 'popBonus(targets[0]);');
    one('overload', 'burstGrowing(targets[0],12);');
    one('flux', 'startFluxMode();');
    const paddle = (dx) => `targets=[]; bonusTimer=99; growTimer=99; ball.x=paddle.x+${dx}*paddle.w/2; ball.y=paddle.y-paddle.h/2-ball.r+2; ball.vx=0; ball.vy=5; comboTimer=2; update(1/60);`;
    one('perfect', paddle(0));
    one('catch', paddle(0.6));
    Math.random = realRandom; return out;
  };
  let W = null;
  try {
    const med = events('medium'), hard = events('hard'), easy = events('easy');
    // Full points (combo 3 -> 4 on an orb hit; orb value 30): the pre-#26 Medium values, and a perfect catch 5 x combo 3.
    const FULL = { orb: 38, danger: 53, bonus: 150, overload: 245, flux: 250, perfect: 15, catch: 2 };
    ck('S1 FULL POINTS: every scoring event pays the same on Easy, Medium and Hard (orb, danger, bonus, overload, FLUX MODE, perfect and plain catch)',
      [easy, med, hard].every((x) => JSON.stringify(x) === JSON.stringify(FULL)), JSON.stringify({ easy, med, hard }));

    const { run: r2 } = bootGame('easy'); W = JSON.parse(r2('JSON.stringify(DIFF_WEIGHT)')); Math.random = realRandom;
    const at = (d) => JSON.parse(r2(`JSON.stringify([2,3,4,5,6,7,8,9].map(l=>levelScoreAt(l,'${d}')))`));
    ck('S3 level thresholds: Easy the table x1.5 (3750 9000 15000 22500 31500 42000 54000 67500), Medium x1, Hard x0.55 (1375 3300 ... 24750)',
      JSON.stringify(at('easy')) === '[3750,9000,15000,22500,31500,42000,54000,67500]' && JSON.stringify(at('medium')) === '[2500,6000,10000,15000,21000,28000,36000,45000]' && JSON.stringify(at('hard')) === '[1375,3300,5500,8250,11550,15400,19800,24750]', JSON.stringify([at('easy'), at('hard')]));

    const w = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
    ck('S4 server: real Easy runs at their own level are accepted (3,750 at 2, 22,500 at 5, 67,500 at 9), and a capped 300,000 run at level 9 on every difficulty',
      (await submit(w, env, { score: 3750, level: 2, difficulty: 'easy' })) === 200 && (await submit(w, env, { score: 22500, level: 5, difficulty: 'easy' })) === 200 && (await submit(w, env, { score: 67500, level: 9, difficulty: 'easy' })) === 200
      && (await submit(w, env, { score: 300000, level: 9, difficulty: 'easy' })) === 200 && (await submit(w, env, { score: 300000, level: 9, difficulty: 'medium' })) === 200 && (await submit(w, env, { score: 300000, level: 9, difficulty: 'hard' })) === 200);
    ck('S4 server: nothing looser on Easy (22,500 at level 3 and 67,500 at level 7 refused)',
      (await submit(w, env, { score: 22500, level: 3, difficulty: 'easy' })) === 422 && (await submit(w, env, { score: 67500, level: 7, difficulty: 'easy' })) === 422);
    ck('S4 server: Medium as before (2,500 at 2 accepted, 26,423 at 4 refused) and the 455,000 ceiling kept on Easy',
      (await submit(w, env, { score: 2500, level: 2, difficulty: 'medium' })) === 200 && (await submit(w, env, { score: 26423, level: 4, difficulty: 'medium' })) === 422 &&
      (await submit(w, env, { score: 455001, level: 9, difficulty: 'easy' })) === 422 && /const SCORE_CEILING = 455_000;/.test(workerSrc) && /const MAX_SCORE = 5_000_000;/.test(workerSrc));

    // W1-W3: a fresh board. Real points: A Easy 100,000 (PH), B Medium 30,000 (PH), C Hard 5,000 (US),
    // D Easy 90,000 + Hard 2,000 (PH): D's best weighted is the Easy one (2,700 > 2,000).
    const w2 = makeEnv(workerMod.LeaderboardDO), lvl = (sc, d) => { let lv = 1; for (const t of [2500, 6000, 10000, 15000, 21000, 28000, 36000, 45000]) if (sc >= Math.round(t * { easy: 1.5, medium: 1, hard: 0.55 }[d])) lv++; return lv; };
    const put = (pid, name, country, score, difficulty) => submit(w, w2, { playerId: pid, name, country, score, difficulty, level: lvl(score, difficulty) });
    await put('w-a', 'ALPHA', 'PH', 100000, 'easy'); await put('w-b', 'BRAVO', 'PH', 30000, 'medium'); await put('w-c', 'CHARLIE', 'US', 5000, 'hard');
    await put('w-d', 'DELTA', 'PH', 90000, 'easy'); await put('w-d', 'DELTA', 'PH', 2000, 'hard');
    const be = await board(w, w2, '&difficulty=easy'), bm = await board(w, w2, '&difficulty=medium'), bh = await board(w, w2, '&difficulty=hard'), ba = await board(w, w2);
    const row = (b, n) => (b.top || []).find((r) => r.name === n) || {};
    ck('W1 the Easy, Medium and Hard boards show real points (Easy 100,000 / 90,000; Medium 30,000; Hard 5,000 / 2,000)',
      row(be, 'ALPHA').score === 100000 && row(be, 'DELTA').score === 90000 && row(bm, 'BRAVO').score === 30000 && row(bh, 'CHARLIE').score === 5000 && row(bh, 'DELTA').score === 2000 && !be.weighted,
      JSON.stringify([be.top, bh.top].map((t) => (t || []).map((r) => r.name + ':' + r.score))));
    const want = { BRAVO: Math.round(30000 * W.medium), CHARLIE: 5000, ALPHA: Math.round(100000 * W.easy), DELTA: Math.round(90000 * W.easy) };
    const order = (ba.top || []).map((r) => r.name + ':' + r.score + '/' + r.points + ':' + r.difficulty).join(' ');
    ck('W2 the ALL board ranks by each player\'s best weighted score and shows it (' + order + ')',
      ba.weighted === true && (ba.top || []).map((r) => r.name).join(',') === Object.entries(want).sort((a, b) => b[1] - a[1]).map((x) => x[0]).join(',') &&
      Object.entries(want).every(([n, v]) => row(ba, n).score === v) && row(ba, 'ALPHA').points === 100000 && row(ba, 'DELTA').difficulty === 'easy' && row(ba, 'DELTA').points === 90000, order);
    const ph = (ba.countries || []).find((c) => c.country === 'PH') || {}, us = (ba.countries || []).find((c) => c.country === 'US') || {};
    ck('W3 country totals add each player\'s best weighted score once (PH ' + ph.totalScore + ', US ' + us.totalScore + ')',
      ph.totalScore === want.ALPHA + want.BRAVO + want.DELTA && ph.playerCount === 3 && us.totalScore === 5000 && ph.topScore === Math.max(want.ALPHA, want.BRAVO, want.DELTA) && ph.topName === ['ALPHA', 'BRAVO', 'DELTA'].sort((x, y) => want[y] - want[x])[0]);
    // Totals stored before the weights (real points) are rebuilt when the board is read; stored scores stay real.
    const inst = w2._inst.get('global'); await inst.state.storage.put({ countries: { PH: { country: 'PH', totalScore: 220000, playerCount: 3, topScore: 100000, topName: 'ALPHA', leaderId: 'w-a' } }, countriesWeights: undefined }); inst.ready = false;   // as stored before the weights; the Durable Object restarts
    const again = await board(w, w2, '&restart=1');   /* FREE PLAN: a new board URL, so the Worker's 60 s leaderboard memo cannot answer for the restarted DO */ const ph2 = (again.countries || []).find((c) => c.country === 'PH') || {};
    const stored = await inst.state.storage.get('players');
    ck('W3 ...totals stored before the weights are rebuilt once when the server loads them, and stored scores are never rewritten',
      ph2.totalScore === ph.totalScore && stored['w-a'].bests.easy.score === 100000 && stored['w-d'].bests.hard.score === 2000, ph2.totalScore + ' vs ' + ph.totalScore);
    const wk = (workerSrc.match(/const DIFF_WEIGHT = (\{[^}]*\})/) || [])[1] || '';
    ck('W4 the game and the server use the same weights (Hard 1 > Medium > Easy); the game shows no All board and no WEIGHTED label',
      JSON.stringify(JSON.parse(wk.replace(/(\w+):/g, '"$1":'))) === JSON.stringify(W) && W.hard === 1 && W.medium < 1 && W.easy < W.medium &&
      !/ALL DIFFICULTIES/.test(gameHtml) && !/\(WEIGHTED\)|WEIGHTED:/.test(gameHtml), wk + ' vs ' + JSON.stringify(W));
    ck('W4 the submit response ranks a player on their own difficulty board (real points)', await (async () => {
      skew += 20000; const r = await w.fetch(new Request(ORIGIN + '/api/submit-score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: 'w-e', name: 'ECHO', country: 'PH', score: 95000, level: lvl(95000, 'easy'), difficulty: 'easy', season: 1 }) }), w2);
      const d = await r.json(); return d.rank === 2 && d.best === 95000; })());

    if (sim) {
      const res = await runParallel(gameHtml, PLAYERS.flatMap((player) => ['easy', 'medium', 'hard'].map((diff) => ({ diff, player, seeds: SEEDS }))));
      const meanOf = (player, diff) => { const r = res.find((x) => x.player === player && x.diff === diff).runs; return r.reduce((a, x) => a + x.score, 0) / r.length; };
      for (const p of PLAYERS) {
        const real = { easy: meanOf(p, 'easy'), medium: meanOf(p, 'medium'), hard: meanOf(p, 'hard') };
        const wt = { easy: Math.round(real.easy * W.easy), medium: Math.round(real.medium * W.medium), hard: Math.round(real.hard * W.hard) };
        ck('S5 ' + p + ': weighted mean Easy ' + wt.easy + ' < Medium ' + wt.medium + ' < Hard ' + wt.hard + ', each at most 90% of the next (real points ' + Math.round(real.easy) + ' / ' + Math.round(real.medium) + ' / ' + Math.round(real.hard) + '; ' + SEEDS + ' seeded runs each)',
          wt.easy <= wt.medium * 0.9 && wt.medium <= wt.hard * 0.9, (100 * wt.easy / wt.medium).toFixed(0) + '% / ' + (100 * wt.medium / wt.hard).toFixed(0) + '%');
      }
    }
  } catch (e) { ck('scoring section ran', false, String(e.stack || e).slice(0, 300)); }
  finally { Math.random = realRandom; }
  return { F, failed };
}

const real = await import(pathToFileURL(path.join(__dirname, 'FLUX-Sparta', 'worker.js')).href);
const main = await suite({ gameHtml: GAME_HTML, workerMod: real });

console.log('== negative controls: each part removed MUST be caught ==');
let NC = 0;
async function control(label, { expect, game = (s) => s, workerSrc = (s) => s }) {
  const g2 = game(GAME_HTML), w2 = workerSrc(WORKER_SRC);
  if (g2 === GAME_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.ncES-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ gameHtml: g2, workerMod: mod, workerSrc: w2, quiet: true, sim: expect === 'S5' });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('Easy weight as heavy as Medium', { expect: 'S5', game: rep('const DIFF_WEIGHT={easy:.09,', 'const DIFF_WEIGHT={easy:.21,') });
await control('no weights (all x1)', { expect: 'S5', game: rep('const DIFF_WEIGHT={easy:.09,medium:.21,hard:1};', 'const DIFF_WEIGHT={easy:1,medium:1,hard:1};') });
await control('Easy points cut again (x0.4)', { expect: 'S1', game: rep(' const points=Math.round((orbValue + combo*2)*(t.r>23?1.15:1)*(fluxMode>0?1.15:1));', " const points=Math.round((orbValue + combo*2)*(t.r>23?1.15:1)*(fluxMode>0?1.15:1)*(difficulty==='easy'?.4:1));") });
await control('FLUX MODE bonus scaled by difficulty', { expect: 'S1', game: rep('score+=250;', "score+=(difficulty==='hard'?250:100);") });
await control('Easy level thresholds back to the x0.3 table', { expect: 'S3', game: rep('const LEVEL_SCORE_MULT={easy:1.5,', 'const LEVEL_SCORE_MULT={easy:.3,') });
await control('server keeps the old Easy thresholds', { expect: 'S4', workerSrc: rep('const LEVEL_SCORE_MULT = { easy: 1.5,', 'const LEVEL_SCORE_MULT = { easy: 0.3,') });
await control('server loosened to two levels either side', { expect: 'S4', workerSrc: rep('const LEVEL_TOLERANCE = 1;', 'const LEVEL_TOLERANCE = 2;') });
await control('difficulty boards weighted too', { expect: 'W1', workerSrc: rep('rows.push({ r, score: difficulty ? b.score : b.weighted,', 'rows.push({ r, score: difficulty ? weightedScore(b.score, difficulty) : b.weighted,') });
await control('ALL board by real points again', { expect: 'W2', workerSrc: rep('const b = difficulty ? ownGet(r.bests, difficulty) : weightedBestOf(r, weights);', 'const b = difficulty ? ownGet(r.bests, difficulty) : bestOf(r);') });   // COMBINED WORLD GRID: board rows now built by boardRows()
await control('country totals from real points', { expect: 'W3', workerSrc: rep('    c.totalScore += x.score;', '    c.totalScore += x.points;') });   // COMBINED WORLD GRID: country totals now built by countryTotals()
await control('stale country totals never rebuilt', { expect: 'W3', workerSrc: rep('      if ((await this.state.storage.get("countriesWeights")) !== JSON.stringify(DIFF_WEIGHT)) await this.recomputeCountries();', '') });
await control('server weights differ from the game', { expect: 'W4', workerSrc: rep('const DIFF_WEIGHT = { easy: 0.09, medium: 0.21, hard: 1 };', 'const DIFF_WEIGHT = { easy: 0.1, medium: 0.21, hard: 1 };') });
await control('the weighted All board comes back', { expect: 'W4', game: rep("function fluxBoardHtml(v){\n", "function fluxBoardHtml(v){\n  if(v.weighted) return '<div class=\"lbSectionLabel\">ALL DIFFICULTIES \u00b7 WEIGHTED: HARD x1</div>';\n") });
const total = main.F + NC;
console.log('\n' + (total ? 'SCORING FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'SCORING PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
