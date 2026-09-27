// PADDLE GRIP + RELATIVE DRAG (tester feedback), in the release gate. Real game page in the harness vm.
//   G1 a round grip (camera-shutter style, 56-60pt) under the launcher, joined by a stem, in the
//      launcher's colour with a lighter ring, and always above the iPhone home indicator;
//   G2 it follows each skin's launcher colour; G3 it pulses gently at the start of each run only;
//   G4 the old T-handle is gone;
//   D1 a finger that starts in the bottom 40% drags the launcher RELATIVELY (by how far it slides);
//      a touch higher up does nothing; a mouse still points directly;
//   D2 a short thumb slide (about a quarter of the screen width from the middle) reaches both edges;
//   D3 lifting the finger and touching again starts a new drag from where the launcher is;
//   H1 "Slide anywhere ↔" on the first run only, gone once the player slides;
//   K1 catch width, catch test and scoring unchanged;
//   T1 popups such as COMBO LOST never rise into the HUD / FLUX meter row.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const bootGame = (init = {}, dims = [390, 844], safe = 34) => {
    const { store, mem } = makeStore(Object.assign({ fluxPlayerId: 'pg-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '5', fluxColorHintSeen: '1' }, init));
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    g.ctx.readSafeBottom = () => safe; run(`innerWidth=${dims[0]}; innerHeight=${dims[1]};`); g.ctx.resize();
    return { g, mem, run };
  };
  // Records the canvas calls made by draw().
  const record = (b) => { const cx = b.run('ctx'); const ops = []; let path = [];
    cx.beginPath = () => { path = []; }; cx.arc = (x, y, r) => { path.push({ arc: [x, y, r] }); }; cx.moveTo = (x, y) => path.push({ m: [x, y] }); cx.lineTo = (x, y) => path.push({ l: [x, y] });
    cx.fill = () => ops.push({ op: 'fill', path: path.slice(), style: String(cx.fillStyle) }); cx.stroke = () => ops.push({ op: 'stroke', path: path.slice(), style: String(cx.strokeStyle), lw: +cx.lineWidth });
    const texts = []; cx.fillText = (t, x, y) => texts.push({ t: String(t), x, y });
    return { ops, texts }; };
  const grip = (ops, b) => { const px = b.run('paddle.x'), py = b.run('paddle.y');
    return ops.filter((o) => o.op === 'fill' && o.path.length === 1 && o.path[0].arc && Math.abs(o.path[0].arc[0] - px) < 0.5 && o.path[0].arc[1] > py && o.path[0].arc[2] >= 24).map((o) => ({ cy: o.path[0].arc[1], r: o.path[0].arc[2], style: o.style })); };

  try {
    const b = bootGame(); b.g.ctx.newGame(); b.run('playing=true; paused=false; gripPulse=0;');
    const rec = record(b); b.g.ctx.draw();
    const gp = grip(rec.ops, b)[0] || {};
    const H = 844, bottom = gp.cy + gp.r;
    ck('G1 a round grip ~58pt under the launcher, in its colour, above the home indicator (iPhone, 34pt inset)',
      gp.r * 2 >= 56 && gp.r * 2 <= 60 && gp.style === b.run('launcherColour()') && bottom <= H - 34 && gp.cy > b.run('paddle.y'), JSON.stringify(gp) + ' bottom ' + bottom);
    const ring = rec.ops.find((o) => o.op === 'stroke' && o.path.length === 1 && o.path[0].arc && Math.abs(o.path[0].arc[1] - gp.cy) < 0.5);
    const stem = rec.ops.find((o) => o.op === 'stroke' && o.path.length === 2 && o.path[0].m && Math.abs(o.path[0].m[0] - b.run('paddle.x')) < 0.5 && o.path[1].l[1] > o.path[0].m[1] && o.path[1].l[1] <= gp.cy - gp.r + 4);
    ck('G1 ...with a lighter ring and joined to the launcher by a short stem', !!ring && /^rgb\(/.test(ring.style) && !!stem);
    const se = bootGame({}, [375, 667], 0); se.g.ctx.newGame(); se.run('playing=true; gripPulse=0;'); const r2 = record(se); se.g.ctx.draw(); const g2 = grip(r2.ops, se)[0] || {};
    const pad = bootGame({}, [820, 1180], 20); pad.g.ctx.newGame(); pad.run('playing=true; gripPulse=0;'); const r3 = record(pad); pad.g.ctx.draw(); const g3 = grip(r3.ops, pad)[0] || {};
    ck('G1 ...fits on iPhone SE (no inset) and iPad (20pt inset) too', g2.cy + g2.r <= 667 && g3.cy + g3.r <= 1180 - 20, (g2.cy + g2.r) + ' / ' + (g3.cy + g3.r));
    const sol = bootGame({ fluxSkin: 'solar' }); sol.run("activeSkin='solar'; colors=currentPalette();"); sol.g.ctx.newGame(); sol.run('playing=true; gripPulse=0;'); const r4 = record(sol); sol.g.ctx.draw();
    ck('G2 it follows the skin\'s launcher colour (Solar: orange)', (grip(r4.ops, sol)[0] || {}).style === '#ff7a18');
    b.g.ctx.newGame(); b.run('playing=true; gripPulse=1.6;'); b.g.ctx.update(0.2);
    const rp = record(b); b.g.ctx.draw(); const pulsing = (grip(rp.ops, b)[0] || {}).r;
    b.run('gripPulse=0;'); const rq = record(b); b.g.ctx.draw(); const still = (grip(rq.ops, b)[0] || {}).r;
    ck('G3 a gentle pulse at the start of each run, then still', pulsing !== still && Math.abs(pulsing - still) <= 29 * 0.1 && b.run('(newGame(), gripPulse)') > 1.5, pulsing + ' vs ' + still);
    ck('G4 the old T-handle and its white crossbar are gone', !/paddle\.y\+paddle\.handleH\);ctx\.stroke\(\)/.test(html) && !/Small grip accent at the bottom of the handle/.test(html));
  } catch (e) { ck('grip section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame(); b.g.ctx.newGame(); b.run('playing=true; paused=false;');
    const W = 390, H = 844, p0 = b.run('paddle.x'), gain = b.run('dragGain()');
    const mv = (id, x, y) => b.g.ctx.pointer({ touches: [{ identifier: id, clientX: x, clientY: y }] });
    mv(1, 100, 700); mv(1, 130, 700);
    ck('D1 a finger in the bottom 40% moves the launcher by how far it slides (x' + gain.toFixed(2) + ')', Math.abs(b.run('paddle.x') - (p0 + 30 * gain)) < 0.01, b.run('paddle.x') + ' vs ' + (p0 + 30 * gain));
    const before = b.run('paddle.x'); b.g.win.ontouchend({ touches: [] }); mv(2, 300, 300); mv(2, 20, 300);
    ck('D1 ...a touch higher up (top 60%) does nothing', b.run('paddle.x') === before);
    b.g.ctx.pointer({ pointerType: 'mouse', clientX: 77 });
    ck('D1 ...a mouse still points directly', b.run('paddle.x') === Math.max(b.run('paddle.w/2+8'), 77));
    b.g.ctx.pointer({ pointerType: 'touch', clientX: 380 });
    ck('D1 ...a stray touch "pointer" event (no drag under way) moves nothing', b.run('paddle.x') === Math.max(b.run('paddle.w/2+8'), 77));
    b.run('setPaddle(W/2);'); b.g.win.ontouchend({ touches: [] });
    mv(3, 195, 760); mv(3, 195 + W * 0.25, 760); const right = b.run('paddle.x');
    b.g.win.ontouchend({ touches: [] }); mv(4, 195, 760); mv(4, 195 - W * 0.5, 760); const left = b.run('paddle.x');
    ck('D2 a short thumb slide (a quarter of the width from the middle) reaches the edge, both ways',
      Math.abs(right - b.run('W-paddle.w/2-8')) < 0.01 && Math.abs(left - b.run('paddle.w/2+8')) < 0.01, right + ' / ' + left);
    b.g.win.ontouchend({ touches: [] }); const at = b.run('paddle.x'); mv(4, 50, 800); mv(4, 60, 800);   // Android reuses the finger's id
    ck('D3 lifting the finger and touching again starts from where the launcher is (no jump)', Math.abs(b.run('paddle.x') - (at + 10 * gain)) < 0.01);
  } catch (e) { ck('drag section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const f = bootGame({ fluxRunsPlayed: '0' }); f.g.ctx.newGame(); f.run('playing=true;');
    let rec = record(f); f.g.ctx.draw();
    const hinted = rec.texts.some((t) => t.t === 'Slide anywhere ↔');
    f.g.ctx.pointer({ touches: [{ identifier: 9, clientX: 100, clientY: 760 }] }); f.g.ctx.pointer({ touches: [{ identifier: 9, clientX: 160, clientY: 760 }] });
    rec = record(f); f.g.ctx.draw();
    ck('H1 first run: "Slide anywhere ↔", gone once the player slides', hinted && !rec.texts.some((t) => /Slide anywhere/.test(t.t)));
    const o = bootGame({ fluxRunsPlayed: '3' }); o.g.ctx.newGame(); o.run('playing=true;'); const r2 = record(o); o.g.ctx.draw();
    ck('H1 ...never after the first run', !r2.texts.some((t) => /Slide anywhere/.test(t.t)));
  } catch (e) { ck('hint section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame(); b.g.ctx.newGame();
    ck('K1 catch width, catch test and scoring unchanged', b.run('paddle.w') === 132 && /ball\.x>paddle\.x-paddle\.w\/2-ball\.r/.test(html) && /function paddleWidthFor\(lv\)\{ return Math\.max\(isPhone\(\)\?96:112,\(isPhone\(\)\?132:150\)-\(lv-1\)\*4\); \}/.test(html) && /const perfect=Math\.abs\(hit\)<\.14;/.test(html));
    b.run('playing=true; texts=[]; popup(W/2,150,"COMBO LOST","#8da0c8"); texts[0].y=40;');
    const rec = record(b); b.g.ctx.draw();
    const t = rec.texts.find((x) => x.t === 'COMBO LOST'), top = b.run('maxHudBottom()');
    ck('T1 COMBO LOST (and every popup) stays below the HUD / FLUX meter row', !!t && t.y >= top + 14, t && t.y + ' vs HUD bottom ' + top);
  } catch (e) { ck('K/T section ran', false, String(e.stack || e).slice(0, 300)); }
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
control('grip too small', 'G1', rep('const GRIP_D=58,', 'const GRIP_D=40,'));
control('grip under the home indicator', 'G1', rep('H-fluxSafeBottom-GRIP_GAP-GRIP_D-GRIP_STEM-paddle.h/2', 'H-GRIP_GAP-GRIP_D-GRIP_STEM-paddle.h/2'));
control('grip in a fixed colour', 'G2', rep("ctx.fillStyle=col;ctx.beginPath();ctx.arc(paddle.x,cy,r,0,Math.PI*2);ctx.fill();", "ctx.fillStyle='#62eaff';ctx.beginPath();ctx.arc(paddle.x,cy,r,0,Math.PI*2);ctx.fill();"));
control('no pulse at the start of a run', 'G3', rep('gripPulse=1.6; drag=null;', 'gripPulse=0; drag=null;'));
control('absolute control back (the finger covers the ball)', 'D1', rep('dragTo(t.clientX,t.clientY);', 'setPaddle(t.clientX);'));
control('the whole screen moves the launcher', 'D1 ...a touch higher up', rep('const DRAG_ZONE=0.6;', 'const DRAG_ZONE=0;'));
control('a slow drag (the thumb must cross the whole screen)', 'D2', rep('return Math.max(1,travel/(W*0.45));', 'return 1;'));
control('a new touch continues the old drag (jump)', 'D3', rep('window.ontouchend=window.ontouchcancel=function(e){ if(!drag) return;', 'window.ontouchend=window.ontouchcancel=function(e){ return;'));
control('hint on every run', 'H1 ...never', rep("let first=false; try{ first=!(+localStorage.fluxRunsPlayed>0); }catch(e){}", "let first=true;"));
control('catch width changed', 'K1', rep("paddle.w=isPhone()?132:150; paddle.handleH", "paddle.w=isPhone()?150:150; paddle.handleH"));
control('popups rise into the HUD again', 'T1', rep('ctx.fillText(t.s,t.x,Math.max(t.y,textTop));', 'ctx.fillText(t.s,t.x,t.y);'));
const total = main.F + NC;
console.log('\n' + (total ? 'PADDLE GRIP FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PADDLE GRIP PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
