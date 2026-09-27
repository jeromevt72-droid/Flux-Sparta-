// PADDLE UNDER THE THUMB (players hold the round grip: "the paddle lags"), in the release gate. Real game page in the harness vm.
//   F1 touch-down and every touchmove put the launcher's centre EXACTLY at the finger's x, in the same event, before any frame;
//   F2 ...on iPhone, iPad and iPad mini, full and narrowed launcher, for fast long jumps too (no speed limit);
//   F3 no easing: frames after a move leave the launcher exactly under the finger (the game loop never moves it);
//   F4 at a wall it stops, and the moment the thumb turns back it is under the thumb again;
//   F5 touching the round grip itself and sliding keeps the grip's centre under the thumb the whole way;
//   F6 the launcher narrowing mid-slide keeps it centred on the finger;
//   F7 pointer events drive it too (Chrome holds touchmove back), the newest coalesced sample wins,
//      touch and pointer for one finger agree, another finger's pointer does nothing, a mouse is unchanged.
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

  const coalesced = (pid, xs, pt = 'touch', yy) => ({ type: 'pointermove', pointerType: pt, pointerId: pid, isPrimary: true, clientX: xs[0], clientY: yy,
    getCoalescedEvents: () => xs.map((x) => ({ clientX: x, clientY: yy })) });
  try {
    const b = bootGame(); b.down(1, 200); const atDown = b.px(); b.move(1, 220); const moved = b.px();
    ck('F1 touch-down and a touchmove put the launcher centre exactly at the finger, in the same event', atDown === 200 && moved === 220 && (b.g.listeners.touchmove || []).length === 1, atDown + ' / ' + moved);
    for (let i = 0; i < 20; i++) b.g.ctx.update(1 / 60);
    ck('F3 no easing: 20 frames later the launcher is still exactly under the finger', b.px() === 220, String(b.px()));
  } catch (e) { ck('F1/F3 section ran', false, String(e.stack || e).slice(0, 300)); }
  try {
    const res = []; let ok = true;
    for (const d of [[390, 844], [820, 1180], [744, 1133]]) for (const narrow of [false, true]) {
      const b = bootGame(d); if (narrow) b.run('paddle.w=paddleWidthFor(9); setPaddle(paddle.x);');
      const lo = b.run('paddle.w/2+8'), hi = b.run('W-paddle.w/2-8');
      b.down(1, Math.round(d[0] / 2));
      for (const x of [lo + 3, hi - 3, Math.round(d[0] / 2) + 7, lo + 1]) { b.move(1, x); if (b.px() !== x) { ok = false; res.push(d[0] + (narrow ? 'n' : '') + ':' + x + '->' + b.px()); } }
      b.up();
    }
    ck('F2 exactly under the finger on iPhone, iPad and iPad mini, full and narrowed launcher, even for edge-to-edge jumps in one event', ok, res.join(' '));
  } catch (e) { ck('F2 section ran', false, String(e.stack || e).slice(0, 300)); }
  try {
    const b = bootGame(); b.down(1, 200); b.move(1, 389); const wall = b.px();
    ck('F4 (setup) past the right edge the launcher stops at the wall', Math.abs(wall - b.run('W-paddle.w/2-8')) < 0.01);
    b.move(1, 300);
    ck('F4 turning back, it is under the thumb again at once', b.px() === 300, String(b.px()));
  } catch (e) { ck('F4 section ran', false, String(e.stack || e).slice(0, 300)); }
  try {
    const b = bootGame(); const gx = b.px(), gy = b.run('paddle.y+paddle.h/2+GRIP_STEM+GRIP_D/2');
    const ev = (x) => ({ touches: [{ identifier: 7, clientX: x, clientY: gy }], preventDefault() {} });
    b.g.win.ontouchstart(ev(gx + 4));
    let off = Math.abs(b.px() - (gx + 4));
    for (let x = gx + 4; x > gx - 120; x -= 9) { for (const f of b.g.listeners.touchmove) f(ev(x)); off = Math.max(off, Math.abs(b.px() - x)); }
    ck('F5 holding the round grip and sliding keeps the grip centre under the thumb the whole way', gy >= b.run('H*DRAG_ZONE') && off === 0, 'max offset ' + off);
  } catch (e) { ck('F5 section ran', false, String(e.stack || e).slice(0, 300)); }
  try {
    const b = bootGame(); b.down(1, 180); b.move(1, 190); b.run('paddle.w=paddleWidthFor(9); setPaddle(paddle.x);'); b.move(1, 191);
    ck('F6 the launcher narrowing mid-slide keeps it centred on the finger', b.px() === 191, String(b.px()));
  } catch (e) { ck('F6 section ran', false, String(e.stack || e).slice(0, 300)); }
  try {
    const b = bootGame(), y = Math.round(844 * 0.9);
    b.pdown(3, 150); const pd = b.px(); b.pmove(3, 158);
    ck('F7 pointerdown and pointermove put it under the finger (touchmove held back)', pd === 150 && b.px() === 158, pd + ' / ' + b.px());
    for (const f of b.g.listeners.pointermove) f(coalesced(3, [160, 171, 183], 'touch', y));
    ck('F7 ...the newest coalesced sample wins', b.px() === 183, String(b.px()));
    b.move(3, 190);
    ck('F7 ...the same finger\'s touchmove agrees', b.px() === 190, String(b.px()));
    b.pmove(9, 40);
    ck('F7 ...another finger\'s pointer does not move it', b.px() === 190, String(b.px()));
    b.up(); b.g.win.onpointerup({ pointerId: 3 }); b.pdown(4, 77, 'mouse', 300);
    const clickMoved = b.px() !== 190; b.pmove(4, 77, 'mouse', 300);
    ck('F7 ...a mouse is unchanged: a click moves nothing, the pointer points directly', !clickMoved && b.px() === Math.max(b.run('paddle.w/2+8'), 77), String(b.px()));
  } catch (e) { ck('F7 section ran', false, String(e.stack || e).slice(0, 300)); }
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
const MOVE = 'drag.x=x; drag.y=y; setPaddle(x);';
control('smoothing: the launcher eases toward the finger', 'F1', rep(MOVE, 'drag.x=x; drag.y=y; setPaddle(paddle.x+(x-paddle.x)*.35);'));
control('the move waits for a later frame', 'F1', rep(MOVE, 'drag.x=x; drag.y=y; requestAnimationFrame(function(){ setPaddle(x); });'));
control('touch-down moves nothing (grip jumps on first move)', 'F1', rep("if(tt.clientY>=H*DRAG_ZONE){ drag={id:tt.identifier,pid:null,x0:tt.clientX,x:tt.clientX,y:tt.clientY}; t=tt; break; }", "if(tt.clientY>=H*DRAG_ZONE){ drag={id:tt.identifier,pid:null,x0:tt.clientX,x:tt.clientX,y:tt.clientY}; return; }"));
control('a speed limit per event', 'F2', rep(MOVE, 'drag.x=x; drag.y=y; setPaddle(paddle.x+Math.max(-40,Math.min(40,x-paddle.x)));'));
control('the game loop eases the launcher', 'F3', rep('if(gripPulse>0) gripPulse=Math.max(0,gripPulse-dt);', 'if(gripPulse>0) gripPulse=Math.max(0,gripPulse-dt); paddle.x+=(W/2-paddle.x)*.05;'));
control('relative drag with gain (#28): the grip runs away from the thumb', 'F5', rep(MOVE, 'const dx=x-drag.x; drag.x=x; drag.y=y; setPaddle(paddle.x+dx*1.6);'));
control('anchored drag (#25): a wall leaves a dead zone', 'F4 turning back', both(
  rep("drag={id:tt.identifier,pid:null,x0:tt.clientX,x:tt.clientX,y:tt.clientY};", "drag={id:tt.identifier,pid:null,x0:tt.clientX,x:tt.clientX,y:tt.clientY,p0:paddle.x};"),
  rep(MOVE, 'drag.x=x; drag.y=y; setPaddle(drag.p0==null?x:drag.p0+(x-drag.x0)); if(drag.p0!=null && x>drag.x0+150) drag.x0=x-150;')));
