// BALL NEVER STALLS (owner, real iPhone, Jupiter/Hard + Solar Inferno: the ball skimmed wall to wall
// above the orbs for ~36 s, score frozen, while SPEED UP kept firing). Real game page in the harness vm.
//   S1 a near-horizontal ball near the ceiling comes back down to the paddle within a few seconds, on
//      Easy, Medium and Hard, with no orb in the way (the worst case);
//   S2 after any frame the ball is never flatter than ~27 deg from horizontal (walls, ceiling, orbs);
//   S3 a normal paddle shot, even at the launcher's very end (~30 deg), is left exactly as it was;
//   S4 after 5 s without touching the paddle or an orb the ball is turned toward the paddle, only until
//      it heads down at 45 deg;
//   S5 while the ball touches nothing for 3 s the run clock stops: no SPEED UP step can start;
//   S6 touching the paddle or an orb resets the idle time.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const DEG = Math.PI / 180;

function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const bootGame = (diff, dims = [390, 844]) => {
    const { store } = makeStore({ fluxPlayerId: 'bs-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '9', fluxColorHintSeen: '1', fluxDifficulty: diff, fluxSeason: '1' });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    g.ctx.readSafeBottom = () => 34; run(`innerWidth=${dims[0]}; innerHeight=${dims[1]};`); g.ctx.resize();
    run(`difficulty=${JSON.stringify(diff)};`); g.ctx.newGame(); run('playing=true; paused=false;');
    return { g, run };
  };
  const angleOf = (b) => Math.atan2(Math.abs(b.run('ball.vy')), Math.abs(b.run('ball.vx'))) / DEG;

  try {
    const res = []; let ok = true;
    for (const diff of ['easy', 'medium', 'hard']) {
      const b = bootGame(diff);
      // Worst case: no orbs at all, ball skimming just under the HUD, almost flat, at full speed.
      b.run('targets.length=0; registerMiss=function(){}; ensureBallColourTarget=function(){}; spawnTarget=function(){}; spawnBonusOrb=function(){}; spawnGrowingOrb=function(){};');
      b.run('ball.x=W*0.3; ball.y=maxHudBottom()+ball.r+2; (function(){ const sp=normalMaxSpeed(); ball.vx=sp*Math.cos(2*Math.PI/180); ball.vy=-sp*Math.sin(2*Math.PI/180); })(); paddle.x=W-60;');
      let t = 0, reached = false, flattest = 90;
      while (t < 8) { b.g.ctx.update(1 / 60); t += 1 / 60; flattest = Math.min(flattest, angleOf(b)); if (b.run('ball.y') >= b.run('paddle.y') - b.run('paddle.h') - b.run('ball.r')) { reached = true; break; } }
      res.push(diff + ':' + t.toFixed(2) + 's/' + flattest.toFixed(1) + 'deg');
      if (!reached || t > 5 || flattest < 26.9) ok = false;
    }
    ck('S1 a near-flat ball under the HUD comes down to the paddle within 5 s on Easy, Medium and Hard (no orbs in the way)', ok, res.join(' '));
    ck('S2 ...and is never flatter than ~27 deg on the way', ok && res.every((r) => +r.split('/')[1].replace('deg', '') >= 26.9), res.join(' '));
  } catch (e) { ck('S1/S2 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame('hard');
    b.run('targets.length=0; spawnTarget=function(){}; registerMiss=function(){};');
    // The launcher's very end: hit = +1 (clamped), the widest legal shot.
    b.run('paddle.x=W/2; ball.x=paddle.x+paddle.w/2-1; ball.y=paddle.y-paddle.h/2-ball.r+1; ball.vx=0; ball.vy=8;');
    const expected = b.run('(function(){ const h=clampCatchHit((ball.x-paddle.x)/(paddle.w/2)); return -Math.PI/2+h*1.05; })()');
    b.g.ctx.update(1 / 60);
    const vx = b.run('ball.vx'), vy = b.run('ball.vy');
    const got = Math.atan2(vy, vx);
    ck('S3 the widest paddle shot is left exactly as the launcher sent it (not flattened, not steepened)', Math.abs(got - expected) < 1e-6 && vy < 0, (got / DEG).toFixed(2) + ' vs ' + (expected / DEG).toFixed(2));
  } catch (e) { ck('S3 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame('hard');
    b.run('ballIdle=5.2; paddle.x=W/2; ball.x=W*0.2; ball.y=H*0.35; (function(){ const sp=10; ball.vx=sp*Math.cos(-40*Math.PI/180); ball.vy=sp*Math.sin(-40*Math.PI/180); })();');
    const sp0 = b.run('Math.hypot(ball.vx,ball.vy)');
    let turned = false; for (let i = 0; i < 90; i++) { b.g.ctx.steerStalledBall(1 / 60); const vy = b.run('ball.vy'), s = b.run('Math.hypot(ball.vx,ball.vy)'); if (vy > 0 && vy / s >= Math.SQRT1_2 - 1e-9) { turned = true; break; } }
    const after = b.run('[ball.vx,ball.vy]'); b.g.ctx.steerStalledBall(1 / 60); const after2 = b.run('[ball.vx,ball.vy]');
    ck('S4 after 5 s untouched the ball is turned toward the paddle until it heads down at 45 deg, keeping its speed, then left alone', turned && Math.abs(b.run('Math.hypot(ball.vx,ball.vy)') - sp0) < 1e-6 && after[0] === after2[0] && after[1] === after2[1], JSON.stringify(after));
    const c = bootGame('hard'); c.run('ballIdle=4.9; ball.vx=8; ball.vy=-6;'); c.g.ctx.steerStalledBall(1 / 60);
    ck('S4 ...but not before 5 s', c.run('ball.vx') === 8 && c.run('ball.vy') === -6);
  } catch (e) { ck('S4 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame('hard');
    b.run('ballIdle=3.5; speedCountdown=0; pendingLevel=0; fluxCountdown=0; missNotice=0;');
    const r0 = b.run('runClock'); b.g.ctx.tickSpeed(1); const r1 = b.run('runClock');
    b.run('ballIdle=0;'); b.g.ctx.tickSpeed(1); const r2 = b.run('runClock');
    ck('S5 while the ball touches nothing for 3 s the run clock stops (no SPEED UP can come due); it runs again after a touch', r1 === r0 && r2 > r1, [r0, r1, r2].join(' -> '));
    b.run('ballIdle=3.5; speedCountdown=2.5;'); b.g.ctx.tickSpeed(1);
    ck('S5 ...and a SPEED UP count already running waits too', b.run('speedCountdown') === 2.5);
  } catch (e) { ck('S5 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame('hard');
    b.run('registerMiss=function(){}; spawnTarget=function(){};');
    b.run('ballIdle=4; targets.length=0; paddle.x=W/2; ball.x=paddle.x; ball.y=paddle.y-paddle.h/2-ball.r+1; ball.vx=0; ball.vy=8;'); b.g.ctx.update(1 / 60);
    const afterPaddle = b.run('ballIdle');
    b.run('ballIdle=4; targets.length=0; ball.x=W/2; ball.y=H*0.45; ball.vx=0; ball.vy=-8; targets.push({x:ball.x,y:ball.y-8,r:20,color:(ball.color+1)%5,vx:0,vy:0,phase:0,age:9,hitPulse:0,grazeCooldown:0});'); b.g.ctx.update(1 / 60);
    const afterOrb = b.run('ballIdle');
    ck('S6 touching the paddle or an orb resets the idle time', afterPaddle < 0.05 && afterOrb < 0.05, afterPaddle + ' / ' + afterOrb);
  } catch (e) { ck('S6 section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('no minimum angle (the reported bug)', 'S1', rep(' steerStalledBall(dt); keepBallAngle();   // BALL NEVER STALLS', ' steerStalledBall(dt);   // BALL NEVER STALLS'));
control('minimum angle too wide (flattens normal paddle shots)', 'S3', rep('const BALL_MIN_ANGLE=27*Math.PI/180', 'const BALL_MIN_ANGLE=40*Math.PI/180'));
control('no steering toward the paddle', 'S4', rep('  if(ballIdle<BALL_STEER_S) return;\n', '  return;\n'));
control('steering never stops (a homing shot)', 'S4', rep('  if(ball.vy>0 && ball.vy/sp>=Math.SQRT1_2) return;   // already heading down at 45 deg or steeper\n', ''));
control('speed steps keep firing while stalled', 'S5', rep('  if(ballStalled()) return;   // BALL NEVER STALLS: no run time, no SPEED UP while the ball touches nothing\n', ''));
control('a paddle catch does not reset the idle time', 'S6', rep('ball.y=paddle.y-paddle.h/2-ball.r; ballTouched();', 'ball.y=paddle.y-paddle.h/2-ball.r;'));
control('an orb touch does not reset the idle time', 'S6', rep('   if(dist(ball,t)<ball.r+t.r){\n     ballTouched();\n', '   if(dist(ball,t)<ball.r+t.r){\n'));
const total = main.F + NC;
console.log('\n' + (total ? 'BALL STALL FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'BALL STALL PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
