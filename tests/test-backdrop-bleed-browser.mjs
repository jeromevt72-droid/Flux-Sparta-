// Skin backdrop black-band fix, measured in a REAL browser engine (Chromium via
// Playwright) on the real game page. Reproduces the iPhone/iPad Home Screen app
// situation as closely as Chromium allows: the page's usable area ends ABOVE
// the physical bottom of the screen, and the game's full-screen container is
// CLIPPED to that shorter area (what WebKit does to fixed layers there). Only
// the page's root background can paint the strip below.
// Checks, on iPhone and iPad sizes, portrait and landscape: the strip below the
// usable area shows the Solar image itself (textured, not one flat colour) and
// runs on from the picture above with no hard edge. Then the OLD approach
// (image inside the container) is replayed on the same page and must show the
// flat band, proving the check can fail. Real iOS WebKit is not available
// here; this needs confirming on a device.
// Not in the release gate (needs a browser binary); run: node test-backdrop-bleed-browser.mjs
import { start } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const { chromium } = pw.default || pw;
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8799, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || '/tmp/shots-backdrop'; fs.mkdirSync(SHOTS, { recursive: true });
// name, physical screen w x h (CSS px), shortfall at the bottom, iOS screen.* (always portrait), orientation
const DEVICES = [
  ['iPhone 15 Pro (Home Screen)', 393, 852, 59, [393, 852], 0], ['iPhone 14 (Home Screen)', 390, 844, 47, [390, 844], 0],
  ['iPhone SE (Home Screen)', 375, 667, 20, [375, 667], 0], ['iPhone 15 Pro (Safari, toolbars)', 393, 852, 120, [393, 852], 0],
  ['iPad (Home Screen)', 820, 1180, 24, [820, 1180], 0], ['iPad landscape (Home Screen)', 1180, 820, 24, [820, 1180], 90],
  ['iPad mini 4 (iPadOS 15.8, Home Screen)', 768, 1024, 20, [768, 1024], 0],
];
const srv = await start(PORT);
const browser = await chromium.launch();
const errors = [];
// The moving stars and the game canvas are hidden while measuring: they are the
// same in both approaches and would make the edge measurement noisy.
// Mean colour of a 1px row, and how textured a block of rows is (colour spread).
async function sample(p, png, H, gap) {
  return p.evaluate(async ({ b64, H, gap }) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const x = cv.getContext('2d'); x.drawImage(img, 0, 0); const s = img.height / H;
    const row = (y) => { const d = x.getImageData(0, Math.round(y * s), img.width, 1).data; const m = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += d[i + k]; return m.map((v) => v / (d.length / 4)); };
    const spread = (y0, y1) => { const d = x.getImageData(0, Math.round(y0 * s), img.width, Math.max(1, Math.round((y1 - y0) * s))).data; let lo = 765, hi = 0; for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
    const cut = H - gap, diff = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return { edge: diff(row(cut - 2), row(cut + 1)), ref: diff(row(cut - 6), row(cut - 3)), gapSpread: spread(cut + 1, H - 1) };
  }, { b64: png.toString('base64'), H, gap });
}
for (const [name, w, h, gap, scr, orient] of DEVICES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  // What the page reports on iOS: a usable height `gap` px short of the screen, screen.* in portrait.
  await ctx.addInitScript(({ innerH, scr, orient }) => {
    Object.defineProperty(window, 'innerHeight', { get: () => innerH, configurable: true });
    Object.defineProperty(screen, 'width', { get: () => scr[0] }); Object.defineProperty(screen, 'height', { get: () => scr[1] });
    Object.defineProperty(window, 'orientation', { get: () => orient });
  }, { innerH: h - gap, scr, orient });
  await ctx.route('**/play/', async (route) => {
    const r = await route.fetch();
    // The shortfall: the root box ends `gap` px above the screen bottom, and the full-screen container is clipped to it.
    const b = (await r.text()).replace('</style>', 'html{height:calc(100% - ' + gap + 'px)!important}#app{bottom:' + gap + 'px!important;overflow:hidden!important}</style>');
    await route.fulfill({ response: r, body: b });
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e));
  await p.goto(BASE + '/play/'); await p.waitForTimeout(400);
  await p.evaluate(() => { document.querySelectorAll('#start,#gameover,#shop,.miniOverlay,#game,#celestialMotion').forEach((e) => { e.style.display = 'none'; }); ownsSkin = () => true; setBackground('solar'); });
  await p.waitForTimeout(700);
  const m = await p.evaluate(() => ({ H: innerHeight, app: document.getElementById('app').getBoundingClientRect().bottom }));
  ck(name + ': the simulated shortfall is real (usable area and container end ' + gap + 'px above the screen bottom)', m.H === h - gap && Math.round(m.app) === h - gap, m.H + ' / ' + m.app);
  const shot = await p.screenshot({ path: SHOTS + '/solar-' + name.replace(/[^a-z0-9]+/gi, '-') + '.png' });
  const s = await sample(p, shot, h, gap);
  ck(name + ': the strip below the usable area shows the Solar image itself (textured, not a flat band)', s.gapSpread > 40, 'colour spread ' + Math.round(s.gapSpread));
  ck(name + ': ...and it runs on from the picture above with no hard edge', s.edge <= Math.max(4, s.ref * 3), 'step at the edge ' + s.edge.toFixed(1) + ' vs ' + s.ref.toFixed(1) + ' between rows above');
  // Replay the OLD approach (image inside the clipped container, page background behind) on the same page.
  await p.evaluate(() => { activeBackground = 'none'; const r = document.documentElement.style; r.backgroundImage = ''; document.getElementById('app').style.background = ''; const l = document.getElementById('skinBgLayer'); l.style.backgroundImage = "url('/solar-inferno.webp')"; l.style.transition = 'none'; l.style.opacity = '0.5'; });
  await p.waitForTimeout(300);
  const old = await sample(p, await p.screenshot(), h, gap);
  ck(name + ': control: the old approach DOES show a flat band here', old.gapSpread <= 6, 'spread ' + Math.round(old.gapSpread) + ', edge ' + old.edge.toFixed(1));
  await p.evaluate(() => { document.getElementById('skinBgLayer').style.opacity = '0'; setBackground('none'); }); await p.waitForTimeout(100);
  const back = await p.evaluate(() => ({ img: document.documentElement.style.backgroundImage, html: getComputedStyle(document.documentElement).backgroundColor }));
  ck(name + ': backdrop off -> page background back to the default', !back.img && back.html === 'rgb(5, 7, 25)', back.html);
  await ctx.close();
}
ck('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
console.log('\n' + (F ? 'BACKDROP BROWSER FAILED: ' + F : 'BACKDROP BROWSER PASSED') + '   (screenshots: ' + SHOTS + ')');
process.exit(F ? 1 : 0);
