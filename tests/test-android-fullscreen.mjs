// ANDROID FULL SCREEN DURING A RUN (owner, BLU G45).
//   A1 the installed Android app asks for full screen with the system buttons hidden (navigationUI 'hide')
//      when a run starts; iPhone, iPad (desktop-style UA), a plain Chrome tab, the Gateway's demo frame and
//      desktops never do;
//   A2 SAME GAME: the game area keeps the height it had before the bars went away (the field, the orbs and
//      the launcher are where they were); the freed strip is background; turning the phone drops the lock;
//   A3 leaving full screen (back button, or Chrome refusing) never pauses or ends the run: the lock goes,
//      the layout is the normal one, and the next finger lift during the run asks again; one request at a time;
//   A4 pause, quit and game over leave full screen (menus keep the buttons); RESUME enters it again;
//      FLUX only leaves a full screen it asked for;
//   A5 wiring: no new listeners (17), the frame loop untouched (2), the resize keeps the same stars when the
//      size did not change (and still draws the same random numbers as main, so seeded runs are identical).
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
function rig(src, { ua = UA.android, standalone = true, framed = false, platform = 'Linux armv8l', touch = true, reject = false } = {}) {
  const a = src.indexOf('let fluxFsH=0'), z = src.indexOf('function resize(){', a);
  const calls = [], cls = new Set(), props = {};
  let fsEl = null, resizes = 0;
  const root = {
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    style: { setProperty: (k, v) => { props[k] = v; } },
    requestFullscreen(o) { calls.push('enter:' + (o && o.navigationUI)); return { then: (ok, no) => { api.settle = () => (reject ? no(new Error('denied')) : ok()); } }; },
  };
  const document = { documentElement: root, fullscreenEnabled: true, get fullscreenElement() { return fsEl; },
    exitFullscreen() { calls.push('exit'); return { catch() {} }; } };
  if (touch) document.ontouchend = null;
  const win = { matchMedia: (q) => ({ matches: standalone && /display-mode: standalone/.test(q) }) };
  win.self = win; win.top = framed ? {} : win;
  const g = { navigator: { userAgent: ua, platform }, document, window: win, innerHeight: 728, innerWidth: 360, resize: () => { resizes++; }, newGame: () => {} };
  vm.createContext(g); vm.runInContext(src.slice(a, z) + '\n;globalThis.__fsH=()=>fluxFsH;', g);
  const api = {
    g, calls, cls, props, settle: () => {},
    enter: () => g.fluxFsEnter(), exit: () => g.fluxFsExit(),
    entered() { fsEl = root; g.innerHeight = 800; document.onfullscreenchange && document.onfullscreenchange(); },
    left() { fsEl = null; g.innerHeight = 728; document.onfullscreenchange && document.onfullscreenchange(); },
    get H() { return g.__fsH(); }, get resizes() { return resizes; },
  };
  return api;
}
function suite(src, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    let r = rig(src); r.enter();
    ck("A1 installed Android app: a run asks for full screen with the system buttons hidden (navigationUI 'hide')", r.calls.join() === 'enter:hide', r.calls.join());
    const never = { iPhone: { ua: UA.iphone, platform: 'iPhone' }, 'iPad (desktop-style)': { ua: UA.ipad, platform: 'MacIntel' }, 'Chrome tab': { standalone: false }, 'Gateway demo frame': { framed: true }, desktop: { ua: UA.desktop } };
    const bad = Object.entries(never).filter(([, o]) => { const q = rig(src, o); q.enter(); return q.calls.length; }).map(([k]) => k);
    ck('A1 never on iPhone, iPad, a plain Chrome tab, the Gateway demo frame, or a desktop', bad.length === 0, bad.join(', '));

    r = rig(src); r.enter(); r.settle(); r.entered();
    ck('A2 the game area keeps the height it had before the bars went away (728 of 800)', r.H === 728 && r.props['--fluxFsH'] === '728px' && r.cls.has('fluxFsRun'), r.H + ' ' + r.props['--fluxFsH']);
    ck('A2 the page keeps the game area that size (CSS) and paints the freed strip as background',
      /html\.fluxFsRun #app\{bottom:auto;height:var\(--fluxFsH\)\}/.test(src) && /html\.fluxFsRun,html\.fluxFsRun body\{background-color:#03040d\}/.test(src));
    ck('A2 the game reads that height (resize: H=fluxFsH||innerHeight)', /fluxFsCheckWidth\(\);W=innerWidth;H=fluxFsH\|\|innerHeight;/.test(src));
    r.g.innerWidth = 800; r.g.fluxFsCheckWidth();
    ck('A2 turning the phone in full screen drops the lock (normal layout)', r.H === 0 && !r.cls.has('fluxFsRun'));

    r = rig(src); r.enter(); r.settle(); r.entered(); const before = r.resizes; r.left();
    ck('A3 leaving full screen (back button): the lock goes and the normal layout is laid out again', r.H === 0 && !r.cls.has('fluxFsRun') && r.resizes === before + 1);
    ck('A3 ...and nothing pauses or ends the run (the full-screen code never touches the run state)', !/paused\s*=|playing\s*=|runActive\s*=|setPaused|endGame/.test(src.slice(src.indexOf('let fluxFsH=0'), src.indexOf('function resize(){'))));
    ck('A3 the next finger lift during a run (not paused) asks again; a touch-down never does (it does not count as a tap)',
      /window\.ontouchend=window\.ontouchcancel=function\(e\)\{ tryResumeAudio\(\); if\(runActive && !paused && e\.type==='touchend' && !document\.fullscreenElement\) fluxFsEnter\(\);/.test(src) && !/ontouchstart=function\(e\)\{[^\n]*fluxFsEnter/.test(src));
    r = rig(src); r.enter(); r.enter(); r.enter();
    ck('A3 one request at a time (taps while Chrome is still answering do not stack)', r.calls.length === 1, r.calls.join());
    r = rig(src, { reject: true }); r.enter(); r.settle();
    ck('A3 Chrome refuses: the lock goes, the normal layout stays', r.H === 0 && !r.cls.has('fluxFsRun') && r.resizes === 1);
    r.enter(); ck('A3 ...and a later tap may ask again', r.calls.length === 2, r.calls.join());

    r = rig(src); r.exit();
    ck('A4 FLUX only leaves a full screen it asked for', r.calls.length === 0);
    r = rig(src); r.enter(); r.settle(); r.entered(); r.exit();
    ck('A4 a full screen FLUX asked for is left when asked', r.calls.join() === 'enter:hide,exit', r.calls.join());
    const body = (name) => { const i = src.indexOf(name); return src.slice(i, src.indexOf('\n}', i)); };
    ck('A4 a new run enters full screen (newGame itself, gameplay, untouched)', /\{ const newGame0=newGame; newGame=function\(\)\{ const r=newGame0\.apply\(this,arguments\); fluxFsEnter\(\); return r; \}; \}/.test(src) && !/fluxFs/.test(body('function newGame(){')));
    ck('A4 game over leaves it', /fluxFsExit\(\);/.test(body('function endGame(){').slice(0, 400)));
    const sp = body('function setPaused(next){');
    ck('A4 pause leaves it, RESUME enters it again', /pauseOverlay'\)\.classList\.remove\('hidden'\);\n   fluxFsExit\(\);/.test(sp) && /last=performance\.now\(\);\n   fluxFsEnter\(\);/.test(sp));
    ck('A4 quitting to the menu from pause leaves it', /playing=false;paused=false;runActive=false;\n  fluxFsExit\(\);/.test(src));

    ck('A5 no new listeners in the game (17)', (src.match(/addEventListener\(/g) || []).length === 17, (src.match(/addEventListener\(/g) || []).length);
    ck('A5 the frame loop is untouched (2)', (src.match(/requestAnimationFrame\(loop\)/g) || []).length === 2);
    ck('A5 full-screen changes that keep the size keep the same stars and canvas (no reshuffle)', /if\(!same\)\{c\.width=W\*dpr;c\.height=H\*dpr;/.test(src) && /if\(same\)\{const s0=stars,n0=nebulae;makeStars\(\);stars=s0;nebulae=n0;\}else makeStars\(\);/.test(src));
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
control('game area grows', 'A2 the game reads', 'H=fluxFsH||innerHeight;', 'H=innerHeight;');
control('lock never dropped on exit', 'A3 leaving full screen', 'function fluxFsDropIfOut(){ if(!document.fullscreenElement && fluxFsH){ fluxFsDrop(); resize(); } }', 'function fluxFsDropIfOut(){}');
control('leaving full screen pauses', 'A3 ...and nothing pauses', "document.onfullscreenchange=function(){ fluxFsAsking=false; if(!document.fullscreenElement) fluxFsDropIfOut(); };", "document.onfullscreenchange=function(){ fluxFsAsking=false; if(!document.fullscreenElement){ fluxFsDropIfOut(); paused=true; } };");
control('requests stack', 'A3 one request', 'if(fluxFsAsking || !fluxFsWanted()', 'if(!fluxFsWanted()');
control('never asks again after back', 'A3 the next finger lift', "if(runActive && !paused && e.type==='touchend' && !document.fullscreenElement) fluxFsEnter(); ", '');
control('exits a full screen it did not ask for', 'A4 FLUX only leaves', 'if(!fluxFsH || !document.fullscreenElement) return;', 'if(!document.fullscreenElement && false) return;');
control('pause keeps full screen', 'A4 pause leaves it', "   fluxFsExit();   // ANDROID FULL SCREEN: the pause menu shows the buttons\n", '');
control('stars reshuffle on every full-screen change', 'A5 full-screen changes', 'if(same){const s0=stars,n0=nebulae;makeStars();stars=s0;nebulae=n0;}else makeStars();', 'makeStars();');
control('a new run does not hide the buttons', 'A4 a new run', ' fluxFsEnter(); return r;', ' return r;');
const total = res.F + NC;
console.log('\n' + (total ? 'ANDROID FULL SCREEN FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'ANDROID FULL SCREEN PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
