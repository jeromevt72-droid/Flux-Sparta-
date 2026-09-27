// SHARE & INSTALL, in the release gate. Real game page in the harness vm.
//   C  share card: shows "FLUX Sparta" and the game's web address (the site's
//      canonical host) in large type on one line (Instagram/TikTok captions are
//      not clickable, so people type what they see);
//   N  install offer (owner, simplified): play always first; after a GOOD run
//      (points, and level 2+ or a new personal best over an earlier one) ONE
//      button "Put FLUX on your Home Screen" with "Not now" under it, on that
//      game-over screen only, at most TWICE ever; never a pop-up by itself;
//      never in the installed app; not used up where nothing can be offered;
//   A  Android: the phone's own one-tap install prompt, nothing else;
//   S  iPhone/iPad Safari: the tap copies the pilot by itself (clipboard only --
//      never in the page address, which Share could send), then ONE line "Tap ⋯ → Share → Add to Home
//      Screen" with an arrow at ⋯ (iPhone: bottom; iPad: top); "Edit Actions"
//      only behind "Can't find it?"; "Not now" always there; no COPY MY PILOT;
//   W  first launch of the Home Screen app: one tap "Welcome back! Tap to
//      continue" reads the copied pilot and brings it in; never replaces a pilot
//      that already played there; never shown in a browser tab;
//   P  in-app browsers (Instagram, Facebook, Messenger, TikTok...): ONE line
//      "Open in Safari to install" with an arrow at their ⋯ menu (top right).
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
    const { store, mem } = makeStore(Object.assign({ fluxSeason: '1' }, init));   // SEASON 1: fixture devices are already on Season 1 (else their seeded bests are cleared once)
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
  // Records what the coach / welcome build (the harness DOM is a stand-in).
  const recorder = (b) => { const made = []; b.g.win.document.createElement = () => { const e = { innerHTML: '', textContent: '', attrs: {}, kids: [], classes: new Set(),
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(k) { this.kids.push(k); return k; }, remove() { this.removed = true; },
      classList: null, querySelector(q) { return (this._q = this._q || {})[q] = (this._q[q] || { onclick: null, classList: { add() {}, remove() {} } }); } };
      e.classList = { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), contains: (c) => e.classes.has(c), toggle() {} }; made.push(e); return e; };
    return made; };
  const flush = () => new Promise((r) => setTimeout(r, 30));
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

  if (!quiet) console.log('== install offer: after a good run, one button, "Not now", twice ever at most ==');
  try {
    const b = bootGame({}, { ios: true });
    const no = b.g.win.document.getElementById('gameoverInstallNo'); let noVis = false;
    no.classList = { add: (c) => { if (c === 'hidden') noVis = false; }, remove: (c) => { if (c === 'hidden') noVis = true; }, contains: () => false, toggle() {} };
    b.g.ctx.refreshInstallButtons();
    ck('N1 brand-new player: nothing offered before playing', b.vis.btn === false && b.mem.fluxInstallOffers === undefined);
    b.endRun(700, 1);
    ck('N2 a first run that is not a good run (level 1, no earlier best): no offer, not used up', b.vis.btn === false && b.mem.fluxInstallOffers === undefined);
    b.g.ctx.newGame(); b.endRun(0, 1);
    ck('N6 a zero-point run: no offer', b.vis.btn === false && b.mem.fluxInstallOffers === undefined);
    b.g.ctx.newGame(); b.endRun(7000, 2);
    ck('N3 a good run: ONE button "Put FLUX on your Home Screen" with "Not now" under it', b.vis.btn === true && /Put FLUX on your Home Screen/.test(b.el.textContent) && noVis === true && b.mem.fluxInstallOffers === '1', b.el.textContent);
    ck('N9 never blocking: nothing opens by itself', b.overlays() === 0 && !/fluxShowIosGuide\(\);\s*\n\s*}\s*\n\s*refreshInstallButtons\(\);\s*\n\s*return r;/.test(gameHtml));
    no.onclick();
    ck('N10 "Not now" puts it away', b.vis.btn === false && noVis === false);
    b.g.ctx.newGame(); b.endRun(8000, 2);
    ck('N4 a second good run: offered a second time', b.vis.btn === true && b.mem.fluxInstallOffers === '2');
    b.g.ctx.newGame();
    ck('N4 ...the next run takes it away', b.vis.btn === false);
    b.endRun(12000, 3);
    ck('N4 ...and never a third time', b.vis.btn === false && b.mem.fluxInstallOffers === '2');
    const pb = bootGame({ fluxRunsPlayed: '2', fluxBestRun_easy: JSON.stringify({ score: 500, level: 1 }) }, { ios: true });
    pb.endRun(700, 1);   // Easy level 2 is 750 (EASY SCORING), so 700 is still level 1
    ck('N5 a new personal best over an earlier one counts as a good run', pb.vis.btn === true);
    const nb = bootGame({ fluxRunsPlayed: '2', fluxBestRun_easy: JSON.stringify({ score: 740, level: 1 }) }, { ios: true });
    nb.endRun(700, 1);
    ck('N5 ...a run below the best at level 1 does not', nb.vis.btn === false);
    const st = bootGame({ fluxRunsPlayed: '3' }, { ios: true, standalone: true }); st.endRun(9000, 3);
    ck('N7 already installed: never offered, not used up', st.vis.btn === false && st.mem.fluxInstallOffers === undefined);
    const desk = bootGame({ fluxRunsPlayed: '3' }, { ios: false }); desk.endRun(9000, 3);
    ck('N8 nothing to offer (no install option): no button, the offer is kept for later', desk.vis.btn === false && desk.mem.fluxInstallOffers === undefined);
  } catch (e) { ck('offer section ran', false, String(e.stack || e).slice(0, 300)); }

  if (!quiet) console.log('== Android: the phone\'s own install button ==');
  try {
    const b = bootGame({}, { ios: false });
    let prompted = 0, coach = 0; const evt = { preventDefault() {}, prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
    b.g.win.onbeforeinstallprompt(evt);
    ck('A1 install available but no run yet: nothing shown', b.vis.btn === false);
    b.endRun(7000, 2);
    ck('A1 after a good run: the same one button', b.vis.btn === true && /Put FLUX on your Home Screen/.test(b.el.textContent), b.el.textContent);
    b.g.ctx.fluxShowIosGuide = () => { coach++; };
    b.el.onclick();
    ck('A2 one tap opens the phone\'s own install prompt (no instructions)', prompted === 1 && coach === 0);
  } catch (e) { ck('Android section ran', false, String(e.stack || e).slice(0, 300)); }

  if (!quiet) console.log('== iPhone / iPad Safari: the tap copies the pilot, then ONE line + arrow ==');
  try {
    const b = bootGame(PILOT, { ios: true }); const made = recorder(b);
    let copied = null, url = null; b.g.win.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve(); } };
    b.g.win.history.replaceState = (st, t, u) => { url = String(u); };
    b.endRun(12000, 3); await flush();
    b.el.onclick();
    ck('S1 the tap copies the pilot by itself (no COPY MY PILOT step)', /^FX1-pilot-77-[0-9A-F]{4}$/.test(copied || '') && !/COPY MY PILOT/.test(gameHtml), copied);
    ck('S1 ...and never puts it in the page address (a link shared from Safari must never carry a pilot code)', url === null && !/#pilot|replaceState\([^)]*code/.test(gameHtml), String(url));
    const coach = made.find((e) => /coachLine/.test(e.innerHTML)) || { innerHTML: '' };
    const lines = (coach.innerHTML.match(/<p class="coachLine[^"]*"/g) || []).length;
    ck('S2 then ONE line: "Tap ⋯ → Share → Add to Home Screen"', lines === 1 && coach.innerHTML.includes('Tap <b>⋯</b> → <b>Share</b> → <b>Add to Home Screen</b>') && !/<b>\d\.<\/b>/.test(coach.innerHTML), coach.innerHTML.slice(0, 160));
    ck('S2 ..."Edit Actions" only behind "Can\'t find it?", and "Not now" is always there', /<p class="coachHelp hidden"[^>]*>[^<]*Edit Actions/.test(coach.innerHTML) && coach.innerHTML.includes('Can’t find it?') && coach.innerHTML.includes('>Not now</button>'));
    ck('S3 a big animated arrow at Safari\'s ⋯: bottom on iPhone', /class="coachArrow down"/.test(coach.innerHTML) && /\.coachArrow\.down\{bottom:[^}]*animation:coachDown/.test(gameHtml));
    const pad = bootGame(PILOT, { ios: true, ipad: true }); const made2 = recorder(pad); pad.endRun(12000, 3); await flush(); pad.el.onclick();
    const c2 = made2.find((e) => /coachLine/.test(e.innerHTML)) || { innerHTML: '' };
    ck('S3 ...top right on iPad', /class="coachArrow up"/.test(c2.innerHTML) && /\.coachArrow\.up\{top:/.test(gameHtml));
    const real = bootGame(PILOT, { ios: true, realIPad: true }); real.g.win.navigator.platform = 'MacIntel'; real.g.win.navigator.maxTouchPoints = 5;
    const phone = bootGame(PILOT, { ios: true, realIPad: true }); phone.g.win.navigator.platform = 'iPhone'; phone.g.win.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)';
    ck('S4 an iPhone ("like Mac OS X") is not taken for an iPad; an iPad (Mac with touch) is', phone.g.ctx.fluxIsIPad() === false && real.g.ctx.fluxIsIPad() === true);
  } catch (e) { ck('iOS section ran', false, String(e.stack || e).slice(0, 300)); }

  if (!quiet) console.log('== first launch of the Home Screen app: one tap, welcome back ==');
  try {
    const src = bootGame(PILOT, { ios: true }); const code = await src.g.ctx.makeRestoreCode('pilot-77');
    const INFO = { found: true, name: 'TITAN', tag: 'K7Q2MX8', country: 'PH', bests: { medium: { score: 9000, level: 3 } }, skus: [] };
    const fresh = () => ({ fluxPlayerId: 'new-app-1', fluxCallsign: 'SWIFT COMET 42', fluxAutoName: '1', fluxProfileComplete: '1' });
    const c = bootGame(fresh(), { ios: true, standalone: true }); const madeC = recorder(c);
    c.g.win.navigator.clipboard = { readText: () => Promise.resolve('  ' + code + '\n') }; c.g.ctx.checkRestoreOnServer = async () => ({ kind: 'found', info: INFO });
    await c.g.ctx.fluxWelcomeBack();
    const btnC = madeC.find((e) => e.id === 'welcomeGo') || {};
    ck('W1 the new app shows one button: "Welcome back! Tap to continue", no instructions', btnC.textContent === 'Welcome back! Tap to continue' && !madeC.some((e) => /Safari|Share|restore code/i.test(e.textContent || '') && e.id !== 'welcomeNo'), btnC.textContent);
    await btnC.onclick(); await flush();
    ck('W2 one tap reads the copied pilot and brings it in (same pilot, scores)', c.mem.fluxPlayerId === 'pilot-77' && c.mem.fluxCallsign === 'TITAN' && c.mem.fluxBest_medium === '9000' && c.g.nav.reload === true, c.mem.fluxPlayerId);
    const e = bootGame(fresh(), { ios: true, standalone: true }); const madeE = recorder(e); let entry = 0;
    e.g.win.navigator.clipboard = { readText: () => Promise.resolve('hello') }; e.g.ctx.openRestoreEntry = () => { entry++; };
    await e.g.ctx.fluxWelcomeBack(); await (madeE.find((x) => x.id === 'welcomeGo') || { onclick: async () => {} }).onclick(); await flush();
    ck('W3 nothing usable copied: the usual paste-your-code box, the new pilot is kept', entry === 1 && e.mem.fluxPlayerId === 'new-app-1');
    const tab = bootGame(fresh(), { ios: true, standalone: false }); const madeT = recorder(tab); await tab.g.ctx.fluxWelcomeBack();
    ck('W6 never shown in a browser tab (a new player there is not "back")', !madeT.some((x) => x.id === 'welcomeGo'));
    const played = bootGame(Object.assign(fresh(), { fluxBest_easy: '500', fluxRunsPlayed: '2' }), { ios: true, standalone: true }); const madeP = recorder(played);
    played.g.ctx.checkRestoreOnServer = async () => ({ kind: 'found', info: INFO });
    await played.g.ctx.fluxWelcomeBack();
    ck('W4 a pilot that already played in the app is never replaced', !madeP.some((e) => e.id === 'welcomeGo') && played.mem.fluxPlayerId === 'new-app-1');
    const n = bootGame(fresh(), { ios: true, standalone: true }); const madeN = recorder(n);
    n.g.ctx.checkRestoreOnServer = async () => ({ kind: 'found', info: INFO });
    await n.g.ctx.fluxWelcomeBack(); (madeN.find((e) => e.id === 'welcomeNo') || { onclick() {} }).onclick();
    ck('W5 "Start as a new pilot" keeps the new pilot and does not ask again', n.mem.fluxPlayerId === 'new-app-1' && n.mem.fluxWelcomeDone === '1');
  } catch (e) { ck('welcome section ran', false, String(e.stack || e).slice(0, 300)); }

  if (!quiet) console.log('== in-app browsers: one line, open in Safari ==');
  try {
    const b = bootGame(PILOT, { ios: true, app: 'Instagram' }); const made = recorder(b); let copied = null;
    b.g.win.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve(); } };
    b.endRun(12000, 3); await flush();
    ck('P1 inside Instagram: the offer appears after a good run', b.vis.btn === true);
    b.el.onclick();
    const coach = made.find((e) => /coachLine/.test(e.innerHTML)) || { innerHTML: '' };
    ck('P1 ...one line "Open in Safari to install" with an arrow at their ⋯ menu (top right), not Home Screen steps',
      coach.innerHTML.includes('Open in <b>Safari</b> to install') && /class="coachArrow up"/.test(coach.innerHTML) && !/Add to Home Screen/.test(coach.innerHTML), coach.innerHTML.slice(0, 160));
    ck('P1 ...and the pilot is copied for Safari', /^FX1-pilot-77-/.test(copied || ''));
    const an = bootGame(PILOT, { ios: false, app: 'Facebook' }); const madeA = recorder(an); an.g.ctx.fluxShowIosGuide();
    ck('P2 Android in-app browser: "Open in your browser to install"', (madeA.find((e) => /coachLine/.test(e.innerHTML)) || { innerHTML: '' }).innerHTML.includes('Open in <b>your browser</b> to install'));
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
await control('offered after any run (not only a good one)', 'N2', rep('if (good && fluxInstallCount() < FLUX_INSTALL_MAX && fluxInstallMode()){', 'if (fluxInstallCount() < FLUX_INSTALL_MAX && fluxInstallMode()){'));
await control('offered again and again', 'N4 ...and never a third time', rep('const FLUX_INSTALL_MAX = 2;', 'const FLUX_INSTALL_MAX = 99;'));
await control('"Not now" missing', 'N3', rep("['gameoverInstallBtn','gameoverInstallNo'].forEach", "['gameoverInstallBtn'].forEach"));
await control('"Not now" does nothing', 'N10', rep("function fluxInstallNotNow(){ fluxInstallOfferNow = false; refreshInstallButtons(); }", "function fluxInstallNotNow(){}"));
await control('a new personal best is not a good run', 'N5', rep('(lv >= 2 || (prevBest > 0 && sc > prevBest))', '(lv >= 2)'));
await control('offer used up where nothing could be shown', 'N8', rep('if (good && fluxInstallCount() < FLUX_INSTALL_MAX && fluxInstallMode()){', 'if (good && fluxInstallCount() < FLUX_INSTALL_MAX){'));
await control('Android gets no one-tap install', 'A1', rep("  if (fluxDeferredInstall) return 'android';", ''));
await control('the tap no longer copies the pilot', 'S1', rep("if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(function(){}, function(){});", ''));
await control('several numbered steps again', 'S2', rep("'<p class=\"coachLine\" id=\"coachLine\">' + line + '</p>' +", "'<p class=\"coachLine\" id=\"coachLine\">' + line + '</p><p class=\"coachLine\"><b>2.</b> Tap Add</p>' +"));
await control('Edit Actions shown straight away', 'S2 ...', rep("'<p class=\"coachHelp hidden\" id=\"coachHelp\">'", "'<p class=\"coachHelp\" id=\"coachHelp\">'"));
await control('arrow on the wrong side on iPhone', 'S3', rep("    up = pad;", "    up = true;"));
await control('iPhone taken for an iPad (its user agent says "Mac")', 'S4', rep("(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)", "(navigator.userAgent.indexOf('Mac') !== -1)"));
await control('pilot code put in the page address again', 'S1 ...and never', rep("  try{ if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(function(){}, function(){}); }catch(e){}\n}", "  try{ if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(function(){}, function(){}); }catch(e){}\n  history.replaceState(null, '', location.pathname + '#pilot=' + code);\n}"));
await control('welcome shown in a browser tab', 'W6', rep("if (done || !fluxFreshPilot() || !fluxIsStandalone() || fluxHasPlayed()) return null;", "if (done || !fluxFreshPilot() || fluxHasPlayed()) return null;"));
await control('welcome replaces a pilot that already played', 'W4', rep("if (done || !fluxFreshPilot() || !fluxIsStandalone() || fluxHasPlayed()) return null;", "if (done || !fluxIsStandalone()) return null;"));
await control('in-app browsers get Home Screen steps', 'P1', rep('  if (app){\n    line = ios', '  if (false){\n    line = ios'));
await control('in-app browsers not detected for the offer', 'P4', rep("  if (fluxInApp()) return 'inapp';\n", ''));
const total = main.F + NC;
console.log('\n' + (total ? 'SHARE & INSTALL FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'SHARE & INSTALL PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
