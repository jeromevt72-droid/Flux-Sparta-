// RC2.8.7 -- D-52..D-55, D-57..D-59 measured in a REAL browser engine
// (Chromium via Playwright), real game page and real worker.js behind a local
// server. Checks what a static scan cannot: rendered font sizes, button
// heights, overlap, and fit on a 360px-wide phone, with and without an iPhone
// Home Screen safe-area inset.
// Not in the release gate (needs a browser binary); run: node test-rc287-browser.mjs
import { start } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const { chromium } = pw.default || pw;
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8797, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || '/tmp/shots-rc287'; fs.mkdirSync(SHOTS, { recursive: true });
const srv = await start(PORT);
const browser = await chromium.launch();
const errors = [];

// Every visible element that directly holds text: its rendered font size.
const smallText = (p) => p.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0 || +cs.opacity === 0) continue;
    if (el.closest('.hidden') || el.closest('[hidden]')) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && parseFloat(cs.fontSize) < 11) out.push((el.id || el.className || el.tagName) + '=' + cs.fontSize);
  }
  return out;
});
const shortButtons = (p) => p.evaluate(() => [...document.querySelectorAll('button')].filter((b) => {
  const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
  return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && r.height < 44 - 0.5;
}).map((b) => (b.id || b.textContent.trim().slice(0, 18)) + '=' + Math.round(b.getBoundingClientRect().height)));
const overflowX = (p) => p.evaluate(() => {
  const bad = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('page ' + document.documentElement.scrollWidth);
  for (const el of document.querySelectorAll('.panel, .stat, .fluxbar, button')) {
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (el.closest('.hidden')) continue;
    if (r.right > innerWidth + 1 || r.left < -1) bad.push((el.id || el.className) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto') bad.push((el.id || el.className) + ' clips ' + el.scrollWidth + '>' + el.clientWidth);
  }
  return bad;
});
const rect = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);
const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

async function phone(width, height, inset) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (inset) {   // stand-in for the iPhone Home Screen notch: env(safe-area-inset-top) = inset
    await ctx.route('**/play/', async (route) => {
      const r = await route.fetch(); let b = await r.text();
      b = b.replace(/env\(safe-area-inset-top(,\s*0px)?\)/g, inset + 'px');
      await route.fulfill({ response: r, body: b });
    });
  }
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(BASE + '/play/'); await p.waitForTimeout(500);
  return { ctx, p };
}

