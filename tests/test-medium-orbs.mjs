// Medium orbs, in the release gate. Real game page in the harness vm.
//   M1 Medium deals 5 orbs on phones at the start (was 4) and after every miss,
//      still +1 every 4 levels up to 6; iPad keeps 6 -> 7 -> 8; never fewer
//      orbs than before at any level or size;
//   M2 only the colours already in play (repeats, never extra colours);
//   M3 long seeded Medium games on small phones, iPhone and iPad: the 10px orb
//      gap holds, orbs stay above the launcher area, the ball always has a
//      matching orb;
//   M4 FULL POINTS (owner): Medium pays the same points per event as Hard and
//      Easy (fusion, danger, bonus, overload, FLUX MODE, perfect and plain
//      catch; the x0.85 and the per-difficulty perfect-catch factor are gone),
//      the popups show those points; Medium and Hard thresholds are the table
//      x1 and x0.55 (Hard lowered so casual players reach level 3), page = server;
//   M5 Hard keeps empty space: 5 orbs on phones and 6 on iPad at every level,
//      never more than before or than Medium; seeded Hard (and Easy) games are
//      frame-for-frame the same as without the Medium code.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const WORKER = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const NORMAL = 'targets.filter(t=>!t.bonus&&!t.growing).length';
const IN_PLAY = 'coloursInPlay()';   // SKILL LADDER: 4 colours, the 5th (star) from level 3
const MATCHES = 'targets.filter(t=>!t.bonus&&!(t.growing&&t.matured)&&t.color===ball.color).length';
const GAPMIN = '(function(){let m=Infinity;for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){const a=targets[i],b=targets[j];m=Math.min(m,Math.hypot(a.x-b.x,a.y-b.y)-a.r-b.r);}return m;})()';
// Orb counts before this change: [phone, pad] at level 1, +1 every 4 levels up to +2, phone limit 6, pad limit 9.
const OLD_CAP = { easy: [3, 5], medium: [4, 6], hard: [5, 7] };
const oldCap = (d, w, lv) => { const [p, pad] = OLD_CAP[d], g = Math.min(2, Math.floor((lv - 1) / 4)); return w <= 700 ? Math.min(6, p + g) : Math.min(9, pad + g); };
const WANT_MEDIUM = { phone: [5, 5, 5, 5, 6, 6, 6, 6, 6], pad: [6, 6, 6, 6, 7, 7, 7, 7, 8] };
const SIZES = [[390, 844], [430, 932], [375, 667], [360, 640], [360, 800], [820, 1180], [744, 1133], [1024, 1366]];
// The page with the Medium code taken out (reference for "unchanged").
const WITHOUT = (html) => html.replace('DIFFICULTY.medium.capPhone=5;\n', '')
  .replace("function mediumPoints(p){ return difficulty==='medium'?Math.round(p*MEDIUM_POINTS):p; }", 'function mediumPoints(p){ return p; }');

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const bootGame = (difficulty, seed, w = 390, h = 844, html = gameHtml) => {
    Math.random = seeded(seed);
    const { store } = makeStore({ fluxPlayerId: 'mo-' + seed, fluxCallsign: 'T', fluxProfileComplete: '1', fluxDifficulty: difficulty, fluxColorHintSeen: '1', fluxRunsPlayed: '5' });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    run(`innerWidth=${w}; innerHeight=${h}; resize();`);
    return { g, run };
  };
  try {
    /* M1 + M2: every deal (start, and a miss at every level) on every size */
    const badCount = [], fewer = [], badColour = [], startCols = []; let deals = 0;
    for (const [w, h] of SIZES) {
      const want = WANT_MEDIUM[w <= 700 ? 'phone' : 'pad'];
      for (let lv = 1; lv <= 9; lv++) {
        const { g, run } = bootGame('medium', 300 + lv + w, w, h);
        g.ctx.newGame(); deals++;
        const chk = (what, L) => {
          const n = run(NORMAL);
          if (n !== want[L - 1]) badCount.push(w + 'x' + h + ' L' + L + ' ' + what + ': ' + n + ' want ' + want[L - 1]);
          if (n < oldCap('medium', w, L)) fewer.push(w + 'x' + h + ' L' + L + ' ' + what + ': ' + n);
          if (run(`targets.some(t=>t.color>=${IN_PLAY})`)) badColour.push(w + 'x' + h + ' L' + L + ' ' + what + ': ' + run('JSON.stringify(targets.map(t=>t.color))'));
        };
        if (lv === 1) { chk('start', 1); startCols.push(run('JSON.stringify(targets.map(t=>t.color).sort())')); }
        run(`level=${lv}; speedLevel=${lv}; misses=0;`); g.ctx.registerMiss(); deals++; chk('miss', lv);
      }
    }
    Math.random = realRandom;
    ck('M1 Medium deals 5 orbs on phones (6 on iPad), +1 every 4 levels: ' + deals + ' fields, ' + SIZES.length + ' sizes, levels 1-9', badCount.length === 0, badCount.slice(0, 4).join(' | '));
    ck('M1 ...never fewer orbs than before at any level or size', fewer.length === 0, fewer.slice(0, 4).join(' | '));
    const phoneStart = startCols.filter((c, i) => SIZES[i][0] <= 700);
    ck('M2 the phone start field is the same 4 colours with one repeat (' + phoneStart[0] + ')', phoneStart.every((c) => c === '[0,0,1,2,3]'));
    ck('M2 only colours already in play on every Medium field (repeats, never extra colours)', badColour.length === 0, badColour.slice(0, 3).join(' | '));
    /* M3 long seeded Medium games */
    let frames = 0, levelUps = 0, fusions = 0, shortGap = 0, worstGap = Infinity, low = 0, noMatch = 0, played = 0, maxN = 0; const lowAt = [];
    for (const [w, h, seed] of [[360, 640, 51], [375, 667, 52], [390, 844, 53], [820, 1180, 54]]) {
      const { g, run } = bootGame('medium', seed, w, h);
      g.ctx.newGame(); let lastLevel = 1, lastScore = 0;
      for (let f = 1; f <= 15000; f++) {
        if (f % 2500 === 0) run('ball.y=H+200; misses=0;');
        else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x+Math.sin(' + f + '*.05)*30));');
        run('if(!playing){ playing=true; paused=false; }');
        g.ctx.update(1 / 60); frames++;
        const lv = run('level'); if (lv > lastLevel) { levelUps += lv - lastLevel; lastLevel = lv; }
        const sc = run('score'); if (sc > lastScore + 10) fusions++; lastScore = sc;
        if (!run('playing')) continue;
        played++; maxN = Math.max(maxN, run(NORMAL));
        const gm = run(GAPMIN); worstGap = Math.min(worstGap, gm); if (gm < 9.5) shortGap++;
        const lowOrb = run('targets.filter(t=>t.y+t.r>Math.max(maxHudBottom()+60,H*.79)+.5).length');
        if (lowOrb) { low++; if (lowAt.length < 3) lowAt.push(w + 'x' + h + ' frame ' + f); }
        if (run(MATCHES) < 1) noMatch++;
      }
      Math.random = realRandom;
    }
    ck('M3 long seeded Medium games ran (' + frames + ' frames, ' + levelUps + ' level-ups, ' + fusions + ' hits, up to ' + maxN + ' orbs)', levelUps >= 6 && fusions > 100 && maxN <= 8);
    ck('M3 the 10px orb gap holds with the fuller Medium field (' + shortGap + ' of ' + played + ' frames under 9.5px, closest ' + worstGap.toFixed(1) + 'px)', shortGap <= played * .0005);
    ck('M3 orbs stay in the orb field, clear of the launcher (' + low + ' frames)', low === 0, lowAt.join(' | '));
    ck('M3 the ball always has a matching orb (' + noMatch + ' frames without)', noMatch === 0);
    /* M4 Medium points */
    const pts = (d) => {
      const { g, run } = bootGame(d, 77); g.ctx.newGame();
      const o = {};
      run('orbValue=40; combo=3; fluxMode=0; flux=0; targets=[]; addTarget(ball.color,W/2,H/2,20); targets[0].danger=true;');
      let s0 = run('score'); g.ctx.fuse(run('targets[0]')); o.fuse = run('score') - s0;
      o.popups = run('texts.map(t=>t.s).join(",")');
      run('combo=2; targets=[{x:100,y:200,r:10,color:0,bonus:true,vx:0,vy:0,phase:0,age:0,life:5}];');
      s0 = run('score'); g.ctx.popBonus(run('targets[0]')); o.bonus = run('score') - s0;
      run('combo=2; targets=[{x:100,y:200,r:30,maxR:34,color:0,growing:true,matured:true,vx:0,vy:0,phase:0,age:0}];');
      s0 = run('score'); g.ctx.burstGrowing(run('targets[0]'), 12); o.grow = run('score') - s0;
      run('fluxMode=0; flux=100;'); s0 = run('score'); g.ctx.startFluxMode(); o.flux = run('score') - s0;   // FLUX MODE +250: scaled on Medium (TIME SPEED)
      Math.random = realRandom; return o;
    };
    const pm = pts('medium'), ph = pts('hard'), pe = pts('easy');
    // Raw points: fusion (40+4*2)=48 (combo 3 -> 4 on the hit) + danger 15, bonus 120+2*10=140, overload 200+2*15=230, FLUX MODE 250.
    const raw = { fuse: 48 + 15, bonus: 140, grow: 230, flux: 250 };
    ck('M4 Medium, Hard and Easy pay the same full points: ' + JSON.stringify(pm).replace(/"popups":"[^"]*",?/, ''), ['fuse', 'bonus', 'grow', 'flux'].every((k) => pm[k] === raw[k] && ph[k] === raw[k] && pe[k] === raw[k]));
    ck('M4 ...the fusion and danger popups show those points (' + pm.popups + ')', pm.popups.includes('+48') && pm.popups.includes('CLEARED •15'));
    ck('M4 no per-difficulty point factor is left in the code', !/function mediumPoints|function scorePoints|MEDIUM_POINTS|EASY_POINTS|DIFFICULTY\[difficulty\]\.mult/.test(gameHtml));
    const perfectPts = (d) => { const { g, run } = bootGame(d, 78); g.ctx.newGame();
      run('combo=4; comboTimer=5; targets=[]; ball.vx=0; ball.vy=6; ball.x=paddle.x; ball.y=paddle.y-ball.r-2;'); const s0 = run('score');
      for (let i = 0; i < 3 && run('score') === s0; i++) g.ctx.update(1 / 60);
      const r = run('score') - s0; Math.random = realRandom; return r; };
    const pp = ['easy', 'medium', 'hard'].map(perfectPts);
    ck('M4 a perfect paddle hit pays 5 x combo on every difficulty (' + pp.join(' / ') + ')', pp.every((x) => x === 20));
    const tbl = (src) => (src.match(/LEVEL_SCORE_MULT\s*=\s*\{[^}]*\}/) || [''])[0].replace(/\s|0(?=\.)/g, '');
    ck('M4 Medium and Hard level thresholds are the table x1 (as before) and x0.55, page = server (' + tbl(gameHtml) + ')', /medium:1,hard:\.55\}$/.test(tbl(gameHtml)) && tbl(WORKER) === tbl(gameHtml) && /const SCORE_CEILING = 455_000;/.test(WORKER));
    /* M5 Hard unchanged (and Easy untouched by the Medium code) */
    const capBad = [];
    for (const d of ['hard']) for (const [w, h] of SIZES) for (let lv = 1; lv <= 9; lv++) {
      const { run } = bootGame(d, 7, w, h); run(`level=${lv};`);
      const n = run('targetCap()'), med = WANT_MEDIUM[w <= 700 ? 'phone' : 'pad'][lv - 1];
      if (n !== (w <= 700 ? 5 : 6) || n > oldCap(d, w, lv) || n > med) capBad.push(d + ' ' + w + 'x' + h + ' L' + lv + ': ' + n);
    }
    Math.random = realRandom;
    ck('M5 Hard keeps empty space: 5 orbs on phones, 6 on iPad, at every level (never more than before or than Medium; every size, levels 1-9)', capBad.length === 0, capBad.slice(0, 4).join(' | '));
    const trace = (html, d, w, h) => { const { g, run } = bootGame(d, 9, w, h, html); g.ctx.newGame(); const out = [];
      for (let f = 0; f < 6000; f++) { if (f % 2000 === 1999) run('ball.y=H+200; misses=0;'); else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x+Math.sin(' + f + '*.03)*55));');
        run('if(!playing){playing=true;paused=false;}'); g.ctx.update(1 / 60);
        if (f % 10 === 0) out.push(run('JSON.stringify([ball.x,ball.y,ball.color,score,level,combo,targets.map(t=>[t.x,t.y,t.r,t.color])])')); }
      Math.random = realRandom; return out.join('\n'); };
    const wo = WITHOUT(GAME_HTML);
    const same = (d) => [[390, 844], [820, 1180]].every(([w, h]) => trace(gameHtml, d, w, h) === trace(wo, d, w, h));
    ck('M5 a seeded Hard game is frame-for-frame the same as without the Medium code (iPhone + iPad, 6,000 frames each)', wo !== GAME_HTML && same('hard'));
    ck('M5 ...and so is a seeded Easy game', same('easy'));
    ck('M5 (sanity) a seeded Medium game does differ', trace(gameHtml, 'medium', 390, 844) !== trace(wo, 'medium', 390, 844));
  } catch (e) { ck('medium orbs section ran', false, String(e.stack || e).slice(0, 300)); }
  finally { Math.random = realRandom; }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each part removed MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('Medium back to 4 orbs on phones', 'M1', rep('DIFFICULTY.medium.capPhone=5;', 'DIFFICULTY.medium.capPhone=4;'));
