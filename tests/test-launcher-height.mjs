// LAUNCHER HEIGHT ON EVERY SCREEN (owner, option 2). Real game page in the harness vm.
//   L1 one rule for every phone and tablet: the gap between the launcher's round grip and the screen bottom is
//      the largest of 4.5% of the screen height, the safe area (home indicator) + 1%, and 6% in Android full
//      screen; proportions, not fixed pixels;
//   L2 the same orb-free share on every device: orbs stay above the launcher by 12% of the play field (score
//      boxes to launcher); every orb bound uses it (spawn, drift, field rect, in-field test), nothing uses the
//      old 79% of the screen;
//   L3 ONE FIELD PER RUN: once a run starts, the field (size, launcher, orb floor) keeps its size for the whole
//      run whatever the window does; it is measured again at the next run; turning the device sideways is the
//      one re-fit;
//   L4 reaction time stays fair: the ball's speed is still set as seconds to cross the play field.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const GRIP = 6 + 10 + 58;   // paddle.h/2 + GRIP_STEM + GRIP_D: launcher bar to the grip's bottom

function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const bootGame = (dims, safe) => {
    const { store } = makeStore({ fluxPlayerId: 'lh-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '5', fluxColorHintSeen: '1', fluxDifficulty: 'medium' });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    g.ctx.readSafeBottom = () => safe; run(`innerWidth=${dims[0]}; innerHeight=${dims[1]};`); g.ctx.resize();
    return { g, run, size: (w, h) => { run(`innerWidth=${w}; innerHeight=${h};`); g.ctx.resize(); } };
  };
  try {
    const cases = [['iPhone app', 393, 852, 34], ['iPhone SE', 375, 667, 0], ['BLU G45 tab', 360, 672, 0], ['small Android tab', 360, 512, 0], ['iPad mini app', 744, 1133, 20], ['iPad Pro app', 1024, 1366, 20]];
    const bad = [];
    for (const [n, w, h, safe] of cases) {
      const b = bootGame([w, h], safe), gap = h - (b.run('paddle.y') + GRIP), want = Math.max(safe + .01 * h, .045 * h);
      if (Math.abs(gap - want) > 1e-6) bad.push(n + ' ' + gap.toFixed(2) + ' vs ' + want.toFixed(2));
    }
    ck('L1 one rule on every phone and tablet: grip-to-bottom gap = max(4.5% of the screen, safe area + 1%)', bad.length === 0, bad.join('; '));
    const b0 = bootGame([360, 800], 0);
    ck('L1 Android full screen: 6% of the screen (BLU G45: 48 px, the hidden button bar), so a slide never starts in the swipe-up zone',
      Math.abs(b0.run('800-(launcherY(800,0,true)+' + GRIP + ')') - 48) < 1e-9 && Math.abs(b0.run('800-(launcherY(800,0,false)+' + GRIP + ')') - 36) < 1e-9);
    ck('L1 the numbers the owner approved: 4.5% minimum, safe area + 1%, 6% in Android full screen',
      /const LAUNCHER_GAP_MIN=\.045, LAUNCHER_GAP_SAFE=\.01, LAUNCHER_GAP_ANDROID_FS=\.06;/.test(html));

    const share = cases.map(([n, w, h, safe]) => { const b = bootGame([w, h], safe); return b.run('(paddle.y-orbFloor())/(paddle.y-maxHudBottom())'); });
    ck('L2 the same orb-free share on every device: 12% of the play field above the launcher', share.every((v) => Math.abs(v - .12) < 1e-9), share.map((v) => v.toFixed(3)).join(' '));
    ck('L2 the owner-approved share', /const ORB_FREE_SHARE=\.12;/.test(html));
    const uses = (html.match(/orbFloor\(\)/g) || []).length;
    ck('L2 every orb bound uses it (spawn area, drift bounds, field rect, in-field test); nothing uses 79% of the screen any more', uses >= 4 && !/H\*\.79/.test(html), uses + ' uses');
    const live = cases.map(([n, w, h, safe]) => { const b = bootGame([w, h], safe); b.g.ctx.newGame(); b.run('playing=true; paused=false;'); for (let i = 0; i < 240; i++) b.g.ctx.update(1 / 60);
      return b.run('targets.filter(function(t){ return !t.bonus && t.y>Math.max(maxHudBottom()+60,orbFloor())-t.r+.5; }).length'); });
    ck('L2 in play (4 s on each device), no orb drifts below the floor', live.every((v) => v === 0), live.join(','));

    const b = bootGame([360, 800], 0); b.g.ctx.newGame(); b.run('playing=true; paused=false;');
    const before = b.run('JSON.stringify([W,H,paddle.y,orbFloor()])');
    b.size(360, 728);   // the bars came back (back button, or Chrome left full screen)
    ck('L3 ONE FIELD PER RUN: the window shrinks mid-run, the field keeps its size, launcher and orb floor', b.run('JSON.stringify([W,H,paddle.y,orbFloor()])') === before, before + ' -> ' + b.run('JSON.stringify([W,H,paddle.y,orbFloor()])'));
    b.g.ctx.readSafeBottom = () => 40; b.size(360, 800); b.size(360, 760);
    ck('L3 ...and whatever it does after that', b.run('JSON.stringify([W,H,paddle.y,orbFloor()])') === before);
    b.run('fluxRunEnd()');
    ck('L3 the next run (and the menus) measure the screen again', b.run('H') === 760 && b.run('paddle.y') === b.run('launcherY(760,40,false)'), b.run('H'));
    b.g.ctx.newGame(); b.run('playing=true;');
    ck('L3 a new run takes the new size', b.run('H') === 760 && b.run('fluxRunField.h') === 760);
    b.size(760, 360);
    ck('L3 turning the device sideways is the one re-fit (the game supports rotation)', b.run('W') === 760 && b.run('H') === 360 && b.run('fluxRunField.w') === 760);
    ck('L3 every way a run ends lets the next run measure again (game over, END RUN & MENU)', /endGame=function\(\)\{ const r=endGame0\.apply\(this,arguments\); fluxRunEnd\(\); return r; \};/.test(html) && /playing=false;paused=false;runActive=false;\n  fluxRunEnd\(\);/.test(html));

    ck('L4 reaction time stays fair: the ball speed is still seconds to cross the play field (score boxes to launcher)', /function playAreaHeight\(\)\{ return Math\.max\(200,paddle\.y-maxHudBottom\(\)\); \}/.test(html) && /function crossingSpeed\(sec\)\{ return playAreaHeight\(\)\/sec\/60; \}/.test(html));
  } catch (e) { ck('suite ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const res = suite(GAME_HTML);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, a, b) {
  if (!GAME_HTML.includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(GAME_HTML.split(a).join(b), true); const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
control('a fixed pixel gap again', 'L1 one rule', 'const gap=Math.max(safe+LAUNCHER_GAP_SAFE*S, LAUNCHER_GAP_MIN*S,', 'const gap=Math.max(6,');
control('no Android full-screen guard', 'L1 Android full screen', 'afs?LAUNCHER_GAP_ANDROID_FS*S:0', '0');
control('home indicator ignored', 'L1 one rule', 'safe+LAUNCHER_GAP_SAFE*S', 'LAUNCHER_GAP_SAFE*S');
control('orb-free share changed', 'L2 the same orb-free share', 'const ORB_FREE_SHARE=.12;', 'const ORB_FREE_SHARE=.2;');
control('drift bound back to 79% of the screen', 'L2 every orb bound', '   const topBound=maxHudBottom()+t.r, botBound=Math.max(topBound+60,orbFloor())-t.r;', '   const topBound=maxHudBottom()+t.r, botBound=Math.max(topBound+60,H*.79)-t.r;');
control('the field follows the window mid-run', 'L3 ONE FIELD PER RUN', 'const f=fluxRunField||{w:innerWidth,h:innerHeight};', 'const f={w:innerWidth,h:innerHeight};');
control('the launcher follows the safe area mid-run', 'L3 ...and whatever', 'fluxSafeBottom=fluxRunField?fluxRunField.safe:readSafeBottom();paddle.y=fluxRunField?fluxRunField.py:launcherY(', 'fluxSafeBottom=readSafeBottom();paddle.y=launcherY(');
control('the field is never measured again', 'L3 the next run', 'function fluxRunEnd(){ if(!fluxRunField) return; fluxRunField=null; resize(); }', 'function fluxRunEnd(){}');
control('rotation keeps the old field', 'L3 turning the device', 'if(fluxRunField&&innerWidth!==fluxRunField.w)fluxRunField=fluxFieldMeasure();', '');
const total = res.F + NC;
console.log('\n' + (total ? 'LAUNCHER HEIGHT FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'LAUNCHER HEIGHT PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
