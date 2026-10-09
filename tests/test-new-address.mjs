// NEW ADDRESS (owner, PR 3 of the move to fluxsparta.com).
//   A1 search and preview tags (canonical, og:url, og:image, twitter:image) of the Gateway and the game name
//      https://fluxsparta.com; sitemap.xml lists fluxsparta.com pages only; robots.txt names its sitemap;
//   A2 SITE_URL is https://fluxsparta.com (wrangler.jsonc);
//   A3 Stripe returns a purchase to the address it STARTED on (fluxsparta.com or the old address, where this
//      browser's pending purchase is stored); any other origin returns to SITE_URL; cancel the same;
//   A4 share links point to fluxsparta.com, also from a page on the old address (an app installed there);
//      the share card prints fluxsparta.com;
//   A5 the old address appears only where it must: the move hand-off, move.html, the privacy sentence, the
//      Worker's two-address list and its comments; never in links, tags, sitemap or robots.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = { gw: R('public/index.html'), game: R('public/play/index.html'), sitemap: R('public/sitemap.xml'), robots: R('public/robots.txt'), wrangler: R('wrangler.jsonc'), worker: R('worker.js') };
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const OLD = 'https://flux-sparta-3.jeromevt72.workers.dev', NEW = 'https://fluxsparta.com', OLDH = 'flux-sparta-3.jeromevt72.workers.dev';
const MOVE_BLOCK = /<script>\n\/\* MOVE TO fluxsparta\.com \(owner\)[\s\S]*?<\/script>\n/;

