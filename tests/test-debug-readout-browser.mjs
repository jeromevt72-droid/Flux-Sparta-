// Temporary screen readout, in a REAL browser engine (Chromium via Playwright)
// on the real game page, at iPhone, iPad and iPad mini sizes:
//   - 4 taps on the FLUX title do nothing; 5 taps open the readout;
//   - it shows real numbers (screen, inner size, safe area, #app bottom);
//   - text >= 11px, buttons >= 44px, fits on screen; CLOSE hides it;
//   - during play, tapping the HUD FLUX logo 5 times does NOT open it.
// Screenshots go to $SHOTS. Not in the release gate (needs a browser binary).
import { start } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const { chromium } = pw.default || pw;
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8803, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || '/tmp/shots-readout'; fs.mkdirSync(SHOTS, { recursive: true });
const DEVICES = [['iPhone 15 Pro', 393, 852], ['iPad', 820, 1180], ['iPad mini 4', 768, 1024]];
const srv = await start(PORT); const browser = await chromium.launch(); const errors = [];
for (const [name, w, h] of DEVICES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e));
  await p.goto(BASE + '/play/'); await p.waitForTimeout(400);
  const tb = await p.locator('#start h1').boundingBox();
  const tapTitle = () => p.touchscreen.tap(tb.x + tb.width / 2, tb.y + tb.height / 2);   // finger-speed taps
  for (let i = 0; i < 4; i++) { await tapTitle(); await p.waitForTimeout(150); }
  ck(name + ': 4 taps on the title do nothing', await p.locator('#fluxReadout').count() === 0);
  await tapTitle(); await p.waitForTimeout(700);
  ck(name + ': the 5th tap opens the readout', await p.locator('#fluxReadout').count() === 1);
  const m = await p.evaluate(() => { const d = document.getElementById('fluxReadout'), r = d.getBoundingClientRect(), t = document.getElementById('fluxReadoutText').textContent;
    return { t, fs: parseFloat(getComputedStyle(document.getElementById('fluxReadoutText')).fontSize), btn: [...d.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height), fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; });
  ck(name + ': it shows the real measurements', new RegExp('inner +' + w + ' x ' + h).test(m.t) && new RegExp('screen +' + w + ' x ' + h).test(m.t) && /safe area +top/.test(m.t) && new RegExp('#app +top 0 bottom ' + h).test(m.t), m.t.split('\n').slice(2, 4).join(' | '));
  ck(name + ': text >= 11px, buttons >= 44px, fully on screen', m.fs >= 11 && m.btn.every((x) => x >= 44) && m.fits, m.fs + 'px, buttons ' + m.btn.join('/'));
  await p.screenshot({ path: SHOTS + '/readout-' + name.replace(/[^a-z0-9]+/gi, '-') + '.png' });
  await p.locator('#fluxReadoutClose').tap(); await p.waitForTimeout(150);
  ck(name + ': CLOSE hides it', await p.locator('#fluxReadout').count() === 0);
  // During play: the HUD logo cannot open it.
  await p.evaluate(() => { try { localStorage.setItem('fluxColorHintSeen', '1'); } catch (e) {} document.getElementById('startBtn').click(); });
  await p.waitForTimeout(400);
  const logo = await p.locator('.hud .logo').boundingBox();
  for (let i = 0; i < 6; i++) { await p.touchscreen.tap(logo.x + logo.width / 2, logo.y + logo.height / 2); await p.waitForTimeout(100); }
  ck(name + ': during play, 6 taps on the HUD FLUX logo do not open it', await p.locator('#fluxReadout').count() === 0);
  await ctx.close();
}
ck('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
console.log('\n' + (F ? 'READOUT BROWSER FAILED: ' + F : 'READOUT BROWSER PASSED') + '   (screenshots: ' + SHOTS + ')');
process.exit(F ? 1 : 0);