for (const [w, h, inset] of [[360, 740, 0], [360, 740, 59], [390, 844, 47]]) {
  const tag = w + 'x' + h + (inset ? ' inset ' + inset : '');
  console.log('== ' + tag + ' ==');
  const { ctx, p } = await phone(w, h, inset);
  try {
    // ---- menu (first launch) ----
    ck('D-55 menu: no text under 11px (' + tag + ')', (await smallText(p)).length === 0, (await smallText(p)).join(' '));
    ck('D-55 menu: every button >= 44px tall (' + tag + ')', (await shortButtons(p)).length === 0, (await shortButtons(p)).join(' '));
    ck('D-55 menu: fits the width (' + tag + ')', (await overflowX(p)).length === 0, (await overflowX(p)).join(' | '));
    ck('D-58 first launch: "Playing for <flag> <Country> · change" is visible', await p.locator('#playingFor').isVisible() && /Playing for .+ · change/.test(await p.locator('#playingFor').innerText()), await p.locator('#playingFor').innerText().catch(() => ''));
    const pf = await rect(p, '#playingFor'), sb = await rect(p, '#startBtn');
    ck('D-58 ...right under ENTER THE FLUX, 44px tap target', pf.h >= 44 && pf.t >= sb.b - 1 && pf.t - sb.b < 24, JSON.stringify(pf));
    await p.screenshot({ path: SHOTS + '/menu-' + w + (inset ? '-inset' : '') + '.png' });
    await p.click('#playingFor');
    ck('D-58 ...tapping "change" opens the country picker', await p.locator('#country').isVisible());
    await p.evaluate(() => { document.getElementById('callsign').value = document.getElementById('callsign').value || 'PILOT-TEST'; });

    // ---- play: HUD ----
    await p.click('#startBtn'); await p.waitForTimeout(300);
    ck('D-54 no tagline / SOUND / FIELD badges in play', await p.evaluate(() => !document.querySelector('.hud .sub') && !document.getElementById('audioBadge') && !document.getElementById('pressureBadge') && !/SOUND • ON|FIELD • STABLE|FLOW • LAUNCH/.test(document.querySelector('.hud').innerText)));
    ck('D-55 HUD: no text under 11px (' + tag + ')', (await smallText(p)).length === 0, (await smallText(p)).join(' '));
    const pb = await rect(p, '#pauseBtn'), fb = await rect(p, '.fluxbar'), fl = await rect(p, '.fluxbar span');
    ck('D-53 pause button is in the FLUX row: [pause] FLUX ---- %', Math.abs((pb.t + pb.b) / 2 - (fl.t + fl.b) / 2) < 3 && pb.r <= fl.l, JSON.stringify({ pb, fl }));
    ck('D-53 pause button is 44px', pb.h >= 44 && pb.w >= 44, pb.w + 'x' + pb.h);
    ck('D-53 pause row sits below the safe-area inset', pb.t >= inset, 'top ' + pb.t + ' inset ' + inset);
    const stats = await p.evaluate(() => [...document.querySelectorAll('.stat')].map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }));
    const logo = await rect(p, '.logo');
    ck('D-53 the FLUX row overlaps no stat box and not the logo', !stats.some((s) => hit(s, fb)) && !hit(logo, fb), JSON.stringify(fb));
    ck('D-53 the stat boxes fit on one row', new Set(stats.map((s) => Math.round(s.t))).size === 1);
    ck('D-55 HUD fits the width (' + tag + ')', (await overflowX(p)).length === 0, (await overflowX(p)).join(' | '));
    // D-50 SPEED UP and D-52 LAST LIFE states, rendered
    await p.evaluate(() => { playing = false; paused = false; score = 2600; pendingLevel = 2; levelCountdown = 3.4; misses = 2; updateHud(); });
    ck('D-50 LEVEL box turns amber and reads SPEED UP 4', await p.evaluate(() => document.getElementById('levelBox').classList.contains('speedUp') && document.getElementById('levelLabel').textContent === 'SPEED UP' && document.getElementById('level').textContent === '4' && getComputedStyle(document.getElementById('levelBox')).borderColor === 'rgb(255, 176, 32)'));
    ck('D-52 last life: LIVES box is red and says LAST LIFE', await p.evaluate(() => document.getElementById('livesLabel').textContent === 'LAST LIFE' && getComputedStyle(document.getElementById('livesBox')).borderColor === 'rgb(255, 59, 92)'));
    const stats2 = await p.evaluate(() => [...document.querySelectorAll('.stat')].map((e) => Math.round(e.getBoundingClientRect().top)));
    ck('D-50/D-52 the wider labels still fit on one row, nothing clipped (' + tag + ')', new Set(stats2).size === 1 && (await overflowX(p)).length === 0, (await overflowX(p)).join(' | ') + ' ' + stats2);
    ck('D-55 HUD in those states: no text under 11px', (await smallText(p)).length === 0, (await smallText(p)).join(' '));
    await p.screenshot({ path: SHOTS + '/hud-' + w + (inset ? '-inset' : '') + '.png' });
    ck('D-52 no FLUX LIVES box is drawn on the canvas', await p.evaluate(() => !/fillText\('FLUX LIVES'/.test(draw.toString())));

    // ---- revive ----
    await p.evaluate(() => { playing = true; offerRevive(); });
    ck('D-59 revive reads "FREE extra life?" with YES, FREE / END RUN', await p.evaluate(() => { const o = document.getElementById('reviveOverlay'); return /FREE extra life\?/.test(o.innerText) && document.getElementById('reviveWatchBtn').innerText.trim() === 'YES, FREE' && document.getElementById('reviveDeclineBtn').innerText.trim() === 'END RUN'; }));
    ck('D-55 revive: buttons >= 44px, text >= 11px', (await shortButtons(p)).length === 0 && (await smallText(p)).length === 0, (await shortButtons(p)).concat(await smallText(p)).join(' '));
    await p.click('#reviveDeclineBtn'); await p.waitForTimeout(700);

    // ---- game over ----
    ck('D-57 game over: headline is the score, then one line', await p.evaluate(() => !/FLUX\s*OVERLOAD|THE FLOW BROKE|FLUX COLLAPSE/.test(document.querySelector('#gameover .panel').innerText) && document.getElementById('finalScore').textContent === (2600).toLocaleString() && /NEW BEST!/.test(document.getElementById('goLine').innerText)), await p.evaluate(() => document.querySelector('#gameover .panel').innerText.slice(0, 120)));
    await p.evaluate(() => document.getElementById('goClaim').classList.remove('hidden'));   // D-60 box, forced visible for measuring
    ck('D-55 game over: no text under 11px (' + tag + ')', (await smallText(p)).length === 0, (await smallText(p)).join(' '));
    ck('D-55 game over: every button >= 44px (' + tag + ')', (await shortButtons(p)).length === 0, (await shortButtons(p)).join(' '));
    ck('D-55 game over: fits the width (' + tag + ')', (await overflowX(p)).length === 0, (await overflowX(p)).join(' | '));
    await p.screenshot({ path: SHOTS + '/gameover-' + w + (inset ? '-inset' : '') + '.png' });

    // ---- leaderboard + skins panels ----
    await p.click('#gameoverMenuBtn'); await p.waitForTimeout(100);
    await p.click('#skinsBtn'); await p.waitForTimeout(100);
    ck('D-55 skins: text >= 11px, buttons >= 44px, fits', (await smallText(p)).length === 0 && (await shortButtons(p)).length === 0 && (await overflowX(p)).length === 0, (await smallText(p)).concat(await shortButtons(p), await overflowX(p)).join(' '));
    await p.screenshot({ path: SHOTS + '/skins-' + w + (inset ? '-inset' : '') + '.png' });
    await p.click('#shopClose');
    await p.click('#leaderBtn'); await p.waitForTimeout(400);
    ck('D-55 leaderboard: text >= 11px, buttons >= 44px, fits', (await smallText(p)).length === 0 && (await shortButtons(p)).length === 0 && (await overflowX(p)).length === 0, (await smallText(p)).concat(await shortButtons(p), await overflowX(p)).join(' '));
  } catch (e) { ck(tag + ' ran', false, String(e.stack || e).slice(0, 300)); }
  await ctx.close();
}
ck('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
console.log('\n' + (F ? 'RC2.8.7 BROWSER FAILED: ' + F : 'RC2.8.7 BROWSER PASSED') + '   (screenshots: ' + SHOTS + ')');
process.exit(F ? 1 : 0);
