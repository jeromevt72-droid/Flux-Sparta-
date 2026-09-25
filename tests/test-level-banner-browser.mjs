// Level-up banner placement, measured in a REAL browser engine (Chromium via
// Playwright) on the real game page. For every device size it forces a
// level-up and checks the drawn banner ("LEVEL X" / "NEXT LEVEL: X") against:
//   - the launcher (paddle bar + handle),
//   - the danger line (the ceiling line the ball bounces off),
//   - every HUD element (logo, score/combo/level/lives boxes, FLUX row + pause),
//   - the play area where the player aims (everything below the danger line),
//   - the screen edges; text >= 11px; no DOM element, so it can never take a touch.
// Devices: iPhone (notch and SE), iPad, iPad mini 4 (iPadOS 15.8, 768x1024) and
// iPad mini 6, portrait and landscape.
// Not in the release gate (needs a browser binary); run: node test-level-banner-browser.mjs
// FIXTURES=1 prints the measured HUD rects that test-level-banner.mjs replays in the gate.
import { start } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const { chromium } = pw.default || pw;
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8798, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || '/tmp/shots-banner'; fs.mkdirSync(SHOTS, { recursive: true });
export const DEVICES = [
  ['iPhone 14 (notch 47)', 390, 844, 47], ['iPhone 15 Pro (island 59)', 393, 852, 59], ['iPhone SE', 375, 667, 20],
  ['iPhone landscape', 844, 390, 0],
  ['iPad', 820, 1180, 24], ['iPad landscape', 1180, 820, 24],
  ['iPad mini 4 (iPadOS 15.8)', 768, 1024, 20], ['iPad mini 4 landscape', 1024, 768, 20],
  ['iPad mini 6', 744, 1133, 24], ['iPad mini 6 landscape', 1133, 744, 24],
];
const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const srv = await start(PORT);
const browser = await chromium.launch();
const errors = []; const fixtures = [];
for (const [name, w, h, inset] of DEVICES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });   // the SW reload would bypass the inset rewrite
  await ctx.route('**/play/', async (route) => {   // stand-in for the notch / status bar: env(safe-area-inset-top) = inset
    const r = await route.fetch(); const b = (await r.text()).replace(/env\(safe-area-inset-top(,\s*0px)?\)/g, inset + 'px');
    await route.fulfill({ response: r, body: b });
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e));
  await p.goto(BASE + '/play/'); await p.waitForTimeout(400);
  await p.click('#startBtn'); await p.waitForTimeout(300);
  for (const [lv, sc] of [[1, 2500], [8, 45000]]) {
    const m = await p.evaluate(([lv, sc]) => {
      level = lv; score = sc; pendingLevel = 0; checkScoreLevel(); playing = false;   // force the banner, freeze the field
      const texts = []; const f0 = ctx.fillText;
      ctx.fillText = function (t, x, y) { texts.push({ t: String(t), font: ctx.font }); return f0.apply(this, arguments); };
      const before = document.querySelectorAll('*').length; draw(); const after = document.querySelectorAll('*').length;
      ctx.fillText = f0;
      const L = levelBannerLayout(), R = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      const hud = [...document.querySelectorAll('.stat, .logo, .fluxbar, #pauseBtn')].map((e) => ({ id: e.id || e.className, ...R(e) }));
      const vW = paddle.w * 1.1, pad = { left: paddle.x - vW / 2 - 12, right: paddle.x + vW / 2 + 12, top: paddle.y - paddle.h * 1.55 / 2 - 12, bottom: paddle.y + paddle.handleH + 6 };
      return { L, hud, ceil: maxHudBottom(), pad, W, H, texts, domAdded: after - before, banner: levelBanner, pending: pendingLevel,
        fx: { stats: R(document.querySelector('.stats')), fluxbar: R(document.querySelector('.fluxbar')), hudRects: cachedHudRects.map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })), W, H } };
    }, [lv, sc]);
    const tag = name + ' ' + w + 'x' + h + ' L' + lv;
    const r = m.L.rect;
    ck(tag + ': banner drawn with "LEVEL ' + lv + '" and "NEXT LEVEL: ' + (lv + 1) + '", no SECURED line', m.texts.some((t) => t.t === 'LEVEL ' + lv) && m.texts.some((t) => t.t === 'NEXT LEVEL: ' + (lv + 1)) && !m.texts.some((t) => /SECURED|FIELD/.test(t.t)), m.texts.map((t) => t.t).join(' | '));
    ck(tag + ': clear of the danger line (text bottom ' + Math.round(r.bottom) + ' < line ' + Math.round(m.ceil) + ')', r.bottom <= m.ceil - 4);
    ck(tag + ': not in the play area where the player aims (entirely above the line)', r.top >= 0 && r.bottom < m.ceil);
    ck(tag + ': clear of the launcher', !hit(r, m.pad), JSON.stringify(m.pad));
    const hudHit = m.hud.filter((x) => hit(r, x));
    ck(tag + ': clear of every HUD element (logo, boxes, FLUX row, pause)', hudHit.length === 0, hudHit.map((x) => x.id).join(','));
    ck(tag + ': on screen', r.left >= 0 && r.right <= m.W && r.top >= inset);
    const sizes = m.texts.filter((t) => /LEVEL/.test(t.t)).map((t) => parseFloat(t.font.match(/(\d+(?:\.\d+)?)px/)[1]));
    ck(tag + ': text >= 11px (' + sizes.join('/') + ')', sizes.length >= 2 && sizes.every((s) => s >= 11));
    ck(tag + ': canvas-drawn, no DOM element (nothing that can take a touch)', m.domAdded === 0);
    if (lv === 1) fixtures.push({ name, w, h, inset, ...m.fx });
    if (lv === 1) await p.screenshot({ path: SHOTS + '/banner-' + name.replace(/[^a-z0-9]+/gi, '-') + '.png' });
  }
  // Play is never blocked: moving a finger over the banner still moves the launcher.
  const L = await p.evaluate(() => { playing = true; return levelBannerLayout().rect; });
  const x0 = await p.evaluate(() => paddle.x);
  await p.mouse.move((L.left + L.right) / 2 - 60, (L.top + L.bottom) / 2);
  const x1 = await p.evaluate(() => paddle.x);
  ck(name + ': a finger over the banner still steers the launcher', x1 !== x0, x0 + ' -> ' + x1);
  await ctx.close();
}
ck('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
if (process.env.FIXTURES) console.log('FIXTURES ' + JSON.stringify(fixtures));
await browser.close(); srv.close();
console.log('\n' + (F ? 'BANNER BROWSER FAILED: ' + F : 'BANNER BROWSER PASSED') + '   (screenshots: ' + SHOTS + ')');
process.exit(F ? 1 : 0);
