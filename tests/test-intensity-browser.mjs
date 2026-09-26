// Intensity, measured in a REAL browser engine (Chromium via Playwright) on the
// real game page: iPhone, iPad and iPad mini sizes, default backdrop and Solar.
// The same scene is drawn at intensity 0 and at full intensity; for every orb
// and the ball, the contrast between its fill and the background right around
// it must not drop. Screenshots at full intensity go to $SHOTS.
// Not in the release gate (needs a browser binary).
import { start } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const { chromium } = pw.default || pw;
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) F++; };
const PORT = 8806, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || '/tmp/shots-intensity'; fs.mkdirSync(SHOTS, { recursive: true });
const DEV = [['iPhone 15 Pro', 393, 852], ['iPad', 820, 1180], ['iPad mini 4', 768, 1024]];
const srv = await start(PORT); const browser = await chromium.launch(); const errors = [];
async function measure(p, png, items) {
  return p.evaluate(async ({ b64, items }) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; const x = cv.getContext('2d'); x.drawImage(img, 0, 0); const s = img.width / innerWidth;
    const lin = (c) => { c /= 255; return c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); };
    const Y = (px, py) => { const d = x.getImageData(Math.round(px * s), Math.round(py * s), 1, 1).data; return .2126 * lin(d[0]) + .7152 * lin(d[1]) + .0722 * lin(d[2]); };
    return items.map(([ox, oy, r]) => { const fill = Y(ox - r * .45, oy + r * .1); let bg = 0; for (let a = 0; a < 48; a++) for (const rr of [r + 6, r + 10]) bg = Math.max(bg, Y(ox + Math.cos(a / 48 * 6.283) * rr, oy + Math.sin(a / 48 * 6.283) * rr));
      return (Math.max(fill, bg) + .05) / (Math.min(fill, bg) + .05); }); }, { b64: png.toString('base64'), items });
}
for (const [name, w, h] of DEV) for (const bg of ['none', 'solar']) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { let x = 12345; Math.random = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e));
  await p.goto(BASE + '/play/'); await p.waitForTimeout(300);
  await p.evaluate((bg) => { try { localStorage.setItem('fluxColorHintSeen', '1'); } catch (e) {} ownsSkin = () => true; setBackground(bg); document.getElementById('startBtn').click(); }, bg);
  await p.waitForTimeout(300);
  const items = await p.evaluate(() => { document.querySelectorAll('.miniOverlay').forEach((e) => e.remove());
    level = 7; speedLevel = 7; combo = 11; comboTimer = 99; bonusTimer = 99; growTimer = 99; const cx = W / 2, f = orbFieldRect(); targets = [];
    [[f.left + 30, f.top + 30, 0], [cx, f.top + 60, 1], [f.right - 30, f.top + 120, 2], [cx - 100, f.bottom - 60, 3], [f.right - 40, f.bottom - 30, 4], [f.left + 28, f.bottom - 28, 1]].forEach(([x, y, c]) => addTarget(c, x, y, 21));
    targets.forEach((t) => { t.vx = 0; t.vy = 0; t.danger = false; t.hint = false; });
    ball.x = cx + 40; ball.y = f.bottom - 150; ball.color = 0; ball.trail = []; for (let i = 0; i < 10; i++) ball.trail.push({ x: ball.x + i * 5, y: ball.y + i * 12 });
    particles = []; texts = []; shake = 0; playing = false; paused = true; updateHud();
    // Freeze everything that moves on its own (twinkling stars, drifting nebulae, CSS animations), so the two shots differ ONLY by intensity.
    const t0 = performance.now(); performance.now = () => t0; const st = document.createElement('style'); st.textContent = '*{animation:none!important;transition:none!important}'; document.head.appendChild(st);
    return targets.map((t) => [t.x, t.y, t.r]).concat([[ball.x, ball.y, ball.r]]); });
  const shot = async (j) => { await p.evaluate((j) => { juice = j; particles = []; }, j); await p.waitForTimeout(200); return p.screenshot(); };
  const c0 = await measure(p, await shot(0), items), png1 = await shot(1), c1 = await measure(p, png1, items);
  fs.writeFileSync(SHOTS + '/intensity-' + name.replace(/[^a-z0-9]+/gi, '-') + '-' + bg + '.png', png1);
  const worst = c0.map((a, i) => c1[i] / a).reduce((m, r) => Math.min(m, r), 9);
  ck(name + ' / ' + (bg === 'none' ? 'default' : 'Solar') + ': full intensity never lowers orb or ball contrast', worst >= 0.99, 'worst ratio ' + worst.toFixed(3) + '; contrast at 0: ' + c0.map((x) => x.toFixed(1)).join(' ') + ' | at 1: ' + c1.map((x) => x.toFixed(1)).join(' '));
  const edge = await p.evaluate(() => juice);
  ck(name + ' / ' + (bg === 'none' ? 'default' : 'Solar') + ': the effects are really on in the full-intensity shot', edge === 1);
  await ctx.close();
}
ck('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
console.log('\n' + (F ? 'INTENSITY BROWSER FAILED: ' + F : 'INTENSITY BROWSER PASSED') + '   (screenshots: ' + SHOTS + ')');
process.exit(F ? 1 : 0);
