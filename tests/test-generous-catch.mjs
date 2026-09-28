// Generous catch (new players only), in the release gate. Real game page in the harness vm.
//   G1 it is on only in a player's first 3 runs, on every difficulty (Easy too);
//   G2 when on, a ball arriving up to 8px beyond the launcher's end is caught;
//      when off, the same ball is missed;
//   G3 a margin catch is never a perfect catch and adds nothing: no points, no
//      FLUX meter, no orb value (owner, TIME SPEED update);
//   G4 when off (4th run on) the game is EXACTLY the same as without the
//      feature (seeded play, frame by frame);
//   G5 a simulated new beginner in a first run (Easy and Medium) keeps the ball
//      longer with it than without (more play before the run ends);
//   G6 it never changes speed: the first-run slow start is gone (speed help 1).
// (The old G7 -- level 2 in 2 of 3 first Easy runs -- measured the removed
// first-run slow start with the old score thresholds; the Easy target is now
// measured in the PR's simulation table.)
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WITHOUT = (h) => h.replace(/\nconst CATCH_MARGIN_PX=8, CATCH_FIRST_RUNS=3;[\s\S]*?\n\}\)\(\);\n/, '\nfunction catchMargin(){ return 0; }\nfunction clampCatchHit(h){ return h; }\n');

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const bootGame = (html, runs, diff = 'medium', seed) => { if (seed) Math.random = seeded(seed); const { store } = makeStore({ fluxPlayerId: 'gc-1', fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: String(runs), fluxDifficulty: diff });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store }); return { g, run: (c) => vm.runInContext(c, g.ctx) }; };
  try {
    const on = (runs, diff) => { const { g, run } = bootGame(gameHtml, runs, diff); g.ctx.newGame(); return run('catchMargin()'); };
    const states = [[0, 'medium'], [1, 'medium'], [2, 'hard'], [3, 'medium'], [7, 'medium'], [0, 'easy']].map(([r, d]) => on(r, d));
    ck('G1 on only in the first 3 runs, on every difficulty including Easy', states.join(',') === '8,8,8,0,0,8', states.join(','));
    // G2/G3: ball falling onto the launcher's right end, 6px beyond it.
    const drop = (runs) => { const { g, run } = bootGame(gameHtml, runs); g.ctx.newGame();
      run('playing=true; targets=[]; combo=1; paddle.x=W/2; ball.vx=0; ball.vy=6; ball.x=paddle.x+paddle.w/2+ball.r+6; ball.y=paddle.y-paddle.h/2-ball.r-2;');
      const s0 = run('score'), m0 = run('misses'); for (let i = 0; i < 40; i++) { g.ctx.update(1 / 60); if (run('ball.vy') < 0 || run('misses') !== m0) break; }   // stop at the catch (or the miss)
      return { caught: run('ball.vy') < 0 && run('misses') === m0, points: run('score') - s0, flux: run('flux'), vy: run('ball.vy'), perfectText: run("texts.some(t=>/PERFECT/.test(t.s))"), orbValue: run('orbValue') }; };
    const a = drop(0), b = drop(5);
    ck('G2 when on, a ball 6px beyond the launcher end is caught; when off, it is missed', a.caught && a.vy < 0 && !b.caught, JSON.stringify([a.caught, b.caught]));
    ck('G3 a margin catch is never perfect and adds nothing (no points, no FLUX meter, no orb value)', a.caught && !a.perfectText && a.points === 0 && a.flux === 0 && a.orbValue === 20, 'points ' + a.points + ', flux ' + a.flux + ', perfect ' + a.perfectText);
    // G4: off -> exactly the same as without the feature.
    const trace = (html, runs, diff) => { const { g, run } = bootGame(html, runs, diff, 4); g.ctx.newGame(); const out = [];
      for (let f = 0; f < 9000; f++) { if (f % 2000 === 1999) run('ball.y=H+200; misses=0;'); else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x+Math.sin(' + f + '*.03)*55));'); run('if(!playing){playing=true;paused=false;}'); g.ctx.update(1 / 60);
        if (f % 15 === 0) out.push(run('JSON.stringify([ball.x,ball.y,ball.vx,ball.vy,score,level,combo,targets.map(t=>[t.x,t.y,t.color])])')); }
      Math.random = realRandom; return out; };
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const off4 = trace(gameHtml, 3, 'medium'), ref4 = trace(WITHOUT(gameHtml), 3, 'medium'), offE = trace(gameHtml, 5, 'easy'), refE = trace(WITHOUT(gameHtml), 5, 'easy');
    ck('G4 when off (4th run on, any difficulty) the game is exactly the same as without it (seeded, 9,000 frames each)', WITHOUT(gameHtml) !== gameHtml && same(off4, ref4) && same(offE, refE), [same(off4, ref4), same(offE, refE)].join(','));
    // G5: simulated new beginner (reacts in 200 ms, aim +-18 px, finger 900 px/s), first run vs a 4th run (same seeds).
    const beginner = (html, runs, seed, diff) => { const { g, run } = bootGame(html, runs, diff, seed); g.ctx.newGame();
      run(`var __h=[],__e=0,__t=0,__q=${seed * 7 + 1},__f=0; function __r(){__q=(__q*1103515245+12345)%2147483648;return __q/2147483648;} function __g(){let u=0,v=0;while(!u)u=__r();while(!v)v=__r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
        var __rev=false; playing=true; paused=false;
        for(let i=0;i<21600;i++){ if(!playing&&!paused)break; if(paused&&__rev&&!playing)break; __h.push(ball.x); if(__h.length>12)__h.shift(); __t-=1/60; if(__t<=0){__e=__g()*18;__t=.5;}
          paddle.x+=Math.max(-15,Math.min(15,__h[0]+__e-paddle.x)); setPaddle(paddle.x); update(1/60); __f++;
          if(paused&&!__rev&&document.getElementById('reviveWatchBtn')){__rev=true;const b=document.getElementById('reviveWatchBtn'); if(b.onclick)b.onclick();} }`);
      const r = run('__f') / 60; Math.random = realRandom; return r; };
    const g5 = [];
    for (const d of ['easy', 'medium']) { let withC = 0, without = 0; for (let s = 1; s <= 20; s++) { withC += beginner(gameHtml, 0, s, d); without += beginner(gameHtml, 3, s, d); } g5.push({ d, withC: withC / 20, without: without / 20 }); }
    ck('G5 a simulated new beginner keeps the ball longer in a first run with it (' + g5.map((x) => x.d + ' ' + x.withC.toFixed(0) + ' s vs ' + x.without.toFixed(0) + ' s').join(', ') + ')', g5.every((x) => x.withC > x.without));
    // G6: it never changes speed (the first-run slow start is gone).
    { const f0 = bootGame(gameHtml, 0), f5 = bootGame(gameHtml, 5); f0.g.ctx.newGame(); f5.g.ctx.newGame();
      ck('G6 it never changes speed: a first run and a 6th run have the same speed limit and no speed help', f0.run('speedHelp()') === 1 && f0.run('normalMaxSpeed()') === f5.run('normalMaxSpeed()') && !/FIRST_RUN_SLOW|firstRunSlowOn/.test(gameHtml)); }
  } catch (e) { ck('generous catch section ran', false, String(e.stack || e).slice(0, 300)); }
  finally { Math.random = realRandom; }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each safeguard removed MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('on for every run', 'G1', rep('function generousCatchFor(runsDone){ return runsDone<CATCH_FIRST_RUNS; }', 'function generousCatchFor(runsDone){ return true; }'));
