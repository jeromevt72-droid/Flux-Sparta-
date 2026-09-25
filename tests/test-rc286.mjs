// RC2.8.6 -- D-46 lite graphics, D-47 PLAY goes straight into the game,
// D-48 install offered only after the first game (Android: native prompt;
// iPhone: 3-step guide), D-49 bring my pilot into the installed app.
// Real game page (harness vm) and real Gateway HTML. Must FAIL on RC2.8.5.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'FLUX-Sparta', 'public');
const GAME_HTML = fs.readFileSync(path.join(PUB, 'play', 'index.html'), 'utf8');
const GW_HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.jeromevt72.workers.dev';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

async function suite({ gameHtml, gwHtml, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const GAME = scriptsOf(gameHtml);
  const bootGame = (init = {}, env = {}) => {
    const { store, mem } = makeStore(init);
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, fetchImpl: () => Promise.resolve(new Response('{"ok":true}', { status: 200 })) });
    const timers = []; g.win.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    g.ctx.fluxIsStandalone = () => !!env.standalone;
    g.ctx.fluxIsIOS = () => !!env.ios;
    const vis = {};
    for (const id of ['gameoverInstallBtn', 'bringPilotBtn']) { const el = g.win.document.getElementById(id);
      vis[id] = false; el.classList = { add: (c) => { if (c === 'hidden') vis[id] = false; }, remove: (c) => { if (c === 'hidden') vis[id] = true; }, contains: () => false, toggle() {} }; }
    const run = (c) => vm.runInContext(c, g.ctx);
    const el = (id) => g.win.document.getElementById(id);
    const endRun = () => { run('score=700; level=1;'); g.ctx.endGame(); };
    return { g, mem, run, el, vis, endRun };
  };

  if (!quiet) console.log('== D-48: install offered only after the first game ==');
  try {
    const b = bootGame({}, { ios: true });
    b.g.ctx.refreshInstallButtons();
    ck('I1 brand-new player: no install button before playing', b.vis.gameoverInstallBtn === false);
    b.endRun();
    ck('I2 after a run the button appears on the game-over screen', b.vis.gameoverInstallBtn === true && b.mem.fluxRunsPlayed === '1');
    ck('I2 ...and never in the menu (owner decision)', !gameHtml.includes('id="installBtn"'));
    ck('I2 on iPhone it says ADD TO HOME SCREEN', /ADD TO HOME SCREEN/.test(b.el('gameoverInstallBtn').textContent), b.el('gameoverInstallBtn').textContent);
    let guide = 0; b.g.ctx.fluxShowIosGuide = () => { guide++; };
    b.el('gameoverInstallBtn').onclick();
    ck('I2 ...and tapping it shows the 3-step guide', guide === 1);
  } catch (e) { ck('iPhone section ran', false, String(e.stack || e).slice(0, 200)); }
  try {
    const b = bootGame({}, { ios: false });
    let prompted = 0; const evt = { preventDefault() {}, prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
    b.g.win.onbeforeinstallprompt(evt);
    ck('I6 Android: even with install available, nothing before the first game', b.vis.gameoverInstallBtn === false);
    b.endRun();
    ck('I3 Android after a run: INSTALL NOW (no instructions)', b.vis.gameoverInstallBtn === true && /INSTALL NOW/.test(b.el('gameoverInstallBtn').textContent), b.el('gameoverInstallBtn').textContent);
    let guide = 0; b.g.ctx.fluxShowIosGuide = () => { guide++; };
    b.el('gameoverInstallBtn').onclick();
    ck('I3 ...tapping it opens the phone\'s own install prompt, never the guide', prompted === 1 && guide === 0);
    ck('I3 ...and the button goes away (the prompt can only be used once)', b.vis.gameoverInstallBtn === false);
    b.g.win.onbeforeinstallprompt(evt); b.g.win.onappinstalled();
    ck('I3 once installed, no button', b.vis.gameoverInstallBtn === false);
  } catch (e) { ck('Android section ran', false, String(e.stack || e).slice(0, 200)); }
  try {
    const s = bootGame({ fluxRunsPlayed: '3' }, { ios: true, standalone: true }); s.g.ctx.refreshInstallButtons();
    ck('I4 already running as the installed app: no install button', s.vis.gameoverInstallBtn === false);
    const d = bootGame({ fluxRunsPlayed: '3' }, { ios: false }); d.g.ctx.refreshInstallButtons();
    ck('I5 a browser with no install option: no button (no instructions shown)', d.vis.gameoverInstallBtn === false);
  } catch (e) { ck('I4/I5 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== D-49: bring my pilot into the installed app ==');
  try {
    const a = bootGame({}, { ios: true, standalone: true }); a.g.ctx.refreshInstallButtons();
    ck('B1 installed app with a brand-new auto pilot: BRING MY PILOT shown', a.vis.bringPilotBtn === true && /^PILOT-/.test(a.run('callsign')));
    const t = bootGame({ fluxPublicTag: 'ABCDEFG' }, { ios: true, standalone: true }); t.g.ctx.refreshInstallButtons();
    ck('B1 ...not shown once this pilot has scores', t.vis.bringPilotBtn === false);
    const w = bootGame({}, { ios: true, standalone: false }); w.g.ctx.refreshInstallButtons();
    ck('B1 ...never shown in the browser', w.vis.bringPilotBtn === false);
    const named = bootGame({ fluxPlayerId: 'n-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1' }, { ios: true, standalone: true }); named.g.ctx.refreshInstallButtons();
    ck('B1 ...never shown for a named pilot', named.vis.bringPilotBtn === false);
  } catch (e) { ck('B1 ran', false, String(e.stack || e).slice(0, 200)); }
  try {
    const src = bootGame({ fluxPlayerId: 'safari-pilot-0001', fluxCallsign: 'TITAN', fluxProfileComplete: '1' });
    const code = await src.g.ctx.makeRestoreCode('safari-pilot-0001');
    const b = bootGame({}, { ios: true, standalone: true });
    b.g.win.navigator.clipboard = { readText: () => Promise.resolve('  ' + code + '\n') };
    let confirmed = null, entry = 0;
    b.g.ctx.checkRestoreOnServer = (id) => Promise.resolve({ kind: 'found', info: { name: 'TITAN', tag: 'KH2K8J7', country: 'US', bests: {}, skus: [] } });
    b.g.ctx.openRestoreConfirm = (id, info) => { confirmed = id; };
    b.g.ctx.openRestoreEntry = () => { entry++; };
    await b.g.ctx.fluxBringPilot();
    ck('B2 BRING MY PILOT reads the copied code and opens the usual restore confirm', confirmed === 'safari-pilot-0001' && entry === 0, String(confirmed));
    b.g.win.navigator.clipboard = { readText: () => Promise.resolve('hello') };
    confirmed = null; await b.g.ctx.fluxBringPilot();
    ck('B3 nothing usable on the clipboard: falls back to pasting by hand', confirmed === null && entry === 1);
    b.g.win.navigator.clipboard = { readText: () => Promise.reject(new Error('denied')) };
    await b.g.ctx.fluxBringPilot();
    ck('B3 clipboard permission refused: falls back too', entry === 2);
  } catch (e) { ck('B2 ran', false, String(e.stack || e).slice(0, 200)); }
  try {
    const mk = () => { let html = ''; const btns = {}; return { get html() { return html; }, btns,
      over: (h) => { html = h; return { querySelector: (q) => (btns[q] = btns[q] || { onclick: null }), remove() {} }; } }; };
    const withScores = bootGame({ fluxPlayerId: 'g-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxBest_easy: '900' }, { ios: true });
    const m1 = mk(); withScores.g.ctx.restoreOverlay = m1.over; let copied = null; withScores.g.ctx.copyText = (t) => { copied = t; };
    await withScores.g.ctx.fluxShowIosGuide();
    const cpb = m1.btns['#guideCopyPilot']; if (cpb && typeof cpb.onclick === 'function') cpb.onclick({ target: {} });
    ck('G1 iPhone guide for a pilot with scores: COPY MY PILOT copies its restore code first', /COPY MY PILOT/.test(m1.html) && /^FX1-g-1-[0-9A-F]{4}$/.test(copied || ''), copied);
    ck('G1 ...and tells them to tap BRING MY PILOT in the app', /BRING MY PILOT FROM SAFARI/.test(m1.html) && /Add to Home Screen/.test(m1.html));
    const fresh = bootGame({}, { ios: true }); const m2 = mk(); fresh.g.ctx.restoreOverlay = m2.over;
    await fresh.g.ctx.fluxShowIosGuide();
    ck('G2 a pilot with nothing to carry gets just the 2 install steps', !/COPY MY PILOT/.test(m2.html) && /Add to Home Screen/.test(m2.html));
  } catch (e) { ck('G ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== D-46: lite graphics on slow devices ==');
  try {
    const feed = (b, ms, n) => { for (let i = 0; i < n; i++) b.g.ctx.fluxPerfSample(ms); };
    const slow = bootGame(); feed(slow, 45, 20 + 60);
    ck('L1 a slow device (45 ms frames, ~22 fps) switches to lite and remembers it', slow.run('window.__fluxLite') === true && slow.mem.fluxLite === '1');
    const fast = bootGame(); feed(fast, 16, 400);
    ck('L2 a fast device (60 fps) never switches', !fast.run('window.__fluxLite') && fast.mem.fluxLite === undefined);
    const mixed = bootGame(); feed(mixed, 16, 30); for (let i = 0; i < 120; i++) mixed.g.ctx.fluxPerfSample(i % 2 ? 40 : 16);
    ck('L3 occasional hiccups (half the frames slow) do not switch', !mixed.run('window.__fluxLite'));
    const gaps = bootGame(); feed(gaps, 5000, 400);
    ck('L4 pauses and backgrounding are ignored', !gaps.run('window.__fluxLite'));
    const warm = bootGame(); feed(warm, 45, 19);
    ck('L1 the first half-second of a run is not judged (warm-up)', !warm.run('window.__fluxLite'));
    const remembered = bootGame({ fluxLite: '1' }); remembered.g.win.devicePixelRatio = 2; remembered.g.ctx.resize();
    ck('L5 remembered lite: normal (non-Retina) sharpness from the start', remembered.run('window.__fluxLite') === true && remembered.run('dpr') === 1);
    const normal = bootGame(); normal.g.win.devicePixelRatio = 2; normal.g.ctx.resize();
    ck('L5 normal devices keep Retina sharpness', normal.run('dpr') === 2, normal.run('dpr'));
    const count = (b) => { const before = b.run('particles.length'); b.g.ctx.burst(10, 10, '#fff', 14); return b.run('particles.length') - before; };
    const pn = count(bootGame()); const pl = count(bootGame({ fluxLite: '1' }));
    ck('L6 lite shows half the particles', pn === 14 && pl === 7, pn + ' vs ' + pl);
    ck('L7 lite turns glow off on the canvas', /Object\.defineProperty\(ctx, 'shadowBlur'/.test(gameHtml) && /if \(d && d\.set\) d\.set\.call\(ctx, 0\);/.test(gameHtml));
    ck('L9 lite also calms the moving background (stars, nebula blur, FLUX Mode filter)', /\.fluxLite #starsFar,\.fluxLite #starsNear\{animation:none!important\}\.fluxLite #nebulaDrift\{display:none!important\}\.fluxLite #app\{filter:none!important\}/.test(gameHtml) && gameHtml.includes("document.documentElement.classList.add('fluxLite')"));
    ck('L8 gameplay timing untouched (same time step rule)', gameHtml.includes(' const dt=Math.min(.032,(ts-last)/1000||.016);'));
  } catch (e) { ck('D-46 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== D-47: PLAY goes straight into the game ==');
  try {
    const body = (gwHtml.match(/function handlePlayTap\(e, url\)\{[\s\S]*?\n  \}\n/) || [''])[0];
    ck('W1 phones/tablets are no longer sent to the install screen before playing', body.length > 0 && !body.includes('showPlayChoice()'), body.length);
    ck('W1 the installed app still opens the play screen directly', body.includes('openPlayScreen();'));
    ck('W2 every PLAY link still points at the game', (gwHtml.match(/href="\/play\/" data-flux-play/g) || []).length >= 4);
  } catch (e) { ck('W ran', false, String(e.stack || e).slice(0, 200)); }
  return { F, failed };
}

const main = await suite({ gameHtml: GAME_HTML, gwHtml: GW_HTML });
console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
async function control(label, { expect, game = (s) => s, gw = (s) => s }) {
  const g2 = game(GAME_HTML), w2 = gw(GW_HTML);
  if (g2 === GAME_HTML && w2 === GW_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = await suite({ gameHtml: g2, gwHtml: w2, quiet: true });
  const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('install offered before the first game', { expect: 'I1', game: rep("if (fluxIsStandalone() || !fluxHasPlayed()) return null;", "if (fluxIsStandalone()) return null;") });
await control('Android shown the iPhone instructions', { expect: 'I3', game: rep("if (mode === 'android' && fluxDeferredInstall){", "if (false){") });
await control('install button shown inside the installed app', { expect: 'I4', game: rep("if (fluxIsStandalone() || !fluxHasPlayed()) return null;", "if (!fluxHasPlayed()) return null;") });
await control('bring-my-pilot shown in the browser', { expect: 'B1', game: rep("try{ return fluxIsStandalone() && localStorage.getItem('fluxAutoName') === '1'", "try{ return localStorage.getItem('fluxAutoName') === '1'") });
await control('bring-my-pilot skips the server check', { expect: 'B2', game: rep("  const r = await checkRestoreOnServer(parsed.playerId);\n  if (r.kind !== 'found'){ openRestoreEntry(); return; }\n  openRestoreConfirm(parsed.playerId, r.info);", "  applyRestorePlan(buildRestorePlan({}, parsed.playerId));") });
await control('guide forgets to copy the pilot', { expect: 'G1', game: rep("  if (cp) cp.onclick = function(e){ copyText(code, e.target); };", "") });
await control('lite never switches on', { expect: 'L1', game: rep("fluxPerfSlow >= FLUX_PERF_FRAMES * FLUX_PERF_SLOW_SHARE) fluxEnableLite();", "fluxPerfSlow > FLUX_PERF_FRAMES) fluxEnableLite();") });
await control('lite switches on for fast devices', { expect: 'L2', game: rep("if (ms > FLUX_PERF_SLOW_MS) fluxPerfSlow++;", "fluxPerfSlow++;") });
await control('pauses counted as slow frames', { expect: 'L4', game: rep("if (!(ms > 0 && ms < 1000)) return;", "if (!(ms > 0)) return;") });
await control('lite keeps Retina sharpness', { expect: 'L5', game: rep("dpr=window.__fluxLite?1:Math.min(devicePixelRatio||1,2);", "dpr=Math.min(devicePixelRatio||1,2);") });
await control('lite keeps all particles', { expect: 'L6', game: rep("if (window.__fluxLite) fluxApplyLiteParticles();", "") });
await control('lite leaves the moving background on', { expect: 'L9', game: rep(".fluxLite #nebulaDrift{display:none!important}", "") });
await control('install button put back in the menu', { expect: 'I2', game: rep('<button type="button" class="linkBtn installBtn hidden" id="bringPilotBtn">', '<button type="button" class="linkBtn installBtn hidden" id="installBtn">x</button><button type="button" class="linkBtn installBtn hidden" id="bringPilotBtn">') });
await control('install screen before play restored', { expect: 'W1', gw: rep("    // D-47 (RC2.8.6): PLAY goes straight into the game on phones and tablets", "    if(isIOSDevice() || deferredInstallPrompt){ e.preventDefault(); showPlayChoice(); return; }\n    // D-47 (RC2.8.6): PLAY goes straight into the game on phones and tablets") });

const total = main.F + NC;
console.log('\n' + (total ? ('RC2.8.6 FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)') : 'RC2.8.6 PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