control('an offset kept from touch-down (grip not under the thumb)', 'F5', rep(MOVE, 'if(drag.off==null) drag.off=paddle.x-x; drag.x=x; drag.y=y; setPaddle(x+drag.off+6);'));
control('a narrowed launcher is placed by its old left edge (off-centre)', 'F6', rep(MOVE, 'drag.x=x; drag.y=y; setPaddle(x-(paddle.w-paddleWidthFor(1))/2);'));
control('touch pointer events ignored (nothing until Chrome releases touchmove)', 'F7 pointerdown', rep("if(e.pointerType && e.pointerType!=='mouse'){   // touch/pen", "if(e.pointerType && e.pointerType!=='mouse'){ return;   // touch/pen"));
control('the oldest coalesced sample used', 'F7 ...the newest', rep('if(c && c.length) return c[c.length-1];', 'if(c && c.length) return c[0];'));
control('a mouse click moves the launcher', 'F7 ...a mouse', rep("window.onpointerdown=function(e){ if(e.pointerType && e.pointerType!=='mouse') pointer(e); };", "window.onpointerdown=function(e){ if(e.pointerType==='mouse') setPaddle(e.clientX); else pointer(e); };"));
const total = main.F + NC;
console.log('\n' + (total ? 'PADDLE UNDER THUMB FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PADDLE UNDER THUMB PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
