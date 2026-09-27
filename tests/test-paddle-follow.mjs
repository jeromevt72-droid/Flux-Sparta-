// PADDLE FOLLOW (players: "the paddle lags behind my thumb"), in the release gate. Real game page in the harness vm.
//   F1 a touchmove moves the launcher in the SAME event (through the real touchmove listener), before any frame runs;
//   F2 it moves at least as far as the thumb slides (gain >= 1) on iPhone, iPad and iPad mini, also with a narrowed launcher;
//   F3 no easing: once moved, frames never drift the launcher further toward some target;
//   F4 at a wall, the moment the thumb turns back the launcher moves back (no dead zone to unwind);
//   F5 the drag is anchored at touch-down, so the first pixels of a slide are not lost;
//   F6 many small moves add up exactly to one big move (nothing lost re-anchoring each event);
//   F7 the launcher narrowing mid-drag never makes it jump;
//   F8 the finger's pointer events drive it too (Chrome holds touchmove back for the first ~15px), the same finger
//      reported by both touch and pointer events moves it once, another finger's pointer does nothing, a mouse is unchanged.
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
  const bootGame = (dims = [390, 844]) => {
    const { store } = makeStore({ fluxPlayerId: 'pf-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '5', fluxColorHintSeen: '1' });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    g.ctx.readSafeBottom = () => 34; run(`innerWidth=${dims[0]}; innerHeight=${dims[1]};`); g.ctx.resize();
    g.ctx.newGame(); run('playing=true; paused=false;');
    const H = dims[1], y = Math.round(H * 0.9);
    const ev = (id, x) => ({ touches: [{ identifier: id, clientX: x, clientY: y }], preventDefault() {} });
    const down = (id, x) => { if (typeof g.win.ontouchstart === 'function') g.win.ontouchstart(ev(id, x)); };
    const move = (id, x) => { for (const f of (g.listeners.touchmove || [])) f(ev(id, x)); };
    const up = () => g.win.ontouchend({ touches: [] });
    const pev = (type, pid, x, pt = 'touch', yy = y) => ({ type, pointerType: pt, pointerId: pid, isPrimary: true, clientX: x, clientY: yy });
    const pdown = (pid, x, pt, yy) => { if (typeof g.win.onpointerdown === 'function') g.win.onpointerdown(pev('pointerdown', pid, x, pt, yy)); };
    const pmove = (pid, x, pt, yy) => { for (const f of (g.listeners.pointermove || [])) f(pev('pointermove', pid, x, pt, yy)); };
    const px = () => run('paddle.x');
    return { g, run, down, move, up, pdown, pmove, px, W: dims[0] };
  };

  try {
    const b = bootGame(); b.down(1, 200); const p0 = b.px(); b.move(1, 220);
    const moved = b.px() - p0;
    ck('F1 a touchmove moves the launcher in the same event, before any frame', moved >= 20 && (b.g.listeners.touchmove || []).length === 1, 'moved ' + moved.toFixed(2));
    const afterMove = b.px(); for (let i = 0; i < 30; i++) b.g.ctx.update(1 / 60);
    ck('F3 no easing: frames after the move leave the launcher exactly where the thumb put it', b.px() === afterMove, afterMove + ' -> ' + b.px());
  } catch (e) { ck('F1/F3 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const res = []; let ok = true;
    for (const dims of [[390, 844], [820, 1180], [744, 1133]]) for (const narrow of [false, true]) {
      const b = bootGame(dims); if (narrow) b.run('paddle.w=isPhone()?96:112; setPaddle(paddle.x);');
      const mid = b.W / 2; b.run('setPaddle(W/2);'); b.down(2, mid);
      let x = mid; let minRatio = Infinity;
      for (let i = 0; i < 20; i++) { const p = b.px(); x += 3; b.move(2, x); if (b.px() < b.run('W-paddle.w/2-8') - 0.01) minRatio = Math.min(minRatio, (b.px() - p) / 3); }
      b.up(); b.run('setPaddle(W/2);'); b.down(3, mid); x = mid;
      for (let i = 0; i < 20; i++) { const p = b.px(); x -= 3; b.move(3, x); if (b.px() > b.run('paddle.w/2+8') + 0.01) minRatio = Math.min(minRatio, (p - b.px()) / 3); }
      res.push(dims[0] + (narrow ? 'n' : '') + ':' + minRatio.toFixed(2)); if (!(minRatio >= 1)) ok = false;
    }
    ck('F2 the launcher moves at least as far as the thumb (iPhone, iPad, iPad mini; full and narrowed launcher)', ok, res.join(' '));
  } catch (e) { ck('F2 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame(); b.down(4, 200); b.move(4, 200 + 390); const wall = b.px();
    ck('F4 (setup) the launcher is at the right wall', Math.abs(wall - b.run('W-paddle.w/2-8')) < 0.01);
    b.move(4, 200 + 390 - 5);
    ck('F4 at the wall, turning the thumb back 5px moves the launcher back at once (>= 5px)', wall - b.px() >= 5, (wall - b.px()).toFixed(2));
    b.up(); b.down(5, 300); b.move(5, 300 - 390); const lw = b.px(); b.move(5, 300 - 390 + 4);
    ck('F4 ...same at the left wall', b.px() - lw >= 4, (b.px() - lw).toFixed(2));
  } catch (e) { ck('F4 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame(); const p0 = b.px(), gain = b.run('dragGain()'); b.down(6, 150); b.move(6, 160);
    ck('F5 the drag is anchored at touch-down: the first 10px of a slide move the launcher', Math.abs(b.px() - (p0 + 10 * gain)) < 0.01, (b.px() - p0).toFixed(2) + ' vs ' + (10 * gain).toFixed(2));
    const c = bootGame(); const q0 = c.px(); c.down(7, 150); c.move(7, 150);
    ck('F5 ...touching down moves nothing by itself', c.px() === q0);
  } catch (e) { ck('F5 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const a = bootGame(), b = bootGame(); a.down(8, 150); b.down(8, 150);
    for (let i = 1; i <= 30; i++) a.move(8, 150 + i * 2); b.move(8, 210);
    ck('F6 thirty 2px moves add up exactly to one 60px move', Math.abs(a.px() - b.px()) < 1e-6, a.px() + ' vs ' + b.px());
  } catch (e) { ck('F6 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame(); b.down(9, 100); b.move(9, 160); const before = b.px();
    b.run('paddle.w=110; setPaddle(paddle.x);'); b.move(9, 160);
    ck('F7 the launcher narrowing mid-drag never makes it jump', Math.abs(b.px() - before) < 0.01, before + ' -> ' + b.px());
  } catch (e) { ck('F7 section ran', false, String(e.stack || e).slice(0, 300)); }
  try {
    const b = bootGame(); const p0 = b.px(), gain = b.run('dragGain()');
    b.pdown(11, 150); b.down(1, 150); b.pmove(11, 154); b.pmove(11, 158);
    ck('F8 pointermove moves the launcher from the first pixels (touchmove held back)', Math.abs(b.px() - (p0 + 8 * gain)) < 0.01, (b.px() - p0).toFixed(2));
    b.move(1, 158); b.pmove(11, 170); b.move(1, 170);
    ck('F8 ...the same finger reported by touch AND pointer events moves it once (20px slide = 20 x gain)', Math.abs(b.px() - (p0 + 20 * gain)) < 0.01, (b.px() - p0).toFixed(2) + ' vs ' + (20 * gain).toFixed(2));
    const k = b.px(); b.pmove(12, 30);
    ck('F8 ...another finger\'s pointer does not move it', b.px() === k);
    b.up(); b.g.win.onpointerup({ pointerId: 11 }); const q0 = b.px(); b.down(2, 200); b.pmove(13, 230);
    ck('F8 ...a drag started from the touch binds the finger\'s pointer too', Math.abs(b.px() - (q0 + 30 * gain)) < 0.01, (b.px() - q0).toFixed(2));
    b.up(); b.g.win.onpointerup({ pointerId: 13 }); const m0 = b.px(); b.pdown(1, 60, 'mouse', 700);
    const clickMoved = b.px() !== m0; b.pmove(1, 77, 'mouse', 300);
    ck('F8 ...a mouse is unchanged: a click moves nothing, the pointer points directly', !clickMoved && b.px() === Math.max(b.run('paddle.w/2+8'), 77), b.px());
  } catch (e) { ck('F8 section ran', false, String(e.stack || e).slice(0, 300)); }
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
const both = (...fs) => (s) => { let o = s; for (const f of fs) { const n = f(o); if (n === o) return s; o = n; } return o; };
const MOVE = 'if(dx) setPaddle(paddle.x+dx*dragGain());'; const MOVEL = 'function dragTo(x,y){ const dx=x-drag.x; drag.x=x; drag.y=y; if(dx) setPaddle(paddle.x+dx*dragGain());';
control('smoothing: the launcher eases toward the thumb', 'F1', both(
  rep(MOVE, 'if(dx) drag.tx=(drag.tx==null?paddle.x:drag.tx)+dx*dragGain();'),
  rep('if(gripPulse>0) gripPulse=Math.max(0,gripPulse-dt);', 'if(gripPulse>0) gripPulse=Math.max(0,gripPulse-dt); if(drag&&drag.tx!=null) setPaddle(paddle.x+(drag.tx-paddle.x)*.35);')));
control('the move waits for a later frame', 'F1', rep(MOVE, 'if(dx) requestAnimationFrame(function(){ setPaddle(paddle.x+dx*dragGain()); });'));
control('gain below 1 (the launcher moves less than the thumb)', 'F2', rep('return Math.max(1,travel/(W*0.45));', 'return 0.7;'));
control('anchored drag (#25): a wall leaves a dead zone when the thumb turns back', 'F4 at the wall', both(
  rep('drag={id:tt.identifier,pid:null,x0:tt.clientX,x:tt.clientX,y:tt.clientY};', 'drag={id:tt.identifier,pid:null,x0:tt.clientX,x:tt.clientX,y:tt.clientY,p0:paddle.x};'),
  rep(MOVE, 'setPaddle(drag.p0+(x-drag.x0)*dragGain());')));
control('drag anchored only at the first touchmove (first pixels lost)', 'F5 the drag', rep('window.ontouchstart=function(e){ pointer(e); };', 'window.ontouchstart=null;'));
control('small moves dropped when re-anchoring each event', 'F6', rep('const dx=x-drag.x; drag.x=x;', 'const dx=Math.abs(x-drag.x)<3?0:x-drag.x; drag.x=x;'));
control('touch pointer events ignored (#25: nothing until Chrome releases touchmove)', 'F8 pointermove', rep("if(e.pointerType && e.pointerType!=='mouse'){   // touch/pen", "if(e.pointerType && e.pointerType!=='mouse'){ return;   // touch/pen"));
control('touch and pointer counted separately (the thumb counted twice)', 'F8 ...the same finger', rep("    dragTo(e.clientX,e.clientY);\n    return;", "    setPaddle(paddle.x+(e.clientX-(drag.px==null?drag.x:drag.px))*dragGain()); drag.px=e.clientX;\n    return;"));
control('a mouse click moves the launcher', 'F8 ...a mouse', rep("window.onpointerdown=function(e){ if(e.pointerType && e.pointerType!=='mouse') pointer(e); };", "window.onpointerdown=function(e){ if(e.pointerType==='mouse') setPaddle(e.clientX); else pointer(e); };"));
const total = main.F + NC;
console.log('\n' + (total ? 'PADDLE FOLLOW FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PADDLE FOLLOW PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
