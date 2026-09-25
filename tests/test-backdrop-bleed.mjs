// Skin backdrop black-band fix, in the release gate. In the iPhone Home Screen
// app the page's usable area can end above the physical bottom of the screen;
// iOS painted the rest with the near-black page background, a black band under
// the Solar Inferno backdrop. Checks on the real game page (harness vm + its
// stylesheet):
//   - the backdrop layer runs past the bottom edge by the status-bar AND
//     home-indicator insets plus a margin;
//   - with a backdrop on, the page background matches the backdrop's bottom
//     colour; with it off, the page background is back to the default;
//   - nothing else about the backdrop changed (image, 50% opacity, cover).
// Ends with negative controls. Real rendering, including a simulated Home
// Screen shortfall, is checked in test-backdrop-bleed-browser.mjs (needs Chromium).
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const cssOf = (h) => [...h.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const css = cssOf(gameHtml);
  const rules = [...css.matchAll(/#skinBgLayer\{([^}]*)\}/g)].map((m) => m[1]);
  const last = (prop) => { let v = null; for (const r of rules) for (const d of r.split(';')) { const i = d.indexOf(':'); if (i > 0 && d.slice(0, i).trim() === prop) v = d.slice(i + 1).trim(); } return v; };
  const bottom = last('bottom') || '';
  ck('K1 the backdrop runs past the bottom edge by the status-bar and home-indicator insets plus a margin',
    /^calc\(-1 \* \(env\(safe-area-inset-top,0px\) \+ env\(safe-area-inset-bottom,0px\)\) - (\d+)px\)$/.test(bottom) && +bottom.match(/(\d+)px\)$/)[1] >= 40, bottom || '(none)');
  ck('K2 the rest of the backdrop is unchanged (full screen, image cover, centred)', last('inset') === '0' && last('background-size') === 'cover' && last('background-position') === 'center' && /position:absolute/.test(rules[0] || ''));
  try {
    const { store } = makeStore({ fluxPlayerId: 'bb-1', fluxCallsign: 'T', fluxProfileComplete: '1' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    const doc = g.win.document;
    const html = { style: {} }, body = { style: {} }, layer = { style: {} };
    doc.documentElement = html; doc.body = body;
    const byId0 = doc.getElementById; doc.getElementById = (id) => (id === 'skinBgLayer' ? layer : byId0(id));
    run('ownsSkin = function(){ return true; };');
    g.ctx.setBackground('solar');
    ck('K3 Solar backdrop on: image shown at 50%', /solar-inferno\.webp/.test(layer.style.backgroundImage) && layer.style.opacity === '0.5', layer.style.opacity);
    ck('K4 ...and the page background behind it matches the backdrop bottom (#1c0c0b)', html.style.backgroundColor === '#1c0c0b' && body.style.backgroundColor === '#1c0c0b', html.style.backgroundColor);
    g.ctx.setBackground('none');
    ck('K5 backdrop off: page background back to the default', html.style.backgroundColor === '' && body.style.backgroundColor === '' && layer.style.opacity === '0');
    run("ownsSkin = function(s){ return s === 'aurora'; };");
    run("activeBackground = 'solar';"); g.ctx.applySkinBackground();
    ck('K6 a backdrop the pilot does not own is never shown, and the page stays default', layer.style.opacity === '0' && html.style.backgroundColor === '');
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
control('backdrop stops at the usable area again (the black band)', 'K1', rep('#skinBgLayer{bottom:calc(-1 * (env(safe-area-inset-top,0px) + env(safe-area-inset-bottom,0px)) - 64px)}\n', ''));
control('only the home-indicator inset covered (Home Screen status-bar shortfall missed)', 'K1', rep('#skinBgLayer{bottom:calc(-1 * (env(safe-area-inset-top,0px) + env(safe-area-inset-bottom,0px)) - 64px)}', '#skinBgLayer{bottom:calc(-1 * env(safe-area-inset-bottom,0px))}'));
control('page background left near-black behind the backdrop', 'K4', rep("  try{ document.documentElement.style.backgroundColor=base; document.body.style.backgroundColor=base; }catch(e){}\n", ''));
control('page background never reset when the backdrop is turned off', 'K5', rep("const base=on && s.bgBase ? s.bgBase : '';", "const base=s && s.bgBase ? s.bgBase : (document.documentElement.style.backgroundColor||'');"));
const total = main.F + NC;
console.log('\n' + (total ? 'BACKDROP BLEED FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'BACKDROP BLEED PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
