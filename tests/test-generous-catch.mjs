// Generous catch (new players only), in the release gate. Real game page in the harness vm.
//   G1 it is on only in a player's first 3 runs, on every difficulty (Easy too);
//   G2 when on, a ball arriving up to 8px beyond the launcher's end is caught;
//      when off, the same ball is missed;
//   G3 a margin catch is never a perfect catch and scores like an ordinary catch;
//   G4 when off (4th run on) the game is EXACTLY the same as without the
//      feature (seeded play, frame by frame);
//   G5 a simulated beginner (first run, Medium) reaches the first level-up more
//      often with it than without (numbers printed; see the PR for the full table);
//   G6 FIRST-RUN HELP: in the very first run only, the ball cruises 8% slower
//      (shared SPEED HELP hook); speed kicks after a fusion are left as normal;
//   G7 target: a typical new beginner on Easy (the default for new pilots)
//      reaches level 2 in about 2 of 3 first runs.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WITHOUT = (h) => h.replace(/\n\/\* GENEROUS CATCH \(new players only\)[\s\S]*?\n\}\)\(\);\n/, '\nfunction catchMargin(){ return 0; }\nfunction clampCatchHit(h){ return h; }\n');

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
      return { caught: run('score') > s0 && run('misses') === m0, points: run('score') - s0, vy: run('ball.vy'), perfectText: run("texts.some(t=>/PERFECT/.test(t.s))"), orbValue: run('orbValue') }; };
    const a = drop(0), b = drop(5);
    ck('G2 when on, a ball 6px beyond the launcher end is caught; when off, it is missed', a.caught && a.vy < 0 && !b.caught, JSON.stringify([a.caught, b.caught]));
    ck('G3 a margin catch is never perfect and scores like an ordinary catch (+2)', !a.perfectText && a.points === 2 && a.orbValue === 20, 'points ' + a.points + ', perfect ' + a.perfectText);
    // G4: off -> exactly the same as without the feature.
    const trace = (html, runs, diff) => { const { g, run } = bootGame(html, runs, diff, 4); g.ctx.newGame(); const out = [];
      for (let f = 0; f < 9000; f++) { if (f % 2000 === 1999) run('ball.y=H+200; misses=0;'); else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x+Math.sin(' + f + '*.03)*55));'); run('if(!playing){playing=true;paused=false;}'); g.ctx.update(1 / 60);
        if (f % 15 === 0) out.push(run('JSON.stringify([ball.x,ball.y,ball.vx,ball.vy,score,level,combo,targets.map(t=>[t.x,t.y,t.color])])')); }
      Math.random = realRandom; return out; };
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const off4 = trace(gameHtml, 3, 'medium'), ref4 = trace(WITHOUT(gameHtml), 3, 'medium'), offE = trace(gameHtml, 5, 'easy'), refE = trace(WITHOUT(gameHtml), 5, 'easy');
    ck('G4 when off (4th run on, any difficulty) the game is exactly the same as without it (seeded, 9,000 frames each)', WITHOUT(gameHtml) !== gameHtml && same(off4, ref4) && same(offE, refE), [same(off4, ref4), same(offE, refE)].join(','));
    // G5: simulated beginner, first run, Medium.
    const beginner = (html, runs, seed, diff = 'medium', react = 9, aim = 14, px = 20) => { const { g, run } = bootGame(html, runs, diff, seed); g.ctx.newGame();
      run(`var __h=[],__e=0,__t=0,__q=${seed * 7 + 1}; function __r(){__q=(__q*1103515245+12345)%2147483648;return __q/2147483648;} function __g(){let u=0,v=0;while(!u)u=__r();while(!v)v=__r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
        var __rev=false, __lv2=false; playing=true; paused=false;
        for(let i=0;i<21600;i++){ if(!playing&&!paused)break; if(paused&&__rev&&!playing)break; __h.push(ball.x); if(__h.length>${react})__h.shift(); __t-=1/60; if(__t<=0){__e=__g()*${aim};__t=.5;}
          paddle.x+=Math.max(-${px},Math.min(${px},__h[0]+__e-paddle.x)); setPaddle(paddle.x); update(1/60); if(level>=2)__lv2=true;
          if(paused&&!__rev&&document.getElementById('reviveWatchBtn')){__rev=true;const b=document.getElementById('reviveWatchBtn'); if(b.onclick)b.onclick();} }`);
      const r = run('__lv2'); Math.random = realRandom; return r; };
    let withC = 0, without = 0; for (let s = 1; s <= 60; s++) { if (beginner(gameHtml, 0, s)) withC++; if (beginner(gameHtml, 3, s)) without++; }
    ck('G5 a simulated casual beginner reaches the first level-up more often in a first run with it (' + withC + '/60) than without (' + without + '/60)', withC > without, withC + ' vs ' + without);
    // G6: first-run help.
    { const f0 = bootGame(gameHtml, 0), f1 = bootGame(gameHtml, 1); f0.g.ctx.newGame(); f1.g.ctx.newGame();
      const k0 = f0.run('speedHelp()'), k1 = f1.run('speedHelp()');
      const cruise = (b) => { b.run('playing=true; targets=[]; ball.x=W/2; ball.y=H*.4; ball.vx=normalMaxSpeed(); ball.vy=0;'); for (let i = 0; i < 120; i++) { b.run('targets=[]; ball.vy=0; ball.y=H*.4;'); b.g.ctx.update(1 / 60); } return b.run('Math.hypot(ball.vx,ball.vy)/normalMaxSpeed()'); };
      const c0 = cruise(f0), c1 = cruise(f1);
      f0.run('ball.vx=normalMaxSpeed()*1.3; ball.vy=0; ball.y=H*.4; targets=[];'); f0.g.ctx.update(1 / 60); const kick = f0.run('Math.hypot(ball.vx,ball.vy)/normalMaxSpeed()');
      ck('G6 first run only: the ball cruises 8% slower (92%); from the second run it is back to 100%; fusion speed kicks are left as normal',
        Math.abs(k0 - .92) < 1e-9 && k1 === 1 && Math.abs(c0 - .92) < .005 && Math.abs(c1 - 1) < .005 && Math.abs(kick - 1.3) < 1e-9, [k0, k1, c0.toFixed(3), c1.toFixed(3), kick.toFixed(3)].join(' ')); }
    // G7: the owner's target, with the "new beginner" model (reacts in 200 ms, aim +-18 px, finger 900 px/s) on Easy.
    let hit = 0, base = 0; for (let s = 1; s <= 60; s++) { if (beginner(gameHtml, 0, s, 'easy', 12, 18, 15)) hit++; if (beginner(gameHtml, 5, s, 'easy', 12, 18, 15)) base++; }
    ck('G7 a typical new beginner on Easy reaches level 2 in about 2 of 3 first runs (' + hit + '/60 = ' + Math.round(100 * hit / 60) + '%; without help ' + base + '/60)', hit >= 36 && hit > base, hit + ' vs ' + base);
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
control('on for every run', 'G1', rep('function generousCatchFor(runsDone,diff){ return runsDone<CATCH_FIRST_RUNS; }', 'function generousCatchFor(runsDone,diff){ return true; }'));
control('off on Easy again', 'G1', rep('function generousCatchFor(runsDone,diff){ return runsDone<CATCH_FIRST_RUNS; }', "function generousCatchFor(runsDone,diff){ return runsDone<CATCH_FIRST_RUNS && diff!=='easy'; }"));
control('first run not slowed', 'G6', rep('const FIRST_RUN_SLOW=.08;', 'const FIRST_RUN_SLOW=0;'));
control('slowed in every run', 'G6', rep('    firstRunSlowOn=runsDone===0;', '    firstRunSlowOn=true;'));
control('fusion speed kicks removed by the help', 'G6', rep('if(sp>lim && sp<=n+1e-9){', 'if(sp>lim){'));
control('help too weak for the target', 'G7', rep('const FIRST_RUN_SLOW=.08;', 'const FIRST_RUN_SLOW=.01;'));
control('margin catch counted as perfect', 'G3', rep('   const perfect=Math.abs(hit)<.14;', '   const perfect=Math.abs(hit)<.14 || Math.abs((ball.x-paddle.x)/(paddle.w/2))>1+ball.r/(paddle.w/2);'));
control('bounces changed a little when off (changes the game)', 'G4', rep('function clampCatchHit(h){ if(!generousCatchOn) return h;', 'function clampCatchHit(h){ if(!generousCatchOn) return h*1.001;'));
control('no margin at all', 'G2', rep('const CATCH_MARGIN_PX=8,', 'const CATCH_MARGIN_PX=0,'));
const total = main.F + NC;
console.log('\n' + (total ? 'GENEROUS CATCH FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'GENEROUS CATCH PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
