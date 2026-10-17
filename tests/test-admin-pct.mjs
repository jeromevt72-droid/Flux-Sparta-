// Admin page: the two percentage helpers that used to share the name "pct". In the release gate.
// The later storage pct(x) silently replaced the stats pct(a, b), so Retention showed "2%" for 2 of 2
// and the daily share column showed "1%" for 1 of 5. This suite loads the FULL admin script and checks:
//   U1 no function name is declared twice anywhere in the admin script (the root cause);
//   R1 ratioPct: 2 of 2 = 100%, 1 of 5 = 20%, 0 of 5 = 0%, nothing to divide by = "—";
//   R2 Retention cells read "1 / 5 — 20%", a real zero reads "0 / 5 — 0%", a day not reached yet reads "—";
//   R3 the daily "Share rate" column uses ratioPct(shares, runs);
//   S1 storagePct formats exactly as before: one decimal, "%" (47.25 -> "47.3%", 75 -> "75%");
//   S2 the storage card still shows its percentage through storagePct.
// Ends with negative controls: each defect re-inserted MUST be caught, including a duplicate name coming back.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'admin.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// Today's storage formula, frozen here so any change to how storage percentages look is caught.
const OLD_STORAGE = (x) => (Math.round(x * 10) / 10) + '%';

function duplicateNames(js) {
  const seen = {};
  for (const m of js.matchAll(/(?<![\w$.])function\s+([A-Za-z_$][\w$]*)\s*\(/g)) seen[m[1]] = (seen[m[1]] || 0) + 1;
  return { count: Object.keys(seen).length, dups: Object.keys(seen).filter((k) => seen[k] > 1) };
}

function suite(adminHtml, quiet = false) {
  const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) failed.push(l); };
  const scripts = scriptsOf(adminHtml), js = scripts.join('\n');
  const d = duplicateNames(js);
  ck('U1 no function name is declared twice in the admin script', d.count > 50 && d.dups.length === 0, d.dups.length ? 'duplicates: ' + d.dups.join(', ') : d.count + ' names');
  const g = boot(scripts, { origin: 'https://flux.example', path: '/admin.html', store: makeStore({}).store });
  const S = g.win.FLUX_ADMIN_STATS || vm.runInContext('typeof FLUX_ADMIN_STATS!=="undefined"?FLUX_ADMIN_STATS:null', g.ctx) || {};
  ck('P1 the full admin script loads without errors and exposes its helpers', g.errors.length === 0 && typeof S.ratioPct === 'function' && typeof S.storagePct === 'function' && typeof S.summarize === 'function', g.errors.join(' | '));
  try {
    const r = [S.ratioPct(2, 2), S.ratioPct(1, 5), S.ratioPct(0, 5), S.ratioPct(1, 0)];
    ck('R1 ratioPct: 2 of 2 = 100%, 1 of 5 = 20%, 0 of 5 = 0%, nothing to divide by = "—"', r.join('|') === '100%|20%|0%|—', r.join('|'));
  } catch (e) { ck('R1 ratioPct ran', false, String(e).slice(0, 200)); }
  try {
    // Cohorts: 5 started 40 days ago (1 back on day 1, 0 on day 7, 1 on day 30); 2 started 3 days ago (2 back on day 1, day 7/30 not reached).
    const rep = { days: [{ date: '2026-10-16', groups: { all: { active: 5, runs: 5, shares: 1 } } }], months: [],
      cohorts: [{ date: '2026-09-07', age: 40, groups: { all: { n: 5, d1: 1, d7: 0, d30: 1 } } }, { date: '2026-10-14', age: 3, groups: { all: { n: 2, d1: 2 } } }] };
    const c = S.summarize(rep, 'all').groups[0].cohorts.map((x) => [x.d1, x.d7, x.d30].join(' | '));
    ck('R2 Retention: "1 / 5 — 20%", a real zero "0 / 5 — 0%", 2 of 2 "2 / 2 — 100%", days not reached "—"',
      c[0] === '1 / 5 — 20% | 0 / 5 — 0% | 1 / 5 — 20%' && c[1] === '2 / 2 — 100% | — | —', JSON.stringify(c));
  } catch (e) { ck('R2 retention ran', false, String(e).slice(0, 200)); }
  ck('R3 the daily "Share rate" column is shares out of runs through ratioPct', /ratioPct\(d\.shares, d\.runs\)/.test(js) && !/(?<![\w$.])pct\(/.test(js));
  try {
    const xs = [0, 0.04, 0.05, 1, 12.34, 33.333333, 47.25, 74.95, 75, 80.06, 99.94, 99.96, 100];
    const got = xs.map((x) => S.storagePct(x)), want = xs.map(OLD_STORAGE);
    ck('S1 storagePct looks exactly as before (one decimal, "%")', got.join('|') === want.join('|') && S.storagePct(47.25) === '47.3%' && S.storagePct(75) === '75%' && S.storagePct(0) === '0%', got.join(' '));
  } catch (e) { ck('S1 storagePct ran', false, String(e).slice(0, 200)); }
  ck('S2 the storage card shows its percentage through storagePct', /' of 2 MB \(' \+ storagePct\(ov\.pct\) \+ '\)'/.test(js));
  return failed;
}

const failed = suite(ADMIN_HTML);
console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const h = mutate(ADMIN_HTML);
  if (h === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const f = suite(h, true), hit = f.filter((x) => x.startsWith(expect));
  console.log((hit.length ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (hit.length ? hit[0] : 'expected ' + expect + '; failed: ' + (f.join(' | ') || 'none')) + ']');
  if (!hit.length) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
const STORAGE_DEF = "  function storagePct(x) { return (Math.round(x * 10) / 10) + '%'; }\n";
// The original bug, put back: the storage helper re-declared under the stats helper's name.
control('a duplicate function name comes back (storage helper named ratioPct again)', 'U1', rep(STORAGE_DEF, STORAGE_DEF + "  function ratioPct(x) { return (Math.round(x * 10) / 10) + '%'; }\n"));
control('...and it really breaks the numbers: 2 of 2 shows "2%"', 'R1', rep(STORAGE_DEF, STORAGE_DEF + "  function ratioPct(x) { return (Math.round(x * 10) / 10) + '%'; }\n"));
control('any other duplicate name (a second fmt)', 'U1', rep(STORAGE_DEF, STORAGE_DEF + '  function fmt(n) { return String(n); }\n'));
control('the old shared name pct is back', 'R3', rep('ratioPct(d.shares, d.runs)', 'pct(d.shares, d.runs)'));
control('a day not reached yet shows "0 / n — 0%"', 'R2', rep("d7: c.age >= 7 ? retCell(v.d7 || 0, v.n) : '—'", 'd7: retCell(v.d7 || 0, v.n)'));
control('retention shows the percent only', 'R2', rep("return fmt(back) + ' / ' + fmt(n) + ' — ' + ratioPct(back, n);", 'return ratioPct(back, n);'));
control('storage percentages rounded differently', 'S1', rep(STORAGE_DEF, "  function storagePct(x) { return Math.round(x) + '%'; }\n"));
control('storage card stops using storagePct', 'S2', rep("' of 2 MB (' + storagePct(ov.pct) + ')'", "' of 2 MB (' + ratioPct(ov.pct, 100) + ')'"));

console.log('\n' + (failed.length || NC ? 'FAILED: ' + failed.length + ' check(s), ' + NC + ' control(s)' : 'ALL PASSED (checks + negative controls)'));
process.exit(failed.length || NC ? 1 : 0);
