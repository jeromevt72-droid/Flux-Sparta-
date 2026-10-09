// GATEWAY ON NARROW PHONES (owner, BLU G45).
//   F1 a flag is picked ONLY by a clean tap: finger down and up on the same flag, little movement, page not
//      scrolled meanwhile, no scroll just before (a tap that stops a fling), not a long hold; keyboard and
//      screen readers (a click with no pointer) still pick; the choice is the Gateway-only display preference
//      (fluxGatewayCountry) -- the game never reads it, so a pilot's real country is never changed here;
//   H1 headline: on portrait screens 400px wide or less, the first compact step that lets the headline start
//      below the greeting is applied (measured, transitions off while measuring); wider screens or a stack
//      that already fits are left exactly as today; if no step fits, the hero grows instead of sliding under
//      the header; the compact steps only touch the country buttons and the spacing below the headline.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GW = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), GAME = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');

function flagRig(src, { now0 = 100000 } = {}) {
  const a = src.indexOf("  var heroFlagBarEl = document.getElementById('heroFlagBar');"), z = src.indexOf('\n  window.escapeHtml2', a);
  const code = src.slice(a, z);
  const L = {}, W = {}; let t = now0; const picked = [];
  const flag = (c) => ({ dataset: { code: c }, closest: function () { return this; } });
  const flags = { US: flag('US'), CN: flag('CN'), BR: flag('BR') };
  const bar = { addEventListener: (n, f) => { L[n] = f; } };
  const g = { document: { getElementById: () => bar }, window: null, Date: { now: () => t }, Math };
  g.window = { scrollY: 0, addEventListener: (n, f) => { W[n] = f; }, setPreferredCountry: (c) => picked.push(c) };
  vm.createContext(g); vm.runInContext(code, g);
  const ev = (o) => Object.assign({ pointerId: 1, clientX: 50, clientY: 50, detail: 1 }, o);
  const api = {
    picked, flags, wait: (ms) => { t += ms; },
    down: (f, o = {}) => L.pointerdown(ev(Object.assign({ target: f }, o))), move: (o) => L.pointermove(ev(o)), cancel: () => L.pointercancel && L.pointercancel(ev({})),
    click: (f, o = {}) => L.click(ev(Object.assign({ target: f }, o))), scroll: (dy = 30) => { g.window.scrollY += dy; W.scroll && W.scroll(); },
    tap(f, o = {}) { api.down(f); api.wait(o.hold || 90); if (o.moveTo) api.move(o.moveTo); api.click(o.upOn || f); } };
  return api;
}

