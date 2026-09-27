// Easy scoring, in the release gate. Real game page (harness vm) + real worker.js.
// The leaderboard keeps each player's best across difficulties, so Easy must
// never pay better than Medium or Hard for the same player.
//   S1 on Easy every scoring event pays EASY_POINTS (x0.4, rounded, at least 1):
//      orb hit, danger orb, bonus orb, overload orb, FLUX MODE, paddle catch;
//   S2 the Easy factor never applies on Medium or Hard: Hard points are
//      unchanged, Medium points are only Medium's own x0.85 (MEDIUM_POINTS,
//      test-medium-orbs.mjs), never x0.4;
//   S3 Easy's level thresholds are scaled by the same x0.4, so Easy levels
//      come at the same pace as before (750 1800 3000 ... 13500);
//   S4 the server uses the same Easy thresholds: a real Easy run is accepted,
//      nothing looser (two levels off is refused), 455,000 ceiling kept;
//   S5 the same simulated player (new beginner, steady player; seeded) scores
//      clearly less on Easy than on Medium and on Hard (mean at most 85%).
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
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
  return { ADMIN_TOKEN: 't', STORE_OPEN: 'false', SITE_URL: ORIGIN,
    LEADERBOARD_DO: { idFromName: (n) => n, get(id) { if (!inst.has(id)) inst.set(id, new DO(new St())); const o = inst.get(id);
      return { fetch(u, i) { const r = () => o.fetch(new Request(u, i)); const p = chain.then(r, r); chain = p.then(() => {}, () => {}); return p; } }; } } };
}
let pidN = 0;
const submit = async (w, env, body) => { skew += 20000;
  const r = await w.fetch(new Request(ORIGIN + '/api/submit-score', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'es-' + (++pidN), name: 'T', country: 'US', season: 1, ...body }) }), env);   // SEASON 1: scores say their season
  return r.status; };

