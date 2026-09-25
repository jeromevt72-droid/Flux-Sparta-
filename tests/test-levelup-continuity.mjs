// Level-up is a continuous flow, not a restart. Real game page in the harness
// vm: build a mid-run field (grown orbs, a bonus orb, a growing overload orb,
// a combo, a lost life, a part-filled FLUX meter, earned orb value), reach the
// score threshold, run the whole SPEED UP countdown, and check that:
//   - every orb is still there with the same size, position, colour and kind,
//     and no orb was spawned or removed by the level-up itself;
//   - score, combo, lives, FLUX meter and orb value are unchanged;
//   - only the difficulty changes, ramping over ~1 s (speed, orb motion,
//     launcher width), and new orbs use the new level's settings;
//   - the SPEED UP countdown, the banner and the background change still happen.
// Ends with negative controls: each old reset is put back and MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORB_KEYS = ['x', 'y', 'r', 'color', 'bonus', 'growing', 'matured', 'maxR', 'danger'];

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    const { store } = makeStore({ fluxPlayerId: 'lu-1', fluxCallsign: 'T', fluxProfileComplete: '1', fluxDifficulty: 'medium' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    g.ctx.newGame();
    // A realistic mid-run field: fused orbs grown to 24..30px, special orbs, run state.
    run(`targets=[];
      addTarget(0,60,300,30); addTarget(1,200,360,27); addTarget(2,320,420,24); addTarget(3,120,520,21);
      targets[1].danger=true;
      targets.push({x:250,y:250,r:10,color:0,spin:0,vx:.1,vy:.1,phase:1,age:1,bonus:true,danger:false,life:4});
      targets.push({x:90,y:620,r:34,maxR:34,color:2,spin:0,vx:.1,vy:.1,phase:1,age:9,growing:true,matured:true,danger:false});
      score=2400; combo=7; comboTimer=2.6; misses=1; flux=62; orbValue=31;`);
    const snap = () => JSON.parse(run('JSON.stringify(targets.map(t=>({' + ORB_KEYS.map((k) => k + ':t.' + k).join(',') + '})))'));
    const state = () => JSON.parse(run('JSON.stringify({score,combo,misses,flux,orbValue,lives:3-misses})'));
    const before = snap(), st0 = state();
    let spawns = 0, bgCalls = [];
    const add0 = g.ctx.addTarget; g.ctx.addTarget = function () { spawns++; return add0.apply(this, arguments); };
    const bg0 = g.ctx.applyCelestialBackground; g.ctx.applyCelestialBackground = function (lv) { bgCalls.push(lv); return bg0.apply(this, arguments); };
    // Reach the threshold (a +100 fusion's worth of score), then the 5 s countdown.
    run('score=2500;'); g.ctx.checkScoreLevel();
    ck('C0 level-up starts: SPEED UP countdown and banner', run('pendingLevel') === 2 && run('levelBanner') > 0 && g.win.document.getElementById('levelLabel').textContent === 'SPEED UP');
    const w0 = run('paddle.w');
    for (let i = 0; i < 5; i++) g.ctx.tickLevelUp(1);
    ck('C1 the new level starts after the countdown', run('level') === 2 && run('pendingLevel') === 0);
    const after = snap();
    ck('C2 every orb is still on the field (none cleared, none added)', after.length === before.length && spawns === 0, before.length + ' -> ' + after.length + ', spawned ' + spawns);
    ck('C3 ...each with the same size, position, colour and kind (grown, bonus, overload, danger)', JSON.stringify(after) === JSON.stringify(before),
      before.map((t, i) => JSON.stringify(t) === JSON.stringify(after[i]) ? '' : 'orb ' + i + ' r ' + t.r + '->' + (after[i] || {}).r).filter(Boolean).join(', '));
    const st1 = state();
    ck('C4 score, combo, lives and FLUX meter unchanged', st1.score === 2500 && st1.combo === st0.combo && st1.lives === st0.lives && st1.flux === st0.flux, JSON.stringify(st0) + ' -> ' + JSON.stringify(st1));
    ck('C5 orb value earned by perfect catches is kept', st1.orbValue === st0.orbValue, st0.orbValue + ' -> ' + st1.orbValue);
    ck('C6 the level-up background change still happens', bgCalls.includes(2));
    // Difficulty ramps over ~1 s: speed/orb motion (speedLevel) and launcher width.
    const s0 = run('speedLevel'), p0 = run('paddle.w');
    g.ctx.tickLevelUp(0.5); const s1 = run('speedLevel'), p1 = run('paddle.w');
    g.ctx.tickLevelUp(0.5); const s2 = run('speedLevel'), p2 = run('paddle.w');
    ck('C7 difficulty ramps smoothly over ~1 s (1 -> 1.5 -> 2), no jump', s0 === 1 && Math.abs(s1 - 1.5) < 1e-9 && s2 === 2, [s0, s1, s2].join(' -> '));
    ck('C8 the launcher narrows with the ramp, not in one jump', p0 === w0 && p1 < p0 && p2 < p1 && p2 === run('paddleWidthFor(2)'), [p0, p1, p2].join(' -> '));
    ck('C9 orbs already on screen are only moved by the normal ramp (their motion follows speedLevel, not the level number)',
      /t\.phase \+= dt\*\(\.7\+speedLevel\*\.035\)/.test(gameHtml) && /const drift = \.45\+\.55\*Math\.max\(0,Math\.min\(1,speedLevel-4\)\)/.test(gameHtml));
    // New orbs use the new level's settings: level 2 allows a 5th colour.
    const r0 = Math.random; Math.random = () => 0.999;
    try { run('targets=targets.slice(0,2);'); g.ctx.spawnTarget(); } finally { Math.random = r0; }
    ck('C10 new orbs spawn with the new level\'s settings (level 2: a 5th colour)', run('targets[targets.length-1].color') === 4, run('targets[targets.length-1].color'));
    ck('C11 score, combo, lives and FLUX survive the ramp too', JSON.stringify(state()) === JSON.stringify(st1));
  } catch (e) { ck('continuity section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each old reset is put back and MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
const FIN = " popup(W/2,155,'LEVEL '+level,'#62eaff');\n updateHud();\n}";
control('field wiped and re-dealt on level-up (the bug)', 'C2', rep(FIN, " popup(W/2,155,'LEVEL '+level,'#62eaff');\n targets=[];\n for(let i=0;i<targetCap();i++)spawnTarget(i%Math.min(5,3+level));\n updateHud();\n}"));
control('orbs shrunk back to spawn size', 'C3', rep(FIN, " popup(W/2,155,'LEVEL '+level,'#62eaff');\n targets.forEach(t=>{t.r=18;});\n updateHud();\n}"));
control('orb value reset on level-up', 'C5', rep(FIN, " popup(W/2,155,'LEVEL '+level,'#62eaff');\n orbValue=20;\n updateHud();\n}"));
control('combo reset on level-up', 'C4', rep(FIN, " popup(W/2,155,'LEVEL '+level,'#62eaff');\n combo=1;\n updateHud();\n}"));
control('FLUX meter reset on level-up', 'C4', rep(FIN, " popup(W/2,155,'LEVEL '+level,'#62eaff');\n flux=0;\n updateHud();\n}"));
control('background change dropped', 'C6', rep(' applyCelestialBackground(level);\n popup(', ' popup('));
control('launcher snaps to the new width', 'C8', rep(FIN, " popup(W/2,155,'LEVEL '+level,'#62eaff');\n paddle.w=paddleWidthFor(level);\n updateHud();\n}"));
control('speed jumps instead of ramping', 'C7', rep(' speedLevel=from;   // ramps up to the new level over LEVEL_RAMP_S', ' speedLevel=level;'));
control('slow 2 s ramp', 'C7', rep('LEVEL_RAMP_S=1;', 'LEVEL_RAMP_S=2;'));
control('orb motion jumps with the level number', 'C9', rep('t.phase += dt*(.7+speedLevel*.035);', 't.phase += dt*(.7+level*.035);'));
const total = main.F + NC;
console.log('\n' + (total ? 'LEVEL-UP CONTINUITY FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'LEVEL-UP CONTINUITY PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
