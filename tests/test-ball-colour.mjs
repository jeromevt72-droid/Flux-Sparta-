// Ball colour rule: every ball must match the colour of at least one orb on
// the field (bonus orbs and matured growing orbs pop on any contact, so they
// do not count). Real game page in the harness vm.
//   1. The reported bug: level 4 on a phone, the ball is orange (the 5th
//      colour, unlocked from level 2) and a miss deals a fresh 4-orb field
//      that only has the first four colours.
//   2. Every new ball (start, miss, revive), for every level 1-9, every
//      difficulty and every colour the ball could have had.
//   3. The last matching orb bursting as a matured growing orb.
//   4. Long simulated play: the launcher follows the ball, the real update()
//      loop runs, misses are forced, level-ups happen through the SPEED UP
//      countdown; the rule is checked after EVERY frame.
// Ends with negative controls: each part of the fix is removed and MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// Deterministic randomness, so every run of the gate plays the same games.
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Independent of the game's own helper: does any colour orb match the ball?
const MATCH = 'targets.some(t=>!t.bonus&&!(t.growing&&t.matured)&&t.color===ball.color)';

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const bootGame = (difficulty, seed) => {
    Math.random = seeded(seed);
    const { store } = makeStore({ fluxPlayerId: 'bc-' + seed, fluxCallsign: 'T', fluxProfileComplete: '1', fluxDifficulty: difficulty, fluxColorHintSeen: '1' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    return { g, run: (c) => vm.runInContext(c, g.ctx) };
  };
  try {
    /* 1. The reported bug, exactly */
    {
      const { g, run } = bootGame('medium', 1);
      g.ctx.newGame(); run('level=4; speedLevel=4; ball.color=4;');   // orange: #ff9a3d, the 5th default colour
      const orange = run('colors[ball.color]');
      g.ctx.registerMiss();
      ck('B1 the reported bug: level 4 phone, orange ball, a miss deals a fresh field -> the ball still has an orb to hit',
        run(MATCH), 'ball ' + run('colors[ball.color]') + ' (was ' + orange + '), field ' + run('JSON.stringify(targets.map(t=>t.color))'));
    }
    /* 2. Every new ball: start, miss, revive -- all levels, difficulties and possible colours */
    let starts = 0, misses = 0, revives = 0; const bad = [];
    for (const d of ['easy', 'medium', 'hard']) {
      for (let lv = 1; lv <= 9; lv++) {
        const nColours = Math.min(9, 4 + Math.floor(lv / 2));
        for (let c = 0; c < nColours; c++) {
          const { g, run } = bootGame(d, 1000 + lv * 10 + c);
          g.ctx.newGame(); starts++;
          if (!run(MATCH)) bad.push(d + ' L' + lv + ' start');
          run('level=' + lv + '; speedLevel=' + lv + '; ball.color=' + c + '; misses=0;');
          g.ctx.registerMiss(); misses++;
          if (!run(MATCH)) bad.push(d + ' L' + lv + ' miss colour ' + c);
          run('ball.color=' + c + '; misses=2; revivesUsedThisRun=0;');
          g.ctx.registerMiss();   // 3rd miss -> revive offer
          const btn = g.win.document.getElementById('reviveWatchBtn'); if (btn && typeof btn.onclick === 'function') btn.onclick(); revives++;
          if (!run(MATCH)) bad.push(d + ' L' + lv + ' revive colour ' + c);
        }
      }
    }
    ck('B2 every new ball matches an orb: ' + starts + ' starts, ' + misses + ' misses, ' + revives + ' revives (levels 1-9, all difficulties, every colour)', bad.length === 0, bad.slice(0, 5).join(' | '));
    /* 3. The last matching orb bursts as a matured growing orb */
    {
      const { g, run } = bootGame('medium', 7);
      g.ctx.newGame();
      run(`level=4; speedLevel=4; targets=[]; addTarget(0,60,300,20); addTarget(1,200,360,20); addTarget(2,320,420,20);
        targets.push({x:150,y:500,r:34,maxR:34,color:5,spin:0,vx:0,vy:0,phase:0,age:9,growing:true,matured:true,danger:false});
        ball.color=5;`);
      const burstT = run('targets[3]'); g.ctx.burstGrowing(burstT, 17);
      run('ball.x=W/2; ball.y=paddle.y-120; ball.vx=0; ball.vy=-2;');
      g.ctx.update(1 / 60);
      ck('B3 when the last orb of the ball\'s colour bursts, a matching orb is added within one frame', run(MATCH), 'ball ' + run('ball.color') + ', field ' + run('JSON.stringify(targets.map(t=>t.color))'));
    }
    {
      // A bonus orb is stored with colour 0 but pops on any contact: it is not a colour match.
      const { g, run } = bootGame('medium', 8);
      g.ctx.newGame();
      run(`level=4; speedLevel=4; targets=[]; addTarget(1,60,300,20); addTarget(2,200,360,20); addTarget(3,320,420,20);
        targets.push({x:250,y:250,r:10,color:0,spin:0,vx:0,vy:0,phase:0,age:1,bonus:true,danger:false,life:5});
        ball.color=0; ball.x=W/2; ball.y=paddle.y-120; ball.vx=0; ball.vy=-2;`);
      g.ctx.update(1 / 60);
      ck('B3 a bonus orb does not count as a match: a real orb of the ball\'s colour is added', run(MATCH), 'field ' + run('JSON.stringify(targets.map(t=>(t.bonus?"bonus":t.color)))'));
    }
    /* 4. Long simulated play, checked after every frame */
    let frames = 0, levelUps = 0, forced = 0, fusions = 0; const miss = [];
    for (const [d, seed] of [['easy', 11], ['medium', 22], ['hard', 33]]) {
      const { g, run } = bootGame(d, seed);
      g.ctx.newGame(); let lastLevel = 1, lastScore = 0;
      for (let f = 1; f <= 30000; f++) {
        if (f % 2500 === 0) { run('ball.y=H+200; misses=0;'); forced++; }         // force a miss now and then
        else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x));');   // otherwise the launcher follows the ball
        run('if(!playing){ playing=true; paused=false; }');
        g.ctx.update(1 / 60); frames++;
        const lv = run('level'); if (lv > lastLevel) { levelUps += lv - lastLevel; lastLevel = lv; }
        if (run('score') > lastScore + 15) fusions++; lastScore = run('score');
        if (!run(MATCH)) { miss.push(d + ' frame ' + f + ' L' + lv + ' ball ' + run('ball.color') + ' field ' + run('JSON.stringify(targets.map(t=>t.color))')); if (miss.length > 3) break; }
      }
    }
    ck('B4 simulated play: the ball always has an orb to hit (' + frames + ' frames, ' + levelUps + ' level-ups, ' + forced + ' forced misses)', miss.length === 0 && frames >= 90000, miss.slice(0, 3).join(' | '));
    ck('B5 ...and the simulation really exercised level-ups and scoring', levelUps >= 6 && fusions > 50, levelUps + ' level-ups, ' + fusions + ' scoring events');
  } catch (e) { ck('ball colour section ran', false, String(e.stack || e).slice(0, 300)); }
  finally { Math.random = realRandom; }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each part of the fix removed MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('the reported bug: a new ball after a miss keeps a colour the field lacks', 'B1', rep(' if(ball) ball.color=pickBallColour();   // the new ball (after a miss or a revive) matches an orb on the new field\n', ''));
control('new balls pick any unlocked colour', 'B2', rep("  return present[Math.floor(Math.random()*present.length)];", "  return Math.floor(Math.random()*Math.min(colors.length,4+Math.floor(level/2)));"));
control('no safety net when the last matching orb bursts', 'B3', rep(' ensureBallColourTarget();   // ball colour rule: never leave the ball with nothing to hit\n', ''));
control('bonus orbs counted as a colour match', 'B3', rep('function isColourTarget(t){ return !t.bonus && !(t.growing && t.matured); }', 'function isColourTarget(t){ return true; }'));
const total = main.F + NC;
console.log('\n' + (total ? 'BALL COLOUR FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'BALL COLOUR PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