// Simulated player (same model as the PR's measurements and test-generous-catch.mjs):
// follows the ball with a delay and a random aim error; 4th+ run; one free revive.
const PLAYERS = [['new beginner', 12, 18, 15], ['steady player', 6, 9, 28]];
// 40 seeds (was 10): with Medium's fuller field and x0.85 points, 10 runs were too few to tell
// Easy from Medium reliably (240 seeded runs: Easy is 66-74% of Medium); the 85% bar is unchanged.
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
  try {
    const { run } = bootGame('easy');
    const EP = run('EASY_POINTS'); Math.random = realRandom;
    const med = events('medium'), hard = events('hard'), easy = events('easy');
    // Values before Easy scoring (combo 3 -> 4 on an orb hit; orb value 30).
    const OLD = { medium: { orb: 38, danger: 53, bonus: 150, overload: 245, flux: 250, perfect: 15, catch: 2 },
      hard: { orb: 38, danger: 53, bonus: 150, overload: 245, flux: 250, perfect: 20, catch: 2 },
      easy: { orb: 38, danger: 53, bonus: 150, overload: 245, flux: 250, perfect: 11, catch: 2 } };
    const want = {}; for (const k in OLD.easy) want[k] = Math.max(1, Math.round(OLD.easy[k] * 0.4));
    want.danger = Math.round(38 * 0.4) + Math.round(15 * 0.4);
    ck('S1 EASY_POINTS is 0.4', EP === 0.4, EP);
    ck('S1 on Easy every scoring event pays x0.4 (orb, danger, bonus, overload, FLUX MODE, perfect and plain catch)', JSON.stringify(easy) === JSON.stringify(want), JSON.stringify(easy) + ' want ' + JSON.stringify(want));
    // Medium: Medium's own MEDIUM_POINTS (x0.85: orb, danger, bonus, overload, perfect catch; FLUX MODE and a plain catch unscaled), never Easy's x0.4.
    const wantMed = { ...OLD.medium }; for (const k of ['orb', 'bonus', 'overload', 'perfect']) wantMed[k] = Math.round(OLD.medium[k] * 0.85);
    wantMed.danger = Math.round(38 * 0.85) + Math.round(15 * 0.85);
    ck('S2 Medium points are only Medium\'s own x0.85 (no Easy x0.4)', JSON.stringify(med) === JSON.stringify(wantMed), JSON.stringify(med) + ' want ' + JSON.stringify(wantMed));
    ck('S2 Hard points unchanged', JSON.stringify(hard) === JSON.stringify(OLD.hard), JSON.stringify(hard));

    const { run: r2 } = bootGame('easy'); Math.random = realRandom;
    const at = (d) => JSON.parse(r2(`JSON.stringify([2,3,4,5,6,7,8,9].map(l=>levelScoreAt(l,'${d}')))`));
    const OLD_EASY = [1875, 4500, 7500, 11250, 15750, 21000, 27000, 33750];
    ck('S3 Easy level thresholds are the old ones x0.4 (750 1800 3000 4500 6300 8400 10800 13500): same level pace', JSON.stringify(at('easy')) === JSON.stringify(OLD_EASY.map((t) => Math.round(t * 0.4))), JSON.stringify(at('easy')));
    ck('S3 Medium and Hard thresholds unchanged', JSON.stringify(at('medium')) === '[2500,6000,10000,15000,21000,28000,36000,45000]' && JSON.stringify(at('hard')) === '[3375,8100,13500,20250,28350,37800,48600,60750]');

    const w = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
    ck('S4 server: real Easy runs at their own level are accepted (750 at 2, 4,500 at 5, 13,500 at 9)',
      (await submit(w, env, { score: 750, level: 2, difficulty: 'easy' })) === 200 && (await submit(w, env, { score: 4500, level: 5, difficulty: 'easy' })) === 200 && (await submit(w, env, { score: 13500, level: 9, difficulty: 'easy' })) === 200);
    ck('S4 server: nothing looser on Easy (4,500 at level 3 and 13,500 at level 7 refused)',
      (await submit(w, env, { score: 4500, level: 3, difficulty: 'easy' })) === 422 && (await submit(w, env, { score: 13500, level: 7, difficulty: 'easy' })) === 422);
    ck('S4 server: Medium unchanged (2,500 at 2 accepted, 26,423 at 4 refused) and the 455,000 ceiling kept on Easy',
      (await submit(w, env, { score: 2500, level: 2, difficulty: 'medium' })) === 200 && (await submit(w, env, { score: 26423, level: 4, difficulty: 'medium' })) === 422 &&
      (await submit(w, env, { score: 455001, level: 9, difficulty: 'easy' })) === 422 && /const SCORE_CEILING = 455_000;/.test(workerSrc));

    if (sim) {
      const html = scriptsOf(gameHtml);
      const play = (diff, seed, [, react, aim, px]) => {
        Math.random = seeded(seed);
        const { store } = makeStore({ fluxPlayerId: 'sim-' + seed, fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: '5', fluxDifficulty: diff });
        const g = boot(html, { origin: 'https://x.test', path: '/play/', store });
        const rr = (c) => vm.runInContext(c, g.ctx);
        g.ctx.newGame();
        rr(`var __h=[],__e=0,__t=0,__q=${seed * 7 + 1},__sc=0; function __r(){__q=(__q*1103515245+12345)%2147483648;return __q/2147483648;} function __g(){let u=0,v=0;while(!u)u=__r();while(!v)v=__r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
          var __rev=false; playing=true; paused=false;
          for(let i=0;i<108000;i++){ if(!playing&&!paused)break; if(paused&&__rev&&!playing)break; __h.push(ball.x); if(__h.length>${react})__h.shift(); __t-=1/60; if(__t<=0){__e=__g()*${aim};__t=.5;}
            paddle.x+=Math.max(-${px},Math.min(${px},__h[0]+__e-paddle.x)); setPaddle(paddle.x); update(1/60); __sc=Math.max(__sc,score);
            if(paused&&!__rev&&document.getElementById('reviveWatchBtn')){__rev=true;const b=document.getElementById('reviveWatchBtn'); if(b.onclick)b.onclick();} }`);
        const s = rr('__sc'); Math.random = realRandom; return s;
      };
      for (const p of PLAYERS) {
        const mean = {};
        for (const d of ['easy', 'medium', 'hard']) { let t = 0; for (let s = 1; s <= SEEDS; s++) t += play(d, s, p); mean[d] = Math.round(t / SEEDS); }
        const low = Math.min(mean.medium, mean.hard);
        ck('S5 ' + p[0] + ': Easy mean score is at most 85% of Medium and of Hard (Easy ' + mean.easy + ', Medium ' + mean.medium + ', Hard ' + mean.hard + '; ' + SEEDS + ' seeded runs each)',
          mean.easy <= low * 0.85, (100 * mean.easy / low).toFixed(0) + '%');
      }
    }
  } catch (e) { ck('easy scoring section ran', false, String(e.stack || e).slice(0, 300)); }
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
await control('Easy pays full points again (old scoring)', { expect: 'S5', game: rep('const EASY_POINTS=.4;', 'const EASY_POINTS=1;') });
await control('Easy points cut too little (x0.75)', { expect: 'S1', game: rep('const EASY_POINTS=.4;', 'const EASY_POINTS=.75;') });
await control('bonus orb not scaled on Easy', { expect: 'S1', game: rep(' const points=mediumPoints(scorePoints(Math.round(120+combo*10+(fluxMode>0?60:0))));', ' const points=mediumPoints(Math.round(120+combo*10+(fluxMode>0?60:0)));') });
await control('FLUX MODE bonus not scaled on Easy', { expect: 'S1', game: rep('score+=scorePoints(250);', 'score+=250;') });
await control('Easy scaling applied to Medium too', { expect: 'S2', game: rep("function scorePoints(n){ return difficulty==='easy' ?", "function scorePoints(n){ return difficulty!=='hard' ?") });
await control('Easy level thresholds not scaled (Easy levels 2.5x slower)', { expect: 'S3', game: rep('const LEVEL_SCORE_MULT={easy:.3,', 'const LEVEL_SCORE_MULT={easy:.75,') });
await control('server keeps the old Easy thresholds', { expect: 'S4', workerSrc: rep('const LEVEL_SCORE_MULT = { easy: 0.3,', 'const LEVEL_SCORE_MULT = { easy: 0.75,') });
await control('server loosened to two levels either side', { expect: 'S4', workerSrc: rep('const LEVEL_TOLERANCE = 1;', 'const LEVEL_TOLERANCE = 2;') });
const total = main.F + NC;
console.log('\n' + (total ? 'EASY SCORING FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'EASY SCORING PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
