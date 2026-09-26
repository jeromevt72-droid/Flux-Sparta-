// Orb colours v2, in the release gate. Real game page in the harness vm.
//   V1 every skin has exactly the approved 5 colours (4 core + 1 unlock);
//   V2 colours in play: 4 at level 1, 5 from level 2 to 9 (the cap), and a
//      long simulated game never deals a colour beyond the 5th;
//   V3 Toxic clearly differs from the free Aurora skin (every Toxic colour is
//      dE >= 25 from the nearest Aurora colour);
//   V4 block style: each orb is filled at EXACTLY its hit radius, with a thin
//      dark outline and a light highlight, and no glow blur;
//   V5 the ball: filled at exactly its hit radius, thin white ring, its symbol;
//   V6 hit areas and physics code unchanged (orb/ball/launcher collision
//      tests and radii are the same expressions as before).
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lab = (h) => { const l = rgb(h).map(lin); const X = (.4124 * l[0] + .3576 * l[1] + .1805 * l[2]) / .95047, Y = .2126 * l[0] + .7152 * l[1] + .0722 * l[2], Z = (.0193 * l[0] + .1192 * l[1] + .9505 * l[2]) / 1.08883; const f = (t) => (t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]; };
const dE = (a, b) => { const A = lab(a), B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
const APPROVED = {
  aurora: ['#ffe768', '#62bdfa', '#f16e52', '#5be8c8', '#7473fb'],
  toxic: ['#d7fe71', '#f773ac', '#9eedfc', '#bd4ff1', '#fd2c29'],
  cosmic: ['#ebf2ff', '#e971ef', '#57dcab', '#ecc238', '#eb5454'],
  solar: ['#fcf6e9', '#46daf0', '#6d7ae5', '#54df6d', '#ef7ba6'],
};

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  try {
    const { store } = makeStore({ fluxPlayerId: 'oc-1', fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    const SK = JSON.parse(run('JSON.stringify(SKINS)'));
    for (const [k, want] of Object.entries(APPROVED)) ck('V1 ' + k + ': exactly the approved 5 colours', JSON.stringify(SK[k].colors) === JSON.stringify(want), (SK[k].colors || []).join(' '));
    const inPlay = []; for (let lv = 1; lv <= 9; lv++) inPlay.push(run('level=' + lv + '; Math.min(colors.length,4+Math.floor(level/2))'));
    ck('V2 colours in play: 4 at level 1, 5 at levels 2-9', inPlay.join('') === '455555555', inPlay.join(' '));
    // Long simulated game: never a colour index beyond the 5th.
    Math.random = seeded(5);
    g.ctx.newGame(); let maxC = 0, lvMax = 1;
    for (let f = 0; f < 20000; f++) { if (f % 3000 === 0) run('misses=0;'); run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x)); if(!playing){playing=true;paused=false;}'); g.ctx.update(1 / 60);
      maxC = Math.max(maxC, run('Math.max(ball.color,...targets.filter(t=>!t.bonus).map(t=>t.color))')); lvMax = Math.max(lvMax, run('level')); }
    Math.random = realRandom;
    ck('V2 a long simulated game (to level ' + lvMax + ') never deals a colour beyond the 5th', maxC <= 4 && lvMax >= 4, 'max colour index ' + maxC);
    const cross = SK.toxic.colors.map((t) => Math.min(...SK.aurora.colors.map((a) => dE(t, a))));
    ck('V3 Toxic clearly differs from Aurora (every colour dE >= 25 from the nearest Aurora colour)', cross.every((x) => x >= 25), cross.map((x) => x.toFixed(0)).join(' '));
    // Record what draw() paints.
    const cx = run('ctx'); const ops = []; let path = [];
    cx.beginPath = () => { path = []; }; cx.arc = (x, y, r) => { path.push({ x, y, r }); }; cx.ellipse = (x, y) => { path.push({ x, y, e: true }); };
    cx.fill = () => { ops.push({ op: 'fill', path: path.slice(), style: String(cx.fillStyle), blur: +cx.shadowBlur || 0, a: +cx.globalAlpha }); };
    cx.stroke = () => { ops.push({ op: 'stroke', path: path.slice(), style: String(cx.strokeStyle), lw: +cx.lineWidth }); };
    const texts = []; cx.fillText = (t, x, y) => { texts.push({ t: String(t), x, y, a: +cx.globalAlpha }); };
    g.ctx.newGame();
    run(`level=2; targets=[]; addTarget(0,80,300,21); addTarget(1,200,330,18); addTarget(4,300,420,24); targets.forEach(t=>{t.danger=false;t.hint=false;t.hitPulse=0;});
      ball.x=190; ball.y=600; ball.color=4; ball.trail=[];`);
    const T = JSON.parse(run('JSON.stringify(targets.map(t=>({x:t.x,y:t.y,r:t.r,c:t.color})))')), B = JSON.parse(run('JSON.stringify({x:ball.x,y:ball.y,r:ball.r,c:ball.color})'));
    ops.length = 0; texts.length = 0; g.ctx.draw();
    const at = (o, x, y, r) => o.path.some((p) => !p.e && Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6 && (r == null || Math.abs(p.r - r) < 1e-6));
    const orbOK = T.map((t) => {
      const body = ops.find((o) => o.op === 'fill' && at(o, t.x, t.y, t.r) && o.a === 1 && !/^#000/.test(o.style));
      const outline = ops.find((o) => o.op === 'stroke' && at(o, t.x, t.y, t.r) && /rgba\(8,10,24/.test(o.style) && o.lw <= 3);
      const hl = ops.find((o) => o.op === 'fill' && o.path.some((p) => p.e && Math.abs(p.x - t.x) < 1e-6 && p.y < t.y) && /rgba\(255,255,255/.test(o.style));
      const bigger = ops.find((o) => o.op === 'fill' && o.path.some((p) => !p.e && Math.abs(p.x - t.x) < 1e-6 && Math.abs(p.y - t.y) < 1e-6 && p.r > t.r + 1e-6) && o.a === 1 && !/^#000/.test(o.style));
      return !!body && !!outline && !!hl && !bigger && body.blur === 0;
    });
    ck('V4 block style: each orb filled at exactly its hit radius, thin dark outline, light highlight, no glow blur', orbOK.every(Boolean), orbOK.join(','));
    const ballBody = ops.find((o) => o.op === 'fill' && at(o, B.x, B.y, B.r) && o.a === 1 && !/^#000/.test(o.style));
    const ring = ops.find((o) => o.op === 'stroke' && at(o, B.x, B.y, B.r + 3.5) && /#ffffff/i.test(o.style));
    const glyphs = JSON.parse(run('JSON.stringify(glyphs)'));
    const sym = texts.find((t) => t.t === glyphs[B.c] && Math.abs(t.x - B.x) < 1e-6);
    ck('V5 the ball: filled at exactly its hit radius, thin white ring, its colour symbol (5th colour: ★)', !!ballBody && !!ring && !!sym && glyphs[4] === '★', [!!ballBody, !!ring, !!sym].join(','));
  } catch (e) { ck('orb colours section ran', false, String(e.stack || e).slice(0, 300)); }
  finally { Math.random = realRandom; }
  const code = scriptsOf(gameHtml).join('\n');
  const pins = ['if(dist(ball,t)<ball.r+t.r){', 'ball.x>paddle.x-paddle.w/2-ball.r && ball.x<paddle.x+paddle.w/2+ball.r){', 'ball={x:W/2,y:paddle.y-28,r:13,', 'const perfect=Math.abs(hit)<.14;',
    "addTarget(color,x,y,isPhone()?16+Math.random()*5:18+Math.random()*6);", 'function paddleWidthFor(lv){ return Math.max(isPhone()?96:112,(isPhone()?132:150)-(lv-1)*4); }'];
  const missing = pins.filter((p) => !code.includes(p));
  ck('V6 hit areas and physics unchanged (collision tests, radii, launcher width, perfect zone)', missing.length === 0, missing.join(' | ').slice(0, 160));
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
control('a sixth colour added back', 'V2', rep("colors:['#ffe768','#62bdfa','#f16e52','#5be8c8','#7473fb']", "colors:['#ffe768','#62bdfa','#f16e52','#5be8c8','#7473fb','#ff9a3d']"));
control('Toxic violet back to Aurora\'s', 'V3', rep("'#bd4ff1','#fd2c29']", "'#7f73f8','#fd2c29']"));
control('orbs drawn bigger than their hit area', 'V4', rep('   blockOrb(t.x,t.y,t.r,colors[t.color]);\n   // Colour-blind cue', '   blockOrb(t.x,t.y,t.r*1.15,colors[t.color]);\n   // Colour-blind cue'));
control('no dark outline', 'V4', rep("ctx.lineWidth=Math.max(1.5,r*.08);ctx.strokeStyle=ORB_OUTLINE;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();", ''));
control('glow blur back on orbs', 'V4', rep('function blockOrb(x,y,r,col){\n  ctx.save();ctx.shadowBlur=0;', 'function blockOrb(x,y,r,col){\n  ctx.save();ctx.shadowBlur=22;'));
control('ball loses its white ring', 'V5', rep("ctx.save();ctx.lineWidth=2;ctx.strokeStyle='#ffffff';ctx.globalAlpha=.95;ctx.beginPath();ctx.arc(ball.x,ball.y,ball.r+3.5,0,Math.PI*2);ctx.stroke();ctx.restore();", ''));
control('orb hit area enlarged', 'V6', rep('if(dist(ball,t)<ball.r+t.r){', 'if(dist(ball,t)<ball.r+t.r+6){'));
control('launcher catch area widened', 'V6', rep('ball.x>paddle.x-paddle.w/2-ball.r && ball.x<paddle.x+paddle.w/2+ball.r){', 'ball.x>paddle.x-paddle.w/2-ball.r-8 && ball.x<paddle.x+paddle.w/2+ball.r+8){'));
const total = main.F + NC;
console.log('\n' + (total ? 'ORB COLOURS V2 FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'ORB COLOURS V2 PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
