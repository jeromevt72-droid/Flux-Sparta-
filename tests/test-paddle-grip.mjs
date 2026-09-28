// PADDLE GRIP + RELATIVE DRAG (tester feedback), in the release gate. Real game page in the harness vm.
//   G1 a round grip (camera-shutter style, 56-60pt) under the launcher, joined by a stem, in the
//      launcher's colour with a lighter ring, and always above the iPhone home indicator;
//   G2 it follows each skin's launcher colour; G3 it pulses gently at the start of each run only;
//   G4 the old T-handle is gone;
//   D1 a finger that starts in the bottom 40% puts the launcher's centre at the finger's x (the grip stays under the thumb);
//      a touch higher up does nothing; a mouse still points directly;
//   D2 the thumb at either edge takes the launcher to that wall;
//   D3 touching again puts it under the new finger; a second finger does not take it over;
//   H1 "Slide anywhere ↔" on the first run only, gone once the player slides;
//   K1 catch width, catch test and scoring unchanged;
//   T1 popups such as COMBO HALVED never rise into the HUD / FLUX meter row.
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
    const W = 390, H = 844;
    const mv = (id, x, y) => b.g.ctx.pointer({ touches: [{ identifier: id, clientX: x, clientY: y }] });
    mv(1, 100, 700); const atDown = b.run('paddle.x'); mv(1, 130, 700);
    ck('D1 a finger in the bottom 40% puts the launcher centre exactly at the finger (touch-down and every move)', atDown === 100 && b.run('paddle.x') === 130, atDown + ' / ' + b.run('paddle.x'));
    const before = b.run('paddle.x'); b.g.win.ontouchend({ touches: [] }); mv(2, 300, 300); mv(2, 20, 300);
    ck('D1 ...a touch higher up (top 60%) does nothing', b.run('paddle.x') === before);
    b.g.ctx.pointer({ pointerType: 'mouse', clientX: 77 });
    ck('D1 ...a mouse still points directly', b.run('paddle.x') === Math.max(b.run('paddle.w/2+8'), 77));
    b.g.ctx.pointer({ pointerType: 'touch', clientX: 380 });
    ck('D1 ...a stray touch "pointer" event (no drag under way) moves nothing', b.run('paddle.x') === Math.max(b.run('paddle.w/2+8'), 77));
    b.g.win.ontouchend({ touches: [] });
    mv(3, 195, 760); mv(3, W - 2, 760); const right = b.run('paddle.x'); mv(3, 2, 760); const left = b.run('paddle.x');
    ck('D2 the thumb at either edge takes the launcher to that wall',
      Math.abs(right - b.run('W-paddle.w/2-8')) < 0.01 && Math.abs(left - b.run('paddle.w/2+8')) < 0.01, right + ' / ' + left);
    b.g.win.ontouchend({ touches: [] }); mv(4, 250, 800);
    b.g.ctx.pointer({ touches: [{ identifier: 4, clientX: 260, clientY: 800 }, { identifier: 5, clientX: 60, clientY: 790 }] });
    ck('D3 touching again puts the launcher under the new finger; a second finger does not take it over', b.run('paddle.x') === 260, b.run('paddle.x'));
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
    b.run('playing=true; texts=[]; popup(W/2,150,"COMBO HALVED","#8da0c8"); texts[0].y=40;');
    const rec = record(b); b.g.ctx.draw();
    const t = rec.texts.find((x) => x.t === 'COMBO HALVED'), top = b.run('maxHudBottom()');
    ck('T1 COMBO HALVED (and every popup) stays below the HUD / FLUX meter row', !!t && t.y >= top + 14, t && t.y + ' vs HUD bottom ' + top);
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
control('relative drag back (the grip slides away from the thumb)', 'D1', rep('drag.x=x; drag.y=y; setPaddle(x);', 'const dx=x-drag.x; drag.x=x; drag.y=y; setPaddle(paddle.x+dx*1.6);'));
control('the whole screen moves the launcher', 'D1 ...a touch higher up', rep('const DRAG_ZONE=0.6;', 'const DRAG_ZONE=0;'));
control('the launcher stops short of the walls', 'D2', rep('function setPaddle(x){paddle.x=Math.max(paddle.w/2+8,Math.min(W-paddle.w/2-8,x))}', 'function setPaddle(x){paddle.x=Math.max(paddle.w/2+40,Math.min(W-paddle.w/2-40,x))}'));
control('any finger takes the launcher', 'D3', rep('    if(drag){ for(let i=0;i<e.touches.length;i++) if(e.touches[i].identifier===drag.id){ t=e.touches[i]; break; }', '    if(drag){ const L=e.touches[e.touches.length-1]; if(L && L.clientY>=H*DRAG_ZONE) t=L;'));
control('hint on every run', 'H1 ...never', rep("let first=false; try{ first=!(+localStorage.fluxRunsPlayed>0); }catch(e){}", "let first=true;"));
control('catch width changed', 'K1', rep("paddle.w=isPhone()?132:150; paddle.handleH", "paddle.w=isPhone()?150:150; paddle.handleH"));
control('popups rise into the HUD again', 'T1', rep('ctx.fillText(t.s,t.x,Math.max(t.y,textTop));', 'ctx.fillText(t.s,t.x,t.y);'));
const total = main.F + NC;
console.log('\n' + (total ? 'PADDLE GRIP FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PADDLE GRIP PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
