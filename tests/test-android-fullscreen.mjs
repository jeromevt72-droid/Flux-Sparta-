// ANDROID FULL SCREEN IN THE INSTALLED APP (owner, BLU G45).
//   A1 the installed Android app hides the system buttons (full screen, navigationUI 'hide'); iPhone, iPad
//      (desktop-style UA), a plain Chrome tab, the Gateway's demo frame and desktops never do;
//   W1 BUTTONS HIDDEN FOR THE WHOLE GAME: runs, pause, game over and the game's menu keep full screen; FLUX
//      never leaves it itself (the Gateway shows the buttons: leaving the page ends full screen by itself); the
//      next finger lift anywhere in the game hides them again; a touch-down never asks (not a tap for Chrome);
//   W2 BACK while the buttons show: during a run (and the revive question) the run goes on, nothing pauses or
//      ends it; on the pause screen, game over and the game's menu FLUX goes back, as today -- but never when the
//      page was hidden (Home / app switch) and never off the end of the history;
//   R1 a run in the Android app starts once full screen is in; Chrome refusing or not answering (FS_WAIT_MS)
//      starts it at once, and only once; one request at a time; elsewhere a run starts at once;
//   D1 LOWER LAUNCHER, SAME GAME (owner, #78 option D): in Android full screen the game is exactly today's (the
//      field is the game area before the bars went: 728 of 800 on the BLU G45; today's launcher line, orb area
//      and ball speed); only the picture moves: the field is drawn lower so the launcher's grip ends 6% of the
//      screen above the bottom edge; every other device is exactly as today (no shift);
//   R2 ONE FIELD PER RUN: the back button / bars coming back never resize the field during the run;
//   B1 the background layers keep the field's shape and fill the whole screen when the screen is not the
//      field's size (no band); a new level keeps it; a skin backdrop is left alone; today's background comes back;
//   C1 the field canvas covers the whole screen (HS); every frame clears it; the combo / FLUX edge light runs to
//      the screen bottom; gameplay never reads HS;
//   A5 wiring: no new listeners (17), the frame loop untouched (2), the same stars when the size is the same.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; BLU G45) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
// The full-screen / field block and resize() of the real page, with the rest of the game stubbed.
function rig(src, { ua = UA.android, standalone = true, framed = false, platform = 'Linux armv8l', reject = false, histLen = 2 } = {}) {
  const a = src.indexOf('let fluxRunField=null;'), z = src.indexOf("\naddEventListener('resize',resize);resize();", a);
  const calls = [], cls = new Set(), props = {}, timers = [], starts = [];
  let fsEl = null;
  const root = {
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
    style: { setProperty: (k, v) => { props[k] = v; } },
    requestFullscreen(o) { calls.push('enter:' + (o && o.navigationUI)); return { then: (ok, no) => { api.settle = () => (reject ? no(new Error('denied')) : ok()); } }; },
  };
  const overlay = { hidden: true, classList: { contains: (c) => c === 'hidden' && overlay.hidden } };
  const app = { style: { background: '' } };
  const document = { documentElement: root, fullscreenEnabled: true, hidden: false, get fullscreenElement() { return fsEl; },
    exitFullscreen() { calls.push('exit'); return { catch() {} }; },
    getElementById: (id) => (id === 'app' ? app : id === 'pauseOverlay' ? overlay : null) };
  const win = { matchMedia: (q) => ({ matches: standalone && /display-mode: standalone/.test(q) }) };
  win.self = win; win.top = framed ? {} : win;
  const THEMES = ['radial-gradient(circle at 50% 15%,#111b43 0,#07091d 48%,#03040d 100%)', 'radial-gradient(circle at 50% 12%,#152852 0,#0a1230 48%,#03040d 100%)'];
  const history = { length: histLen, backs: 0, back() { history.backs++; } };
  const g = { navigator: { userAgent: ua, platform }, document, window: win, history, innerHeight: 728, innerWidth: 360, devicePixelRatio: 2, Math, String, JSON,
    W: 0, H: 0, dpr: 1, runActive: false, paused: false, fluxSafeBottom: 0, stars: [], nebulae: [],
    c: { width: 0, height: 0, style: {} }, ctx: { setTransform() {} }, paddle: { h: 12, y: 0 }, GRIP_STEM: 10, GRIP_D: 58, GRIP_GAP: 6,
    readSafeBottom: () => 0, maxHudBottom: () => 138, makeStars() {}, refreshHudRects() {},
    setTimeout: (f) => { timers.push(f); return timers.length; }, requestAnimationFrame: (f) => { f(0); return 1; },
    newGame() { starts.push({ H: g.H, W: g.W }); g.runActive = true; }, endGame() { g.runActive = false; },
    CELESTIAL_BG_ENABLED: true, CELESTIAL_THEMES: THEMES, celestialIndex: 0, skin: false,
    applyCelestialBackground(l) { g.celestialIndex = l - 1; app.style.background = THEMES[g.celestialIndex]; }, applySkinBackground() { app.style.background = g.skin ? 'transparent' : THEMES[g.celestialIndex]; } };
  g.skinBackdropOn = () => g.skin;
  vm.createContext(g);
  vm.runInContext(src.slice(a, z) + '\n;resize();globalThis.__st=()=>({field:fluxRunField,HS,fit:fluxFsFit,waiting:!!fluxFsStartNext,shift:fluxFieldShift});', g);
  const api = {
    g, calls, cls, props, starts, history, app, THEMES, overlay, settle: () => {},
    st: () => g.__st(),
    tick() { const t = timers.splice(0); t.forEach((f) => f()); },
    entered(h = 800) { fsEl = root; g.innerHeight = h; g.resize(); document.onfullscreenchange && document.onfullscreenchange(); },
    left(h = 728) { fsEl = null; g.innerHeight = h; document.onfullscreenchange && document.onfullscreenchange(); },
    hide(v) { document.hidden = v; },
  };
  return api;
}
function suite(src, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const fn = (name) => { const i = src.indexOf(name); return i < 0 ? '' : src.slice(i, src.indexOf('\n}', i)); };
  try {
    let r = rig(src); r.g.newGame();
    ck("A1 installed Android app: the system buttons are hidden (full screen, navigationUI 'hide')", r.calls.join() === 'enter:hide', r.calls.join());
    const never = { iPhone: { ua: UA.iphone, platform: 'iPhone' }, 'iPad (desktop-style)': { ua: UA.ipad, platform: 'MacIntel' }, 'Chrome tab': { standalone: false }, 'Gateway demo frame': { framed: true }, desktop: { ua: UA.desktop } };
    const bad = Object.entries(never).filter(([, o]) => { const q = rig(src, o); q.g.newGame(); q.g.fluxFsEnter(); return q.calls.length || q.starts.length !== 1; }).map(([k]) => k);
    ck('A1 never on iPhone, iPad, a plain Chrome tab, the Gateway demo frame, or a desktop (and there a run starts at once)', bad.length === 0, bad.join(', '));

    // R1: the run waits for full screen
    ck('R1 the Android app: the run does not start before full screen is in', r.starts.length === 0 && r.st().waiting);
    r.g.innerHeight = 800; r.g.resize();   // the screen grows before Chrome reports full screen
    r.settle(); r.entered();
    ck('R1 ...then it starts once', r.starts.length === 1, JSON.stringify(r.starts));
    const today = (H, safe) => Math.min(H - Math.max(42, Math.min(90, H * .095)), H - safe - 6 - 58 - 10 - 6);
    ck('D1 the play field is today\'s: the game area before the bars went (728 of 800)', r.starts[0].H === 728 && r.st().field.h === 728 && r.st().field.s === 800 && r.st().HS === 800, JSON.stringify(r.st().field));
    ck('D1 the game itself is today\'s: today\'s launcher line in the field, ball speed measured from it as today', r.g.paddle.y === today(728, 0) && /function playAreaHeight\(\)\{ return Math\.max\(200,paddle\.y-maxHudBottom\(\)\); \}/.test(src), r.g.paddle.y);
    ck('D1 only the picture moves: the field is drawn lower, so the grip ends 6% of the screen (48 px) above the bottom edge', r.st().shift === 30 && Math.abs(800 - (r.g.paddle.y + r.st().shift + 6 + 10 + 58) - 48) < 1e-9 &&
      /ctx\.save\(\);ctx\.translate\(sx,sy\+fluxFieldShift\);/.test(fn('function draw(){')), 'shift ' + r.st().shift);
    ck('D1 ...the score boxes and their banners are not moved (drawn outside the shifted field)', /ctx\.restore\(\);\n drawSlotBanners\(\);/.test(fn('function draw(){')));
    const ip = rig(src, { ua: UA.iphone, platform: 'iPhone' }); ip.g.innerHeight = 844; ip.g.readSafeBottom = () => 34; ip.g.resize(); ip.g.newGame();
    ck('D1 every other device exactly as today: the launcher where it was, nothing shifted, orbs down to 79% of the screen',
      ip.g.paddle.y === today(844, 34) && ip.st().shift === 0 && !/orbFloor|ORB_FREE_SHARE/.test(src) && (src.match(/H\*\.79/g) || []).length === 4, ip.g.paddle.y + ' / ' + ip.st().shift);
    // B1 in full screen: today's field (728) on a taller screen (800)
    const geo = r.app.style.background.match(/circle ([\d.]+)px at 50% ([\d.]+)px/) || [];
    const y = 728 * .15, R = Math.sqrt(180 * 180 + (728 - y) * (728 - y));
    ck('B1 the screen is taller than the field: the level background keeps the field\'s exact shape (in px) and fills the screen', r.cls.has('fluxFsRun') && r.props['--fluxFsH'] === '728px' && Math.abs(+geo[2] - y) < 0.06 && Math.abs(+geo[1] - R) < 0.06, r.app.style.background);
    ck('B1 the pressure glow too', r.props['--fluxFsPR'] === Math.hypot(180, 728).toFixed(1) + 'px' &&
      ['#ffc44730 0%,transparent 60%', '#ffc44755 0%,transparent 62%', '#ff4f6870 0%,transparent 66%'].every((st) => src.includes('radial-gradient(circle var(--fluxFsPR) at 50% var(--fluxFsH),' + st + ')')));
    r.g.applyCelestialBackground(2);
    ck('B1 a new level meanwhile: the new background, same shape', /^radial-gradient\(circle [\d.]+px at 50% 87\.4px,#152852/.test(r.app.style.background), r.app.style.background);
    r.g.skin = true; r.g.applySkinBackground();
    ck('B1 a skin backdrop (already painted over the whole screen) is left alone', r.app.style.background === 'transparent');
    r.g.skin = false; r.g.applySkinBackground();
    r.tick();
    ck('R1 ...and the wait timer that fires later does not start it twice', r.starts.length === 1);
    let q = rig(src, { reject: true }); q.g.newGame(); q.settle();
    ck('R1 Chrome refuses: the run starts at once, with the normal screen (728)', q.starts.length === 1 && q.starts[0].H === 728);
    q = rig(src); q.g.newGame(); q.tick();
    ck('R1 Chrome does not answer within FS_WAIT_MS: the run starts anyway, once', q.starts.length === 1 && /const FS_WAIT_MS=900;/.test(src));
    q.entered(); ck('R1 ...and full screen arriving after that does not start a second run', q.starts.length === 1);
    let okTap = false, why = '';
    try { q = rig(src); q.g.newGame(); q.g.fluxFsEnter(); q.g.fluxFsEnter(); okTap = q.calls.length === 1 && q.starts.length === 0; why = q.calls.join() + ' starts ' + q.starts.length; } catch (e) { why = String(e).slice(0, 120); }
    ck('R1 one request at a time, and a tap while Chrome is answering does not start the run early', okTap, why);

    // R2 + W2: back during a run
    const fieldBefore = JSON.stringify([r.g.W, r.g.H, r.g.paddle.y, r.st().shift]);
    r.left();
    ck('R2 ONE FIELD PER RUN: back pressed mid-run (the bars come back), the field keeps its size, launcher and place on screen', JSON.stringify([r.g.W, r.g.H, r.g.paddle.y, r.st().shift]) === fieldBefore && r.g.c.style.height === '728px', JSON.stringify([r.g.W, r.g.H, r.g.paddle.y, r.st().shift]) + ' css ' + r.g.c.style.height);
    ck('B1 the screen is the field\'s size again (the bars are back): today\'s background exactly', !r.cls.has('fluxFsRun') && r.app.style.background === r.THEMES[1], r.app.style.background);
    r.tick();
    ck('W2 back during a run: the run goes on (no going back, nothing paused or ended)', r.history.backs === 0 && r.g.runActive && !r.g.paused);
    ck('W2 ...the full-screen code never touches the run state', !/paused\s*=|playing\s*=|runActive\s*=|setPaused\(|endGame\(\)/.test(src.slice(src.indexOf('let fluxRunField=null;'), src.indexOf("{ const newGame0=newGame;"))));

    // W2 on the pause screen, game over, the menu
    r.overlay.hidden = false; r.g.paused = true; r.left(); r.tick();
    ck('W2 back on the pause screen: FLUX goes back, as today', r.history.backs === 1);
    r.entered(); r.overlay.hidden = true; r.g.paused = false; r.g.endGame(); r.left(); r.tick();
    ck('W2 back on game over / the game\'s menu: FLUX goes back, as today', r.history.backs === 2);
    r.entered(); r.hide(true); r.left(); r.tick();
    ck('W2 Home or app switching (the page is hidden): nothing happens', r.history.backs === 2);
    r.hide(false);
    q = rig(src); q.g.newGame(); q.settle(); q.entered(); q.g.paused = true; q.left(); q.tick();
    ck('W2 the revive question (paused, but no pause screen): the run goes on, no going back', q.history.backs === 0);
    q = rig(src, { histLen: 1 }); q.g.endGame(); q.entered(); q.left(); q.tick();
    ck('W2 nothing to go back to: FLUX does not go back (the next Back closes the app, as today)', q.history.backs === 0);

    // W1 whole game
    ck('W1 FLUX never leaves full screen itself (pause, game over and END RUN & MENU keep it; the Gateway shows the buttons)', !/exitFullscreen\(|fluxFsExit/.test(src));
    ck('W1 the next finger lift anywhere in the game hides the buttons again (not while a run waits to start); a touch-down never asks',
      /window\.ontouchend=window\.ontouchcancel=function\(e\)\{ tryResumeAudio\(\); if\(e\.type==='touchend' && !document\.fullscreenElement && !fluxFsStartNext\) fluxFsEnter\(\);/.test(src) && !/ontouchstart=function\(e\)\{[^\n]*fluxFsEnter/.test(src));
    ck('W1 RESUME asks again too', /last=performance\.now\(\);\n   fluxFsEnter\(\);/.test(fn('function setPaused(next){')));
    ck('W1 newGame itself (gameplay) is untouched: the wait lives in a wrapper', !/fluxFs/.test(fn('function newGame(){')) && /\{ const newGame0=newGame; newGame=function\(\)\{/.test(src));

    // C1 field canvas to the edge
    ck('C1 the field canvas covers the whole screen (HS = the field, or the screen when taller) and play uses H',
      /W=f\.w;H=f\.h;HS=Math\.max\(H,innerHeight\);/.test(src) && /c\.height=HS\*dpr;/.test(src) && !/c\.height=H\*dpr/.test(src) && !/html\.fluxFsRun #game[,{]/.test(src));
    ck('C1 every frame clears the whole canvas', /function draw\(\)\{\n ctx\.clearRect\(0,0,W,HS\|\|H\);/.test(src));
    const jz = fn('function drawJuiceUnderOrbs(){');
    ck('C1 the combo / FLUX edge light carries on to the screen bottom', /ctx\.rect\(0,bot,W,H-bot\); if\(HS>H\) ctx\.rect\(0,H,W,HS-H\);/.test(jz) && /if\(HS>H\)\{ ctx\.fillStyle='rgb\('\+rgb\+'\)'; ctx\.fillRect\(0,H,W,HS-H\); \}/.test(jz));
    const gp = ['function update(', 'function newGame(', 'function registerMiss(', 'function addTarget(', 'function setPaddle(', 'function orbFieldRect(', 'function playAreaHeight('].filter((n) => /\bHS\b/.test(fn(n)));
    ck('C1 gameplay never reads HS', gp.length === 0, gp.join(', '));

    ck('A5 no new listeners in the game (17)', (src.match(/addEventListener\(/g) || []).length === 17, (src.match(/addEventListener\(/g) || []).length);
    ck('A5 the frame loop is untouched (2)', (src.match(/requestAnimationFrame\(loop\)/g) || []).length === 2);
    ck('A5 the same stars when the size is the same; the canvas is only resized when its pixel size changes', /const same=\(W===pW&&H===pH&&dpr===pD\);if\(!same\|\|c\.width!==Math\.floor\(W\*dpr\)\|\|c\.height!==Math\.floor\(HS\*dpr\)\)\{c\.width=W\*dpr;c\.height=HS\*dpr;/.test(src) && /if\(same\)\{const s0=stars,n0=nebulae;makeStars\(\);stars=s0;nebulae=n0;\}else makeStars\(\);/.test(src));
  } catch (e) { ck('suite ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const res = suite(GAME);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, a, b) {
  if (!GAME.includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(GAME.split(a).join(b), true); const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
control('buttons left visible', 'A1 installed Android app', "requestFullscreen({navigationUI:'hide'})", 'requestFullscreen()');
control('iPhone too', 'A1 never', "if(!/Android/i.test(navigator.userAgent) || fluxIsIOSDevice() || window.top!==window.self) return false;", 'if(window.top!==window.self) return false;');
control('Chrome tabs too', 'A1 never', "return mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)') || mm('(display-mode: minimal-ui)');", 'return true;');
control('the run starts before full screen is in', 'R1 the Android app', "if(fluxFsWanted() && !document.fullscreenElement){ fluxFsStartNext=start; fluxFsEnter(); setTimeout(fluxFsGo,FS_WAIT_MS); return; }", "if(fluxFsWanted() && !document.fullscreenElement){ fluxFsEnter(); }");
control('the run can start twice', 'R1 ...and the wait timer', 'function fluxFsGo(){ const go=fluxFsStartNext; fluxFsStartNext=null; if(go) go(); }', 'function fluxFsGo(){ const go=fluxFsStartNext; if(go) go(); }');
control('a refusal leaves the run waiting', 'R1 Chrome refuses', 'function(){ fluxFsAsking=false; fluxFsGo(); }); else', 'function(){ fluxFsAsking=false; }); else');
control('a tap while waiting starts the run early', 'R1 one request', '  if(fluxFsAsking) return;   //', '  if(fluxFsAsking){ fluxFsGo(); return; }   //');
control('the field is not drawn lower', 'D1 only the picture', 'ctx.translate(sx,sy+fluxFieldShift);', 'ctx.translate(sx,sy);');
control('the launcher itself moved (a longer field: the BLU harder)', 'D1 the game itself', 'fluxFieldShift=f.fs?Math.max(0,fluxLowLauncherY(f.s,fluxSafeBottom)-paddle.y):0;', 'fluxFieldShift=0;if(f.fs)paddle.y=fluxLowLauncherY(f.s,fluxSafeBottom);');
control('the field grows to the whole screen', 'D1 the play field is today', 'h:keep?fluxPlainH.h:innerHeight', 'h:innerHeight');
control('the growing screen is taken for today\'s area', 'D1 the play field is today', 'if(!document.fullscreenElement&&!fluxFsAsking)fluxPlainH=', 'if(!document.fullscreenElement)fluxPlainH=');
control('the field follows the window mid-run', 'R2 ONE FIELD PER RUN', 'const f=fluxRunField||fluxFieldMeasure();', 'const f=fluxFieldMeasure();');
control('back during a run goes back', 'W2 back during a run', '  if(runActive && !onPause) return;', '');
control('back on pause does nothing', 'W2 back on the pause screen', 'if(history.length>1) history.back();', '');
control('Home navigates back', 'W2 Home or app switching', 'if(document.hidden || document.fullscreenElement) return;', 'if(document.fullscreenElement) return;');
control('back off the end of the history', 'W2 nothing to go back to', 'if(history.length>1) history.back();', 'history.back();');
control('game over shows the buttons again', 'W1 FLUX never leaves', ' playing=false; runActive=false;\n', ' playing=false; runActive=false;\n try{ document.exitFullscreen(); }catch(e){}\n');
control('only runs re-hide the buttons', 'W1 the next finger lift', "if(e.type==='touchend' && !document.fullscreenElement && !fluxFsStartNext) fluxFsEnter();", "if(runActive && !paused && e.type==='touchend' && !document.fullscreenElement && !fluxFsStartNext) fluxFsEnter();");
control('the band again: #app cut at the field', 'B1 the screen is taller', 'if(fit){ root.style.setProperty(', 'if(false){ root.style.setProperty(');
control('level-up loses the shape', 'B1 a new level', 'applyCelestialBackground=function(){ const r=cel0.apply(this,arguments); if(fluxFsFit) fluxFsPaintApp(); return r; };', '');
control('skin backdrop overpainted', 'B1 a skin backdrop', "if(!app || skinBackdropOn()) return;", "if(!app) return;");
control("today's background not given back", 'B1 the screen is the field', "else app.style.background=CELESTIAL_BG_ENABLED ? theme : '';", '');
control('the canvas stays field-tall', 'C1 the field canvas', 'c.height=HS*dpr;', 'c.height=H*dpr;');
control('the strip is never cleared', 'C1 every frame clears', 'ctx.clearRect(0,0,W,HS||H);', 'ctx.clearRect(0,0,W,H);');
control('edge light stops at the field', 'C1 the combo / FLUX edge light', "  if(HS>H){ ctx.fillStyle='rgb('+rgb+')'; ctx.fillRect(0,H,W,HS-H); }", '');
control('gameplay reads the screen height', 'C1 gameplay never reads HS', 'bottom:Math.max(top+60,H*.79) }; }', 'bottom:Math.max(top+60,HS*.79) }; }');
control('stars reshuffle on every full-screen change', 'A5 the same stars', 'if(same){const s0=stars,n0=nebulae;makeStars();stars=s0;nebulae=n0;}else makeStars();', 'makeStars();');
const total = res.F + NC;
console.log('\n' + (total ? 'ANDROID FULL SCREEN FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'ANDROID FULL SCREEN PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
