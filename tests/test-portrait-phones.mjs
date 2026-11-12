// PORTRAIT ON PHONES (owner; testers: on a phone turned to landscape the ball reached the ceiling and it and the
// launcher kept bouncing until the phone was turned back). Real game page in the harness vm, this build against
// origin/main, the game's own loop() driven frame by frame (60 fps), a scripted finger, a seeded Math.random.
//   P1 portrait unchanged: on phones (360x800, 390x844), at every difficulty, 60 s of play is frame-for-frame
//      main's (score, combo, level, orb value, FLUX, lives, run clock, ball, every orb, the launcher);
//   P2 a phone turned sideways mid-run: the run pauses (the normal pause), the rotate screen shows, and 10 s
//      sideways scores nothing and moves nothing; RESUME does nothing while sideways; the field is not re-fit;
//   P3 safety net: even with no resize event, the loop never simulates a frame of a run sideways on a phone;
//   P4 back to portrait: the rotate screen goes, the FLUX PAUSED screen stays (no auto-resume), the run is
//      exactly as it was (same field, ceiling, launcher, every value); RESUME carries on, and the rest of the run
//      is frame-for-frame a run paused and resumed in portrait at the same moment;
//   P5 a run started sideways on a phone waits (nothing of the run starts, not its stats) and starts in portrait;
//   P6 menus and game over sideways: no rotate screen, nothing paused (as today);
//   P7 tablets (800x1280 / 820x1180 screens) and desktop (no touch) unchanged: sideways mid-run keeps playing,
//      the field re-fits once as today, frame-for-frame main;
//   P8 manifest.webmanifest "orientation": "portrait"; the Play app's twa-manifest is not changed here (it
//      needs a rebuild to lock natively: the PR says so);
//   P9 no new buttons (the rotate screen has none), no new listener (17 addEventListener), text >= 11 px.
// Ends with negative controls: each defect MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const MANIFEST = fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest'), 'utf8');
const TWA = fs.readFileSync(path.join(ROOT, 'android', 'twa-manifest.json'), 'utf8');
const git = (a) => { try { return execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } };
const MAIN = git(['show', 'origin/main:public/play/index.html']);
const MAIN_TWA = git(['show', 'origin/main:android/twa-manifest.json']);
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// A real classList for the elements the checks read (the harness gives a stand-in that answers everything).
function el(hidden) { const set = new Set(hidden ? ['hidden'] : []); return { classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); } }, style: {}, textContent: '', onclick: null, _set: set }; }
// screen: [w, h, touchPoints]. A phone is the harness default (a touch screen).
const PHONE = [360, 800, 5], IPHONE = [390, 844, 5], TABLET = [800, 1280, 5], IPAD = [820, 1180, 5], DESKTOP = [1920, 1080, 0];
function bootGame(html, diff, scr, win, seed = 7) {
  const { store } = makeStore({ fluxPlayerId: 'pp-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '9', fluxColorHintSeen: '1', fluxDifficulty: diff, fluxSeason: '1' });
  const pre = `screen.width=${scr[0]}; screen.height=${scr[1]}; navigator.maxTouchPoints=${scr[2]}; innerWidth=${win[0]}; innerHeight=${win[1]};`;
  const g = boot([pre, ...scriptsOf(html)], { origin: 'https://x.test', path: '/play/', store });
  const run = (c) => vm.runInContext(c, g.ctx);
  for (const id of ['rotateOverlay', 'pauseOverlay', 'start', 'gameover']) g.els[id] = el(true);
  g.els.pauseBtn = Object.assign(el(false), { offsetParent: {}, getBoundingClientRect: () => ({ left: 12, top: 12, right: 56, bottom: 56, width: 44, height: 44 }) });
  run('try{ document.getElementById("pauseBtn").onclick=function(){ if(!document.getElementById("start").classList.contains("hidden")) return; if(document.getElementById("gameover").classList.contains("hidden")) setPaused(!paused); }; document.getElementById("resumeBtn").onclick=function(){ setPaused(false); }; }catch(e){}');
  g.ctx.Math = Object.assign(Object.create(Math), { random: seeded(seed) });
  g.ctx.readSafeBottom = () => 0; g.ctx.resize();
  run(`difficulty=${JSON.stringify(diff)};`);
  let ts = 1000, frame = 0;
  const api = {
    g, run,
    size: (w, h, fire = true) => { run(`innerWidth=${w}; innerHeight=${h};`); if (fire) g.ctx.resize(); },
    start: () => { g.els.start._set.add('hidden'); g.ctx.newGame(); run('paused=false;'); },
    // one frame of the game's own loop, with a scripted finger (no random numbers)
    step: (n = 1) => { for (let i = 0; i < n; i++) { frame++; run(`if(playing && !paused && ball) setPaddle(ball.x+34*Math.sin(${frame}/37));`); ts += 1000 / 60; g.ctx.loop(ts); } },
    fp: () => run(`JSON.stringify({score,combo,level,orbValue,flux,fluxMode,misses,runClock,speedStep,playing,paused,
      ball:ball&&[ball.x,ball.y,ball.vx,ball.vy,ball.color], pad:[paddle.x,paddle.y,paddle.w], W, H,
      t:targets.map(function(t){ return [t.x,t.y,t.r,t.color,!!t.growing,!!t.bonus]; })})`),
    shown: (id) => !g.els[id]._set.has('hidden'),
  };
  return api;
}

function suite(html, manifest, twa, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const sec = (name, fn) => { try { fn(); } catch (e) { ck(name + ' section ran', false, String(e.stack || e).slice(0, 300)); } };

  sec('P1', () => {
    if (!MAIN) { ck('P1 main build available', false, 'git show origin/main failed'); return; }
    const rows = []; let ok = true, scored = true;
    for (const [scr, win, name] of [[PHONE, [360, 800], '360x800'], [IPHONE, [390, 844], '390x844']]) for (const diff of ['easy', 'medium', 'hard']) {
      const a = bootGame(html, diff, scr, win, 31), b = bootGame(MAIN, diff, scr, win, 31);
      a.start(); b.start(); let bad = -1;
      for (let f = 0; f < 3600; f++) { a.step(); b.step(); if (a.fp() !== b.fp()) { bad = f; break; } }
      const s = JSON.parse(a.fp()).score; if (!(s > 0)) scored = false;
      if (bad >= 0) ok = false;
      rows.push(name + '/' + diff[0] + (bad >= 0 ? ' DIFFERS at frame ' + bad : ' =' + s));
    }
    ck('P1 portrait on phones is frame-for-frame main (60 s, scripted finger, 2 phones x 3 difficulties: score, combo, level, orb value, FLUX, lives, clock, ball, orbs, launcher)', ok && scored, rows.join(' '));
  });

  let snap = null;
  sec('P2', () => {
    const a = bootGame(html, 'hard', PHONE, [360, 800], 41); a.start(); a.step(120);
    const before = a.fp(), ceil = a.run('maxHudBottom()');
    a.size(800, 360);
    const p = JSON.parse(a.fp());
    ck('P2 turned sideways mid-run: the run pauses (the normal pause screen under the rotate screen)', p.paused === true && p.playing === false && a.shown('pauseOverlay'), JSON.stringify({ paused: p.paused, playing: p.playing }));
    ck('P2 ...the rotate screen shows', a.shown('rotateOverlay'));
    ck('P2 ...the field is not re-fit (it stays the run\'s portrait field: 360x800, same launcher)', p.W === 360 && p.H === 800 && JSON.stringify(p.pad) === JSON.stringify(JSON.parse(before).pad), p.W + 'x' + p.H);
    a.step(600);
    const after = a.fp();
    ck('P2 10 s sideways: nothing scores, nothing moves (score, combo, orb value, FLUX, clock, ball, orbs unchanged)', JSON.stringify({ ...JSON.parse(after), playing: 0, paused: 0 }) === JSON.stringify({ ...JSON.parse(before), playing: 0, paused: 0 }), JSON.parse(before).score + ' -> ' + JSON.parse(after).score);
    a.g.els.resumeBtn = a.g.els.resumeBtn || null; a.run('setPaused(false);'); a.step(60);
    const r = JSON.parse(a.fp());
    ck('P2 RESUME does nothing while sideways (still paused, nothing moved)', r.paused === true && r.playing === false && a.fp() === after && a.shown('rotateOverlay'));
    snap = { before, ceil, a };
  });

  sec('P3', () => {
    const a = bootGame(html, 'medium', PHONE, [360, 800], 43); a.start(); a.step(90);
    const before = a.fp();
    a.size(800, 360, false);   // no resize event at all
    a.step(300);
    const p = JSON.parse(a.fp());
    ck('P3 safety net: with no resize event, the loop still never simulates a frame sideways (paused, rotate screen, nothing changed)', p.paused === true && a.shown('rotateOverlay') && JSON.stringify({ ...p, playing: 0, paused: 0 }) === JSON.stringify({ ...JSON.parse(before), playing: 0, paused: 0 }), p.score + ' vs ' + JSON.parse(before).score);
  });

  sec('P4', () => {
    if (!snap) { ck('P4 needs P2', false); return; }
    const { a, before, ceil } = snap;
    a.size(360, 800);
    const p = JSON.parse(a.fp());
    ck('P4 back to portrait: the rotate screen goes; the FLUX PAUSED screen stays (no auto-resume: RESUME is the player\'s)', !a.shown('rotateOverlay') && a.shown('pauseOverlay') && p.paused === true && p.playing === false);
    ck('P4 ...the run is exactly as it was (same field, ceiling, launcher, score, ball, every orb)', JSON.stringify({ ...p, playing: 0, paused: 0 }) === JSON.stringify({ ...JSON.parse(before), playing: 0, paused: 0 }) && a.run('maxHudBottom()') === ceil);
    a.run('setPaused(false);');
    const q = JSON.parse(a.fp());
    ck('P4 RESUME in portrait carries on', q.playing === true && q.paused === false && !a.shown('pauseOverlay'));
    // the same run, paused and resumed in portrait at the same frame (two portrait resizes, as the rotation made)
    const b = bootGame(html, 'hard', PHONE, [360, 800], 41); b.start(); b.step(120);
    b.run('setPaused(true);'); b.step(600); b.size(360, 800); b.size(360, 800); b.step(60); b.run('setPaused(false);');
    let bad = -1; for (let f = 0; f < 1800; f++) { a.step(); b.step(); if (a.fp() !== b.fp()) { bad = f; break; } }
    ck('P4 ...and the next 30 s are frame-for-frame a run paused and resumed in portrait at the same moment', bad < 0, bad < 0 ? 'score ' + JSON.parse(a.fp()).score : 'differs at frame ' + bad);
  });

  sec('P5', () => {
    const a = bootGame(html, 'medium', PHONE, [800, 360], 51);
    a.run('var __st=fluxRunStartedAt;');
    a.start();
    const p = JSON.parse(a.fp());
    ck('P5 a run started sideways on a phone waits: no run, nothing of it started (not its stats), the rotate screen shows', a.run('runActive') === false && p.playing === false && a.shown('rotateOverlay') && a.run('fluxRunStartedAt===__st'), JSON.stringify({ runActive: a.run('runActive'), playing: p.playing }));
    a.step(120);
    ck('P5 ...still waiting while sideways', a.run('runActive') === false);
    a.size(360, 800);
    const q = JSON.parse(a.fp());
    ck('P5 ...turned to portrait: the run starts, in a portrait field (360x800), the rotate screen gone', a.run('runActive') === true && q.playing === true && q.W === 360 && q.H === 800 && !a.shown('rotateOverlay') && a.run('fluxRunStartedAt!==__st'), q.W + 'x' + q.H);
    a.step(120);
    ck('P5 ...and plays', JSON.parse(a.fp()).ball[1] !== q.ball[1]);
  });

  sec('P6', () => {
    const a = bootGame(html, 'medium', PHONE, [360, 800], 61);
    a.size(800, 360);
    ck('P6 the menu sideways: no rotate screen, nothing paused (as today)', !a.shown('rotateOverlay') && a.run('paused') === false);
    a.size(360, 800); a.start(); a.step(30); a.run('endGame();'); a.size(800, 360);
    ck('P6 game over sideways: no rotate screen (as today)', !a.shown('rotateOverlay') && a.run('runActive') === false);
  });

  sec('P7', () => {
    if (!MAIN) { ck('P7 main build available', false); return; }
    const rows = []; let ok = true;
    for (const [scr, por, land, name] of [[TABLET, [800, 1280], [1280, 800], 'tablet 800x1280'], [IPAD, [820, 1180], [1180, 820], 'iPad 820x1180'], [DESKTOP, [900, 1000], [1280, 720], 'desktop']]) {
      const a = bootGame(html, 'hard', scr, por, 71), b = bootGame(MAIN, 'hard', scr, por, 71);
      a.start(); b.start(); a.step(60); b.step(60); a.size(land[0], land[1]); b.size(land[0], land[1]);
      const p = JSON.parse(a.fp());
      if (!(p.playing && !p.paused && p.W === land[0] && !a.shown('rotateOverlay'))) { ok = false; rows.push(name + ' PAUSED/NOT RE-FIT ' + p.W); continue; }
      let bad = -1; for (let f = 0; f < 1200; f++) { a.step(); b.step(); if (a.fp() !== b.fp()) { bad = f; break; } }
      if (bad >= 0) ok = false;
      rows.push(name + (bad >= 0 ? ' differs at ' + bad : ' ok, ' + JSON.parse(a.fp()).score));
    }
    ck('P7 tablets and desktop unchanged: sideways mid-run keeps playing, re-fits once as today, frame-for-frame main (20 s)', ok, rows.join(' | '));
  });

  sec('P8', () => {
    let m = null; try { m = JSON.parse(manifest); } catch (e) {}
    ck('P8 manifest.webmanifest: "orientation": "portrait" (valid JSON, everything else as before)', m && m.orientation === 'portrait' && m.display === 'standalone' && m.start_url === '/' && m.icons.length === 4, m && m.orientation);
    ck('P8 the Play app\'s twa-manifest is unchanged here (orientation "default" until the rebuild)', MAIN_TWA === null || twa === MAIN_TWA, '');
  });

  sec('P9', () => {
    const btn = (h) => (h.match(/<button\b/g) || []).length;
    const ov = (html.match(/<div id="rotateOverlay"[\s\S]*?<\/small><\/div>/) || [''])[0];
    ck('P9 no new buttons (the rotate screen has none)', MAIN === null || btn(html) === btn(MAIN), btn(html) + ' vs ' + (MAIN && btn(MAIN)));
    ck('P9 ...the rotate screen says "Rotate to portrait to keep playing", no button', /Rotate to portrait to keep playing/.test(ov) && !/<button/.test(ov), ov.slice(0, 120));
    ck('P9 no new listener: 17 addEventListener( as before', (html.match(/addEventListener\(/g) || []).length === 17);
    const css = (html.match(/#rotateOverlay[^{]*\{[^}]*\}/g) || []).join(' ');
    const sizes = [...css.matchAll(/font-size:(\d+)px/g)].map((x) => +x[1]);
    ck('P9 rotate screen text is 11 px or more, and above every other layer (z-index 90)', sizes.length > 0 && sizes.every((s) => s >= 11) && /#rotateOverlay\{[^}]*z-index:90/.test(css), sizes.join(','));
  });
  return { F, failed };
}

const res = suite(GAME, MANIFEST, TWA);
console.log('\n== negative controls: each defect MUST be caught ==');
let NC = 0;
function control(label, expect, edit) {
  const [h, m, t] = edit(GAME, MANIFEST, TWA);
  if (h === GAME && m === MANIFEST && t === TWA) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(h, m, t, true); const hit = r.failed.filter((f) => f.startsWith(expect));
  console.log((hit.length ? '  PASS  caught: ' : '  FAIL  NOT caught: ') + label + '  [' + (hit[0] || r.failed.slice(0, 2).join(' | ') || 'nothing failed') + ']');
  if (!hit.length) NC++;
}
const rep = (a, b) => (h, m, t) => [h.includes(a) ? h.replace(a, b) : h, m, t];
control('no pause on turning (resize does not check)', 'P2 turned sideways', (h, m, t) => [h.replace('if(FLUX_PHONE)fluxOrientCheck();/* PORTRAIT ON PHONES */', '').replace(" if(playing && FLUX_PHONE && innerWidth>innerHeight){ fluxOrientCheck(); fluxLoopIdle=true; last=ts; return; }", ''), m, t]);
control('the loop safety net removed', 'P3 safety net', rep(" if(playing && FLUX_PHONE && innerWidth>innerHeight){ fluxOrientCheck(); fluxLoopIdle=true; last=ts; return; }", ''));
control('the field re-fit while sideways (as before)', 'P2 ...the field is not re-fit', rep('&&!fluxPhoneLandscape())fluxRunField=fluxFieldMeasure();', ')fluxRunField=fluxFieldMeasure();'));
control('RESUME allowed while sideways', 'P2 RESUME does nothing', rep(" if(!next && fluxPhoneLandscape()){ fluxOrientCheck(); return; }", ''));
control('auto-resume on turning back', 'P4 back to portrait', rep("  ov.classList.add('hidden');\n  if(fluxRotateStart)", "  ov.classList.add('hidden'); if(runActive && paused) setPaused(false);\n  if(fluxRotateStart)"));
control('no rotate screen (pause only)', 'P2 ...the rotate screen shows', rep("    ov.classList.remove('hidden');\n    return;", "    return;"));
control('a run started sideways is not held', 'P5 a run started sideways', rep("if(fluxPhoneLandscape()){ fluxRotateStart=function(){ newGame1.apply(self,args); }; fluxOrientCheck(); return; }", ''));
control('the held run starts innermost (its stats start at the tap)', 'P5 a run started sideways', (h, m, t) => {
  const w = "/* PORTRAIT ON PHONES: a run started while a phone is sideways waits for portrait. The outermost wrapper (the last\n   one set), so nothing of the run -- not its stats, not its clock -- starts before the phone is in portrait. */\n{ const newGame1=newGame; newGame=function(){\n    const self=this, args=arguments;\n    if(fluxPhoneLandscape()){ fluxRotateStart=function(){ newGame1.apply(self,args); }; fluxOrientCheck(); return; }\n    fluxRotateStart=null;\n    return newGame1.apply(self,args); }; }\n";
  if (!h.includes(w)) return [h, m, t];
  const body = w.split('\n').slice(2).join('\n');
  return [h.replace(w, '').replace("let fluxRotateStart=null;", "let fluxRotateStart=null;\n" + body.replace('{ const newGame1', '{ const newGame1').trim() + "\n"), m, t];
});
control('the rotate screen on the menu too', 'P6 the menu sideways', rep("if(!runActive && !fluxRotateStart){ ov.classList.add('hidden'); return; }", ''));
control('tablets treated as phones (shorter side under 900)', 'P7 tablets and desktop', rep('if(!(s>0 && s<600)) return false;', 'if(!(s>0 && s<900)) return false;'));
control('desktop treated as a phone (no touch check, any screen)', 'P7 tablets and desktop', rep('if(!(s>0 && s<600)) return false;\n    return (navigator.maxTouchPoints||0)>0 || !!(window.matchMedia && window.matchMedia(\'(pointer: coarse)\').matches);', 'return true;'));
control('a portrait change (the loop check without the sideways test)', 'P1 portrait on phones', rep(" if(playing && FLUX_PHONE && innerWidth>innerHeight){ fluxOrientCheck(); fluxLoopIdle=true; last=ts; return; }", " if(playing && FLUX_PHONE){ fluxOrientCheck(); fluxLoopIdle=!fluxLoopIdle; if(fluxLoopIdle){ last=ts; return; } }"));
control('manifest left at "any"', 'P8 manifest.webmanifest', (h, m, t) => [h, m.replace('"orientation": "portrait"', '"orientation": "any"'), t]);
control('the Play app manifest changed without a rebuild note', 'P8 the Play app', (h, m, t) => [h, m, t.replace('"orientation": "default"', '"orientation": "portrait"')]);
control('a button on the rotate screen', 'P9 no new buttons', rep('<small>Your run is paused.</small>', '<button id="rotOk">OK</button><small>Your run is paused.</small>'));
control('a new listener', 'P9 no new listener', rep('function fluxOrientCheck(){', "addEventListener('orientationchange',function(){});\nfunction fluxOrientCheck(){"));

const total = res.F + NC;
console.log('\n' + (total ? 'PORTRAIT ON PHONES FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PORTRAIT ON PHONES PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