control('off on Easy again', 'G1', rep('    generousCatchOn=generousCatchFor(runsDone);', "    generousCatchOn=generousCatchFor(runsDone) && difficulty!=='easy';"));
control('margin catch counted as perfect', 'G3', rep('   const perfect=!marginCatch && Math.abs(hit)<.14;', '   const perfect=marginCatch || Math.abs(hit)<.14;'));
control('margin catch pays like an ordinary catch (+2)', 'G3', rep('const paddlePoints=marginCatch?0:', 'const paddlePoints=marginCatch?2:'));
control('margin catch fills the FLUX meter', 'G3', rep('   if(!marginCatch) addFlux(3+Math.min(5,combo));', '   addFlux(3+Math.min(5,combo));'));
control('bounces changed a little when off (changes the game)', 'G4', rep('function clampCatchHit(h){ if(!generousCatchOn) return h;', 'function clampCatchHit(h){ if(!generousCatchOn) return h*1.001;'));
control('no margin at all', 'G2', rep('const CATCH_MARGIN_PX=8,', 'const CATCH_MARGIN_PX=0,'));
control('first-run slow start back', 'G6', rep('SPEED_HELPS.push(recoverFactor);', "SPEED_HELPS.push(recoverFactor); SPEED_HELPS.push(function(){ try{ return (+localStorage.getItem('fluxRunsPlayed')||0)===0?.92:1; }catch(e){ return 1; } });"));
const total = main.F + NC;
console.log('\n' + (total ? 'GENEROUS CATCH FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'GENEROUS CATCH PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
