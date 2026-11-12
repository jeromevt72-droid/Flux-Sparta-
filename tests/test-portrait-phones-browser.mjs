// PORTRAIT ON PHONES measured in a REAL browser engine (Chromium via Playwright), real game page and real
// worker.js behind the local test server. A 360x800 Android phone (Chrome tab, and the Play app: display-mode
// fullscreen) turned to 800x360 mid-run; a run started sideways; a tablet and a desktop window unchanged.
// Not in the release gate (needs a browser binary); run: node test-portrait-phones-browser.mjs
import { start } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs')).catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const { chromium } = pw.default || pw;
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8798, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || '/tmp/shots-portrait'; fs.mkdirSync(SHOTS, { recursive: true });
const srv = await start(PORT); const browser = await chromium.launch(); const errors = [];
const UA = 'Mozilla/5.0 (Linux; Android 13; BLU G45) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
async function open(w, h, { twa = false, mobile = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block', ...(mobile ? { userAgent: UA } : {}) });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(String(e)));
  if (twa) await p.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => /display-mode:\s*fullscreen/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q); });
  await p.goto(BASE + '/play/'); await p.waitForTimeout(500);
  return { ctx, p };
}
const startRun = (p) => p.evaluate(() => { const c = document.getElementById('callsign'); if (c && !c.value) c.value = 'PILOT-PORTRAIT'; document.querySelectorAll('.fluxCoach,.miniOverlay').forEach((e) => e.classList.add('hidden')); document.getElementById('startBtn').click(); });
const st = (p) => p.evaluate(() => ({ score, playing, paused, runActive, W, H, phone: FLUX_PHONE, rot: !document.getElementById('rotateOverlay').classList.contains('hidden'), pause: !document.getElementById('pauseOverlay').classList.contains('hidden'), ball: [ball && ball.x, ball && ball.y], orbValue, catches: window.__c || 0 }));
const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display !== 'none' && r.width > 0 && r.height > 0 && document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest(s) !== null; }, sel);

for (const twa of [false, true]) {
  const tag = twa ? 'Play app' : 'Chrome tab';
  const { ctx, p } = await open(360, 800, { twa });
  await startRun(p); await p.waitForTimeout(1500);
  await p.evaluate(() => { window.__c = 0; const f = window.playPaddleHit; window.playPaddleHit = function () { window.__c++; return f.apply(this, arguments); }; window.__fol = setInterval(() => { if (playing) setPaddle(ball.x); }, 4); });
  const a = await st(p);
  ck(tag + ': a phone (360x800 touch screen); the run plays in portrait', a.phone === true && a.playing && !a.rot, JSON.stringify(a));
  await p.setViewportSize({ width: 800, height: 360 }); await p.waitForTimeout(400);
  const b = await st(p);
  ck(tag + ': turned to 800x360 mid-run: paused, the rotate screen covers the screen, the field kept (' + b.W + 'x' + b.H + ')', b.paused && !b.playing && b.rot && await visible(p, '#rotateOverlay') && b.W === 360, JSON.stringify(b));
  await p.screenshot({ path: SHOTS + '/rotate-' + (twa ? 'playapp' : 'chrome') + '.png' });
  await p.waitForTimeout(8000);
  const c = await st(p);
  ck(tag + ': 8 s sideways with the finger following the ball: no catch, no points, orb value unchanged (the loop is gone)', c.score === b.score && c.catches === b.catches && c.orbValue === b.orbValue && c.ball[0] === b.ball[0] && c.ball[1] === b.ball[1], b.score + ' -> ' + c.score + ', catches ' + b.catches + ' -> ' + c.catches);
  await p.evaluate(() => document.getElementById('resumeBtn').click()).catch(() => {});
  ck(tag + ': RESUME (under the rotate screen) does nothing while sideways', (await st(p)).paused === true);
  await p.setViewportSize({ width: 360, height: 800 }); await p.waitForTimeout(400);
  const d = await st(p);
  ck(tag + ': back to portrait: the rotate screen goes, FLUX PAUSED is there, the run is as it was', !d.rot && d.pause && d.paused && d.score === b.score && d.ball[0] === b.ball[0] && d.W === 360 && d.H === a.H, JSON.stringify(d));
  await p.screenshot({ path: SHOTS + '/back-' + (twa ? 'playapp' : 'chrome') + '.png' });
  await p.click('#resumeBtn'); await p.waitForTimeout(1500);
  const e = await st(p);
  ck(tag + ': RESUME carries on in portrait', e.playing && !e.paused && (e.ball[1] !== d.ball[1]), JSON.stringify(e));
  await ctx.close();
}
{ // a run started sideways on a phone
  const { ctx, p } = await open(360, 800);
  await p.setViewportSize({ width: 800, height: 360 }); await p.waitForTimeout(300);
  await startRun(p); await p.waitForTimeout(800);
  const a = await st(p);
  ck('started sideways: the run waits (rotate screen, no run)', a.rot && !a.runActive && !a.playing, JSON.stringify(a));
  await p.setViewportSize({ width: 360, height: 800 }); await p.waitForTimeout(800);
  const b = await st(p);
  ck('...turned to portrait: the run starts in a 360-wide field', b.runActive && b.playing && !b.rot && b.W === 360, JSON.stringify(b));
  await ctx.close();
}
for (const [w, h, mobile, name] of [[800, 1280, true, 'tablet 800x1280'], [1280, 720, false, 'desktop window 1280x720']]) {
  const { ctx, p } = await open(mobile ? w : 900, mobile ? h : 1000, { mobile });
  await startRun(p); await p.waitForTimeout(1200);
  await p.setViewportSize({ width: mobile ? h : w, height: mobile ? w : h }); await p.waitForTimeout(500);
  const a = await st(p); await p.waitForTimeout(1000); const b = await st(p);
  ck(name + ': not a phone; sideways keeps playing (no rotate screen), the field re-fits as today', a.phone === false && a.playing && !a.paused && !a.rot && a.W === (mobile ? h : w) && (b.ball[1] !== a.ball[1]), JSON.stringify(a));
  await ctx.close();
}
ck('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close(); srv.close();
console.log('\n' + (F ? 'PORTRAIT ON PHONES (browser) FAILED: ' + F : 'PORTRAIT ON PHONES (browser) PASSED') + '  (screenshots: ' + SHOTS + ')');
process.exit(F ? 1 : 0);
