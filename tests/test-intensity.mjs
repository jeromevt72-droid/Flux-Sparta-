// Intensity ("juice"), in the release gate. Real game page in the harness vm.
//   J1 intensity is 0 at the start, rises with combo, level and FLUX mode, max 1;
//   J2 it settles after a miss;
//   J3 it never changes the game: a seeded simulation with intensity on and one
//      with it forced to 0 play EXACTLY the same (score, ball, orbs every frame);
//   J4 the edge light is drawn only OUTSIDE the area orbs can ever be in;
//   J5 the trail glow is never behind an orb;
//   J6 lite mode: no extra particles, no trail glow, faint edge light only;
//   J7 the combo sound keeps climbing past x12 with the hit streak (max 2 octaves),
//      and the scoring code (combo cap 12, points formula) is unchanged;
//   J8 a perfect catch bursts in the ball's own colour, bigger than before;
//   J9 the effects are drawn BEFORE the orbs (never on top of them).
// Ends with negative controls. Pixel-level contrast at full intensity (default
// and Solar) is measured in test-intensity-browser.mjs (needs Chromium).
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const inter = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const bootGame = (extra = {}) => { const { store } = makeStore(Object.assign({ fluxPlayerId: 'ju-1', fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1' }, extra));
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store }); return { g, run: (c) => vm.runInContext(c, g.ctx) }; };
  const code = scriptsOf(gameHtml).join('\n');
  try {
    { const { g, run } = bootGame(); g.ctx.newGame();
      const at0 = run('juice');
      run('combo=4;level=1;fluxMode=0;'); for (let i = 0; i < 240; i++) run('tickJuice(1/60)'); const mid = run('juice');
      run('combo=12;level=9;fluxMode=6;'); for (let i = 0; i < 240; i++) run('tickJuice(1/60)'); const high = run('juice');
      ck('J1 intensity: 0 at the start, rises with combo, level and FLUX mode, never above 1', at0 === 0 && mid > .15 && mid < .5 && high > .95 && high <= 1, [at0, mid.toFixed(2), high.toFixed(2)].join(' / '));
      run('playing=true;paused=false;misses=0;'); g.ctx.registerMiss(); const afterMiss = run('juice');
      run('fluxMode=0;'); for (let i = 0; i < 120; i++) run('tickJuice(1/60)'); const settled = run('juice');
      ck('J2 it settles after a miss (drops to a quarter at once, then eases to the level baseline)', afterMiss <= .26 && settled < .3, afterMiss.toFixed(2) + ' -> ' + settled.toFixed(2)); }
    // J3: same seed, intensity on vs forced off -> identical game.
    const trace = (off) => { Math.random = seeded(9); const { g, run } = bootGame(); if (off) run('juiceTarget=function(){return 0;};'); g.ctx.newGame(); const out = []; let maxJ = 0, maxP = 0;
      for (let f = 0; f < 12000; f++) { if (f % 2500 === 2499) run('ball.y=H+200;misses=0;'); else run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x));'); run('if(!playing){playing=true;paused=false;}');
        g.ctx.update(1 / 60); maxJ = Math.max(maxJ, run('juice')); maxP = Math.max(maxP, run('particles.length'));
        if (f % 20 === 0) out.push(run('JSON.stringify([ball.x,ball.y,score,level,combo,misses,targets.map(t=>[t.x,t.y,t.r,t.color])])')); }
      Math.random = realRandom; return { out, maxJ, maxP }; };
    const on = trace(false), off = trace(true);
    const same = on.out.length === off.out.length && on.out.every((x, i) => x === off.out[i]);
    ck('J3 it never changes the game: intensity on vs off play exactly the same (seeded, 12,000 frames)', same && on.maxJ > .5 && on.maxP > off.maxP, 'max intensity ' + on.maxJ.toFixed(2) + ', max particles ' + on.maxP + ' vs ' + off.maxP);
    // J4/J5: instrument the effects drawing.
    { const { g, run } = bootGame(); g.ctx.newGame();
      run(`playing=true; juice=1; targets=[]; addTarget(0,60,300,21); addTarget(1,200,330,21); addTarget(2,320,420,21); addTarget(3,144,608,16);   // the last one sits on the trail
        ball.x=120; ball.y=520; ball.trail=[]; for(let i=0;i<10;i++) ball.trail.push({x:120+i*6, y:520+i*22});`);
      const cx = run('ctx'); const rects = []; let clipped = false, filledAfterClip = false; const glows = [];
      cx.rect = (x, y, w, h) => { rects.push({ left: x, top: y, right: x + w, bottom: y + h }); }; cx.clip = () => { clipped = true; }; const fills = []; cx.fillRect = (x, y, w, h) => { if (clipped) filledAfterClip = true; fills.push({ left: x, top: y, right: x + w, bottom: y + h }); };
      const gc = run('glowCircle'); run('glowCircle = function(x,y,r,c,a){ __glows.push([x,y,r]); }; var __glows = [];');
      run('drawJuiceUnderOrbs()');
      const f = JSON.parse(run('JSON.stringify(orbFieldRect())')); const GAP = run('JUICE_EDGE_GAP'); const inner = { left: f.left - GAP + 1e-6, right: f.right + GAP - 1e-6, top: f.top - GAP + 1e-6, bottom: f.bottom + GAP - 1e-6 };
      ck('J4 the edge light is clipped to a frame at least ' + GAP + 'px outside the orb field (never behind or next to an orb)', GAP >= 12 && clipped && filledAfterClip && rects.length >= 1 && rects.every((r) => !inter(r, inner)) && fills.every((r) => !inter(r, inner)), rects.length + ' clip rects, ' + fills.length + ' fills');
      const B = JSON.parse(run('JSON.stringify({x:ball.x,y:ball.y,r:ball.r})')), T = JSON.parse(run('JSON.stringify(targets.map(t=>[t.x,t.y,t.r]))')), G = JSON.parse(run('JSON.stringify(__glows)'));
      ck('J5 the trail glow is never behind (or right next to) an orb or the ball, and is drawn where the trail is clear', G.length > 0 && G.every(([x, y, r]) => T.every(([tx, ty, tr]) => Math.hypot(tx - x, ty - y) >= tr + r + 12) && Math.hypot(B.x - x, B.y - y) >= B.r + r + 12), G.length + ' glows');
      // J6 lite
      run('window.__fluxLite=true; __glows=[];'); rects.length = 0;
      let edgeAlpha = 0; const cg = cx.createLinearGradient; cx.createLinearGradient = function () { const gr = cg.apply(this, arguments); const add = gr.addColorStop; gr.addColorStop = function (o, col) { const m = String(col).match(/,([0-9.]+)\)$/); if (m) edgeAlpha = Math.max(edgeAlpha, +m[1]); return add && add.apply(this, arguments); }; return gr; };
      run('drawJuiceUnderOrbs()');
      ck('J6 lite mode: no extra particles, no trail glow, faint edge light only', run('juiceExtraParticles(20)') === 0 && run('__glows.length') === 0 && edgeAlpha > 0 && edgeAlpha <= .1, 'edge alpha ' + edgeAlpha);
      run('window.__fluxLite=false;'); }
    // J7 sound past x12
    { const { g, run } = bootGame(); const tones = []; g.ctx.tone = (fq) => { tones.push(fq); }; g.ctx.noise = () => {};
      const pitch = (c, st) => { tones.length = 0; run('streak=' + st + ';'); g.ctx.playFusion(c); return tones[0]; };
      const p12 = pitch(12, 12), p18 = pitch(12, 18), p24 = pitch(12, 24), p40 = pitch(12, 40), p11 = pitch(11, 30);
      ck('J7 the combo sound keeps climbing past x12 with the hit streak, up to 2 octaves', p18 > p12 && p24 > p18 && p40 === p24 && p11 < p12, [p11, p12, p18, p24, p40].map(Math.round).join(' '));
      ck('J7 ...and scoring is unchanged (combo cap 12, same points formula)', code.includes('combo=Math.min(12,combo+1);') && code.includes('const points=Math.round((orbValue + combo*2)*(t.r>23?1.15:1)*(fluxMode>0?1.15:1));')); }
    // J8 perfect catch
    { const { g, run } = bootGame(); g.ctx.newGame();
      run('playing=true; particles=[]; ball.color=2; ball.vy=5; ball.vx=0; ball.x=paddle.x; ball.y=paddle.y-paddle.h/2-ball.r+1;');
      g.ctx.update(1 / 60);
      const col = run('colors[2]'), n = run('particles.filter(p=>p.col===' + JSON.stringify(col) + ').length'), w = run("particles.filter(p=>p.col==='#ffffff').length");
      ck('J8 a perfect catch bursts in the ball\'s own colour, bigger than the white spark', n >= 22 && w >= 12, n + ' in ball colour, ' + w + ' white'); }
    const drawSrc = (code.match(/function draw\(\)\{[\s\S]*?\n\}\n/) || [''])[0];
    ck('J9 the effects are drawn before the orbs, never on top of them', drawSrc.indexOf('drawJuiceUnderOrbs();') > 0 && drawSrc.indexOf('drawJuiceUnderOrbs();') < drawSrc.indexOf('for(const t of targets){'));
  } catch (e) { ck('intensity section ran', false, String(e.stack || e).slice(0, 300)); }
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
control('intensity unbounded', 'J1', rep('  juice=Math.max(0,Math.min(1,juice));', '  juice=Math.max(0,juice*1.02+.01);'));
control('no settling after a miss', 'J2', rep('juice*=JUICE_MISS_KEEP;', ''));
control('extra particles use the game\'s random numbers', 'J3', rep('particles.push({x,y,vx:juiceRand(-5,5),vy:juiceRand(-5,5),life:1,col});', 'particles.push({x,y,vx:rand(-5,5),vy:rand(-5,5),life:1,col});'));
control('edge light over the whole screen', 'J4', rep('  ctx.rect(0,0,W,top); ctx.rect(0,bot,W,H-bot);', '  ctx.rect(0,0,W,H); ctx.rect(0,bot,W,H-bot);'));
control('trail glow behind orbs', 'J5', rep('    if(targets.some(function(t){ return Math.hypot(t.x-p.x,t.y-p.y)<t.r+r+JUICE_EDGE_GAP; })) return;\n', ''));
control('trail glow behind the ball', 'J5', rep('    if(Math.hypot(ball.x-p.x,ball.y-p.y)<ball.r+r+JUICE_EDGE_GAP) return;   // nor behind the ball itself\n', ''));
control('edge light right up against the orb field', 'J4', rep('const JUICE_EDGE_GAP=14;', 'const JUICE_EDGE_GAP=0;'));
control('lite mode gets the full effects', 'J6', rep('function juiceExtraParticles(n){ return window.__fluxLite ? 0 :', 'function juiceExtraParticles(n){ return false ? 0 :'));
control('sound stops at x12 again', 'J7', rep('playFusion=function(c){ return playFusion0(c>=12 ? Math.min(24,Math.max(c,streak)) : c); };', 'playFusion=function(c){ return playFusion0(c); };'));
control('intensity raises the combo cap', 'J7', rep('combo=Math.min(12,combo+1);', 'combo=Math.min(12+Math.round(juice*6),combo+1);'));
control('no perfect-catch burst in the ball colour', 'J8', rep('juiceBurst(ball.x,ball.y,colors[ball.color],22);', ''));
control('effects drawn over the orbs', 'J9', rep(' drawJuiceUnderOrbs();   // INTENSITY', ' // INTENSITY'));
const total = main.F + NC;
console.log('\n' + (total ? 'INTENSITY FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'INTENSITY PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
