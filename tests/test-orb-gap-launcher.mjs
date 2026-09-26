// Orb gap + launcher colour, in the release gate. Real game page in the harness vm.
//   G1 long simulated games on Easy, Medium and Hard: no two orbs ever come
//      closer than ORB_GAP (edge to edge) while playing, so no orb hides
//      another's colour or symbol;
//   G2 two orbs placed on top of each other (or touching) are pulled apart to
//      the gap in one step, stay inside the orb field, keep their sizes;
//   G3 a crowded field (spawned on top of each other) opens up within 1 s;
//   G4 the game-over collapse (pulling the field together) is left alone;
//   L1 Solar and Cosmic draw the launcher in their own colour; the others keep
//      their first orb colour;
//   L2 each own launcher colour is far from every orb colour of its skin (and so
//      from the ball) and from the background (CIEDE2000);
//   L3 the bright middle of the bar is a tint of that colour, not white.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// CIEDE2000
function lab(hex) { const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const X = (c[0] * .4124 + c[1] * .3576 + c[2] * .1805) / .95047, Y = c[0] * .2126 + c[1] * .7152 + c[2] * .0722, Z = (c[0] * .0193 + c[1] * .1192 + c[2] * .9505) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116); return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]; }
function de2000(h1, h2) { const [L1, a1, b1] = lab(h1), [L2, a2, b2] = lab(h2), r = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2, G = .5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const A1 = a1 * (1 + G), A2 = a2 * (1 + G), c1 = Math.hypot(A1, b1), c2 = Math.hypot(A2, b2);
  let h1_ = Math.atan2(b1, A1) / r; if (h1_ < 0) h1_ += 360; let h2_ = Math.atan2(b2, A2) / r; if (h2_ < 0) h2_ += 360;
  const dL = L2 - L1, dC = c2 - c1; let dh = 0; if (c1 * c2) { dh = h2_ - h1_; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(dh * r / 2), Lm = (L1 + L2) / 2, cm = (c1 + c2) / 2;
  let hm = h1_ + h2_; if (c1 * c2) { if (Math.abs(h1_ - h2_) > 180) hm += (hm < 360 ? 360 : -360); hm /= 2; }
  const T = 1 - .17 * Math.cos((hm - 30) * r) + .24 * Math.cos(2 * hm * r) + .32 * Math.cos((3 * hm + 6) * r) - .2 * Math.cos((4 * hm - 63) * r);
  const dT = 30 * Math.exp(-(((hm - 275) / 25) ** 2)), Rc = 2 * Math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7)), Sl = 1 + .015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), Sc = 1 + .045 * cm, Sh = 1 + .015 * cm * T, Rt = -Math.sin(2 * dT * r) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh)); }
