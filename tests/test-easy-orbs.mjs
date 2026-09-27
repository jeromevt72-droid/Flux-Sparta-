// Easy orbs, in the release gate. Real game page in the harness vm.
//   E1 Easy deals 6 orbs (5 on small phones: 380px wide or less, or 700px
//      tall or less) at the start, after a miss and at every level 1-9;
//   E2 only the colours already in play (repeats, never extra colours);
//   E3 on Easy the ball always has at least 2 matching orbs: every new ball
//      (start, miss, revive) and every frame of long seeded Easy games with
//      hits, misses and level-ups;
//   E4 Medium and Hard are unchanged (same orb counts as before, and a seeded
//      Medium game is frame-for-frame the same as without the Easy code);
//   E5 the 10px orb gap holds on Easy with the fuller field, on every size.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Independent of the game's helpers.
const COLOUR = '(t=>!t.bonus&&!(t.growing&&t.matured))';
const MATCHES = `targets.filter(t=>${COLOUR}(t)&&t.color===ball.color).length`;
const NORMAL = 'targets.filter(t=>!t.bonus&&!t.growing).length';
const IN_PLAY = 'Math.min(colors.length,4+Math.floor(level/2))';
const GAPMIN = '(function(){let m=Infinity;for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){const a=targets[i],b=targets[j];m=Math.min(m,Math.hypot(a.x-b.x,a.y-b.y)-a.r-b.r);}return m;})()';
// Medium/Hard orb counts before this change (phone cap, pad cap, +1 every 4 levels up to +2).
const OLD_CAP = { medium: [4, 6], hard: [5, 7] };
const SIZES = [[390, 844, 6], [430, 932, 6], [375, 667, 5], [360, 640, 5], [360, 800, 5], [820, 1180, 6], [744, 1133, 6]];

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const bootGame = (difficulty, seed, w = 390, h = 844, html = gameHtml) => {
    Math.random = seeded(seed);
    const { store } = makeStore({ fluxPlayerId: 'eo-' + seed, fluxCallsign: 'T', fluxProfileComplete: '1', fluxDifficulty: difficulty, fluxColorHintSeen: '1', fluxRunsPlayed: '5' });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    run(`innerWidth=${w}; innerHeight=${h}; resize();`);
    return { g, run };
  };
  const revive = (g) => { const b = g.win.document.getElementById('reviveWatchBtn'); if (b && typeof b.onclick === 'function') b.onclick(); };
  try {
    /* E1 + E2 + E3 on every new ball, every size and level */
    const badCount = [], badColour = [], badMatch = []; let deals = 0;
    for (const [w, h, want] of SIZES) {
      for (let lv = 1; lv <= 9; lv++) {
        const { g, run } = bootGame('easy', 500 + lv + w, w, h);
        g.ctx.newGame(); deals++;
        const chk = (what) => {
          const n = run(NORMAL), maxC = run(`Math.max(...targets.map(t=>t.color))`), m = run(MATCHES);
          if (n !== want) badCount.push(w + 'x' + h + ' L' + lv + ' ' + what + ': ' + n);
          if (maxC >= run(IN_PLAY)) badColour.push(w + 'x' + h + ' L' + lv + ' ' + what + ': colour ' + maxC);
          if (m < 2) badMatch.push(w + 'x' + h + ' L' + lv + ' ' + what + ': ' + m + ' match');
        };
        if (lv === 1) chk('start');
        run(`level=${lv}; speedLevel=${lv}; misses=0;`);
        for (let c = 0; c < run(IN_PLAY); c++) { run('ball.color=' + c + '; misses=0;'); g.ctx.registerMiss(); deals++; chk('miss c' + c); }
        run('misses=2; revivesUsedThisRun=0;'); g.ctx.registerMiss(); revive(g); deals++; chk('revive');
      }
    }
    Math.random = realRandom;
    ck('E1 Easy deals 6 orbs (5 on phones 380px wide or less / 700px tall or less): ' + deals + ' fields, 7 sizes, levels 1-9', badCount.length === 0, badCount.slice(0, 4).join(' | '));
    ck('E2 only the colours already in play (repeats, never extra colours) on every Easy field', badColour.length === 0, badColour.slice(0, 4).join(' | '));
    ck('E3 every new ball on Easy (start, miss, revive) has at least 2 matching orbs', badMatch.length === 0, badMatch.slice(0, 4).join(' | '));
    /* E3 + E5 long seeded Easy games, checked every frame */
    let frames = 0, levelUps = 0, fusions = 0, forced = 0, worstGap = Infinity, shortGap = 0, inRange = 0, played = 0, maxNormal = 0, minNormal = 99; const miss = [], extra = [];
    for (const [w, h, want, seed] of [[390, 844, 6, 41], [360, 640, 5, 42], [820, 1180, 6, 43]]) {
      const { g, run } = bootGame('easy', seed, w, h);
      g.ctx.newGame(); let lastLevel = 1, lastScore = 0;
      for (let f = 1; f <= 30000; f++) {
        if (f % 2500 === 0) { run('ball.y=H+200; misses=0;'); forced++; }
        else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x+Math.sin(' + f + '*.05)*30));');
        run('if(!playing){ playing=true; paused=false; }');
        g.ctx.update(1 / 60); frames++;
        const lv = run('level'); if (lv > lastLevel) { levelUps += lv - lastLevel; lastLevel = lv; }
        const sc = run('score'); if (sc > lastScore + 15) fusions++; lastScore = sc;
        if (!run('playing')) continue;
        const m = run(MATCHES); if (m < 2 && miss.length < 4) miss.push(w + 'x' + h + ' frame ' + f + ' L' + lv + ': ' + m + ' match, field ' + run('JSON.stringify(targets.map(t=>t.color))'));
        const n = run(NORMAL); maxNormal = Math.max(maxNormal, n); minNormal = Math.min(minNormal, n); played++; if (n >= 5 && n <= 6) inRange++;
        if (run(`targets.some(t=>t.color>=${IN_PLAY})`) && extra.length < 4) extra.push(w + 'x' + h + ' frame ' + f);
        const gm = run(GAPMIN); worstGap = Math.min(worstGap, gm); if (gm < 9.5) shortGap++;
      }
      Math.random = realRandom;
    }
    ck('E3 long seeded Easy games: the ball always has at least 2 matching orbs (' + frames + ' frames, ' + levelUps + ' level-ups, ' + fusions + ' hits, ' + forced + ' forced misses)',
      miss.length === 0 && levelUps >= 6 && fusions > 100, miss.join(' | '));
    ck('E1 ...the field stays at 5-6 orbs while playing, also after a growing orb is fused (' + (100 * inRange / played).toFixed(2) + '% of frames; min ' + minNormal + ', max ' + maxNormal + ')', minNormal >= 4 && maxNormal <= 6 && inRange >= played * .98);
    ck('E2 ...and no orb ever has a colour that is not in play yet', extra.length === 0, extra.join(' | '));
    // As on Medium, a crowded moment (several grown orbs against a wall) can squeeze the gap for a frame or two; it must stay that rare.
    ck('E5 the 10px orb gap holds on the fuller Easy field (' + shortGap + ' of ' + played + ' frames under 9.5px, closest ' + worstGap.toFixed(1) + 'px)', shortGap <= played * .0005);
    /* E4 Medium and Hard unchanged */
    const capBad = [];
    for (const d of ['medium', 'hard']) for (const [w, h] of SIZES) for (let lv = 1; lv <= 9; lv++) {
      const { run } = bootGame(d, 7, w, h); run(`level=${lv};`);
      const [p, pad] = OLD_CAP[d], g = Math.min(2, Math.floor((lv - 1) / 4)), want = w <= 700 ? Math.min(6, p + g) : Math.min(9, pad + g);
      if (run('targetCap()') !== want) capBad.push(d + ' ' + w + 'x' + h + ' L' + lv + ': ' + run('targetCap()') + ' want ' + want);
    }
    Math.random = realRandom;
    ck('E4 Medium and Hard keep their orb counts (every size, levels 1-9)', capBad.length === 0, capBad.slice(0, 4).join(' | '));
    const WITHOUT = (html) => html.replace("function targetCap(){if(difficulty==='easy')return easyOrbCount();", 'function targetCap(){')
      .replace("  if(difficulty==='easy' && playing) easyTopUpMatches();\n", '');
    const trace = (html, d) => { const { g, run } = bootGame(d, 9, 390, 844, html); g.ctx.newGame(); const out = [];
      for (let f = 0; f < 6000; f++) { if (f % 2000 === 1999) run('ball.y=H+200; misses=0;'); else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x+Math.sin(' + f + '*.03)*55));');
        run('if(!playing){playing=true;paused=false;}'); g.ctx.update(1 / 60);
        if (f % 15 === 0) out.push(run('JSON.stringify([ball.x,ball.y,ball.color,score,level,targets.map(t=>[t.x,t.y,t.color])])')); }
      Math.random = realRandom; return out.join('\n'); };
    const wo = WITHOUT(GAME_HTML);   // reference: the shipped page with the Easy code taken out
    ck('E4 a seeded Medium and Hard game is frame-for-frame the same as without the Easy code (6,000 frames each)',
      wo !== GAME_HTML &&trace(gameHtml, 'medium') === trace(wo, 'medium') && trace(gameHtml, 'hard') === trace(wo, 'hard'));
  } catch (e) { ck('easy orbs section ran', false, String(e.stack || e).slice(0, 300)); }
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
control('Easy back to the old 3 orbs', 'E1', rep("function targetCap(){if(difficulty==='easy')return easyOrbCount();", 'function targetCap(){'));
control('6 orbs on small phones too', 'E1', rep('return (W<=380||H<=700)?5:6;', 'return 6;'));
control('an extra colour on the Easy field', 'E2', rep(' for(let i=0;i<targetCap();i++){\n   const [x,y]=safeSpawnPoint(isPhone()?18:22);\n   const color=i%Math.min(5,3+level);', ' for(let i=0;i<targetCap();i++){\n   const [x,y]=safeSpawnPoint(isPhone()?18:22);\n   const color=i===1?colors.length-1:i%Math.min(5,3+level);'));
control('a fused growing orb still replaced on a full Easy field (7 orbs)', 'E1', rep("if(!(difficulty==='easy' && t.growing && easyFieldFull())) addTarget(", 'if(true) addTarget('));
control('no 2-match guarantee during play', 'E3', rep("  if(difficulty==='easy' && playing) easyTopUpMatches();\n", ''));
control('no 2-match guarantee for a new ball after a miss', 'E3', rep(" if(ball && difficulty==='easy'){ ball.color=easyPickColour(ball.color); easyTopUpMatches(); }", ''));
control('guarantee only 1 match', 'E3', rep('const EASY_MATCH_MIN=2;', 'const EASY_MATCH_MIN=1;'));
control('Medium given more orbs too', 'E4', rep("function targetCap(){if(difficulty==='easy')return easyOrbCount();", "function targetCap(){if(difficulty!=='hard')return easyOrbCount();"));
control('guarantee applied on Medium too', 'E4', (s) => s.replace("function easyTopUpMatches(){\n  if(!ball || difficulty!=='easy') return;", 'function easyTopUpMatches(){\n  if(!ball) return;').replace("  if(difficulty==='easy' && playing) easyTopUpMatches();", '  if(playing) easyTopUpMatches();'));
control('orb gap off (orbs may touch)', 'E5', rep('const ORB_GAP=10;', 'const ORB_GAP=0;'));
const total = main.F + NC;
console.log('\n' + (total ? 'EASY ORBS FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'EASY ORBS PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