function suite(src, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    let r = flagRig(src); r.wait(5000); r.tap(r.flags.BR);
    ck('F1 a clean tap picks the flag', r.picked.join() === 'BR', r.picked.join());
    r = flagRig(src); r.wait(5000); r.down(r.flags.US); r.move({ clientX: 50, clientY: 20 }); r.click(r.flags.US);
    ck('F1 a finger that moves (scroll / swipe, 30 px) never picks', r.picked.length === 0, r.picked.join());
    r = flagRig(src); r.wait(5000); r.down(r.flags.US); r.cancel(); r.click(r.flags.US);
    ck('F1 ...nor when the browser takes the touch for a scroll (pointercancel)', r.picked.length === 0);
    r = flagRig(src); r.wait(5000); r.down(r.flags.US); r.scroll(40); r.click(r.flags.US);
    ck('F1 ...nor when the page scrolled while the finger was down', r.picked.length === 0);
    r = flagRig(src); r.wait(5000); r.scroll(20); r.wait(120); r.tap(r.flags.CN);
    ck('F1 a tap that STOPS a scroll (120 ms after it) never picks (the BLU G45 case)', r.picked.length === 0, r.picked.join());
    r = flagRig(src); r.wait(5000); r.scroll(20); r.wait(400); r.tap(r.flags.CN);
    ck('F1 ...once the page is still, the next clean tap picks', r.picked.join() === 'CN', r.picked.join());
    r = flagRig(src); r.wait(5000); r.tap(r.flags.US, { upOn: r.flags.CN });
    ck('F1 finger down on one flag, lifted on another: nothing picked', r.picked.length === 0);
    r = flagRig(src); r.wait(5000); r.tap(r.flags.US, { hold: 1500 });
    ck('F1 a long hold (1.5 s) does not pick', r.picked.length === 0);
    r = flagRig(src); r.wait(5000); r.tap(r.flags.US, { moveTo: { clientX: 56, clientY: 54 } });
    ck('F1 a little finger wobble (6 px) still counts as a tap', r.picked.join() === 'US', r.picked.join());
    r = flagRig(src); r.click(r.flags.BR, { detail: 0 });
    ck('F1 keyboard / screen reader (click with no pointer) still picks', r.picked.join() === 'BR', r.picked.join());
    ck('F1 the Gateway choice is display-only: stored as fluxGatewayCountry, never read by the game', /var GATEWAY_COUNTRY_KEY = 'fluxGatewayCountry';/.test(src) && !/fluxGatewayCountry/.test(GAME));
  } catch (e) { ck('flag section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const css = (src.match(/body\.heroCta-t[12][^{]*\{[^}]*\}/g) || []).join('\n');
    const sels = (src.match(/body\.heroCta-t[12] ([^{]+)\{/g) || []).map((x) => x.replace(/^body\.heroCta-t[12] /, '').replace(/\{$/, '').trim());
    ck('H1 the compact steps only touch the country buttons and the spacing below the headline', sels.length >= 6 && sels.every((x) => ['.countryBar', '.flag', '.actions', '.actions .btn', '.warmLine', '.trustLine'].includes(x)), sels.join(', '));
    ck('H1 while measuring, transitions are off (no mid-animation readings)', /body\.heroCta-measuring \.heroCTA,body\.heroCta-measuring \.heroCTA \*\{transition:none!important\}/.test(src));
    // the real fit function, with a stand-in layout: the stack's top depends on the step applied
    const a = src.indexOf("  var CTA_TIERS = ['', 'heroCta-t1', 'heroCta-t2']"), z = src.indexOf('  function fitHeroBrand(){', a);
    const fit = (w, h, tops) => { const cls = new Set(); const body = { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } };
      const tier = () => (cls.has('heroCta-t2') ? 2 : cls.has('heroCta-t1') ? 1 : 0); const hero = { style: { minHeight: '' }, getBoundingClientRect: () => ({ height: 680 }) };
      const cta = { offsetHeight: 1, getBoundingClientRect: () => ({ top: tops[tier()] }) }, rot = { getBoundingClientRect: () => ({ bottom: 96 }) };
      const g = { document: { body, querySelector: (q) => (q === '.heroCTA' ? cta : q === '.hero' ? hero : null), getElementById: () => rot }, window: { innerWidth: w, innerHeight: h }, Math };
      vm.createContext(g); vm.runInContext(src.slice(a, z) + '\nthis.__r = fitHeroCta();', g); return { r: g.__r, cls: [...cls].join(' '), min: hero.style.minHeight }; };
    const ok390 = fit(390, 844, [266, 0, 0]), n360 = fit(360, 690, [-29, 204, 260]), n320 = fit(320, 640, [-79, 40, 120]), grow = fit(320, 568, [-200, -60, -20]), wide = fit(768, 1024, [-50, 0, 0]), land = fit(380, 320, [-50, 100, 100]);
    ck('H1 a stack that already fits (iPhone 390x844): left exactly as today', ok390.r.tier === 'none' && ok390.cls === '' && ok390.min === '', JSON.stringify(ok390));
    ck('H1 360 px: the FIRST step that fits is used (t1)', n360.r.tier === 'tier1' && n360.cls === 'heroCta-t1', JSON.stringify(n360));
    ck('H1 320 px: t1 is not enough, t2 is used', n320.r.tier === 'tier2' && n320.cls === 'heroCta-t2', JSON.stringify(n320));
    ck('H1 if no step fits, the hero grows by what is missing (never slides under the header), on top of the tightest step', grow.r.tier === 'grow' && grow.min === '804px' && grow.cls === 'heroCta-t2', JSON.stringify(grow));
    ck('H1 wider than 400 px or landscape: never touched, even if it overlaps (larger screens look as today)', wide.r.tier === 'none' && wide.cls === '' && land.r.tier === 'none' && land.cls === '');
    ck('H1 the fit runs at every point the logo fit runs (load, fonts, resize, rotation), stack first', /function fitHeroBrand\(\)\{[\s\S]{0,200}fitHeroCta\(\);/.test(src));
  } catch (e) { ck('headline section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const res = suite(GW);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, a, b) {
  if (!GW.includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(GW.split(a).join(b), true); const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
control('a click picks whatever happened before', 'F1 a finger that moves', "if(!tap || !tap.ok || tap.btn !== btn || Math.abs(window.scrollY - tap.sy) > FLAG_TAP_SLOP || Date.now() - tap.t > FLAG_TAP_MAX_MS) return;", '');
control('a tap that stops a scroll still picks', 'F1 a tap that STOPS', 'ok: Date.now() - lastScrollAt >= FLAG_SCROLL_QUIET', 'ok: true');
control('keyboard clicks are refused too', 'F1 keyboard', 'if(e.detail !== 0){', 'if(true){');
control('steps applied on every width', 'H1 wider than 400', "var narrow = window.innerWidth <= 400 && window.innerHeight > window.innerWidth;", 'var narrow = true;');
control('always the tightest step', 'H1 360 px', "if(over <= 0){ chosen = i; break; }", "if(over <= 0 && i === CTA_TIERS.length - 1){ chosen = i; break; }");
control('no growth fallback', 'H1 if no step fits', "hero.style.minHeight = Math.ceil(hero.getBoundingClientRect().height + over) + 'px';", '');
control('measured mid-transition', 'H1 while measuring', 'body.heroCta-measuring .heroCTA,body.heroCta-measuring .heroCTA *{transition:none!important}', '');
const total = res.F + NC;
console.log('\n' + (total ? 'GATEWAY NARROW FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'GATEWAY NARROW PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
