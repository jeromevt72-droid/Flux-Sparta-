// PURCHASES IN THE GOOGLE PLAY APP (owner): the privacy policy says skins are not sold in the Play app, and the
// code proves the Play app (the TWA, launched at /play/?src=playstore) can never reach
// /api/create-checkout-session while STORE_OPEN is false.
//   PP1 privacy policy (both copies, identical): section 8 has the owner's "Google Play app" paragraph right after
//       its first paragraph, the effective date is October 22, 2026, and nothing else in the page changed from
//       origin/main;
//   PP2 the game in the Play app: STORE_OPEN is false; buySkin() for every skin, opened from the Play launch URL
//       with the TWA referrer, sends no request to /api/create-checkout-session and never leaves FLUX; the only
//       buySkin the page keeps is the one that checks STORE_OPEN first; the shop draws SOON (disabled) and never
//       wires a BUY button while the store is closed;
//   PP3 the server: with wrangler.jsonc's STORE_OPEN ("false"), or none set, /api/create-checkout-session answers
//       403 STORE_CLOSED to a Play-app request (TWA referrer, ?src=playstore, a real pilot) and never calls Stripe;
//       a positive control (STORE_OPEN "true") shows the same request would reach Stripe;
//   PP4 the Gateway's demo game (hero-demo.html): its BUY code can never reach the server: every /api/ request is
//       answered inside the demo, and the demo frame takes no taps. The retired copy public/welcome/hero-demo.html has
//       no such answer, but no page opens it (welcome/ only forwards to /) and the Play app has no address bar; if it
//       were opened anyway, the server refuses (PP3).
// Ends with negative controls: each guard removed MUST be caught.
import fs from 'fs'; import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const IN = {
  priv: read('public/privacy.html'), privW: read('public/welcome/privacy.html'), game: read('public/play/index.html'),
  worker: read('worker.js'), wrangler: read('wrangler.jsonc'), gateway: read('public/index.html'),
  demo: read('public/hero-demo.html'), demoW: read('public/welcome/hero-demo.html'),
};
let MAIN_PRIV = null; try { MAIN_PRIV = execFileSync('git', ['-C', ROOT, 'show', 'origin/main:public/privacy.html'], { encoding: 'utf8' }); } catch (e) { MAIN_PRIV = null; }
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const PARA = '<p><strong>Google Play app:</strong> Skins are not sold in the FLUX app from Google Play.\nIf they are offered there in the future, they will be bought through\nGoogle Play\'s own billing system.</p>\n';
const FIRST = '<h2>8. Purchases and payment</h2>\n<p>Skins are purchased through <strong>Stripe</strong>. You enter your payment\ndetails on Stripe\'s own checkout page.</p>\n';
const SKUS = ['toxic', 'cosmic', 'solar'];
const TWA_REF = 'android-app://com.fluxsparta.app/';

