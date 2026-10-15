// FIRST RUN SMOOTH: a slow phone's first visit no longer crawls in slow motion for the first ~5 s of its
// first run, and nothing heavy runs during a first run. Boots the REAL game page. In the release gate.
//   C1 the Lite check runs on the menu (field drawn as in a run); a clearly slow phone switches to Lite
//      before the run starts; a fast phone, a 30 fps phone and a borderline phone do not (D-46 decides, as before);
//   C2 ENTER tapped before the check is done: it goes on for the run's first frames and decides at 12;
//   C3 Lite already remembered: no check; D-46 itself is unchanged (60 frames after 20, 25 ms, 60%);
//   C4 gameplay untouched: a frame still moves the game at most 32 ms; listeners 17; requestAnimationFrame(loop) 2;
//   S1 first visit (no worker yet): the offline copy is not registered at load, nor during a run; it is
//      registered once the first run has ended, or after 20 s on the menu; a returning visit registers at load.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.jeromevt72.workers.dev';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const tick = () => new Promise((r) => setTimeout(r, 15));

async function suite(html, quiet) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const GAME = scriptsOf(html);
  const game = (extra = {}) => { const { store } = makeStore({ fluxProfileComplete: '1', fluxCallsign: 'TITAN', ...extra }); const g = boot(GAME, { origin: ORIGIN, path: '/play/', store }); g.run = (code) => vm.runInContext(code, g.ctx); return g; };
  const menu = (g, ms, n) => { g.run('fluxMenuCheckStart()'); for (let i = 0; i < n; i++) g.run('fluxMenuCheckSample(' + (Array.isArray(ms) ? ms[i % ms.length] : ms) + ')'); };
  const lite = (g) => g.run('!!window.__fluxLite');
  try {
    // C1
    let g = game(); g.run('fluxMenuCheckStart()');
    ck('C1 the check runs on the menu and draws the field live (as in a run)', g.run('fluxMenuCheckOn') === true && g.run('fieldIsStill()') === false);
    menu(g, 66, 30);
    ck('C1 a clearly slow phone (66 ms frames) switches to Lite on the menu, before any run, and remembers it',
      lite(g) && g.run('localStorage.getItem("fluxLite")') === '1' && g.run('playing') === false && g.run('fluxMenuCheckOn') === false);
    for (const [label, ms] of [['a fast phone (16 ms)', 16.7], ['a 30 fps phone (33 ms)', 33.4], ['a borderline phone (half the frames slow)', [16.7, 50]], ['mostly slow, middle frame 33 ms', [33.4, 33.4, 45]]]) {
      g = game(); menu(g, ms, 30);
      ck('C1 ' + label + ': not switched here (left to D-46 as before)', !lite(g) && g.run('fluxMenuCheckOn') === false);
    }
    g = game(); menu(g, 66, 30); g.run('fieldIsStill()');
    ck('C1 after the check the menu field copy is used again', g.run('fluxMenuCheckOn') === false);
    ck('C1 the check starts by itself once the page has loaded (no new listener)', /\(function fluxMenuCheckWhenLoaded\(\)\{ if \(document\.readyState !== 'complete'\)\{ setTimeout\(fluxMenuCheckWhenLoaded, 300\); return; \} setTimeout\(fluxMenuCheckStart, 400\); \}\)\(\);/.test(html));
    // C2
    g = game(); menu(g, 66, 10); g.run("document.getElementById('startBtn').onclick()");
    ck('C2 ENTER before 12 menu frames: no decision yet, the check goes on in the run', !lite(g) && g.run('fluxMenuCheckOn') === true && g.run('playing') === true);
    for (let i = 0; i < 14; i++) g.run('fluxMenuCheckSample(70)');
    ck('C2 ...and a clearly slow phone is switched after 12 timed frames', lite(g) && g.run('fluxMenuCheckOn') === false);
    g = game(); g.run("document.getElementById('startBtn').onclick()");
    ck('C2 ENTER before the check even began: it starts with the run', g.run('fluxMenuCheckOn') === true);
    for (let i = 0; i < 20; i++) g.run('fluxMenuCheckSample(16.7)');
    ck('C2 ...a fast phone stays as it is', !lite(g) && g.run('fluxMenuCheckOn') === false);
    g = game(); menu(g, 66, 20); g.run("document.getElementById('startBtn').onclick()");
    ck('C2 ENTER after 12+ menu frames: decided before the first frame of the run', lite(g) && g.run('fluxMenuCheckOn') === false);
    // C3
    g = game({ fluxLite: '1' }); g.run('fluxMenuCheckStart()');
    ck('C3 Lite already remembered: no check', g.run('fluxMenuCheckOn') === false);
    ck('C3 D-46 unchanged (60 frames after 20, 25 ms, 60%)', /let fluxPerfN = 0, fluxPerfSlow = 0, fluxPerfSkip = 20;/.test(html) && /const FLUX_PERF_FRAMES = 60, FLUX_PERF_SLOW_MS = 25, FLUX_PERF_SLOW_SHARE = 0.6;/.test(html));
    // C4
    ck('C4 a frame still moves the game at most 32 ms (gameplay untouched)', html.includes('const dt=Math.min(.032,(ts-last)/1000||.016);'));
    ck('C4 listeners 17, requestAnimationFrame(loop) 2', (html.match(/addEventListener\(/g) || []).length === 17 && (html.match(/requestAnimationFrame\(loop\)/g) || []).length === 2,
      (html.match(/addEventListener\(/g) || []).length + ' / ' + (html.match(/requestAnimationFrame\(loop\)/g) || []).length);
    // S1
    const sw = async (controller, setup) => {
      const g2 = game(); const reg = [], timers = [];
      g2.win.navigator.serviceWorker.register = (u) => { reg.push(u); return Promise.resolve({ waiting: null, installing: null, addEventListener() {} }); };
      g2.win.navigator.serviceWorker.controller = controller;
      let now = 1e12; g2.win.Date.now = () => now;
      g2.win.setTimeout = (fn, ms) => { timers.push(fn); return timers.length; };
      if (setup) setup(g2);
      g2.fire('load'); await tick();
      const step = async (ms = 2000) => { now += ms; for (const t of timers.splice(0)) t(); await tick(); };
      return { g: g2, reg, step };
    };
    let s = await sw(null);
    ck('S1 first visit: not registered at load', s.reg.length === 0);
    s.g.run("document.getElementById('startBtn').onclick()"); for (let i = 0; i < 10; i++) await s.step();
    ck('S1 ...nor during the run (20 s of it)', s.reg.length === 0);
    s.g.run('playing=false; paused=false;'); s.g.ctx.endGame(); s.g.run('runActive=false;'); await s.step();
    ck('S1 ...registered once the first run has ended', s.reg.length === 1 && s.reg[0] === '/sw.js', s.reg.join(','));
    s = await sw(null); for (let i = 0; i < 9; i++) await s.step();
    const at18 = s.reg.length; await s.step(); await s.step();
    ck('S1 first visit, no run: registered after 20 s on the menu', at18 === 0 && s.reg.length === 1, at18 + ' ' + s.reg.length);
    s = await sw({});
    ck('S1 a returning visit (a worker in control) registers at load, as before', s.reg.length === 1);
  } catch (e) { ck('ran without error', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
  return { F, failed };
}
console.log('== FIRST RUN SMOOTH ==');
const main = await suite(HTML, false);
console.log('\n-- negative controls --');
let NC = 0;
const rep = (a, b) => (h) => (h.includes(a) ? h.replace(a, b) : h);
for (const [label, expect, mut] of [
  ['no menu check (the 5 s slow motion is back)', 'C1', rep("setTimeout(fluxMenuCheckStart, 400); })();", "})();") ],
  ['menu check never switches', 'C1', rep('if (slow >= Math.ceil(n * 0.83) && mid > 40) fluxEnableLite();', '') ],
  ['menu check as loose as D-46 (a 30 fps phone switched on the menu)', 'C1', rep('if (slow >= Math.ceil(n * 0.83) && mid > 40) fluxEnableLite();', 'if (slow >= Math.ceil(n * 0.6)) fluxEnableLite();') ],
  ['quick tap: the check stops at the run', 'C2', rep('    fluxMenuCheckTarget = FLUX_MENU_CHECK_MIN; fluxMenuCheckSkip = Math.max(fluxMenuCheckSkip, 2); return;', '    fluxMenuCheckOn = false; return;') ],
  ['the offline copy registered at load on a first visit', 'S1', rep('if(navigator.serviceWorker.controller) fluxSwRegister(); else fluxSwWhenIdle();', 'fluxSwRegister();') ],
  ['the offline copy registered during a run', 'S1', rep('if(playing || paused || runActive){ swRunSeen=true; swIdleSince=0; setTimeout(fluxSwWhenIdle,2000); return; }', 'if(false){}') ],
  ['gameplay clock changed', 'C4', rep('const dt=Math.min(.032,(ts-last)/1000||.016);', 'const dt=Math.min(.064,(ts-last)/1000||.016);') ],
]) {
  const h = mut(HTML); if (h === HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; continue; }
  const r = await suite(h, true), hit = r.failed.filter((f) => f.startsWith(expect));
  console.log((hit.length ? '  PASS  caught: ' : '  FAIL  missed: ') + label + (hit.length ? '' : '  [' + (r.failed.join(' | ') || 'none') + ']')); if (!hit.length) NC++;
}
const ok = !main.F && !NC;
console.log('\n' + (ok ? 'FIRST RUN SMOOTH PASSED: all checks and all negative controls' : 'FIRST RUN SMOOTH FAILED'));
process.exit(ok ? 0 : 1);
