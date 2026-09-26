// SHARE & INSTALL, in the release gate. Real game page in the harness vm.
//   C  share card: shows "FLUX Sparta" and the game's web address (the site's
//      canonical host) in large type on one line (Instagram/TikTok captions are
//      not clickable, so people type what they see);
//   N  install offer: never before playing, never blocking (a button on the
//      game-over screen, no pop-up), only after a GOOD run (points, and level 2+
//      or a new personal best over an earlier one), ONCE (remembered); never in
//      the installed app; not used up where nothing can be offered;
//   A  Android: the phone's own one-tap install prompt;
//   S  iPhone/iPad Safari: COPY MY PILOT first, then the current iOS steps
//      (⋯ -> Share -> scroll down -> Add to Home Screen, "Edit Actions" hint -> Add);
//   P  in-app browsers (Instagram, Facebook, Messenger, TikTok...): "open in
//      Safari / your browser first" instead of Home Screen steps, COPY MY PILOT kept.
// Ends with negative controls: each defect re-inserted MUST be caught by the named check.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const CANON = 'flux-sparta-3.jeromevt72.workers.dev';
const UA_IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0 (iPhone15,2; iOS 26_0; en_US)';

async function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const SCRIPTS = scriptsOf(gameHtml);
  const bootGame = (init = {}, env = {}) => {
    const { store, mem } = makeStore(init);
    const g = boot(SCRIPTS, { origin: 'https://preview.example', path: '/play/', store, fetchImpl: () => Promise.resolve(new Response('{"ok":true}', { status: 200 })) });
    g.win.setTimeout = () => 0;
    g.ctx.fluxIsStandalone = () => !!env.standalone;
    g.ctx.fluxIsIOS = () => !!env.ios;
    if (!env.realIPad) g.ctx.fluxIsIPad = () => !!env.ipad;
    if (env.app) g.win.FLUX_IN_APP = env.app;
    const vis = {}; const el = g.win.document.getElementById('gameoverInstallBtn'); vis.btn = false;
    el.classList = { add: (c) => { if (c === 'hidden') vis.btn = false; }, remove: (c) => { if (c === 'hidden') vis.btn = true; }, contains: () => false, toggle() {} };
    let overlays = 0; const over0 = g.ctx.restoreOverlay; g.ctx.restoreOverlay = function () { overlays++; return over0.apply(this, arguments); };
    const run = (c) => vm.runInContext(c, g.ctx);
    const endRun = (sc, lv) => { run('score=' + sc + '; level=' + lv + ';'); g.ctx.endGame(); };
    return { g, mem, run, el, vis, endRun, overlays: () => overlays };
  };
  // Records what a canvas is asked to draw (text, font, where).
  const fakeCanvas = () => { const texts = []; let font = ''; const c2d = new Proxy({}, { get(t, k) {
      if (k === 'fillText') return (s, x, y) => texts.push({ s: String(s), x, y, font, px: +((font.match(/(\d+)px/) || [])[1] || 0) });
      if (k === 'measureText') return (s) => ({ width: String(s).length * (+((font.match(/(\d+)px/) || [])[1] || 0)) * 0.55 });   // ~ a bold system font; real pixels: see the screenshots
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'font') return font;
      if (k in t) return t[k];
      return () => {};
    }, set(t, k, v) { if (k === 'font') font = v; else t[k] = v; return true; } });
    return { texts, canvas: { width: 0, height: 0, getContext: () => c2d } }; };
  const drawCard = (b, canonical) => { const f = fakeCanvas();
    b.g.win.document.createElement = () => f.canvas;
    b.g.win.document.querySelector = (q) => (canonical && /canonical/.test(q) ? { getAttribute: () => canonical } : null);
    b.g.ctx.drawShareCard({ score: 4200, added: 1200, country: 'PH' }); return f.texts; };
  const guideHtml = async (b) => { let html = ''; let copied = null; const btns = {};
    b.g.ctx.restoreOverlay = (h) => { html = h; return { querySelector: (q) => (btns[q] = btns[q] || { onclick: null }), remove() {} }; };
    b.g.ctx.copyText = (t) => { copied = t; };
    await b.g.ctx.fluxShowIosGuide();
    const cp = btns['#guideCopyPilot']; if (cp && typeof cp.onclick === 'function') cp.onclick({ target: {} });
    return { html, copied }; };
  const PILOT = { fluxPlayerId: 'pilot-77', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxBest_medium: '9000', fluxCountry: 'PH' };

  if (!quiet) console.log('== share card: name and web address ==');
  try {
    const t = drawCard(bootGame(PILOT), 'https://' + CANON + '/play/');
    const title = t.find((x) => x.s === 'FLUX Sparta');
    ck('C1 the card shows "FLUX Sparta" as its title, large', !!title && title.px >= 90 && title.y < 300, JSON.stringify(title));
    const addr = t.find((x) => x.s === CANON);
    ck('C2 the card shows the game\'s web address (canonical host)', !!addr, t.map((x) => x.s).join(' | '));
    ck('C3 ...large: one line across the card (>= 46px on the 1080-wide card, fits inside it)', !!addr && addr.px >= 46 && addr.s.length * addr.px * 0.55 <= 1000, addr && addr.px);
    const short = drawCard(bootGame(PILOT), 'https://flux.gg/play/').find((x) => x.s === 'flux.gg');
    ck('C3 ...a short address is drawn big (72px), not shrunk', !!short && short.px === 72, short && short.px);
    ck('C3 ...below the score, inside the card', !!addr && addr.y > 900 && addr.y < 1330, addr && addr.y);
    const fb = drawCard(bootGame(PILOT), null);
    ck('C2 no canonical link: the page\'s own host is shown', fb.some((x) => x.s === 'preview.example'), fb.map((x) => x.s).join(' | '));
    ck('C4 the real page names its canonical address (so the card shows the live site)', gameHtml.includes('<link rel="canonical" href="https://' + CANON + '/play/">'));
    ck('C5 nothing personal on the card', !t.some((x) => /TITAN|pilot-77/.test(x.s)));
  } catch (e) { ck('card section ran', false, String(e.stack || e).slice(0, 300)); }

  if (!quiet) console.log('== install offer: once, after a good run, never blocking ==');
  try {
    const b = bootGame({}, { ios: true });
    b.g.ctx.refreshInstallButtons();
    ck('N1 brand-new player: nothing offered before playing', b.vis.btn === false && b.mem.fluxInstallOffered === undefined);
    b.endRun(700, 1);
    ck('N2 a first run that is not a good run (level 1, no earlier best): no offer, not used up', b.vis.btn === false && b.mem.fluxInstallOffered === undefined);
    b.g.ctx.newGame(); b.endRun(0, 1);
    ck('N6 a zero-point run: no offer', b.vis.btn === false && b.mem.fluxInstallOffered === undefined);
    b.g.ctx.newGame(); b.endRun(7000, 2);
    ck('N3 a good run (level 2+): ADD TO HOME SCREEN on the game-over screen, remembered', b.vis.btn === true && /ADD TO HOME SCREEN/.test(b.el.textContent) && b.mem.fluxInstallOffered === '1', b.el.textContent);
    ck('N9 never blocking: no pop-up or panel opens by itself', b.overlays() === 0);
    b.g.ctx.newGame();
    ck('N4 the next run takes it away', b.vis.btn === false);
    b.endRun(12000, 3);
    ck('N4 ...and it is offered only once (another good run: nothing)', b.vis.btn === false);
    const pb = bootGame({ fluxRunsPlayed: '2', fluxBestRun_easy: JSON.stringify({ score: 1000, level: 1 }) }, { ios: true });
    pb.endRun(1500, 1);
    ck('N5 a new personal best over an earlier one counts as a good run', pb.vis.btn === true);
    const nb = bootGame({ fluxRunsPlayed: '2', fluxBestRun_easy: JSON.stringify({ score: 2000, level: 1 }) }, { ios: true });
    nb.endRun(1500, 1);
    ck('N5 ...a run below the best at level 1 does not', nb.vis.btn === false);
    const st = bootGame({ fluxRunsPlayed: '3' }, { ios: true, standalone: true }); st.endRun(9000, 3);
    ck('N7 already installed: never offered, not used up', st.vis.btn === false && st.mem.fluxInstallOffered === undefined);
    const desk = bootGame({ fluxRunsPlayed: '3' }, { ios: false }); desk.endRun(9000, 3);
    ck('N8 nothing to offer (no install option): no button, the offer is kept for later', desk.vis.btn === false && desk.mem.fluxInstallOffered === undefined);
  } catch (e) { ck('offer section ran', false, String(e.stack || e).slice(0, 300)); }

  if (!quiet) console.log('== Android: the phone\'s own install button ==');
  try {
    const b = bootGame({}, { ios: false });
    let prompted = 0, guide = 0; const evt = { preventDefault() {}, prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
    b.g.win.onbeforeinstallprompt(evt);
    ck('A1 install available but no run yet: nothing shown', b.vis.btn === false);
    b.endRun(7000, 2);
    ck('A1 after a good run: INSTALL NOW', b.vis.btn === true && /INSTALL NOW/.test(b.el.textContent), b.el.textContent);
    b.g.ctx.fluxShowIosGuide = () => { guide++; };
    b.el.onclick();
    ck('A2 one tap opens the phone\'s own install prompt (no instructions)', prompted === 1 && guide === 0);
  } catch (e) { ck('Android section ran', false, String(e.stack || e).slice(0, 300)); }

  if (!quiet) console.log('== iPhone / iPad Safari: current iOS steps ==');
  try {
    const b = bootGame(PILOT, { ios: true }); const { html, copied } = await guideHtml(b);
    const iCopy = html.indexOf('COPY MY PILOT'), iDots = html.indexOf('Tap <b>⋯</b> (bottom right) → <b>Share</b>');
    ck('S1 iPhone: step 1 COPY MY PILOT (copies the restore code)', iCopy > 0 && /^FX1-pilot-77-[0-9A-F]{4}$/.test(copied || ''), copied);
    ck('S1 ...then "Tap ⋯ (bottom right) → Share"', iDots > iCopy, iDots);
    ck('S1 ...then "Scroll down → Add to Home Screen" with the Edit Actions hint', /Scroll down → <b>Add to Home Screen<\/b> \(not there\? tap <b>Edit Actions<\/b> and add it\)/.test(html));
    ck('S1 ...then "Tap Add", then BRING MY PILOT in the new app', html.includes('Tap <b>Add</b>.') && html.indexOf('Tap <b>Add</b>.') < html.indexOf('BRING MY PILOT FROM SAFARI'));
    ck('S1 no out-of-date "square with an arrow" step', !/square with an arrow/.test(html));
    const pad = await guideHtml(bootGame(PILOT, { ios: true, ipad: true }));
    ck('S2 iPad: Share is at the top right (or ⋯ → Share)', pad.html.includes('Tap <b>Share</b> (top right)') && /Add to Home Screen/.test(pad.html));
    const real = bootGame({}, { ios: true, realIPad: true }); real.g.win.document.ontouchend = null;   // a touch device
    real.g.win.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    const phoneIsPad = real.g.ctx.fluxIsIPad();
    real.g.win.navigator.platform = 'MacIntel'; real.g.win.navigator.maxTouchPoints = 5; real.g.win.navigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    ck('S2 an iPhone ("like Mac OS X") gets the iPhone steps; an iPad (Mac with touch) the iPad ones', phoneIsPad === false && real.g.ctx.fluxIsIPad() === true, phoneIsPad);
    const fresh = await guideHtml(bootGame({}, { ios: true }));
    ck('S3 a pilot with nothing to carry: just the 3 install steps', !/COPY MY PILOT/.test(fresh.html) && /<b>1\.<\/b> Tap <b>⋯<\/b>/.test(fresh.html) && /<b>3\.<\/b> Tap <b>Add<\/b>/.test(fresh.html));
  } catch (e) { ck('iOS section ran', false, String(e.stack || e).slice(0, 300)); }

  if (!quiet) console.log('== in-app browsers: open in Safari / your browser first ==');
  try {
    const b = bootGame(PILOT, { ios: true, app: 'Instagram' });
    b.endRun(12000, 3);
    ck('P1 inside Instagram: the offer appears after a good run', b.vis.btn === true);
    let shown = 0; const g0 = b.g.ctx.fluxShowIosGuide; b.g.ctx.fluxShowIosGuide = () => { shown++; }; b.el.onclick(); b.g.ctx.fluxShowIosGuide = g0;
    const { html, copied } = await guideHtml(b);
    ck('P1 ...tapping it shows "OPEN IN SAFARI FIRST" with ⋯ → Open in browser', shown === 1 && html.includes('OPEN IN SAFARI FIRST') && html.includes('Tap <b>⋯</b> (top right) → <b>Open in browser</b>') && /Open in external browser/.test(html), html.slice(0, 120));
    ck('P1 ...instead of Home Screen steps', !/Edit Actions|Scroll down|Tap <b>Add<\/b>/.test(html));
    ck('P1 ...COPY MY PILOT kept (the pilot lives in Instagram\'s storage), then restore it in Safari', html.indexOf('COPY MY PILOT') > 0 && html.indexOf('COPY MY PILOT') < html.indexOf('Open in browser') && /^FX1-pilot-77-/.test(copied || '') && html.includes('HAVE A RESTORE CODE?'));
    const tt = await guideHtml(bootGame(PILOT, { ios: true, app: 'TikTok' }));
    ck('P2 TikTok: ⋯ or the share arrow → Open in browser', /or the share arrow → <b>Open in browser<\/b>/.test(tt.html));
    const an = await guideHtml(bootGame(PILOT, { ios: false, app: 'Facebook' }));
    ck('P3 Android in-app browser: "open in your browser first"', an.html.includes('OPEN IN YOUR BROWSER FIRST') && !/Safari/.test(an.html.replace('BRING MY PILOT FROM SAFARI', '')));
    // The real D-38 check (last script of the page) feeds the offer.
    const r = bootGame(Object.assign({ fluxRunsPlayed: '1' }, PILOT), { ios: true }); r.g.win.navigator.userAgent = UA_IG;
    vm.runInContext(SCRIPTS[SCRIPTS.length - 1], r.g.ctx);
    ck('P4 the page\'s own in-app browser check (D-38) drives it', r.g.ctx.fluxInApp() === 'Instagram' && r.g.ctx.fluxInstallMode() === 'inapp');
  } catch (e) { ck('in-app section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const main = await suite(GAME_HTML);
console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = await suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('card title back to "F L U X"', 'C1', rep("SHARE_CARD_TITLE='FLUX Sparta'", "SHARE_CARD_TITLE='F L U X'"));
await control('card ignores the canonical address', 'C2', rep("if(typeof h==='string' && ", "if(false && "));
await control('address in small print', 'C3', rep('SHARE_CARD_ADDRESS_PX=72', 'SHARE_CARD_ADDRESS_PX=34'));
await control('offered after any run (not only a good one)', 'N2', rep('if (good && !fluxInstallOffered() && fluxInstallMode()){', 'if (!fluxInstallOffered() && fluxInstallMode()){'));
await control('offered again and again', 'N4', rep('if (good && !fluxInstallOffered() && fluxInstallMode()){', 'if (good && fluxInstallMode()){'));
await control('offer stays on for later runs', 'N4', rep('newGame = function(){ fluxInstallOfferNow = false; refreshInstallButtons();', 'newGame = function(){'));
await control('a new personal best is not a good run', 'N5', rep('(lv >= 2 || (prevBest > 0 && sc > prevBest))', '(lv >= 2)'));
await control('offer used up where nothing could be shown', 'N8', rep('if (good && !fluxInstallOffered() && fluxInstallMode()){', 'if (good && !fluxInstallOffered()){'));
await control('guide pops up by itself after the run', 'N9', rep("      try{ localStorage.setItem('fluxInstallOffered', '1'); }catch(e){}", "      try{ localStorage.setItem('fluxInstallOffered', '1'); }catch(e){} fluxShowIosGuide();"));
await control('Android gets no one-tap install', 'A1', rep("  if (fluxDeferredInstall) return 'android';", ''));
await control('old iOS steps (Share square) put back', 'S1', rep("'Tap <b>\\u22ef</b> (bottom right) \\u2192 <b>Share</b>.'", "'Tap <b>Share</b> (the square with an arrow) in Safari.'"));
await control('iPhone taken for an iPad (its user agent says "Mac")', 'S2', rep("(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)", "(navigator.userAgent.indexOf('Mac') !== -1 && 'ontouchend' in document)"));
await control('Edit Actions hint dropped', 'S1', rep(' (not there? tap <b>Edit Actions</b> and add it)', ''));
await control('in-app browsers get Home Screen steps', 'P1', rep('  if (app){\n', '  if (false){\n'));
await control('in-app guide forgets COPY MY PILOT', 'P1', rep("(code ? step('Copy your pilot so ' + browser + ' starts as you:', true) + '<button id=\"guideCopyPilot\">COPY MY PILOT</button>' : '') +", ''));
await control('in-app browsers not detected for the offer', 'P4', rep("  if (fluxInApp()) return 'inapp';\n", ''));
const total = main.F + NC;
console.log('\n' + (total ? 'SHARE & INSTALL FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'SHARE & INSTALL PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