async function suite(I, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + String(x).slice(0, 300) + ']' : '')); if (!c) { F++; failed.push(l); } };

  /* ---- PP1 the privacy policy ---- */
  ck('PP1 section 8: the "Google Play app" paragraph comes right after the first paragraph (both copies)', [I.priv, I.privW].every((h) => h.includes(FIRST + PARA)));
  ck('PP1 the two copies are identical; the effective date is October 22, 2026', I.priv === I.privW && /Effective date: <strong>October 22, 2026<\/strong>/.test(I.priv));
  if (MAIN_PRIV !== null) {
    const back = I.priv.replace(PARA, '').replace(/Effective date: <strong>October 22, 2026<\/strong>/, (MAIN_PRIV.match(/Effective date: <strong>[^<]+<\/strong>/) || [''])[0]);
    ck('PP1 nothing else changed: without the paragraph and the date the page equals origin/main\'s', back === MAIN_PRIV || I.priv === MAIN_PRIV);
  }

  /* ---- PP2 the game, opened as the Play app ---- */
  ck('PP2 the game\'s store switch is off: const STORE_OPEN = false', /\nconst STORE_OPEN = false;/.test(I.game));
  const calls = [];
  const fetchImpl = (u) => { calls.push(String(u)); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: 'https://checkout.stripe.com/c/pay/cs_test_x' }) }); };
  let threw = '', navTo = null, guarded = false;
  try {
    const g = boot(scriptsOf(I.game), { origin: 'https://fluxsparta.com', path: '/play/', search: '?src=playstore', store: makeStore({ fluxPlayerId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001' }).store, fetchImpl });
    try { g.win.document.referrer = TWA_REF; } catch (e) {}
    for (const sku of SKUS) { const btn = { disabled: false, textContent: 'BUY' }; await g.ctx.buySkin(sku, btn); }
    await new Promise((r) => setImmediate(r));
    navTo = g.nav.to;
    guarded = /^async function \(sku, btn\) \{\n  if \(!STORE_OPEN\) \{/.test(String(g.ctx.buySkin));
  } catch (e) { threw = String(e).slice(0, 120); }
  ck('PP2 buySkin() for every skin, from the Play launch URL (TWA referrer): no request to /api/create-checkout-session', !threw && !calls.some((u) => u.includes('create-checkout-session')), threw || calls.filter((u) => /checkout/.test(u)).join(','));
  ck('PP2 ...and FLUX never navigates away (no Stripe page)', navTo === null, navTo);
  ck('PP2 the buySkin the page keeps is the one that checks STORE_OPEN before anything else', guarded);
  const fetches = (I.game.match(/fetch\('\/api\/create-checkout-session'/g) || []).length;
  ck('PP2 the checkout request appears only in the two buySkin bodies (the first is replaced at load by the guarded one)', fetches === 2 && /\nbuySkin = async function \(sku, btn\) \{\n  if \(!STORE_OPEN\) \{/.test(I.game), fetches);
  ck('PP2 the shop draws COMING SOON / SOON (disabled) and wires no BUY button while the store is closed', /else if\(!STORE_OPEN\)\{btn\.textContent='SOON';btn\.disabled=true;\}/.test(I.game) && /STORE_OPEN\?s\.price:'COMING SOON'/.test(I.game));

  /* ---- PP3 the server ---- */
  const val = (I.wrangler.match(/"STORE_OPEN":\s*"([^"]*)"/) || [])[1];
  ck('PP3 wrangler.jsonc keeps the server store closed: "STORE_OPEN": "false"', val === 'false', val);
  const tmp = path.join(__dirname, '.pp-worker-' + Math.random().toString(16).slice(2) + '.mjs');
  fs.writeFileSync(tmp, I.worker);
  const realFetch = globalThis.fetch, stripe = [];
  globalThis.fetch = async (u) => { stripe.push(String(u)); return new Response(String(u).includes('/prices/') ? '{"id":"price_x","active":true,"livemode":false}' : '{"id":"cs_test_x","url":"https://checkout.stripe.com/c/pay/cs_test_x"}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const w = (await import(pathToFileURL(tmp).href)).default;
    const base = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_TOXIC: 'price_t', STRIPE_PRICE_COSMIC: 'price_c', STRIPE_PRICE_SOLAR: 'price_s', SITE_URL: 'https://fluxsparta.com' };
    const ask = async (env, sku) => {
      const r = await w.fetch(new Request('https://fluxsparta.com/api/create-checkout-session?src=playstore', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://fluxsparta.com', Referer: TWA_REF },
        body: JSON.stringify({ sku, playerId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001' }) }), env, { waitUntil() {} });
      let d = {}; try { d = await r.json(); } catch (e) {}
      return { status: r.status, code: d.code };
    };
    stripe.length = 0;
    const closed = []; for (const sku of SKUS) closed.push(await ask({ ...base, STORE_OPEN: val }, sku));
    const unset = []; for (const sku of SKUS) unset.push(await ask({ ...base }, sku));
    ck('PP3 a Play-app request (TWA referrer, ?src=playstore, a real pilot) is refused for every skin: 403 STORE_CLOSED, with STORE_OPEN as in wrangler.jsonc and with none set',
      closed.concat(unset).every((x) => x.status === 403 && x.code === 'STORE_CLOSED'), JSON.stringify(closed.concat(unset)));
    ck('PP3 ...and Stripe is never called', stripe.length === 0, stripe.join(','));
    stripe.length = 0;
    const open = await ask({ ...base, STORE_OPEN: 'true' }, 'solar');
    ck('PP3 positive control: with STORE_OPEN "true" the same request would reach Stripe (so the check above can fail)', open.status === 200 && stripe.length >= 1, open.status + ' ' + stripe.length);
  } catch (e) { ck('PP3 worker ran', false, String(e.stack || e).slice(0, 200)); }
  finally { globalThis.fetch = realFetch; try { fs.unlinkSync(tmp); } catch (e) {} }

  /* ---- PP4 the Gateway's demo game ---- */
  const shim = /window\.fetch = function\(input, init\)\{\n    var u = \(input && input\.url\) \? input\.url : String\(input\);\n    if \(\/\\\/api\\\/\/\.test\(u\)\) \{\n      \/\/ Never reach the real server from the demo\.\n      return Promise\.resolve\(new Response\('\{\}'/;
  ck('PP4 the demo game answers every /api/ request itself, before its BUY code could run', shim.test(I.demo) && I.demo.indexOf('window.fetch = function(input, init){') < I.demo.indexOf('async function buySkin('));
  const opens = ['gateway', 'game', 'demo', 'priv'].filter((k) => /welcome\/hero-demo/.test(I[k]));
  ck('PP4 the retired welcome/hero-demo.html is opened by no page (welcome/ only forwards to the Gateway); the server refuses it anyway (PP3)', opens.length === 0 && /window\.location\.replace\('\/' \+ window\.location\.search\)/.test(read('public/welcome/index.html')), opens.join(','));
  ck('PP4 the Gateway\'s demo frame takes no taps (pointer-events: none)', /\.gameFrame iframe\{width:100%;height:100%;border:0;pointer-events:none\}/.test(I.gateway));
  return { F, failed };
}

const main = await suite(IN);
console.log('\n== negative controls: each guard removed MUST be caught ==');
let NC = 0;
async function control(label, expect, key, a, b) {
  if (!IN[key].includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const I2 = { ...IN, [key]: IN[key].split(a).join(b) };
  const r = await suite(I2, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
await control('paragraph missing from the main copy', 'PP1 section 8', 'priv', PARA, '');
await control('paragraph placed after the Stripe paragraph instead', 'PP1 section 8', 'privW', FIRST + PARA, FIRST);
await control('effective date not updated', 'PP1 the two copies', 'priv', 'October 22, 2026', 'October 21, 2026');
await control('another sentence changed in the policy', 'PP1 nothing else changed', 'priv', 'FLUX never receives your card number', 'FLUX does not receive your card number');
await control('game store switch on', 'PP2 the game\'s store switch', 'game', '\nconst STORE_OPEN = false;', '\nconst STORE_OPEN = true;');
await control('the guarded buySkin no longer checks the switch', 'PP2 buySkin() for every skin', 'game', "buySkin = async function (sku, btn) {\n  if (!STORE_OPEN) {", "buySkin = async function (sku, btn) {\n  if (false) {");
await control('the shop wires BUY while closed', 'PP2 the shop draws', 'game', "else if(!STORE_OPEN){btn.textContent='SOON';btn.disabled=true;}", "else{btn.textContent='BUY';btn.onclick=()=>buySkin(sku,btn);}");
await control('server store opened in wrangler.jsonc', 'PP3 wrangler.jsonc', 'wrangler', '"STORE_OPEN": "false"', '"STORE_OPEN": "true"');
await control('server gate removed', 'PP3 a Play-app request', 'worker', 'if (String(env.STORE_OPEN || "").toLowerCase() !== "true") {', 'if (false) {');
await control('demo can reach the server', 'PP4 the demo game', 'demo', '// Never reach the real server from the demo.\n      return Promise.resolve(', '// Never reach the real server from the demo.\n      return realFetch.apply(this, arguments) || Promise.resolve(');
await control('a page opens the retired demo copy', 'PP4 the retired', 'gateway', 'src="hero-demo.html" loading="lazy"', 'src="welcome/hero-demo.html" loading="lazy"');
await control('demo frame takes taps', 'PP4 the Gateway', 'gateway', '.gameFrame iframe{width:100%;height:100%;border:0;pointer-events:none}', '.gameFrame iframe{width:100%;height:100%;border:0}');
const total = main.F + NC;
console.log('\n' + (total ? 'PLAY PURCHASES FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PLAY PURCHASES PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
