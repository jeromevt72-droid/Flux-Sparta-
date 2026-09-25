// Skin backdrop black-band fix, measured in a REAL browser engine (Chromium via
// Playwright) on the real game page. Reproduces the iPhone Home Screen app
// situation: the page's usable area ends ABOVE the physical bottom of the
// screen by the status-bar inset, and iOS paints the rest with the page
// background (the black band under Solar Inferno). Chromium has no notch, so
// the insets are simulated (env(safe-area-inset-*) rewritten) and the game's
// full-screen container is made to end short by the status-bar inset.
// Checks, on iPhone and iPad sizes: the backdrop still reaches the bottom of
// the screen, and the page background behind it matches the backdrop's bottom.
// Not in the release gate (needs a browser binary); run: node test-backdrop-bleed-browser.mjs
import { start } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const { chromium } = pw.default || pw;
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8799, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || '/tmp/shots-backdrop'; fs.mkdirSync(SHOTS, { recursive: true });
const DEVICES = [
  ['iPhone 15 Pro (Home Screen)', 393, 852, 59, 34], ['iPhone 14 (Home Screen)', 390, 844, 47, 34], ['iPhone SE (Home Screen)', 375, 667, 20, 0],
  ['iPad (Home Screen)', 820, 1180, 24, 20], ['iPad mini 4 (iPadOS 15.8, Home Screen)', 768, 1024, 20, 0],
];
const srv = await start(PORT);
const browser = await chromium.launch();
const errors = [];
for (const [name, w, h, top, bottom] of DEVICES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.route('**/play/', async (route) => {
    const r = await route.fetch();
    const b = (await r.text()).replace(/env\(safe-area-inset-top(,\s*0px)?\)/g, top + 'px').replace(/env\(safe-area-inset-bottom(,\s*0px)?\)/g, bottom + 'px')
      // The iOS Home Screen shortfall: the full-screen container ends `top` px above the screen bottom.
      .replace('</style>', '#app{bottom:' + top + 'px!important}</style>');
    await route.fulfill({ response: r, body: b });
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e));
  await p.goto(BASE + '/play/'); await p.waitForTimeout(400);
  const off = await p.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  await p.evaluate(() => { ownsSkin = () => true; setBackground('solar'); });
  await p.waitForTimeout(700);
  const m = await p.evaluate(() => { const a = document.getElementById('app').getBoundingClientRect(), l = document.getElementById('skinBgLayer').getBoundingClientRect();
    return { H: innerHeight, appBottom: a.bottom, layerTop: l.top, layerBottom: l.bottom, html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, opacity: getComputedStyle(document.getElementById('skinBgLayer')).opacity }; });
  ck(name + ': the simulated shortfall is real (usable area ends ' + (m.H - m.appBottom) + 'px above the screen bottom)', m.H - m.appBottom === top);
  ck(name + ': the Solar backdrop still reaches the bottom of the screen', m.layerBottom >= m.H && m.layerTop <= 0, 'layer ' + Math.round(m.layerTop) + '..' + Math.round(m.layerBottom) + ', screen ' + m.H);
  ck(name + ': behind it, the page background matches the backdrop bottom (#1c0c0b)', m.html === 'rgb(28, 12, 11)' && m.body === 'rgb(28, 12, 11)', m.html);
  await p.screenshot({ path: SHOTS + '/solar-' + name.replace(/[^a-z0-9]+/gi, '-') + '.png' });
  await p.evaluate(() => setBackground('none')); await p.waitForTimeout(100);
  const back = await p.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  ck(name + ': backdrop off -> page background back to the default', back === off && off === 'rgb(5, 7, 25)', off + ' -> ' + back);
  await ctx.close();
}
ck('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
console.log('\n' + (F ? 'BACKDROP BROWSER FAILED: ' + F : 'BACKDROP BROWSER PASSED') + '   (screenshots: ' + SHOTS + ')');
process.exit(F ? 1 : 0);
