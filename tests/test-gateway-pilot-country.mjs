// GATEWAY: THE PILOT'S OWN COUNTRY BY DEFAULT (owner).
//   G1 a pilot with a country set in the game sees it on the Gateway by default, on every visit, even if an
//      older Gateway choice (e.g. an accidental tap) is stored;
//   G2 a flag tapped during the visit still changes what the Gateway shows for that visit;
//   G3 without a pilot country (new player, unfinished profile, unknown code): exactly as before (the stored
//      Gateway choice, or none);
//   G4 the Gateway never writes the pilot's country (fluxCountry), and the game never reads the Gateway choice.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GW = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), GAME = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');

function visit(src, store) {
  const a = src.indexOf("  var GATEWAY_COUNTRY_KEY = 'fluxGatewayCountry';"), z = src.indexOf("  // Returns 'leader'", a);
  const mem = Object.assign({}, store), writes = [];
  const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { writes.push(k); mem[k] = String(v); }, removeItem: (k) => { writes.push(k); delete mem[k]; } };
  const w = { COUNTRY_META: { FR: {}, US: {}, IN: {}, BR: {}, PH: {} }, applyPreferredCountryUI() {}, renderGrid() {} };
  const g = { window: w, localStorage: ls, document: { getElementById: () => null }, setTimeout: () => 0, Object, RegExp };
  vm.createContext(g); vm.runInContext(src.slice(a, z), g);
  return { get: () => w.getPreferredCountry(), tap: (c) => w.setPreferredCountry(c), mem, writes };
}
function suite(src, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    const pilot = { fluxProfileComplete: '1', fluxCountry: 'FR', fluxGatewayCountry: 'IN' };
    const v1 = visit(src, pilot);
    ck('G1 a pilot with a country sees it by default, even over an older stored Gateway choice (an accidental tap)', v1.get() === 'FR', v1.get());
    v1.tap('BR');
    ck('G2 a flag tapped during the visit changes what the Gateway shows for that visit', v1.get() === 'BR', v1.get());
    const v2 = visit(src, v1.mem);
    ck('G1 ...and the next visit starts again on the pilot\'s own country', v2.get() === 'FR', v2.get());
    v2.tap(''); ck('G2 ...OTHER COUNTRY tapped: nothing highlighted for the visit', v2.get() === '', v2.get());
    ck('G3 new player (no pilot country): the stored Gateway choice, as before', visit(src, { fluxGatewayCountry: 'PH' }).get() === 'PH');
    ck('G3 unfinished profile (country only guessed): as before', visit(src, { fluxCountry: 'US', fluxGatewayCountry: 'PH' }).get() === 'PH');
    ck('G3 unknown or "OTHER" pilot country: as before', visit(src, { fluxProfileComplete: '1', fluxCountry: 'OTHER', fluxGatewayCountry: 'PH' }).get() === 'PH' && visit(src, { fluxProfileComplete: '1', fluxCountry: 'ZZ' }).get() === '');
    ck('G3 nothing at all: none, as before', visit(src, {}).get() === '');
    ck('G4 the Gateway never writes the pilot\'s country; the game never reads the Gateway choice', !v1.writes.includes('fluxCountry') && !v2.writes.includes('fluxCountry') && !/fluxCountry['"]\s*,|setItem\('fluxCountry'/.test(src.replace(/var KEYS=\[[^\]]*\]/g, '')) && !/fluxGatewayCountry/.test(GAME));
  } catch (e) { ck('section ran', false, String(e.stack || e).slice(0, 300)); }
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
control('the stored Gateway choice wins over the pilot', 'G1 a pilot', '    var pc = window.pilotCountry(); if(pc) return pc;\n', '');
control('a tap during the visit is ignored for a pilot', 'G2 a flag', '    if(gatewayVisitChoice !== null) return gatewayVisitChoice;\n', '');
control('a guessed country (unfinished profile) is used', 'G3 unfinished', "      if(localStorage.getItem('fluxProfileComplete') !== '1') return '';\n", '');
const total = res.F + NC;
console.log('\n' + (total ? 'GATEWAY PILOT COUNTRY FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'GATEWAY PILOT COUNTRY PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
