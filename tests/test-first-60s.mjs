// First 60 seconds, in the release gate. The first-run colour hint used to be a
// box over the play field (it covered orbs, often the one matching the ball).
// Real game page in the harness vm, on the measured iPhone/iPad layouts:
//   F1 the hint is drawn in the HUD strip slot: clear of the play field, the
//      launcher, the danger line and the HUD; text >= 11px;
//   F2 while it shows, the nearest orb of the ball's colour gets the hint ring,
//      without the high-level warning sound;
//   F3 it lasts 5 s of play and then is gone; a level banner or miss notice
//      takes the slot first; it is first-run only;
//   F4 one tap on ENTER THE FLUX starts play at once (no extra screen).
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const DEVICES = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-level-banner.mjs'), 'utf8').match(/const DEVICES = (\[[\s\S]*?\n\]);/)[1]);

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const bootGame = (extra = {}) => { const { store, mem } = makeStore(Object.assign({ fluxPlayerId: 'f6-1', fluxCallsign: 'T', fluxProfileComplete: '1' }, extra));
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store }); return { g, mem, run: (c) => vm.runInContext(c, g.ctx) }; };
  try {
    let bad = [];
    for (const d of DEVICES) {
      const { g, run } = bootGame();
      const rectOf = (r) => ({ getBoundingClientRect: () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }) });
      g.win.document.querySelector = (sel) => sel === '.stats' ? rectOf(d.stats) : sel === '.fluxbar' ? rectOf(d.fluxbar) : g.win.document.getElementById('x');
      const cx = run('ctx'); const texts = [];
      cx.measureText = (t) => ({ width: String(t).length * parseFloat(String(cx.font).match(/(\d+(?:\.\d+)?)px/)[1]) * 0.72 });
      cx.fillText = (t, x, y) => { const px = parseFloat(String(cx.font).match(/(\d+(?:\.\d+)?)px/)[1]); const w = cx.measureText(t).width;
        const al = String(cx.textAlign || 'start'), bl = String(cx.textBaseline || 'alphabetic'); const left = al === 'center' ? x - w / 2 : x; const top = bl === 'top' ? y : y - px * 0.8;
        texts.push({ t: String(t), px, box: { left, right: left + w, top, bottom: top + px } }); };
      g.win.document.getElementById('startBtn').onclick();
      run('W=' + d.W + ';H=' + d.H + ';paddle.y=H-Math.max(42,Math.min(90,H*.095));paddle.handleH=W<=700?22:28;paddle.x=W/2;cachedHudRects=' + JSON.stringify(d.hud) + ';');
      texts.length = 0; g.ctx.draw();
      const ht = texts.filter((x) => /HIT THE ORB|MATCHES YOUR BALL/.test(x.t)); const top = run('maxHudBottom()'), fieldBottom = run('Math.max(maxHudBottom()+60,H*.79)');
      const r = ht.length ? ht.reduce((a, x) => ({ left: Math.min(a.left, x.box.left), right: Math.max(a.right, x.box.right), top: Math.min(a.top, x.box.top), bottom: Math.max(a.bottom, x.box.bottom) }), ht[0].box) : null;
      const pad = run('({left:paddle.x-paddle.w*.55-12,right:paddle.x+paddle.w*.55+12,top:paddle.y-paddle.h-12,bottom:paddle.y+paddle.handleH+6})');
      const hud = [d.stats, d.fluxbar].concat(d.hud.filter((x) => x.right - x.left < d.W * 0.9));
      if (!r || ht.length !== 2) bad.push(d.name + ': not drawn');
      else if (r.bottom > top - 4) bad.push(d.name + ': reaches the play field / danger line');
      else if (hit(r, pad) || hud.some((x) => hit(r, x)) || r.left < 0 || r.right > d.W || r.top < 0) bad.push(d.name + ': overlaps launcher/HUD/edge');
      else if (!ht.every((x) => x.px >= 11)) bad.push(d.name + ': text < 11px');
    }
    ck('F1 the first-run hint sits in the HUD strip slot on every device: off the play field, launcher, danger line and HUD; text >= 11px (' + DEVICES.length + ' layouts)', bad.length === 0, bad.slice(0, 3).join(' | '));
    { const { g, run } = bootGame(); let threats = 0; g.ctx.playThreat = () => { threats++; }; run('playThreat=function(){ __th=(typeof __th==="number"?__th:0)+1; }; var __th=0;');
      g.win.document.getElementById('startBtn').onclick();
      run('level=1; targets=[]; addTarget(0,80,300,20); addTarget(1,300,300,20); addTarget(0,300,500,20); ball.color=0; ball.x=290; ball.y=560; ball.vx=0; ball.vy=-2;');
      g.ctx.update(1 / 60);
      const hints = JSON.parse(run('JSON.stringify(targets.map(t=>!!t.hint))'));
      ck('F2 during the hint, the nearest orb of the ball\'s colour gets the hint ring (and only that one), no warning sound', JSON.stringify(hints) === '[false,false,true]' && run('__th') === 0, JSON.stringify(hints) + ' threats ' + run('__th'));
      for (let i = 0; i < 300; i++) { run('ball.x=W/2; ball.y=H*.45; ball.vy=-2; targets=targets.slice(0,3);'); g.ctx.update(1 / 60); }
      const left = run('colorHintLeft'), hintsAfter = JSON.parse(run('JSON.stringify(targets.map(t=>!!t.hint))'));
      ck('F3 after 5 s of play the hint is gone (and so is the ring, below level 5)', left === 0 && hintsAfter.every((x) => !x), left + ' ' + JSON.stringify(hintsAfter));
      run('colorHintLeft=3; levelBanner=2;'); const cx = run('ctx'); const tx = []; cx.fillText = (t) => tx.push(String(t)); g.ctx.draw();
      ck('F3 a level banner takes the slot first', tx.some((t) => /^LEVEL /.test(t)) && !tx.some((t) => /HIT THE ORB/.test(t))); }
    { const { g, run } = bootGame({ fluxColorHintSeen: '1' }); g.win.document.getElementById('startBtn').onclick();
      ck('F3 first run only: later runs show no hint', run('colorHintLeft') === 0);
      ck('F4 one tap on ENTER THE FLUX starts play at once', run('playing') === true && run('paused') === false); }
  } catch (e) { ck('first-60s section ran', false, String(e.stack || e).slice(0, 300)); }
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
control('hint back over the play field (24% down)', 'F1', rep("const L=levelBannerLayout('HIT THE ORB THAT','MATCHES YOUR BALL');", "const L=levelBannerLayout('HIT THE ORB THAT','MATCHES YOUR BALL');L.y1=H*.24;L.y2=L.y1+L.f1+3;"));
control('no hint ring during the hint', 'F2', rep('if((level>=5 || colorHintLeft>0) && ball){', 'if(level>=5 && ball){'));
control('warning sound during the first-run hint', 'F2', rep('   if(level>=5 && bestT && bestD<Math.min(W,H)*.28 && Math.random()<dt*.75) playThreat();', '   if(bestT) playThreat();'));
control('hint never ends', 'F3', rep(' if(colorHintLeft>0) colorHintLeft=Math.max(0,colorHintLeft-dt);\n', ''));
control('hint covers the level banner', 'F3', rep(' else if(colorHintLeft>0 && !levelBanner){', ' else if(colorHintLeft>0){'));
control('ring left on after the hint', 'F3', rep(' } else if(targets.some(t=>t.hint)) targets.forEach(t=>t.hint=false);   // the first-run hint ended below level 5', ' }'));
const total = main.F + NC;
console.log('\n' + (total ? 'FIRST 60S FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'FIRST 60S PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
