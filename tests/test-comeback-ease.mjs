// Comeback ease, in the release gate. Real game page in the harness vm.
//   E1 two misses within 20 s of play start the ease (6 s); one miss, or two
//      misses 25 s apart, do not;
//   E2 during the ease the ball covers 15% less distance per frame, and it is
//      back to full speed after ~6 s;
//   E3 the ball is never faster than the normal speed limit, during or after;
//   E4 the relaunch after a miss keeps its normal speed;
//   E5 when the ease is not active the game is EXACTLY the same (seeded play
//      with misses 25 s apart matches a build without the ease, frame by frame);
//   E6 it never touches scoring: no score, points, combo or lives code in it.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WITHOUT_EASE = (h) => h.replace(/\n\/\* COMEBACK EASE\.[\s\S]*?\n\}\)\(\);\n/, '\nfunction easeFactor(){ return 1; }\n').replace('normalMaxSpeed()*easeFactor();   // x1 unless the comeback ease is on', 'normalMaxSpeed();');

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const bootGame = (html) => { const { store } = makeStore({ fluxPlayerId: 'ce-1', fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1' });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store }); return { g, run: (c) => vm.runInContext(c, g.ctx) }; };
  try {
    // Play in open field: no orbs, the launcher follows the ball (so no accidental misses).
    const step = (run, g, secs, each) => { for (let i = 0; i < Math.round(secs * 60); i++) { run('if(!playing){playing=true;paused=false;} targets=[]; paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x));'); g.ctx.update(1 / 60); if (each) each(i); } };
    const miss = (run, g) => { run('ball.y=H+200;'); g.ctx.update(1 / 60); };
    { const { g, run } = bootGame(gameHtml); g.ctx.newGame(); run('playing=true;');
      step(run, g, 3); miss(run, g); const one = run('easeLeft');
      step(run, g, 5); const before = run('Math.hypot(ball.vx,ball.vy)'), normalLim = run('normalMaxSpeed()');
      miss(run, g); const two = run('easeLeft');
      const b2 = bootGame(gameHtml); b2.g.ctx.newGame(); b2.run('playing=true;'); step(b2.run, b2.g, 1); miss(b2.run, b2.g); step(b2.run, b2.g, 25); miss(b2.run, b2.g);
      ck('E1 two misses within 20 s start a 6 s ease; one miss, or misses 25 s apart, do not', one === 0 && two > 5.9 && two <= 6 && b2.run('easeLeft') === 0, [one, two.toFixed(2), b2.run('easeLeft')].join(' / '));
      // E2/E3: speed during the ease (after it settles) and after it.
      let maxDuring = 0, sumDuring = 0, nDuring = 0;
      step(run, g, 5, (i) => { if (i >= 60) { const sp = run('Math.hypot(ball.vx,ball.vy)'); maxDuring = Math.max(maxDuring, sp); sumDuring += sp; nDuring++; } });
      step(run, g, 2.5); const after = run('Math.hypot(ball.vx,ball.vy)');
      ck('E2 during the ease the ball runs at 85% of its top speed; afterwards it is back to full speed', Math.abs(sumDuring / nDuring / normalLim - .85) < .01 && Math.abs(after / normalLim - 1) < .01 && run('easeLeft') === 0,
        'during ' + (sumDuring / nDuring / normalLim).toFixed(3) + ', after ' + (after / normalLim).toFixed(3) + ' (full speed before: ' + (before / normalLim).toFixed(3) + ')');
      // A ball already at full speed when the ease starts is brought down to the eased limit within a second.
      step(run, g, 2); const full = run('Math.hypot(ball.vx,ball.vy)'); run('easeLeft=6;'); step(run, g, 1); const settled = run('Math.hypot(ball.vx,ball.vy)');
      ck('E3 the ease only slows: during it the ball never goes above the eased limit (a full-speed ball is brought down within 1 s)', maxDuring <= normalLim * .85 + 1e-9 && full > normalLim * .99 && settled <= normalLim * .85 + 1e-9, (maxDuring / normalLim).toFixed(4) + ', ' + (full / normalLim).toFixed(3) + ' -> ' + (settled / normalLim).toFixed(3));
      // E4: relaunch after a miss during the ease keeps its normal speed.
      run('easeLeft=6; level=3; speedLevel=3;'); miss(run, g);
      const vy = run('ball.vy'), want = run('-Math.max(6.2,6.0+level*.15)*DIFFICULTY[difficulty].speed');
      ck('E4 the relaunch after a miss keeps its normal speed', Math.abs(vy - want) < 1e-9, vy.toFixed(3) + ' vs ' + want.toFixed(3)); }
    // E5: misses 25 s apart -> identical to a build without the ease.
    const trace = (html) => { Math.random = seeded(3); const { g, run } = bootGame(html); g.ctx.newGame(); const out = [];
      for (let f = 0; f < 9000; f++) { if (f % 1500 === 1499) run('ball.y=H+200; misses=0;'); else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x));'); run('if(!playing){playing=true;paused=false;}'); g.ctx.update(1 / 60);
        if (f % 15 === 0) out.push(run('JSON.stringify([ball.x,ball.y,ball.vx,ball.vy,score,level,combo,targets.map(t=>[t.x,t.y,t.color])])')); }
      Math.random = realRandom; return out; };
    const a = trace(gameHtml), b = trace(WITHOUT_EASE(gameHtml));
    ck('E5 when the ease is not active, the game is exactly the same (seeded, misses 25 s apart, 9,000 frames)', WITHOUT_EASE(gameHtml) !== gameHtml && a.length === b.length && a.every((x, i) => x === b[i]));
    const block = (gameHtml.match(/\/\* COMEBACK EASE\.[\s\S]*?\n\}\)\(\);\n/) || [''])[0].replace(/\/\*[\s\S]*?\*\//g, '');
    ck('E6 it never touches scoring: no score, points, combo, lives or orb code in it', block.length > 0 && !/\bscore\b|points|combo|misses|orbValue|targets|revive/.test(block));
  } catch (e) { ck('ease section ran', false, String(e.stack || e).slice(0, 300)); }
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
control('eases after any single miss', 'E1', rep('if(easeClock-easeLastMiss<=EASE_WINDOW_S) easeLeft=EASE_TIME_S;', 'easeLeft=EASE_TIME_S;'));
control('no time window (misses minutes apart count)', 'E1', rep('const EASE_WINDOW_S=20,', 'const EASE_WINDOW_S=1e9,'));
control('slows 40% instead of 15%', 'E2', rep('EASE_SLOW=.15;', 'EASE_SLOW=.4;'));
control('ease never ends', 'E2', rep('    easeLeft=Math.max(0,easeLeft-dt);\n', ''));
control('fast ball not slowed down to the eased limit', 'E3', rep('      if(sp>lim){ const nsp=Math.max(lim,sp-normalMaxSpeed()*2.2*dt); ball.vx*=nsp/sp; ball.vy*=nsp/sp; }\n', ''));
control('relaunch slowed by the ease', 'E4', rep('    easeLeft=Math.max(0,easeLeft-dt);\n    return r;', '    if(ball && easeLeft===EASE_TIME_S){ ball.vx*=.85; ball.vy*=.85; }\n    easeLeft=Math.max(0,easeLeft-dt);\n    return r;'));
control('always a little slower (changes the game)', 'E5', rep('function easeFactor(){ return easeLeft<=0 ? 1 :', 'function easeFactor(){ return easeLeft<=0 ? .999 :'));
control('ease adds points', 'E6', rep('    easeLeft=Math.max(0,easeLeft-dt);\n', '    easeLeft=Math.max(0,easeLeft-dt); score+=0;\n'));
const total = main.F + NC;
console.log('\n' + (total ? 'COMEBACK EASE FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'COMEBACK EASE PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
