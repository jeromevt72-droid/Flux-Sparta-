// BATTERY / HEAT, PR A -- LIFECYCLE (owner). Real game page in the harness vm; the frame loop is driven by hand.
//   B1 HIDDEN: while the page is hidden no frame simulates or draws; on return the first frame is one
//      normal step (dt .016) however long it was away; score, combo, lives, level, run clock and spawn
//      timers are exactly as they were;
//   B2 PAUSE: while paused (pause button or revive offer) nothing is simulated or redrawn -- the last
//      frame stays; RESUME: the first frame is one normal step, no physics / spawn / timer jump;
//   B3 MENUS / GAME OVER: nothing is simulated; the sky still moves every frame, but the field (orbs,
//      ball, launcher, particles) is drawn once into its copy and stamped; it is redrawn only when
//      something in it changes (the launcher moves, a skin is equipped, the screen is resized); with a
//      bonus or lightning orb on the field it is drawn live (they pulse with the clock);
//   B4 FLUX MODE: the #app filter and the glow layer are written once when FLUX MODE starts and once
//      when it ends, not every frame, with the same values;
//   B5 during a run every frame still simulates and draws live, exactly as before (D-45 loop shape kept).
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
  const start = (diff = 'hard') => {
    const { store } = makeStore({ fluxPlayerId: 'bl-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '9', fluxColorHintSeen: '1', fluxDifficulty: diff, fluxSeason: '1' });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    g.ctx.readSafeBottom = () => 34; run('innerWidth=390; innerHeight=844;'); g.ctx.resize();
    // SEEDED: the same orbs, ball and spawns every run (unseeded, a ball could hit an orb in B1's single step about 1 run in 60)
    run('(function(){ var s=20261009; Math.random=function(){ s=(s*16807)%2147483647; return (s-1)/2147483646; }; })();');
    run(`difficulty='${diff}'; fluxPerfN=1e9;`); g.ctx.newGame(); run('playing=true; paused=false;');
    // spies: what each frame really does
    run(`window.__u=[]; window.__d=0; window.__f=0; window.__s=0;
      var __upd=update; update=function(dt){ __u.push(dt); return __upd(dt); };
      var __drw=draw; draw=function(){ __d++; return __drw(); };
      var __fld=drawField; drawField=function(){ __f++; return __fld(); };
      var __sky=drawSky; drawSky=function(t){ __s++; return __sky(t); };`);
    let ts = 1000;
    const frame = (gap = 1000 / 60) => { ts += gap; g.ctx.loop(ts); };
    const counts = () => run('({ u:__u.length, d:__d, f:__f, s:__s, lastDt:__u[__u.length-1] })');
    const reset = () => run('__u.length=0; __d=0; __f=0; __s=0;');
    const state = () => run('({ score, combo, misses, level, runClock, growTimer, bonusTimer, speedCountdown, flux, ballX:ball.x, ballY:ball.y, n:targets.length })');
    return { g, run, frame, counts, reset, state };
  };
  try {
    const A = start();
    for (let i = 0; i < 30; i++) A.frame();
    A.reset(); const before = A.state();
    A.g.win.document.hidden = true;
    for (let i = 0; i < 120; i++) A.frame();
    const hid = A.counts(), during = A.state();
    A.g.win.document.hidden = false;
    A.frame(30000);   // the next frame comes 30 s later
    const back = A.counts(), after = A.state();
    ck('B1 hidden: no frame simulates or draws', hid.u === 0 && hid.d === 0, JSON.stringify(hid));
    ck('B1 ...score, combo, lives, level, run clock and spawn timers are untouched while hidden', JSON.stringify(before) === JSON.stringify(during), '');
    ck('B1 back: the first frame is one normal step (dt 0.016), never a jump, however long it was away', back.u === 1 && Math.abs(back.lastDt - .016) < 1e-9 && back.d === 1, JSON.stringify(back));
    // the same seeded run, never hidden, one normal step: being away must leave EXACTLY that state
    const Z = start(); for (let i = 0; i < 30; i++) Z.frame(); Z.frame(16); const twin = Z.state();   // the return step is a fixed 16 ms
    ck('B1 ...and the state moved by exactly that one step (score, combo, lives, level unchanged)', after.score === before.score && after.combo === before.combo && after.misses === before.misses && after.level === before.level && after.runClock - before.runClock < .02
      && JSON.stringify(after) === JSON.stringify(twin), JSON.stringify({ rc: [before.runClock, after.runClock], twin: JSON.stringify(after) === JSON.stringify(twin) }));
  } catch (e) { ck('B1 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    for (const how of ['pause button', 'revive offer']) {
      const A = start();
      for (let i = 0; i < 30; i++) A.frame();
      if (how === 'pause button') A.run('setPaused(true);'); else A.run('offerRevive=offerRevive; paused=true;');
      A.reset(); const before = A.state();
      for (let i = 0; i < 200; i++) A.frame();
      const p = A.counts(), during = A.state();
      if (how === 'pause button') A.run('setPaused(false);'); else A.run('paused=false;');
      A.frame(5000);
      const r = A.counts();
      ck('B2 ' + how + ': nothing simulated or redrawn while paused (the last frame stays)', p.u === 0 && p.d === 0 && JSON.stringify(before) === JSON.stringify(during), JSON.stringify(p));
      ck('B2 ' + how + ': RESUME is one normal step (dt 0.016): no physics, spawn or timer jump', r.u === 1 && Math.abs(r.lastDt - .016) < 1e-9 && r.d === 1, JSON.stringify(r));
    }
  } catch (e) { ck('B2 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const A = start();
    for (let i = 0; i < 30; i++) A.frame();
    A.run('targets=targets.filter(function(t){ return !t.bonus && !t.growing; }); burst(W/2,H/2,"#ffffff",20); endGame();');
    A.reset();
    for (let i = 0; i < 120; i++) A.frame();
    const m = A.counts();
    ck('B3 game over: nothing simulated; the sky moves every frame; the field is drawn once and stamped', m.u === 0 && m.s === 120 && m.d === 120 && m.f === 1, JSON.stringify(m));
    A.reset(); A.run('paddle.x+=40;'); A.frame(); A.frame();
    const mv = A.counts();
    A.reset(); A.run('equipSkin("aurora"); colors=colors.slice();'); A.frame(); A.frame();
    const sk = A.counts();
    A.reset(); A.run('innerWidth=820; innerHeight=1180; resize();'); A.frame(); A.frame();
    const rs = A.counts();
    ck('B3 ...redrawn as soon as something in it changes: the launcher moves, a skin, a resize', mv.f === 1 && sk.f === 1 && rs.f === 1, JSON.stringify({ mv: mv.f, sk: sk.f, rs: rs.f }));
    A.reset(); A.run('targets.push({x:W/2,y:H*.3,r:34,maxR:34,color:0,spin:0,vx:0,vy:0,phase:0,age:5,growing:true,matured:true,danger:false});'); for (let i = 0; i < 10; i++) A.frame();
    const lz = A.counts();
    ck('B3 ...with a lightning orb on the field it is drawn live every frame (it pulses with the clock)', lz.f === 10 && lz.d === 10, JSON.stringify(lz));
    const M = start(); M.run('playing=false; paused=false; targets.length=0;'); M.reset(); for (let i = 0; i < 60; i++) M.frame();
    const mm = M.counts();
    ck('B3 start menu: nothing simulated, sky every frame, field once', mm.u === 0 && mm.s === 60 && mm.f === 1, JSON.stringify(mm));
  } catch (e) { ck('B3 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const A = start();
    let writes = 0, toggles = 0, lastFilter = null, glowOn = null;
    const app = { style: {} }; Object.defineProperty(app.style, 'filter', { set(v) { writes++; lastFilter = v; }, get() { return lastFilter; } });
    const glow = { classList: { toggle(c, on) { toggles++; glowOn = on; }, add() { toggles++; glowOn = true; }, remove() { toggles++; glowOn = false; } } };
    A.g.els.app = app; A.g.els.fluxGlow = glow;
    for (let i = 0; i < 30; i++) A.frame();
    const w0 = writes, t0 = toggles;
    A.run('fluxMode=4;'); for (let i = 0; i < 60; i++) A.frame();
    const w1 = writes, t1 = toggles, onF = lastFilter, onG = glowOn;
    A.run('fluxMode=0.001;'); for (let i = 0; i < 60; i++) A.frame();
    ck('B4 FLUX MODE: the filter and the glow are written once when it starts and once when it ends (not every frame)', w0 === 1 && t0 === 1 && w1 - w0 === 1 && t1 - t0 === 1 && writes - w1 === 1 && toggles - t1 === 1, [w0, w1, writes, t0, t1, toggles].join(','));
    ck('B4 ...with the same values as before (brightness 1.18, saturate 1.35, glow on; then none, glow off)', onF === 'brightness(1.18) saturate(1.35)' && onG === true && lastFilter === 'none' && glowOn === false, onF + ' / ' + lastFilter);
  } catch (e) { ck('B4 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const A = start(); A.reset();
    for (let i = 0; i < 60; i++) A.frame();
    const c = A.counts();
    ck('B5 during a run every frame simulates and draws the field live, as before', c.u === 60 && c.d === 60 && c.f === 60, JSON.stringify(c));
    ck('B5 the loop still schedules the next frame first (D-45) and there is one rAF chain', /function loop\(ts\)\{\n requestAnimationFrame\(loop\);/.test(html) && (html.match(/requestAnimationFrame\(loop\)/g) || []).length === 2, '');
  } catch (e) { ck('B5 section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const t0 = Date.now();
const res = suite(GAME_HTML);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
function control(label, expect, mut) {
  const h = mut(GAME_HTML);
  if (h === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(h, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
control('drawing while hidden', 'B1 hidden', rep(' if(document.hidden || paused){ fluxLoopIdle=true; last=ts; return; }', ' if(paused){ fluxLoopIdle=true; last=ts; return; }'));
control('no re-anchor after hidden / pause', 'B1 back', rep(' if(fluxLoopIdle){ fluxLoopIdle=false; last=ts; }', ''));
control('redrawing while paused', 'B2 pause button: nothing', rep(' if(document.hidden || paused){ fluxLoopIdle=true; last=ts; return; }', ' if(document.hidden){ fluxLoopIdle=true; last=ts; return; }'));
control('the field redrawn every frame under menus', 'B3 game over', rep(' if(fieldIsStill()) stampField(); else drawField();', ' drawField();'));
control('the field copy never refreshed', 'B3 ...redrawn as soon', rep(' if(!fieldCopy || !sameKey(fieldCopyKey,key)){', ' if(!fieldCopy){'));
control('a lightning orb frozen under menus', 'B3 ...with a lightning orb', rep(' for(const t of targets) if(t.bonus || (t.growing && t.matured)) return false;   // these pulse with the clock\n', ''));
control('FLUX look written every frame again', 'B4 FLUX MODE', rep(' if(on===fluxModeLookOn) return;\n', ''));
const total = res.F + NC;
console.log('\n' + (total ? 'BATTERY LIFECYCLE FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'BATTERY LIFECYCLE PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
