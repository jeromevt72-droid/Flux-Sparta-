// FIRST INSTALL (Chromium, not in the gate): open the game with no worker yet, start a run at once,
// and check the page never reloads while the worker installs and takes control.
//   node tests/test-first-install-reload-browser.mjs
import { start } from './browser-server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const port = 9300 + Math.floor(Math.random() * 200), srv = await start(port);
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) F++; };
try {
  const ctx = await b.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); let navs = 0; p.on('framenavigated', (f) => { if (f === p.mainFrame()) navs++; });
  await p.goto('http://localhost:' + port + '/play/');
  await p.waitForFunction(() => { const s = document.getElementById('startBtn'); return s && s.offsetWidth > 0 && typeof s.onclick === 'function'; }, null, { timeout: 60000 });
  const n0 = navs; await p.evaluate(() => { window.__mark = 1; document.getElementById('startBtn').click(); });
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const r = await p.evaluate(() => ({ mark: window.__mark === 1, ctrl: !!navigator.serviceWorker.controller, playing: typeof playing !== 'undefined' && !!playing }));
  ck('the worker took control', r.ctrl);
  ck('the page never reloaded (from opening to now)', navs === 1 && n0 === 1 && r.mark, 'page loads ' + navs);
  ck('the run started at once is still going', r.playing);
} catch (e) { ck('ran: ' + e.message, false); }
await b.close(); srv.close();
console.log(F ? 'FIRST INSTALL (browser) FAILED' : 'FIRST INSTALL (browser) PASSED'); process.exit(F ? 1 : 0);
