// Temporary screen readout (Solar band debugging), in the release gate.
// Players must never see it by accident. Checks on the real game page (harness vm):
//   - it opens ONLY after 5 taps within 3 seconds (4 taps, or 5 slow taps, do nothing);
//   - the only trigger is the big FLUX title on the start menu (not a button, not
//     on screen during play); the HUD logo cannot be tapped (pointer-events:none);
//   - it is never saved: opening/closing writes nothing to storage;
//   - it is read-only: score, level, lives, skin and backdrop are untouched;
//   - it uses no new event listeners (the listener-leak rule stays intact).
// Ends with negative controls. The real rendering on iPhone/iPad sizes is in
// test-debug-readout-browser.mjs (needs Chromium).
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const code = scriptsOf(gameHtml).join('\n;\n');
  const block = (code.match(/SCREEN READOUT[\s\S]*?\}\)\(\);/) || [''])[0];
  ck('R1 the readout block uses no addEventListener (listener-leak rule intact)', block.length > 0 && !/addEventListener\(/.test(block));
  ck('R2 the only trigger is the start-menu FLUX title; the HUD logo cannot take taps',
    /document\.querySelector\('#start h1'\)/.test(block) && !/\.logo/.test(block) && /\.hud\{[^}]*pointer-events:none/.test(gameHtml) && /<div id="start"><div class="panel menuPanel"><h1>FLUX<\/h1>/.test(gameHtml));
  try {
    const { store, mem } = makeStore({ fluxPlayerId: 'dr-1', fluxCallsign: 'T', fluxProfileComplete: '1' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    run('var __toggles = 0; toggleFluxReadout = function(){ __toggles++; };');
    const taps = (times) => { run('fluxReadoutTaps = []; __toggles = 0;'); for (const t of times) run('fluxReadoutTap(' + t + ')'); return run('__toggles'); };
    ck('R3 four quick taps do nothing', taps([1000, 1200, 1400, 1600]) === 0);
    ck('R3 five taps spread over more than 3 seconds do nothing', taps([1000, 1800, 2600, 3400, 4200]) === 0);
    ck('R3 five taps within 3 seconds open it (once)', taps([1000, 1300, 1600, 1900, 2200]) === 1);
    ck('R3 a sixth tap right after does not re-toggle (the count starts over)', taps([1000, 1300, 1600, 1900, 2200, 2400]) === 1);
    // Open/close for real: storage and game state untouched.
    const before = JSON.stringify(Object.assign({}, mem)), state = run('JSON.stringify([score,level,misses,activeSkin,activeBackground,colors])');
    run('delete toggleFluxReadout;');
    const g2 = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run2 = (c) => vm.runInContext(c, g2.ctx);
    // The harness DOM finds every id; make #fluxReadout exist only while it is open.
    const doc2 = g2.win.document, byId = doc2.getElementById; let isOpen = false, removed = 0;
    doc2.getElementById = (id) => id === 'fluxReadout' ? (isOpen ? { remove: () => { removed++; isOpen = false; } } : null) : byId(id);
    const make = doc2.createElement; doc2.createElement = (t) => { const e = make(t); return e; };
    let opened = false;
    try { run2('setInterval = function(){ return 7; }; fluxReadoutText = function(){ return "ok"; }; toggleFluxReadout();'); isOpen = true; opened = run2('fluxReadoutTimer') ? true : 'no live refresh'; run2('toggleFluxReadout();'); } catch (e) { opened = String(e); }
    ck('R4 it opens (with a live refresh) and closes again', opened === true && removed === 1 && !isOpen && run2('fluxReadoutTimer') === 0, String(opened).slice(0, 120));
    ck('R5 it is never saved: storage unchanged', JSON.stringify(Object.assign({}, mem)) === before);
    ck('R6 it is read-only: score, level, lives, skin, backdrop, colours unchanged', run2('JSON.stringify([score,level,misses,activeSkin,activeBackground,colors])') === state);
  } catch (e) { ck('readout section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each safeguard removed MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('opens on a single tap', 'R3', rep('const FLUX_READOUT_TAPS = 5,', 'const FLUX_READOUT_TAPS = 1,'));
control('slow taps count (no time window)', 'R3', rep('FLUX_READOUT_WINDOW_MS = 3000;', 'FLUX_READOUT_WINDOW_MS = 1e9;'));
control('triggered from the HUD logo', 'R2', rep("document.querySelector('#start h1')", "document.querySelector('.hud .logo')"));
control('HUD made tappable', 'R2', rep('.hud{position:absolute;top:max(16px,env(safe-area-inset-top));left:0;right:0;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;pointer-events:none}', '.hud{position:absolute;top:max(16px,env(safe-area-inset-top));left:0;right:0;padding:10px 16px;display:flex;align-items:center;justify-content:space-between}'));
control('remembered across reloads', 'R5', rep("  d.id = 'fluxReadout';", "  d.id = 'fluxReadout'; try{ localStorage.setItem('fluxReadoutOn','1'); }catch(e){}"));
control('a listener added for the gesture', 'R1', rep('  if (title) title.onclick = function(){ fluxReadoutTap(Date.now()); };', "  if (title) title.addEventListener('click', function(){ fluxReadoutTap(Date.now()); });"));
const total = main.F + NC;
console.log('\n' + (total ? 'DEBUG READOUT FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'DEBUG READOUT PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
