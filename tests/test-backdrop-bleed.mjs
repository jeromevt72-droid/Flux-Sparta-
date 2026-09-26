// Skin backdrop black-band fix, in the release gate. In the iPhone/iPad Home
// Screen app the page's usable area ends above the physical bottom of the
// screen, and iOS clips the game's full-screen container (and the old backdrop
// layer inside it) to that shorter area; only the page's ROOT background paints
// the strip below. So the backdrop image is painted on the root (<html>)
// background, sized in px like CSS "cover" over the whole physical screen.
// Checks on the real game page (harness vm):
//   - Solar on: the image is on the root background and covers the full
//     physical screen (iPhone portrait, iPad portrait + landscape, Safari);
//   - #app, <body> and the old layer are see-through, so nothing covers it;
//   - the level tint still sits over it at 50% (same look as before);
//   - rotating / resizing re-fits it;
//   - off, or not owned: everything back to the default.
// Ends with negative controls. Rendering (with a simulated short viewport and
// clipped container) is checked in test-backdrop-bleed-browser.mjs (Chromium).
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const IMG_W = 900, IMG_H = 1599;   // public/solar-inferno.webp

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    const { store } = makeStore({ fluxPlayerId: 'bb-1', fluxCallsign: 'T', fluxProfileComplete: '1' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    const doc = g.win.document;
    const html = { style: {} }, body = { style: {} }, layer = { style: {} }, app = { style: {} };
    doc.documentElement = html; doc.body = body;
    const byId0 = doc.getElementById; doc.getElementById = (id) => (id === 'skinBgLayer' ? layer : id === 'app' ? app : byId0(id));
    run('ownsSkin = function(){ return true; };');
    // Parse the root background's first-layer size/position; does it cover a W x H screen from the top-left?
    const tile = () => {
      const sz = String(html.style.backgroundSize || '').split(',').map((v) => v.trim().split(/\s+/).map(parseFloat));
      const ps = String(html.style.backgroundPosition || '').split(',').map((v) => v.trim().split(/\s+/).map(parseFloat));
      return { sz, ps };
    };
    const covers = (W, H) => { const { sz, ps } = tile(); if (sz.length < 2 || ps.length < 2) return false;
      return [0, 1].every((i) => ps[i][0] <= 0 && ps[i][1] <= 0 && ps[i][0] + sz[i][0] >= W && ps[i][1] + sz[i][1] >= H); };
    // Centred on the PHYSICAL screen (so rotation does not push the picture off-centre).
    const centred = (W, H) => { const { sz, ps } = tile(); return sz[1] && Math.abs(ps[1][0] + sz[1][0] / 2 - W / 2) <= 2 && Math.abs(ps[1][1] + sz[1][1] / 2 - H / 2) <= 2; };
    const aspectOk = () => { const { sz } = tile(); return sz[1] && Math.abs(sz[1][0] / sz[1][1] - IMG_W / IMG_H) < 0.01; };
    const cover = (desc) => { const { sz, ps } = tile(); return desc + ': ' + (sz[1] || []).join('x') + ' at ' + (ps[1] || []).join(',') + ' | ' + html.style.backgroundColor; };
    const setWin = (w, h, sw, sh, o) => { run(`innerWidth=${w}; innerHeight=${h}; screen={width:${sw},height:${sh}}; orientation=${o};`); };

    // iPhone 15 Pro Home Screen app: usable area 393x793, physical screen 393x852 (59px short).
    setWin(393, 793, 393, 852, 0);
    g.ctx.setBackground('solar');
    ck('K1 Solar on: the image is painted on the page root background (the only thing iOS paints below the usable area)',
      /url\('\/solar-inferno\.webp'\)/.test(html.style.backgroundImage || ''), String(html.style.backgroundImage).slice(0, 80));
    ck('K2 iPhone Home Screen app: the image covers the full physical screen, 393x852, down to the bottom (like CSS cover: aspect kept, centred)', covers(393, 852) && centred(393, 852) && aspectOk(), cover('iPhone'));
    ck('K3 nothing covers it: game container, page body and the old layer are see-through',
      app.style.background === 'transparent' && body.style.backgroundColor === 'transparent' && layer.style.opacity === '0', app.style.background + ' / ' + body.style.backgroundColor + ' / ' + layer.style.opacity);
    ck('K4 the dark field sits over the image at 75% (orb colours v2: image at 25%, so orbs stand out) and a matching base colour is behind it',
      /^radial-gradient\(circle at 50% 15%,rgba\(17,27,67,0\.75\) 0,rgba\(7,9,29,0\.75\) 48%,rgba\(3,4,13,0\.75\) 100%\), url/.test(html.style.backgroundImage || '') && html.style.backgroundColor === '#1c0c0b', String(html.style.backgroundImage).slice(0, 110));
    // iPad (portrait) Home Screen app, then landscape: iOS keeps screen.* in portrait.
    setWin(820, 1156, 820, 1180, 0); g.fire('resize');
    ck('K5 iPad portrait: covers the full physical screen 820x1180 after a resize', covers(820, 1180) && centred(820, 1180) && aspectOk(), cover('iPad portrait'));
    setWin(1180, 796, 820, 1180, 90); g.fire('resize');
    ck('K5 iPad landscape: covers the full physical screen 1180x820 after rotation, centred on it', covers(1180, 820) && centred(1180, 820) && aspectOk(), cover('iPad landscape'));
    // Safari with toolbars: usable area 390x664 on an 390x844 screen.
    setWin(390, 664, 390, 844, 0); g.fire('resize');
    ck('K5 iPhone Safari with toolbars: covers down to the physical bottom 390x844', covers(390, 844) && centred(390, 844) && aspectOk(), cover('Safari'));
    // Level tint under the backdrop.
    g.ctx.applyCelestialBackground(9);
    ck('K6 a level-up keeps the backdrop: the container stays see-through and the level-9 tint is laid over the image',
      app.style.background === 'transparent' && /rgba\(126,58,46,0\.75\)/.test(html.style.backgroundImage || '') && /solar-inferno/.test(html.style.backgroundImage || ''), app.style.background.slice(0, 40));
    g.ctx.setBackground('none');
    ck('K7 backdrop off: root background cleared, page body default, the game container gets its level gradient back',
      !html.style.backgroundImage && html.style.backgroundColor === '' && body.style.backgroundColor === '' && /^radial-gradient\(circle at 50% 10%,#7e3a2e/.test(app.style.background || ''), String(app.style.background).slice(0, 50));
    run("ownsSkin = function(s){ return s === 'aurora'; };");
    run("activeBackground = 'solar';"); g.ctx.applySkinBackground();
    ck('K8 a backdrop the pilot does not own is never shown, and the page stays default', !html.style.backgroundImage && html.style.backgroundColor === '' && layer.style.opacity === '0');
  } catch (e) { ck('backdrop section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each part of the fix removed MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('image sized to the usable area only (the band again)', 'K2', rep('return { w:w, h:h+Math.min(240,Math.max(0,sh-h)) };', 'return { w:w, h:h };'));
control('iPad rotation ignored (portrait screen height used in landscape)', 'K5', rep('sh=land ? Math.min(a,b) : Math.max(a,b);', 'sh=Math.max(a,b);'));
control('no re-fit on resize/rotation', 'K5', rep('if(skinBackdropOn())applySkinBackground();/* backdrop re-fits on rotation / window changes */', ''));
control('game container left opaque over the root backdrop', 'K3', rep("      if(app) app.style.background='transparent';\n", ''));
control('backdrop back at 50% (orbs harder to see on Solar)', 'K4', rep('const BACKDROP_DARK=.75;', 'const BACKDROP_DARK=.5;'));
control('dark field not laid over the image (too bright, unreadable orbs)', 'K4', rep("root.style.backgroundImage=halfTheme(theme)+\", url('\"+s.bg+\"')\";", "root.style.backgroundImage=\"url('\"+s.bg+\"')\";"));
control('a level-up paints the level gradient over the backdrop', 'K6', rep('  if(skinBackdropOn()){ applySkinBackground(); return; }   // the level tint is painted under the backdrop instead\n', ''));
control('root background never cleared when the backdrop is turned off', 'K7', rep("root.style.backgroundColor=''; root.style.backgroundImage='';", "root.style.backgroundColor='';"));
const total = main.F + NC;
console.log('\n' + (total ? 'BACKDROP BLEED FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'BACKDROP BLEED PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
