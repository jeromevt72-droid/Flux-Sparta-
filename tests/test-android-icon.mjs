// ANDROID ICON (owner): the right icon and a clean name on every Android phone, and Play-ready icons.
//   I1 icons: 192 and 512 "any"; 192 and 512 "maskable" that are fully opaque, full square, with the artwork
//      inside the maskable safe zone (radius 40% of the width); a 180 apple-touch-icon (also at the two root
//      addresses browsers probe by themselves); a favicon.ico holding 16, 32 and 48 px images;
//   I2 manifest: name "FLUX Sparta", short_name "FLUX" (fits under an icon), start_url / id / scope unchanged,
//      the four icons above with their real sizes;
//   I3 /play/ and the Gateway offer the same icons in the page itself (sizes given) and application-name FLUX,
//      for browsers that make a plain shortcut and skip the manifest;
//   T1 the one-line Chrome tip: on a game-over screen, once per player ever, only in Android browsers that make a
//      plain shortcut (Xiaomi, OPPO/realme, vivo, Infinix/Tecno, UC, Opera Mini, plain web views); never in
//      Chrome, Samsung Internet or Firefox, never inside TikTok / Instagram / Facebook (their banner, #59), never
//      when the browser offers its own install, never in the Home Screen app.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'FLUX-Sparta', 'public');
const rd = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// A small PNG reader (8-bit RGBA / RGB, non-interlaced), enough for these icons.
function png(buf) {
  if (!buf || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let i = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (i < buf.length) { const n = buf.readUInt32BE(i), t = buf.toString('ascii', i + 4, i + 8), d = buf.subarray(i + 8, i + 8 + n); i += 12 + n;
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (t === 'IDAT') idat.push(d); }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(w * h * 4), stride = w * bpp;
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y++) { const f = raw[p++], line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x++) { const a = x >= bpp ? line[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255; else if (f === 2) line[x] = (line[x] + up) & 255; else if (f === 3) line[x] = (line[x] + ((a + up) >> 1)) & 255;
      else if (f === 4) { const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c)) & 255; } }
    for (let x = 0; x < w; x++) { out[(y * w + x) * 4] = line[x * bpp]; out[(y * w + x) * 4 + 1] = line[x * bpp + 1]; out[(y * w + x) * 4 + 2] = line[x * bpp + 2]; out[(y * w + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255; }
    prev = line; }
  return { w, h, d: out };
}
const file = (f) => { try { return fs.readFileSync(path.join(PUB, f.replace(/^\//, ''))); } catch (e) { return null; } };
const opaque = (im) => { for (let i = 3; i < im.d.length; i += 4) if (im.d[i] !== 255) return false; return true; };
// The farthest pixel (as a share of the width) from the centre that differs from the corner colour.
const artRadius = (im) => { const bg = [im.d[0], im.d[1], im.d[2]]; let m = 0;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { const k = (y * im.w + x) * 4; if (Math.abs(im.d[k] - bg[0]) + Math.abs(im.d[k + 1] - bg[1]) + Math.abs(im.d[k + 2] - bg[2]) > 24) m = Math.max(m, Math.hypot(x + .5 - im.w / 2, y + .5 - im.h / 2) / im.w); }
  return m; };

const UA = {
  xiaomi: 'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0 Mobile Safari/537.36 XiaoMi/MiuiBrowser/14.4.0-g',
  oppo: 'Mozilla/5.0 (Linux; Android 13; CPH2591) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Mobile Safari/537.36 HeyTapBrowser/45.10.3.1',
  vivo: 'Mozilla/5.0 (Linux; Android 13; V2207) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0 Mobile Safari/537.36 VivoBrowser/17.6.0.0',
  infinix: 'Mozilla/5.0 (Linux; Android 12; Infinix X6816) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0 Mobile Safari/537.36 PHX/12.6',
  uc: 'Mozilla/5.0 (Linux; U; Android 11; en-US; TECNO KF6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0 UCBrowser/13.4.0.1306 Mobile Safari/537.36',
  operaMini: 'Mozilla/5.0 (Linux; U; Android 12; Redmi 10C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0 Mobile Safari/537.36 OPR/74.0 Opera Mini',
  webview: 'Mozilla/5.0 (Linux; Android 12; TECNO KG5; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0 Mobile Safari/537.36',
  chrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
};

function suite({ manifest, game, gw, files = file }, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };

  // I1 -------------------------------------------------------------------------------------------
  try {
    const any = [['icon-192.png', 192], ['icon-512.png', 512]].map(([f, n]) => { const im = png(files(f)); return im && im.w === n && im.h === n; });
    ck('I1 "any" icons at 192 and 512', any.every(Boolean));
    const mk = [['icon-maskable-192.png', 192], ['icon-maskable-512.png', 512]].map(([f, n]) => { const im = png(files(f)); return im && { ok: im.w === n && im.h === n, opaque: opaque(im), r: artRadius(im) }; });
    ck('I1 maskable icons at 192 and 512: full square, fully opaque (Play-ready), artwork inside the 40% safe zone',
      mk.every((m) => m && m.ok && m.opaque && m.r <= 0.40), JSON.stringify(mk.map((m) => m && { o: m.opaque, r: +m.r.toFixed(3) })));
    const t = png(files('apple-touch-icon.png')), tp = files('apple-touch-icon-precomposed.png');
    ck('I1 apple-touch-icon 180x180, opaque, also at the two root addresses browsers probe by themselves',
      !!t && t.w === 180 && t.h === 180 && opaque(t) && !!tp && tp.equals(files('apple-touch-icon.png')));
    const ico = files('favicon.ico'); let sizes = [];
    if (ico && ico.readUInt16LE(2) === 1) for (let i = 0; i < ico.readUInt16LE(4); i++) { const e = 6 + i * 16, off = ico.readUInt32LE(e + 12), len = ico.readUInt32LE(e + 8), im = png(ico.subarray(off, off + len)); sizes.push(im ? im.w : 0); }
    ck('I1 favicon.ico (the address browsers try on their own) holds 16, 32 and 48 px images', sizes.join(',') === '16,32,48', sizes.join(','));
  } catch (e) { ck('I1 section ran', false, String(e.stack || e).slice(0, 300)); }

  // I2 -------------------------------------------------------------------------------------------
  try {
    const m = JSON.parse(manifest);
    ck('I2 manifest name "FLUX Sparta", short_name "FLUX" (fits under an Android icon); start_url, id and scope unchanged',
      m.name === 'FLUX Sparta' && m.short_name === 'FLUX' && m.short_name.length <= 12 && m.start_url === '/' && m.id === '/' && m.scope === '/', JSON.stringify([m.name, m.short_name, m.start_url, m.id]));
    const want = [['icon-192.png', '192x192', 'any'], ['icon-512.png', '512x512', 'any'], ['icon-maskable-192.png', '192x192', 'maskable'], ['icon-maskable-512.png', '512x512', 'maskable']];
    const got = want.map(([s, z, p]) => (m.icons || []).some((i) => i.src === s && i.sizes === z && (i.purpose || 'any') === p && i.type === 'image/png'));
    const real = (m.icons || []).every((i) => { const im = png(files(i.src)); return im && i.sizes === im.w + 'x' + im.h; });
    ck('I2 ...icons: 192 and 512 "any", 192 and 512 "maskable" (their own opaque files), each file real and of the size it says', got.every(Boolean) && real && !(m.icons || []).some((i) => i.purpose === 'maskable' && /^icon-\d+\.png$/.test(i.src)), JSON.stringify(got));
  } catch (e) { ck('I2 section ran', false, String(e.stack || e).slice(0, 300)); }

  // I3 -------------------------------------------------------------------------------------------
  for (const [name, html] of [['/play/', game], ['Gateway', gw]]) {
    const head = html.slice(0, html.indexOf('</head>'));
    const tags = [...head.matchAll(/<link rel="(icon|apple-touch-icon)"([^>]*)>/g)].map((t) => ({ rel: t[1], sizes: (/sizes="([^"]+)"/.exec(t[2]) || [])[1], href: (/href="([^"]+)"/.exec(t[2]) || [])[1] }));
    const has = (rel, sizes, href) => tags.some((t) => t.rel === rel && t.sizes === sizes && t.href === href && !!files(href));
    ck('I3 ' + name + ': the page itself offers icon 512 and 192 (with sizes), favicon.ico and a 180 apple-touch-icon, all real files',
      has('icon', '512x512', '/icon-512.png') && has('icon', '192x192', '/icon-192.png') && has('icon', '16x16 32x32 48x48', '/favicon.ico') && has('apple-touch-icon', '180x180', '/apple-touch-icon.png') && tags.every((t) => !!files(t.href)), JSON.stringify(tags));
    ck('I3 ' + name + ': application-name "FLUX" (the short name a plain shortcut takes)', /<meta name="application-name" content="FLUX">/.test(head));
  }

  // T1 -------------------------------------------------------------------------------------------
  try {
    const run = (ua, { played = true, inApp = null, offer = false, standalone = false, seen = false } = {}) => {
      const init = { fluxPlayerId: 'and-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: played ? '3' : '0' };
      if (seen) init.fluxChromeTip = '1';
      const { store, mem } = makeStore(init);
      const g = boot(scriptsOf(game), { origin: 'https://x.test', path: '/play/', store, standalone });
      g.win.navigator.userAgent = ua; g.ctx.FLUX_IN_APP = inApp;
      if (offer) vm.runInContext('fluxDeferredInstall = { prompt(){}, userChoice: Promise.resolve() };', g.ctx);
      g.ctx.fluxIsStandalone = () => standalone;
      let shown = null; g.els.gameoverChromeTip = { classList: { toggle(c, hide) { if (c === 'hidden') shown = !hide; }, add() {}, remove() {}, contains() { return false; } } };
      vm.runInContext('playing=true;', g.ctx); g.ctx.endGame();
      const first = shown; shown = null; vm.runInContext('playing=true;', g.ctx); g.ctx.endGame();
      return { first, second: shown, flag: mem.fluxChromeTip };
    };
    const yes = ['xiaomi', 'oppo', 'vivo', 'infinix', 'uc', 'operaMini', 'webview'].map((k) => [k, run(UA[k])]);
    ck('T1 shortcut-only Android browsers (Xiaomi, OPPO/realme, vivo, Infinix/Tecno, UC, Opera Mini, plain web views): the tip at a game over, then never again',
      yes.every(([, r]) => r.first === true && r.second === false && r.flag === '1'), JSON.stringify(yes.map(([k, r]) => k + ':' + r.first + '/' + r.second)));
    const no = ['chrome', 'samsung', 'firefox', 'iphone'].map((k) => [k, run(UA[k])]);
    ck('T1 ...never in Chrome, Samsung Internet, Firefox or on an iPhone', no.every(([, r]) => r.first === false && r.flag !== '1'), JSON.stringify(no.map(([k, r]) => k + ':' + r.first)));
    const ia = run(UA.webview + ' [FBAN/EMA;FBLC/en_US;]', { inApp: 'Facebook' });
    ck('T1 ...never inside TikTok / Instagram / Facebook (Facebook Lite included): their own banner covers it', ia.first === false && ia.flag !== '1');
    const of = run(UA.xiaomi, { offer: true }), sa = run(UA.xiaomi, { standalone: true }), np = run(UA.xiaomi, { played: false }), sn = run(UA.xiaomi, { seen: true });
    ck('T1 ...never when the browser offers its own install, in the Home Screen app, or once already shown', of.first === false && sa.first === false && sn.first === false, JSON.stringify([of.first, sa.first, sn.first]));
    ck('T1 ...a brand-new pilot sees it at their first game over (the run counts before the check)', np.first === true, String(np.first));
    ck('T1 ...one line in the game-over screen, no pop-up; the #59 banner code is untouched',
      /<p id="gameoverChromeTip" class="chromeTip hidden">Tip: open FLUX in <b>Chrome<\/b> to install it\.<\/p>/.test(game) && /\/\/ Game page: a pilot who has not finished a run yet plays first; the banner comes with their first game over\./.test(game));
  } catch (e) { ck('T1 section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const SRC = { manifest: rd('manifest.webmanifest'), game: rd('play/index.html'), gw: rd('index.html') };
const t0 = Date.now();
const res = suite(SRC);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
function control(label, expect, edit) {
  const src = { ...SRC }; let changed = false;
  for (const [k, f] of Object.entries(edit)) { if (k === 'files') continue; const v = f(src[k]); if (v !== src[k]) changed = true; src[k] = v; }
  if (edit.files) { src.files = edit.files; changed = true; }
  if (!changed) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(src, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
control('maskable is the plain 512 again (translucent pixels, not Play-ready)', 'I1 maskable', { files: (f) => file(f === 'icon-maskable-512.png' ? 'icon-512.png' : f) });
control('no favicon.ico', 'I1 favicon', { files: (f) => (f === 'favicon.ico' ? null : file(f)) });
control('manifest keeps the long name', 'I2 manifest name', { manifest: rep('"name": "FLUX Sparta"', '"name": "FLUX \\u2014 Flow Launch Unite Xcelerate"') });
control('manifest maskable points at the plain icon', 'I2 ...icons', { manifest: rep('"src": "icon-maskable-512.png"', '"src": "icon-512.png"') });
control('/play/ without the large page icons', 'I3 /play/: the page', { game: rep('<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">\n', '') });
control('Gateway without application-name', 'I3 Gateway: application-name', { gw: rep('<meta name="application-name" content="FLUX">', '') });
control('tip shown every game over', 'T1 shortcut-only', { game: rep("return localStorage.getItem('fluxChromeTip') !== '1';", 'return true;') });
control('tip shown in Chrome too', 'T1 ...never in Chrome', { game: rep("if (!/Android/i.test(ua) || !FLUX_SHORTCUT_ONLY.test(ua)) return false;", "if (!/Android/i.test(ua)) return false;") });
control('tip shown inside Facebook', 'T1 ...never inside', { game: rep('if (fluxInApp() || fluxDeferredInstall ||', 'if (fluxDeferredInstall ||') });
control('tip shown when the browser can install', 'T1 ...never when', { game: rep('if (fluxInApp() || fluxDeferredInstall ||', 'if (fluxInApp() ||') });
const total = res.F + NC;
console.log('\n' + (total ? 'ANDROID ICON FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'ANDROID ICON PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