async function suite(src, workerMod, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + String(x).slice(0, 220) + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    const tags = (h) => [...h.matchAll(/<(link rel="canonical"|meta property="og:(?:url|image)"|meta name="twitter:image")[^>]*?(?:href|content)="([^"]+)"/g)].map((m) => m[2]);
    const tg = tags(src.gw), tp = tags(src.game);
    ck('A1 Gateway tags: canonical / og:url "https://fluxsparta.com/", og:image / twitter:image on fluxsparta.com', JSON.stringify(tg) === JSON.stringify([NEW + '/', NEW + '/', NEW + '/og-image.jpg', NEW + '/og-image.jpg']), tg.join(' '));
    ck('A1 game tags: canonical / og:url "https://fluxsparta.com/play/", og:image / twitter:image on fluxsparta.com', JSON.stringify(tp) === JSON.stringify([NEW + '/play/', NEW + '/play/', NEW + '/og-image.jpg', NEW + '/og-image.jpg']), tp.join(' '));
    const locs = [...src.sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    ck('A1 sitemap.xml lists fluxsparta.com pages only (/, /play/, privacy, terms)', JSON.stringify(locs) === JSON.stringify([NEW + '/', NEW + '/play/', NEW + '/privacy.html', NEW + '/terms.html']), locs.join(' '));
    ck('A1 robots.txt names https://fluxsparta.com/sitemap.xml', /^Sitemap: https:\/\/fluxsparta\.com\/sitemap\.xml$/m.test(src.robots) && !src.robots.includes(OLDH));
    const cfg = JSON.parse(src.wrangler.replace(/^\s*\/\/.*$/mg, ''));
    ck('A2 SITE_URL is https://fluxsparta.com (wrangler.jsonc, so a deploy keeps it)', cfg.vars.SITE_URL === NEW, cfg.vars.SITE_URL);
  } catch (e) { ck('static section ran', false, String(e.stack || e)); }

  try {   // A3: the real createCheckout, Stripe answered here
    const sent = []; const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, init) => { u = String(u);
      if (u.includes('/v1/prices/')) return new Response(JSON.stringify({ id: 'p3', livemode: false, active: true }), { status: 200 });
      if (u.endsWith('/v1/checkout/sessions')) { sent.push(new URLSearchParams(init.body)); return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 }); }
      return realFetch(u, init); };
    const env = { STORE_OPEN: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_SOLAR: 'p3', SITE_URL: NEW };
    const buy = async (origin, e = env) => { const r = await workerMod.default.fetch(new Request(origin + '/api/create-checkout-session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' }, body: JSON.stringify({ sku: 'solar', playerId: 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000c3' }) }), e, { waitUntil() {} }); return { status: r.status, p: sent[sent.length - 1] }; };
    const n = await buy(NEW), o = await buy(OLD), x = await buy('https://flux-sparta-3.preview.example'), y = await buy('https://evil.example', Object.assign({}, env, { SITE_URL: NEW }));
    const ok = (r, base) => r.status === 200 && r.p && r.p.get('success_url') === base + '/?session_id={CHECKOUT_SESSION_ID}&sku=solar' && r.p.get('cancel_url') === base + '/?checkout=cancelled';
    ck('A3 a purchase started on fluxsparta.com returns to fluxsparta.com (success and cancel)', ok(n, NEW), n.p && n.p.get('success_url'));
    ck('A3 a purchase started on the old address returns to the old address (its pending purchase is stored there)', ok(o, OLD), o.p && o.p.get('success_url'));
    ck('A3 any other origin returns to SITE_URL (fluxsparta.com), never to that origin', ok(x, NEW) && ok(y, NEW), [x.p && x.p.get('success_url'), y.p && y.p.get('success_url')].join(' | '));
    globalThis.fetch = realFetch;
  } catch (e) { ck('Stripe section ran', false, String(e.stack || e)); }

  try {   // A4: the share link and the card's address, on both addresses
    const shareFrom = (origin) => { const { store } = makeStore({ fluxPlayerId: 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000c4', fluxCallsign: 'TITAN', fluxProfileComplete: '1' });
      const g = boot(scriptsOf(src.game), { origin, path: '/play/', store });   // standalone (installed app) by default
      const canon = (src.game.match(/<link rel="canonical" href="([^"]+)">/) || [])[1];
      g.ctx.document.querySelector = (q) => (q === 'link[rel="canonical"]' && canon ? { getAttribute: () => canon } : null);
      return { url: vm.runInContext('shareUrl()', g.ctx), host: vm.runInContext('shareSiteAddress()', g.ctx), errors: g.errors }; };
    const a = shareFrom(OLD), b = shareFrom(NEW);
    ck('A4 share link is https://fluxsparta.com/play/?src=share, also from an app installed on the old address', a.url === NEW + '/play/?src=share' && b.url === NEW + '/play/?src=share', a.url + ' | ' + b.url);
    ck('A4 the share card prints fluxsparta.com on both addresses', a.host === 'fluxsparta.com' && b.host === 'fluxsparta.com', a.host + ' | ' + b.host);
  } catch (e) { ck('share section ran', false, String(e.stack || e)); }

  try {   // A5
    const gw = src.gw.replace(MOVE_BLOCK, ''), game = src.game.replace(MOVE_BLOCK, '');
    const wk = src.worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
    ck('A5 outside the move hand-off, the Gateway and the game never name the old address (links, tags, scripts)', !gw.includes(OLDH) && !game.includes(OLDH));
    ck('A5 the Worker\'s code names the old address only in its two-address list', (wk.match(/flux-sparta-3\.jeromevt72\.workers\.dev/g) || []).length === 1 && /const SITE_ORIGINS = new Set\(\["https:\/\/fluxsparta\.com", "https:\/\/flux-sparta-3\.jeromevt72\.workers\.dev"\]\);/.test(wk));
  } catch (e) { ck('address section ran', false, String(e.stack || e)); }
  return { F, failed };
}

const t0 = Date.now();
const real = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const res = await suite(SRC, real);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0, nTmp = 0;
async function control(label, expect, file, a, b) {
  const s2 = Object.assign({}, SRC); if (!s2[file].includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  s2[file] = s2[file].split(a).join(b); let mod = real;
  if (file === 'worker') { const f = path.join(os.tmpdir(), 'flux-na-' + process.pid + '-' + (++nTmp) + '.mjs'); fs.writeFileSync(f, s2.worker); mod = await import(pathToFileURL(f).href); fs.unlinkSync(f); }
  const r = await suite(s2, mod, true); const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
await control('Gateway canonical left on the old address', 'A1 Gateway', 'gw', '<link rel="canonical" href="https://fluxsparta.com/">', '<link rel="canonical" href="' + OLD + '/">');
await control('game preview image left on the old address', 'A1 game', 'game', '<meta property="og:image" content="https://fluxsparta.com/og-image.jpg">', '<meta property="og:image" content="' + OLD + '/og-image.jpg">');
await control('sitemap left on the old address', 'A1 sitemap', 'sitemap', '<loc>https://fluxsparta.com/play/</loc>', '<loc>' + OLD + '/play/</loc>');
await control('robots names the old sitemap', 'A1 robots', 'robots', 'Sitemap: https://fluxsparta.com/sitemap.xml', 'Sitemap: ' + OLD + '/sitemap.xml');
await control('SITE_URL left on the old address', 'A2', 'wrangler', '"SITE_URL": "https://fluxsparta.com"', '"SITE_URL": "' + OLD + '"');
await control('every purchase returns to SITE_URL (old-address buyers lose their pending purchase)', 'A3 a purchase started on the old address', 'worker', 'const siteUrl = SITE_ORIGINS.has(reqOrigin) ? reqOrigin : (env.SITE_URL || reqOrigin);', 'const siteUrl = env.SITE_URL || reqOrigin;');
await control('a purchase returns to any origin it came from', 'A3 any other origin', 'worker', 'const siteUrl = SITE_ORIGINS.has(reqOrigin) ? reqOrigin : (env.SITE_URL || reqOrigin);', 'const siteUrl = reqOrigin;');
await control('share link from this page\'s own address', 'A4 share link', 'game', "function shareUrl(){ return 'https://'+shareSiteAddress()+'/play/?src=share'; }", "function shareUrl(){ return location.origin+'/play/?src=share'; }");
await control('a Play link to the old address', 'A5 outside the move', 'gw', '<link rel="canonical" href="https://fluxsparta.com/">', '<link rel="canonical" href="https://fluxsparta.com/"><a href="' + OLD + '/play/">x</a>');
const total = res.F + NC;
console.log('\n' + (total ? 'NEW ADDRESS FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'NEW ADDRESS PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
