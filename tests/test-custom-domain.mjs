// CUSTOM DOMAIN (owner): FLUX at https://fluxsparta.com, the workers.dev address kept.
//   D1 wrangler.jsonc declares fluxsparta.com as a Custom Domain of this Worker (so a deploy never wipes it),
//      and nothing else: no www (a dashboard Redirect Rule sends www to fluxsparta.com, so a pilot never
//      splits between two addresses), no wildcard, no zone route that would run the Worker on every file;
//   D2 "workers_dev": true is written out, so the old address keeps working for every player and app;
//   D3 everything else is exactly as on main: name, main, assets (only /api/* runs the Worker: free plan),
//      Durable Object binding + migration, KV, cron, vars (SITE_URL stays the old address until PR 3);
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WRANGLER = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
const parse = (t) => JSON.parse(t.replace(/^\s*\/\/.*$/mg, ''));
const show = (f) => { try { const r = spawnSync('git', ['show', 'origin/main:' + f], { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; } catch (e) { return null; } };
const MAIN = show('wrangler.jsonc');
const OLD = 'https://flux-sparta-3.jeromevt72.workers.dev';

function suite(w, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    const c = parse(w);
    const r = Array.isArray(c.routes) ? c.routes : [];
    ck('D1 fluxsparta.com is declared in wrangler.jsonc as a Custom Domain of this Worker', r.some((x) => x && x.pattern === 'fluxsparta.com' && x.custom_domain === true), JSON.stringify(c.routes));
    ck('D1 ...and it is the only route: no www, no wildcard, no zone route (www is a dashboard redirect)', r.length === 1 && !c.route && !/\*/.test(JSON.stringify(r)) && !/www\./.test(JSON.stringify(r)), JSON.stringify(c.routes));
    ck('D2 the workers.dev address stays on ("workers_dev": true, written out)', c.workers_dev === true, String(c.workers_dev));
    ck('D3 free plan: only /api/* runs the Worker; every file is still served by the asset layer', JSON.stringify(c.assets && c.assets.run_worker_first) === '["/api/*"]' && c.assets.directory === './public' && c.assets.not_found_handling === '404-page');
    ck('D3 same Worker, Durable Object, migration, KV and cron', c.name === 'flux-sparta-3' && c.main === 'worker.js' && JSON.stringify(c.durable_objects.bindings) === JSON.stringify([{ name: 'LEADERBOARD_DO', class_name: 'LeaderboardDO' }])
      && JSON.stringify(c.migrations) === JSON.stringify([{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }]) && c.kv_namespaces.length === 1 && JSON.stringify(c.triggers) === JSON.stringify({ crons: ['*/30 * * * *'] }));
    ck('D3 SITE_URL still the workers.dev address (it moves in PR 3), store still closed', c.vars.SITE_URL === OLD && c.vars.STORE_OPEN === 'false', c.vars.SITE_URL);
    if (MAIN) { const strip = (x) => { const o = parse(x); delete o.routes; delete o.workers_dev; return JSON.stringify(o); };
      ck('D3 apart from the two domain lines, wrangler.jsonc is identical to main', strip(MAIN) === strip(w)); }
    else ck('D3 (git not available: compared with the fixed values above only)', true);
  } catch (e) { ck('wrangler.jsonc parsed', false, String(e).slice(0, 200)); }
  return { F, failed };
}

const t0 = Date.now();
const res = suite(WRANGLER);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, mut) {
  const w = mut(WRANGLER);
  if (w === WRANGLER) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(w, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
const DOM = '    { "pattern": "fluxsparta.com", "custom_domain": true }';
control('the domain only in the dashboard (not declared)', 'D1 fluxsparta.com', rep(DOM, '    { "pattern": "example.com", "custom_domain": true }'));
control('www attached as a second copy of the site', 'D1 ...and it is the only route', rep(DOM, DOM + ',\n    { "pattern": "www.fluxsparta.com", "custom_domain": true }'));
control('a zone wildcard route', 'D1 ...and it is the only route', rep(DOM, DOM + ',\n    { "pattern": "fluxsparta.com/*", "zone_name": "fluxsparta.com" }'));
control('workers.dev switched off', 'D2', rep('  "workers_dev": true,\n', '  "workers_dev": false,\n'));
control('workers.dev left to the default', 'D2', rep('  "workers_dev": true,\n', ''));
control('every file runs the Worker', 'D3 free plan', rep('"/api/*"\n    ],', '"/api/*", "/*"\n    ],'));
control('SITE_URL moved already', 'D3 SITE_URL', rep('"SITE_URL": "' + OLD + '"', '"SITE_URL": "https://fluxsparta.com"'));
control('a new Durable Object migration', 'D3 same Worker', rep('"tag": "v1",', '"tag": "v2",'));
const total = res.F + NC;
console.log('\n' + (total ? 'CUSTOM DOMAIN FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'CUSTOM DOMAIN PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