const BACKGROUND = { solar: '#10080c', cosmic: '#07091d' };   // Solar: its visible bottom edge (rgb(16,8,12)); Cosmic: the default dark field

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const bootGame = () => { const { store } = makeStore({ fluxPlayerId: 'og-1', fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: '5' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store }); return { g, run: (c) => vm.runInContext(c, g.ctx) }; };
  const minGap = (run) => run('(function(){let m=Infinity;for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){const a=targets[i],b=targets[j];m=Math.min(m,Math.hypot(a.x-b.x,a.y-b.y)-a.r-b.r);}return m;})()');
  try {
    const { g, run } = bootGame();
    const GAP = run('typeof ORB_GAP==="number" ? ORB_GAP : 0');
    for (const diff of ['easy', 'medium', 'hard']) {
      Math.random = seeded(diff.length * 97);
      run(`difficulty='${diff}';`); g.ctx.newGame(); let worst = Infinity, lvMax = 1, frames = 0;
      for (let f = 0; f < 12000; f++) { if (f % 2500 === 0) run('misses=0;');
        run('paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,ball.x)); if(!playing){playing=true;paused=false;}'); g.ctx.update(1 / 60);
        if (run('playing')) { worst = Math.min(worst, minGap(run)); frames++; } lvMax = Math.max(lvMax, run('level')); }
      Math.random = realRandom;
      ck('G1 ' + diff + ': ' + frames + ' frames to level ' + lvMax + ', orbs never closer than ' + GAP + 'px edge to edge', GAP >= 8 && worst >= GAP - 0.5 && lvMax >= (diff === 'easy' ? 2 : 3), 'closest ' + worst.toFixed(1) + 'px');
    }
    g.ctx.newGame(); run('playing=true; paused=false; level=2;');
    run('targets=[]; addTarget(0,150,300,20); addTarget(1,150,300,18); targets.forEach(t=>{t.vx=0;t.vy=0;});');
    const r0 = run('targets.map(t=>t.r).join()');
    g.ctx.update(1 / 60);
    ck('G2 two orbs on the same spot are pulled apart to the gap in one step, sizes unchanged', minGap(run) >= GAP - 0.5 && run('targets.map(t=>t.r).join()') === r0, minGap(run).toFixed(1));
    run('targets=[]; addTarget(0,30,300,20); addTarget(1,62,305,18); targets.forEach(t=>{t.vx=.3;t.vy=0;});'); g.ctx.update(1 / 60);
    ck('G2 touching orbs at the field edge are separated and stay inside the field', minGap(run) >= GAP - 0.5 && run('targets.every(t=>t.x>=t.r+16-1e-6 && t.x<=W-t.r-16+1e-6)'), minGap(run).toFixed(1));
    run('targets=[]; for(let i=0;i<8;i++) addTarget(i%4,190+i,380,20);');
    for (let f = 0; f < 60; f++) g.ctx.update(1 / 60);
    ck('G3 a crowded field (8 orbs spawned on one spot) opens up to the gap within 1 s', minGap(run) >= GAP - 0.5, minGap(run).toFixed(1));
    ck('G4 the gap is kept only while playing (the game-over collapse still pulls the field together)', /\n if\(playing\) keepOrbGap\(\);/.test(gameHtml));
  } catch (e) { Math.random = realRandom; ck('orb gap section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const { g, run } = bootGame();
    const SK = JSON.parse(run('JSON.stringify(SKINS)'));
    const use = (k) => run(`activeSkin='${k}'; colors=currentPalette(); launcherColour()`);
    const got = { solar: use('solar'), cosmic: use('cosmic'), aurora: use('aurora'), toxic: use('toxic') };
    ck('L1 Solar and Cosmic have their own launcher colour; Aurora and Toxic keep their first orb colour',
      got.solar === SK.solar.launcher && got.cosmic === SK.cosmic.launcher && got.aurora === SK.aurora.colors[0] && got.toxic === SK.toxic.colors[0], JSON.stringify(got));
    for (const k of ['solar', 'cosmic']) {
      const L = SK[k].launcher || SK[k].colors[0], d = SK[k].colors.map((c) => de2000(L, c)), bg = de2000(L, BACKGROUND[k]);
      ck('L2 ' + k + ': launcher ' + L + ' is far from every orb colour (and the ball) and from the background', Math.min(...d) >= 30 && bg >= 40, 'orbs ' + d.map((x) => x.toFixed(0)).join(',') + ' | background ' + bg.toFixed(0));
    }
    // What draw() paints for the launcher on Solar.
    run(`activeSkin='solar'; colors=currentPalette(); newGame(); playing=true;`);
    const cx = run('ctx'); const strokes = []; const stops = [];
    cx.stroke = () => { strokes.push(String(cx.strokeStyle)); };
    cx.createLinearGradient = () => ({ addColorStop: (o, c) => stops.push(c) });
    g.ctx.draw();
    ck('L1 Solar: the launcher is drawn in its own colour', strokes.includes(SK.solar.launcher) && !strokes.includes(SK.solar.colors[0]), [...new Set(strokes)].slice(0, 6).join(' '));
    ck('L3 ...and its bright middle is a tint of that colour, not white', stops.includes(SK.solar.launcher) && !stops.includes('#fff') && stops.some((c) => /^rgb\(/.test(c)), stops.join(' '));
  } catch (e) { ck('launcher section ran', false, String(e.stack || e).slice(0, 300)); }
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
control('orbs allowed to overlap while drifting', 'G2', rep(' if(playing) keepOrbGap();', ' ;'));
control('gap too small (orbs touch)', 'G1', rep('const ORB_GAP=10;', 'const ORB_GAP=0;'));
control('gap also forced during the game-over collapse', 'G4', rep(' if(playing) keepOrbGap();', ' keepOrbGap();'));
control('launcher back to the first orb colour', 'L1', rep(' const paddleCol = launcherColour();', " const paddleCol = colors[0]||'#62eaff';"));
control('Solar launcher too close to an orb (cream)', 'L2', rep("launcher:'#ff7a18'", "launcher:'#fff4e0'"));
control('white middle stripe back', 'L3', rep('grad.addColorStop(.5,launcherHighlight(paddleCol));', "grad.addColorStop(.5,'#fff');"));
const total = main.F + NC;
console.log('\n' + (total ? 'ORB GAP + LAUNCHER FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'ORB GAP + LAUNCHER PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
