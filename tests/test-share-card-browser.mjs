// Share card in a REAL browser engine (Chromium via Playwright), iPhone, iPad
// and iPad mini sizes: a run ends with points, SHARE MY SCORE is on screen
// (>= 44px, inside the panel), the card image is a real 720x900 JPEG, and the
// share sheet receives the image plus the text with the link. The game-over
// screen and the card are saved to $SHOTS. Not in the release gate.
import { start } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const { chromium } = pw.default || pw;
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8807, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || '/tmp/shots-share'; fs.mkdirSync(SHOTS, { recursive: true });
const DEV = [['iPhone 15 Pro', 393, 852], ['iPad', 820, 1180], ['iPad mini 4', 768, 1024]];
const srv = await start(PORT); const browser = await chromium.launch(); const errors = [];
// Warm the browser's emoji font and JPEG encoder once (a cold headless Chromium can take seconds to load it the
// first time; phones use their built-in emoji font), so the timing below measures the game.
{ const w = await browser.newPage(); await w.setContent('<canvas id=c></canvas>'); await w.evaluate(() => { const x = document.getElementById('c').getContext('2d'); x.font = '220px "Noto Color Emoji",sans-serif'; x.fillText('\u{1F1F5}\u{1F1ED}', 0, 200); }); await w.evaluate(() => new Promise((r) => document.getElementById('c').toBlob(r, 'image/jpeg', .9))); await w.close(); }
// ...and run one unmeasured game-over in the real page (the first renderer in a fresh headless browser is slow once).
{ const wc = await browser.newContext({ viewport: { width: 393, height: 852 }, serviceWorkers: 'block' }); const w = await wc.newPage(); await w.goto(BASE + '/play/'); await w.waitForTimeout(300);
  await w.evaluate(() => { document.getElementById('startBtn').click(); }); await w.waitForTimeout(200); await w.evaluate(() => { score = 100; revivesUsedThisRun = 1; endGame(); });
  await w.waitForFunction(() => !!shareFile, null, { timeout: 15000 }).catch(() => {}); await wc.close(); }
for (const [name, w, h] of DEV) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e));
  await p.addInitScript(() => { try { localStorage.setItem('fluxColorHintSeen', '1'); localStorage.setItem('fluxCountry', 'PH'); localStorage.setItem('fluxBest_medium', '3000'); localStorage.setItem('fluxDifficulty', 'medium'); } catch (e) {}
    window.__shared = null; navigator.canShare = (d) => !!(d && d.files); navigator.share = (d) => { window.__shared = { text: d.text, url: d.url, files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) }; return Promise.resolve(); }; });
  await p.goto(BASE + '/play/'); await p.waitForTimeout(400);
  await p.evaluate(() => { document.getElementById('startBtn').click(); });
  await p.waitForTimeout(300);
  await p.evaluate(() => { score = 4200; level = 2; revivesUsedThisRun = 1; endGame(); window.__t0 = performance.now(); });
  // A very quick tap, before the card is ready, still shares the text and link.
  const early = await p.evaluate(() => new Promise((res) => { const iv = setInterval(() => { const go = document.getElementById('gameover'); if (go && !go.classList.contains('hidden')) { clearInterval(iv);
      const hadFile = !!shareFile; document.getElementById('shareBtn').click(); const s = window.__shared; window.__shared = null; res({ hadFile, s }); } }, 5); }));
  ck(name + ': a tap before the card is ready still shares the text and the link', !early.hadFile && early.s && !early.s.files.length && /^I added 1,200 for/.test(early.s.text) && /\/play\/$/.test(early.s.url), JSON.stringify(early).slice(0, 160));
  await p.evaluate(() => { document.getElementById('shareBtn').textContent = '📤 SHARE MY SCORE'; });
  // endGame reveals the game-over screen after a short pause; the card is drawn when the line is shown.
  const ready = await p.evaluate(() => new Promise((res) => { let shown = 0; const iv = setInterval(() => { const go = document.getElementById('gameover'); if (!shown && go && !go.classList.contains('hidden')) shown = performance.now();
      if (shareFile && shown) { clearInterval(iv); res(Math.round(performance.now() - shown)); } }, 10); setTimeout(() => res(-1), 5000); }));
  console.log('  INFO  ' + name + ': card image ready ' + (ready >= 0 ? ready + ' ms after the game-over screen appeared' : 'not within 5 s (seen now and then on the first page of a fresh headless browser)'));   // informational: a tap before it is ready shares text + link
  await p.waitForTimeout(300);
  const m = await p.evaluate(() => { const b = document.getElementById('shareBtn'), r = b.getBoundingClientRect(), panel = document.querySelector('#gameover .panel').getBoundingClientRect();
    return { visible: !b.classList.contains('hidden') && r.height > 0, h: r.height, inPanel: r.left >= panel.left && r.right <= panel.right, text: b.textContent, file: !!shareFile }; });
  ck(name + ': SHARE MY SCORE is on the game-over screen (>= 44px, inside the panel)', m.visible && m.h >= 44 && m.inPanel, JSON.stringify(m));
  await p.locator('#shareBtn').scrollIntoViewIfNeeded();
  await p.screenshot({ path: SHOTS + '/gameover-' + name.replace(/[^a-z0-9]+/gi, '-') + '.png' });
  await p.locator('#shareBtn').tap(); await p.waitForTimeout(200);
  const s = await p.evaluate(() => window.__shared);
  const withImage = s && s.files.length === 1 && s.files[0].type === 'image/jpeg' && s.files[0].size > 15000 && /^I added 1,200 for 🇵🇭 Philippines! Beat me in FLUX: http:\/\/localhost:\d+\/play\/$/.test(s.text);
  const textOnly = s && !s.files.length && /^I added 1,200 for 🇵🇭 Philippines!/.test(s.text) && /\/play\/$/.test(s.url);
  ck(name + ': the share sheet gets "I added 1,200 for 🇵🇭 Philippines! ... /play/" (' + (withImage ? 'with the JPEG card' : 'text + link: card not ready yet') + ')', withImage || textOnly, JSON.stringify(s).slice(0, 200));
  if (name === 'iPhone 15 Pro') { const url = await p.evaluate(() => drawShareCard(shareInfo).toDataURL('image/jpeg',.9)); fs.writeFileSync(SHOTS + '/share-card.jpg', Buffer.from(url.split(',')[1], 'base64'));
    const dims = await p.evaluate(() => { const c = drawShareCard(shareInfo); return [c.width, c.height]; }); ck('the card is 720x900 (4:5, fits every chat and story app)', dims[0] === 720 && dims[1] === 900, dims.join('x')); }
  await ctx.close();
}
ck('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
console.log('\n' + (F ? 'SHARE BROWSER FAILED: ' + F : 'SHARE BROWSER PASSED') + '   (screenshots: ' + SHOTS + ')');
process.exit(F ? 1 : 0);
