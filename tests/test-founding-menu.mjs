// FOUNDING PILOT MENU CLEANUP (owner). The real game page in the harness vm.
//   M1 a new player (not a Founding Pilot): "spots left" only, as before;
//   M2 a Founding Pilot who has never put on Solar Inferno: badge and "spots left", as before;
//   M3 a pilot who has put on Solar Inferno (skin or backdrop, now or ever): neither line, and the mark
//      is kept per pilot so switching back to another skin keeps them hidden; pilots from before the mark
//      existed count when Solar Inferno is on now;
//   M4 putting on Solar Inferno (THEMES & SKINS or TRY IT NOW) hides them at once;
//   M5 all 1,000 spots taken, or the offer switched off: neither line for anyone;
//   M6 only the two lines: the welcome card, the NEW dot, the board badge code and the grant are untouched.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const PID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000057', OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000058';

async function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const menu = ({ fp = 0, left = 742, store = {} } = {}) => {
    const init = Object.assign({ fluxPlayerId: PID, fluxCallsign: 'ACE', fluxProfileComplete: '1', fluxRunsPlayed: '6', fluxFoundingShown: PID, fluxSkinsSeen: PID,
      fluxFoundingLeft: JSON.stringify({ left, at: Date.now() }) }, fp ? { fluxFounding: JSON.stringify({ pid: PID, n: fp }) } : {}, store);
    const { store: st, mem } = makeStore(init);
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store: st });
    const el = () => { const e = { textContent: '', hidden: true, classList: { toggle(c, on) { if (c === 'hidden') e.hidden = !!on; }, add(c) { if (c === 'hidden') e.hidden = true; }, remove(c) { if (c === 'hidden') e.hidden = false; }, contains(c) { return c === 'hidden' && e.hidden; } } }; return e; };
    g.els.foundingBadge = el(); g.els.foundingLeft = el();
    const run = (c) => vm.runInContext(c, g.ctx);
    run('fluxLbCached = function(){ return null; };');
    const peek = () => ({ badge: g.els.foundingBadge.hidden ? '' : g.els.foundingBadge.textContent, line: g.els.foundingLeft.hidden ? '' : g.els.foundingLeft.textContent });   // as the menu shows it now, no refresh
    const now = () => { run('fluxFoundingRefresh();'); return { badge: g.els.foundingBadge.hidden ? '' : g.els.foundingBadge.textContent, line: g.els.foundingLeft.hidden ? '' : g.els.foundingLeft.textContent }; };
    return { g, run, mem, now, peek };
  };
  try {
    const a = menu().now();
    ck('M1 new player (not a Founding Pilot): "spots left" only, as before', a.badge === '' && a.line === 'Founding Pilot spots left: 742', JSON.stringify(a));
    const b = menu({ fp: 57 }).now();
    ck('M2 Founding Pilot who never put on Solar Inferno: badge and "spots left", as before', b.badge === 'FOUNDING PILOT #57' && b.line === 'Founding Pilot spots left: 742', JSON.stringify(b));
    const c = menu({ fp: 57, store: { fluxSkin: 'solar', fluxBackground: 'solar' } }); const cv = c.now();
    ck('M3 Solar Inferno on now (e.g. TRY IT NOW from before this change): neither line, and the mark is kept for this pilot', cv.badge === '' && cv.line === '' && c.mem.fluxSolarUsed === PID, JSON.stringify([cv, c.mem.fluxSolarUsed]));
    const d = menu({ fp: 57, store: { fluxBackground: 'solar' } }).now();
    ck('M3 ...the Solar Inferno backdrop alone counts too', d.badge === '' && d.line === '', JSON.stringify(d));
    const e = menu({ fp: 57, store: { fluxSolarUsed: PID, fluxSkin: 'aurora' } }).now();
    ck('M3 ...used once, now on another skin: still neither line', e.badge === '' && e.line === '', JSON.stringify(e));
    const f = menu({ fp: 57, store: { fluxSolarUsed: OTHER } }).now();
    ck('M3 ...the mark belongs to its pilot: another pilot on this device still sees the lines', f.badge === 'FOUNDING PILOT #57' && f.line !== '', JSON.stringify(f));
    const n = menu({ store: { fluxSkin: 'solar' } }).now();
    ck('M3 ...a new player who bought and put on Solar Inferno: no "spots left" either', n.badge === '' && n.line === '', JSON.stringify(n));
    // a Founding Pilot owns Solar Inferno (equipSkin ignores skins that are not owned)
    const h = menu({ fp: 57 }); h.run("fluxOwnedSkus = new Set(['solar']); fluxEntitlementsLoaded = true;"); const h0 = h.now(); h.run("equipSkin('solar');"); const h1 = h.peek(); h.run("equipSkin('aurora'); setBackground('none');"); const h2 = h.now();
    ck('M4 putting on Solar Inferno in THEMES & SKINS hides both at once; switching back keeps them hidden',
      h0.badge !== '' && h1.badge === '' && h1.line === '' && h2.badge === '' && h2.line === '' && h.mem.fluxSolarUsed === PID, JSON.stringify([h0, h1, h2]));
    const t = menu({ fp: 57 }); t.run("fluxOwnedSkus = new Set(['solar']); fluxEntitlementsLoaded = true;");
    let tv = null; await t.g.ctx.fluxFoundingEquip().then(() => { tv = t.now(); });
    ck('M4 ...TRY IT NOW (the whole package) hides both', tv && tv.badge === '' && tv.line === '' && t.mem.fluxSolarUsed === PID, JSON.stringify(tv));
    const z1 = menu({ fp: 57, left: 0 }).now(), z2 = menu({ left: 0 }).now();
    ck('M5 all 1,000 spots taken: neither line for a Founding Pilot nor for anyone else', z1.badge === '' && z1.line === '' && z2.badge === '' && z2.line === '', JSON.stringify([z1, z2]));
    const o = menu({ fp: 57, left: null }).now();
    ck('M5 ...offer switched off (no count): neither line either, the badge hidden too', o.badge === '' && o.line === '', JSON.stringify(o));
    const w = menu({ fp: 57, store: { fluxSkin: 'solar', fluxFoundingShown: '' } }); w.run("document.getElementById('start').classList = { contains(){ return false; } };");
    ck('M6 only the two lines: the welcome card, the NEW dot and the board badge are driven as before',
      /function fluxFoundingToast\(\)\{/.test(html) && /function fluxSkinsDot\(\)\{/.test(html) && /badge:n>0 \? 'FOUNDING PILOT #'\+n/.test(html) && w.run('typeof fluxFoundingNum') === 'function' && w.run('fluxFoundingNum()') === 57);
  } catch (err) { ck('section ran', false, String(err.stack || err).slice(0, 300)); }
  return { F, failed };
}

const t0 = Date.now();
const res = await suite(GAME_HTML);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
async function control(label, expect, mut) {
  const h = mut(GAME_HTML);
  if (h === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = await suite(h, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
await control('Solar Inferno users still see the lines', 'M3 Solar', rep("const left=fluxFoundingLeftNow(), quiet=fluxSolarUsed() || !(left>0);", "const left=fluxFoundingLeftNow(), quiet=!(left>0);"));
await control('only the current skin counts (switching back shows them again)', 'M3 ...used once', rep('if(localStorage.getItem(FLUX_SOLAR_USED_KEY)===playerId) return true;', ''));
await control('the mark is not per pilot', 'M3 ...the mark belongs', rep('if(localStorage.getItem(FLUX_SOLAR_USED_KEY)===playerId) return true;', 'if(localStorage.getItem(FLUX_SOLAR_USED_KEY)) return true;'));
await control('the backdrop alone does not count', 'M3 ...the Solar Inferno backdrop', rep("if(activeSkin==='solar' || activeBackground==='solar')", "if(activeSkin==='solar')"));
await control('putting on Solar Inferno does not refresh the menu', 'M4 putting', rep("equipSkin=function(sku){ const r=equip0.apply(this,arguments); if(sku==='solar') fluxFoundingRefresh(); return r; };", "equipSkin=function(sku){ return equip0.apply(this,arguments); };"));
await control('the badge stays when all spots are taken', 'M5 all', rep('quiet=fluxSolarUsed() || !(left>0);', 'quiet=fluxSolarUsed() || left===null;'));
await control('the badge stays when the offer is switched off', 'M5 ...offer', rep('quiet=fluxSolarUsed() || !(left>0);', 'quiet=fluxSolarUsed() || left===0;'));
const total = res.F + NC;
console.log('\n' + (total ? 'FOUNDING MENU FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'FOUNDING MENU PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