control('Medium starts at 6 on phones (no room to grow)', 'M1', rep('DIFFICULTY.medium.capPhone=5;', 'DIFFICULTY.medium.capPhone=6;'));
control('Medium iPad cut to 5 (fewer than before)', 'M1', rep('DIFFICULTY.medium.capPhone=5;', 'DIFFICULTY.medium.capPhone=5;DIFFICULTY.medium.capPad=5;'));
control('an extra colour on the Medium start field', 'M2', rep('   const color=i%coloursInPlay();\n   // Deliberately', '   const color=i===4?4:i%coloursInPlay();\n   // Deliberately'));
control('an extra colour after a miss', 'M2', rep(' for(let i=0;i<targetCap();i++){\n   const [x,y]=safeSpawnPoint(isPhone()?18:22);\n   const color=i%coloursInPlay();', ' for(let i=0;i<targetCap();i++){\n   const [x,y]=safeSpawnPoint(isPhone()?18:22);\n   const color=i===1?colors.length-1:i%coloursInPlay();'));
control('orb gap off (orbs may touch)', 'M3', rep('const ORB_GAP=10;', 'const ORB_GAP=0;'));
control('Medium points cut again (x0.85)', 'M4', rep(' const points=Math.round((orbValue + combo*2)*(t.r>23?1.15:1)*(fluxMode>0?1.15:1));', " const points=Math.round((orbValue + combo*2)*(t.r>23?1.15:1)*(fluxMode>0?1.15:1)*(difficulty==='medium'?.85:1));"));
control('perfect paddle points scaled by difficulty again', 'M4', rep('Math.max(2,Math.round(5*combo))', 'Math.max(2,Math.round(5*combo*DIFFICULTY[difficulty].mult))'));
control('fusion popup differs from the points', 'M4', rep("popup(t.x,t.y,'+'+points,colors[t.color]);", "popup(t.x,t.y,'+'+Math.round(points*.85),colors[t.color]);"));
control('Medium level table changed', 'M4', rep('medium:1,hard:.55};', 'medium:.85,hard:.55};'));
control('Hard grows with level again', 'M5', rep("if(difficulty==='hard') return isPhone()?d.capPhone:d.capPad;", ''));
control('Hard back to 7 orbs on iPad', 'M5', rep('DIFFICULTY.hard.capPad=6;', 'DIFFICULTY.hard.capPad=7;'));
control('Hard given more orbs too', 'M5', rep('DIFFICULTY.medium.capPhone=5;', 'DIFFICULTY.medium.capPhone=5;DIFFICULTY.hard.capPhone=6;'));
const total = main.F + NC;
console.log('\n' + (total ? 'MEDIUM ORBS FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'MEDIUM ORBS PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
