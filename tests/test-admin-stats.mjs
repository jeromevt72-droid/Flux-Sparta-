// Admin tool: search with the new name rules, the PLAYER STATS dashboard, the guide. In the release gate.
//   A1 a preset name is found, in any case and with extra spaces;
//   A2 "NAME #TAG" finds exactly that pilot; "#TAG" alone works;
//   A3 a typed one-word name is found;
//   A4 a banned name is found by its real name AND by "PILOT" (what the board shows), and says SHOWN AS PILOT;
//   A5 an old name deleted by the clean-up is no longer findable; the pilot is found by its preset;
//   D1 the dashboard turns the server's totals into the right numbers (runs per player, average
//      run, level, share rate, Day 1/7/30 by src and by country; "—" before a day is reached);
//   D2 it lives inside admin.html (same password, no separate page), uses the admin API, writes text only;
//   D3 GAMEPLAY table: by difficulty x speed step, hit rate, misses per minute, time at
//      the step (share of that difficulty's play time), lives lost per minute, runs;
//      only difficulty/step keys, nothing about a person; drawn as text in PLAYER STATS;
//   G1 the guide covers the lost-pilot steps, the name rules and how to read the stats;
//   G3 ...and how to remove a test pilot safely, Remove vs Restrict vs Privacy delete, and how to undo it;
//   G2 ...and how to read GAMEPLAY for tuning the speed.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { presetNameForId } from './preset-names.mjs';
import { levelFor } from './level-rule.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', DAY = 86400000, T0 = Date.parse('2026-10-01T12:00:00Z'), H = { 'x-admin-token': 'pw' };
const P = (n) => '0000000' + n + '-aaaa-4bbb-8ccc-00000000000' + n;

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { if (typeof k === 'object') { for (const [kk, vv] of Object.entries(k)) this.map.set(kk, structuredClone(vv)); } else this.map.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
}
function makeEnv(LeaderboardDO) {
  const instances = new Map(); let chain = Promise.resolve();
  return { ADMIN_TOKEN: 'pw', LEADERBOARD_DO: { idFromName: (n) => n, _instances: instances, get(id) {
    if (!instances.has(id)) instances.set(id, new LeaderboardDO({ storage: new FakeStorage(), blockConcurrencyWhile: (fn) => fn() }));
    const o = instances.get(id);
    return { fetch(url, init) { const run = () => o.fetch(new Request(url, init)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } }; } } };
}

async function suite({ adminHtml, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
  const call = async (p, body, headers = {}) => { const res = await worker.fetch(new Request(ORIGIN + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }), env, {}); let d = null; try { d = await res.json(); } catch (e) {} return { status: res.status, data: d }; };
  const submit = (pid, name, score, country = 'PH') => call('/api/submit-score', { playerId: pid, name, score, level: levelFor(score, 'easy'), difficulty: 'easy', country, season: 1 })   // SEASON 1: scores say their season;
  const find = async (q) => ((await call('/api/admin/find-player', { query: q }, H)).data || {}).matches || [];
  try {
    await submit(P(1), 'SWIFT COMET 42', 400); await submit(P(2), 'titan', 300); await submit(P(3), 'NOVA7', 200);
    // A pilot whose old typed name was stored before the name rules: the clean-up switches it once.
    const lb = env.LEADERBOARD_DO._instances.get('global'); const stored = await lb.state.storage.get('players');
    stored[P(4)] = { playerId: P(4), name: 'JOHN SMITH', country: 'US', score: 100, level: 1, difficulty: 'easy' };
    await lb.state.storage.put({ players: stored, nameRulesV1: 0 }); lb.ready = false;
    await call('/api/admin/name-ban', { name: 'NOVA7' }, H);
    const a1 = await find('swift  comet 42');
    ck('A1 a preset name is found in lower case with extra spaces', a1.length === 1 && a1[0].name === 'SWIFT COMET 42', a1.map((m) => m.name).join(','));
    const tag = a1[0] && a1[0].tag, a2 = await find('SWIFT COMET 42 #' + String(tag).slice(0, 4)), a2b = await find('#' + tag);
    ck('A2 "NAME #TAG" finds exactly that pilot, and "#TAG" alone works', a2.length === 1 && a2[0].tag === tag && a2b.length === 1, tag);
    const a3 = await find('Titan');
    ck('A3 a typed one-word name is found', a3.length === 1 && a3[0].name === 'TITAN');
    const a4 = await find('NOVA7'), a4b = await find('PILOT');
    ck('A4 a banned name is found by its real name and by PILOT (what the board shows), marked SHOWN AS PILOT',
      a4.length === 1 && a4[0].shownAs === 'PILOT' && a4b.some((m) => m.name === 'NOVA7'), JSON.stringify(a4.map((m) => [m.name, m.shownAs])));
    const a5 = await find('JOHN SMITH'), a5b = await find(presetNameForId(P(4)));
    ck('A5 an old name deleted by the clean-up is not findable; the pilot is found by its preset', a5.length === 0 && a5b.length === 1, presetNameForId(P(4)));
  } catch (e) { ck('search section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    // A real stats report from the real worker: 2 TikTok pilots (PH), 1 direct (JP) on day 0; TikTok ones return on day 1, one on day 7.
    let now = T0; await call('/api/admin/analytics', {}, H); env.LEADERBOARD_DO._instances.get('analytics').nowMs = () => now;
    const ev = (pid, events, src, country) => call('/api/events', { pid, events, src, country });
    await ev(P(5), [{ e: 'open' }, { e: 'run_end', sec: 60, lvl: 2, diff: 'easy' }, { e: 'share' }], 'tiktok', 'PH');
    await ev(P(6), [{ e: 'open' }, { e: 'run_end', sec: 120, lvl: 4, diff: 'easy' }, { e: 'run_end', sec: 60, lvl: 3, diff: 'easy' }], 'tiktok', 'PH');
    await ev(P(7), [{ e: 'open' }, { e: 'run_end', sec: 30, lvl: 1, diff: 'easy' }], 'direct', 'JP');
    await ev(P(5), [{ e: 'play', diff: 'easy', st: 0, sec: 120, hit: 60, wrong: 20, lost: 2 }, { e: 'play', diff: 'easy', st: 1, sec: 60, hit: 20, wrong: 20, lost: 2 }], 'tiktok', 'PH');
    await ev(P(6), [{ e: 'play', diff: 'hard', st: 0, sec: 30, hit: 10, wrong: 10, lost: 3 }], 'tiktok', 'PH');
    now = T0 + DAY; await ev(P(5), [{ e: 'open' }], 'tiktok', 'PH'); await ev(P(6), [{ e: 'open' }], 'tiktok', 'PH');
    now = T0 + 7 * DAY; await ev(P(5), [{ e: 'open' }], 'tiktok', 'PH');
    const rep = (await call('/api/admin/analytics', { from: '2026-10-01', to: '2026-10-08' }, H)).data;
    const { store } = makeStore({});
    const g = boot(scriptsOf(adminHtml), { origin: ORIGIN, path: '/admin.html', store });
    const S = g.win.FLUX_ADMIN_STATS || vm.runInContext('typeof FLUX_ADMIN_STATS!=="undefined"?FLUX_ADMIN_STATS:null', g.ctx);
    const all = S.summarize(rep, 'all').groups[0], day0 = all.daily.find((d) => d.date === '2026-10-01');
    ck('D1 everyone: 3 active and 3 new on day 0, 4 runs = 1.3 runs/player, average run 67.5 s, average level 2.5, share rate 1 in 4',
      day0.active === 3 && day0['new'] === 3 && Math.abs(day0.runs / day0.active - 4 / 3) < 1e-9 && all.avgRunSec === 67.5 && all.avgLevel === 2.5 && all.shareRate === 0.25, JSON.stringify(day0));
    const bySrc = S.summarize(rep, 'src').groups, tk = bySrc.find((x) => x.key === 's:tiktok'), dr = bySrc.find((x) => x.key === 's:direct');
    ck('D1 by source: TikTok players came back 100% on day 1 and 50% on day 7; direct 0%; Day 30 not reached yet ("—")',
      tk && dr && tk.day1 === 1 && tk.day7 === 0.5 && dr.day1 === 0 && dr.day7 === 0 && isNaN(tk.day30) && tk.cohorts[0].d30 === '—', JSON.stringify([tk && [tk.day1, tk.day7], dr && [dr.day1, dr.day7]]));
    const byC = S.summarize(rep, 'country').groups.map((x) => x.key).join(',');
    ck('D1 by country: one row per country', byC === 'c:JP,c:PH', byC);
    ck('D2 the dashboard is inside the admin page (same password), not a separate page, and uses the admin API',
      /<h2>PLAYER STATS<\/h2>/.test(adminHtml) && /await call\('analytics', \{ from:/.test(adminHtml) && !fs.existsSync(path.join(ROOT, 'public', 'stats.html')) && !fs.existsSync(path.join(ROOT, 'public', 'dashboard.html')));
    const P3 = S.summarizePlay ? S.summarizePlay(rep).rows : [];
    const pr = P3.map((c) => [c.diff, c.step, c.runs, +c.hitRate.toFixed(3), +c.missesPerMin.toFixed(3), +c.livesPerMin.toFixed(3), +c.timeShare.toFixed(3)].join(':')).join(' ');
    ck('D3 GAMEPLAY: Easy step 0 hit rate 75%, 11 misses/min, 1 life/min, 67% of Easy time; step 1 50%, 22/min, 2/min, 33%; Hard step 0 50%, 26/min, 6/min, 100%',
      pr === 'easy:0:1:0.75:11:1:0.667 easy:1:1:0.5:22:2:0.333 hard:0:1:0.5:26:6:1', pr);
    ck('D3 ...the server keeps it only by difficulty and step (no country or source rows), and PLAYER STATS draws it as a GAMEPLAY table',
      rep.days.every((d) => Object.keys(d.groups).every((k) => !/^p:/.test(k) || /^p:(easy|medium|hard):\d$/.test(k))) && /box\.appendChild\(el\('h2', null, 'GAMEPLAY'\)\)/.test(adminHtml)
      && /\['Difficulty', 'Speed step', 'Runs', 'Time at step', 'Hit rate', 'Misses \/ min', 'Lives lost \/ min'\]/.test(adminHtml) && S.summarize(rep, 'country').groups.every((g) => !/^p:/.test(g.key)));
    const js = scriptsOf(adminHtml).join('\n'), statsJs = js.slice(js.indexOf('/* ---------------- player stats'), js.indexOf('function guard('));
    ck('D2 the stats code writes text only (no innerHTML) and loads nothing from other sites', statsJs.length > 500 && !/innerHTML/.test(statsJs) && !/<script[^>]+src=/.test(adminHtml));
    ck('D2 averages already worked out are shown as numbers (never passed to the two-number ratio helper, which would show "—")', /\[num\(g\.runsPerPlayer\), 'runs \/ player \/ day'\]/.test(adminHtml) && !/ratio\(g\./.test(adminHtml));
    const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'), adminHtml.indexOf('<details id="advanced">'));
    ck('G1 the guide covers lost pilots (find, check, issue a code, where they paste it), the name rules (presets, one word, PILOT, clean-up) and the stats (what each number means, which platform keeps players)',
      /A player lost their pilot/.test(guide) && /ISSUE RESTORE CODE/.test(guide) && /HAVE A RESTORE CODE\?/.test(guide) && /RESTORE A DIFFERENT PILOT/.test(guide)
      && /preset name/.test(guide) && /one word/.test(guide) && /<b>PILOT<\/b>/.test(guide) && /Old-name clean-up/.test(guide)
      && /Day 1 \/ Day 7 \/ Day 30/.test(guide) && /Which platform brings players who come back/.test(guide) && /\?src=tiktok/.test(guide));
    ck('G2 the guide says how to read GAMEPLAY for tuning (hit rate, misses and lives lost per minute, time at each step, what a jump means)',
      /Reading GAMEPLAY/.test(guide) && /Hit rate/.test(guide) && /Lives lost \/ min/.test(guide) && /Time at step/.test(guide) && /too big a jump/.test(guide) && /nothing about a person/.test(guide));
    ck('G3 the guide says how to remove a test pilot (backup first, exact name + #TAG, REMOVE SCORE, check), Remove vs Restrict vs Privacy delete, Season 0 scores, and how to undo with a backup',
      /Removing test pilots/.test(guide) && /BACK UP NOW/.test(guide) && /TITAN #QGAC1ZN/.test(guide) && /REMOVE SCORE/.test(guide) && /UNRESTRICT/.test(guide)
      && /PRIVACY DELETE/.test(guide) && /Season 0 bests leave the boards/.test(guide) && /RESTORE NOW/.test(guide) && /Never act on a card whose #TAG you did not type/.test(guide));
  } catch (e) { ck('dashboard section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ adminHtml: ADMIN_HTML, workerMod: realMod });
console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { admin = (s) => s, worker = (s) => s }) {
  const a2 = admin(ADMIN_HTML), w2 = worker(WORKER_SRC);
  if (a2 === ADMIN_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-admin-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const r = await suite({ adminHtml: a2, workerMod: await import(pathToFileURL(tmp).href), quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('extra spaces break the search', 'A1', { worker: rep('.toUpperCase().replace(/\\s+/g, " ").trim();', '.toUpperCase().trim();') });
await control('search ignores what the board shows', 'A4', { worker: rep('v.name.includes(n) || String(v.shownAs || "").includes(n)', 'v.name.includes(n)') });
await control('share rate per player instead of per run', 'D1', { admin: rep('shareRate: t.runs ? t.shares / t.runs : NaN', 'shareRate: t.active ? t.shares / t.active : NaN') });
await control('retention counted before the day is reached', 'D1', { admin: rep("d30: c.age >= 30 ? pct(v.d30 || 0, v.n) : '—'", "d30: pct(v.d30 || 0, v.n)") });
await control('hit rate counts lost balls as hits tried', 'D3', { admin: rep('c.hitRate = (c.hit + c.wrong) ? c.hit / (c.hit + c.wrong) : NaN;', 'c.hitRate = (c.hit + c.wrong + c.lost) ? c.hit / (c.hit + c.wrong + c.lost) : NaN;') });
await control('time share over all difficulties', 'D3', { admin: rep('c.timeShare = perDiff[c.diff] ? c.sec / perDiff[c.diff] : NaN;', 'c.timeShare = c.sec / 210;') });
await control('GAMEPLAY table not drawn', 'D3', { admin: rep("box.appendChild(el('h2', null, 'GAMEPLAY'));", '') });
await control('guide loses the test-pilot removal steps', 'G3', { admin: rep('<h3>Removing test pilots (and what to do about a cheater)</h3>', '<h3>Test pilots</h3>') });
await control('guide loses the GAMEPLAY note', 'G2', { admin: rep('<h3>Reading GAMEPLAY (tuning the speed)</h3>', '<h3>Gameplay</h3>') });
await control('averages shown as "—"', 'D2 averages', { admin: rep('[num(g.runsPerPlayer), ', '[ratio(g.runsPerPlayer), ') });
await control('guide loses the name rules', 'G1', { admin: rep('<h3>Pilot names</h3>', '<h3>Names</h3>').bind(null) && ((s) => s.replace('Old-name clean-up', 'Clean-up')) });
const total = main.F + NC;
console.log('\n' + (total ? 'ADMIN STATS FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'ADMIN STATS PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
