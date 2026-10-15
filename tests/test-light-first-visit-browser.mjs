// Extra, NOT in the gate (needs Chromium): LIGHT FIRST VISIT in a real browser at BLU G45 size
// (360x800, DPR 2). The browser is told the connection kind (navigator.connection), as Chrome on
// Android reports it. Checks what a brand-new visitor's Gateway actually downloads:
//   B1 Wi-Fi ('4g'): the sharp planet pictures (assets2x) and the gameplay preview, as before;
//   B2 slow ('3g'): no assets2x picture, no preview, no service worker; only the small planet
//      pictures, after the page has loaded;
//   B3 slow + a run already finished: the preview loads.
// Timing and data on throttled fast/slow 3G are measured separately (see the pull request).
// Usage: node test-light-first-visit-browser.mjs
import { start } from './browser-server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8790, srv = await start(PORT);
async function visit(et, played = false) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([e, p]) => {
    try { Object.defineProperty(navigator, 'connection', { configurable: true, get: () => ({ effectiveType: e, saveData: false, addEventListener() {} }) }); } catch (x) {}
    if (p) try { localStorage.setItem('fluxRunsPlayed', '2'); } catch (x) {}
  }, [et, played]);
  const page = await ctx.newPage(); const urls = [];
  page.on('request', (r) => urls.push(new URL(r.url()).pathname));
  await page.goto('http://localhost:' + PORT + '/?src=test', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const sw = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length));
  await b.close();
  return { urls, sw };
}
try {
  const wifi = await visit('4g'), slow = await visit('3g'), back = await visit('3g', true);
  ck('B1 Wi-Fi: sharp planet pictures + preview + service worker, as before',
    ['solar', 'frozen', 'neon', 'storm', 'celestial'].every((n) => wifi.urls.includes('/assets2x/' + n + '@2x.webp')) && wifi.urls.includes('/hero-demo.html') && wifi.sw === 1, JSON.stringify(wifi.urls));
  ck('B2 slow: no sharp picture, no preview, no service worker; small planet pictures after load',
    !slow.urls.some((u) => u.startsWith('/assets2x/')) && !slow.urls.includes('/hero-demo.html') && slow.sw === 0 && ['solar', 'frozen', 'neon', 'storm', 'celestial'].every((n) => slow.urls.includes('/assets/' + n + '.webp')), JSON.stringify(slow.urls));
  ck('B3 slow + a run already finished: the preview loads', back.urls.includes('/hero-demo.html'));
} finally { srv.close(); }
console.log(F ? 'LIGHT FIRST VISIT (browser) FAILED: ' + F : 'LIGHT FIRST VISIT (browser) PASSED');
process.exit(F ? 1 : 0);
