// FIRST-RUN MEASURE (owner, measurement only). Real worker, real game page, real Gateway head script.
//   S1 server: "open" carries a yes/no in-app-browser flag (iab); a new pilot whose first batch was opened in an
//      app's built-in browser adds to newIab (once), and their first run to firstIab; old pages (no flag) and
//      junk count as other browsers;
//   S2 ...by source too, never the app's name, nothing about a person;
//   O1 owner summary: "new players who never start a run" and the report split the first-run rate into in-app
//      browsers and other browsers; groups under 5 show no numbers;
//   C1 game: "open" says yes/no whether FLUX was opened in an app's built-in browser (never which app);
//   C2 game: hidden once, back, first run started, closed mid-run -> the first run is still sent (one extra
//      hidden send); an open-then-play-then-close page still sends once;
//   C3 ...the extra send happens only while a first run waits, once per page load at most;
//   G1 Gateway: every PLAY path keeps a valid ?src= tag on the way to /play/; bad tags are dropped; the game URL
//      constant itself is unchanged.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const GW_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', T0 = Date.parse('2026-10-01T12:00:00Z'), H = { 'x-admin-token': 'pw' };
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

async function suite({ gameHtml, gwHtml, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };

  // ---------------- server ----------------
  try {
    const worker = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
    const call = async (p, body, headers = {}) => { const res = await worker.fetch(new Request(ORIGIN + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }), env, {}); let d = null; try { d = await res.json(); } catch (e) {} return { status: res.status, data: d }; };
    await call('/api/admin/analytics', {}, H); const an = env.LEADERBOARD_DO._instances.get('analytics'); an.nowMs = () => T0;
    const ev = (pid, events, src) => call('/api/events', { pid, events, src, country: 'PH' });
    await ev(P(1), [{ e: 'open', home: false, iab: true }], 'tiktok');                 // in TikTok, left before playing
    await ev(P(1), [{ e: 'open', home: false, iab: true }, { e: 'first_run' }], 'tiktok');   // came back and played
    await ev(P(2), [{ e: 'open', home: false, iab: false }, { e: 'first_run' }], 'tiktok');  // real browser, played
    await ev(P(3), [{ e: 'open', home: false }], 'direct');                             // an old page: no flag
    await ev(P(4), [{ e: 'open', iab: 'TikTok' }], 'direct');                           // junk flag
    await ev(P(5), [{ e: 'first_run' }, { e: 'open', iab: true }], 'instagram');         // in Instagram, played at once
    const g = (await call('/api/admin/analytics', { from: '2026-10-01', to: '2026-10-01' }, H)).data.days[0].groups;
    const a = g.all || {}, tk = g['s:tiktok'] || {}, ig = g['s:instagram'] || {}, dr = g['s:direct'] || {};
    ck('S1 5 new players, 3 first runs; 2 opened in an in-app browser (counted once each), both of whom played',
      a.new === 5 && a.first === 3 && a.newIab === 2 && a.firstIab === 2 && a.opens === 6, JSON.stringify(a));
    ck('S1 ...old pages (no flag) and a junk flag count as other browsers', !dr.newIab && dr.new === 2 && !dr.firstIab, JSON.stringify(dr));
    ck('S2 ...by source: TikTok 2 new (1 in-app), Instagram 1 new (in-app)', tk.new === 2 && tk.newIab === 1 && tk.firstIab === 1 && tk.first === 2 && ig.new === 1 && ig.newIab === 1 && ig.firstIab === 1, JSON.stringify([tk, ig]));
    const raw = JSON.stringify([...an.state.storage.map.entries()]);
    ck('S2 ...the app\'s name and the pilot IDs are never stored', !/TikTok|Instagram/.test(raw) && !raw.includes(P(1)) && !raw.includes(P(5)));
  } catch (e) { ck('server section ran', false, String(e.stack || e).slice(0, 300)); }

  // ---------------- owner summary ----------------
  try {
    const run = workerMod.LeaderboardDO.ownerInsights;
    const rep = (all) => ({ today: '2026-10-20', days: [{ date: '2026-10-19', groups: { all } }], cohorts: [] });
    const r = run(rep({ active: 60, new: 40, first: 16, newIab: 20, firstIab: 4, opens: 60, runs: 30 }), {});
    const f = r.findings.find((x) => x.id === 'FIRST_RUN_LOW') || {};
    ck('O1 the "never start a run" finding splits the rate: in-app browsers 20% of 20, other browsers 60% of 20',
      /40% of 40 new players/.test(f.measured || '') && /in-app browsers 20% of 20; other browsers 60% of 20/.test(f.measured || ''), f.measured);
    ck('O1 ...and so does the report\'s New players line', /started a first run: 40% \(in-app browsers 20% of 20; other browsers 60% of 20\)/.test(r.export), (r.export.match(/New players:[^\n]*/) || [''])[0]);
    const r2 = run(rep({ active: 60, new: 40, first: 10, newIab: 3, firstIab: 0, opens: 60, runs: 30 }), {});
    const f2 = r2.findings.find((x) => x.id === 'FIRST_RUN_LOW') || {};
    ck('O1 ...a group under 5 shows no numbers', /in-app browsers fewer than 5 new players; other browsers 27% of 37/.test(f2.measured || ''), f2.measured);
  } catch (e) { ck('owner summary section ran', false, String(e.stack || e).slice(0, 300)); }

  // ---------------- game ----------------
  try {
    const bootGame = (init = {}) => {
      const { store } = makeStore(Object.assign({ fluxPlayerId: 'frm-pilot-1', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: '0', fluxDifficulty: 'easy' }, init));
      const g = boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store });
      g.ctx.Blob = Blob; const beacons = []; g.win.navigator.sendBeacon = (u, b) => { beacons.push(b); return true; };
      const run = (c) => vm.runInContext(c, g.ctx);
      const sent = async () => { const out = []; for (const b of beacons) { try { out.push(JSON.parse(await b.text()).events.map((e) => e.e).join(',')); } catch (e) {} } return out; };
      const raw = async () => { const out = []; for (const b of beacons) out.push(await b.text()); return out.join('\n'); };
      const hide = (h) => { g.win.document.hidden = h; g.win.document.onvisibilitychange(); };
      return { g, run, sent, raw, hide, beacons };
    };
    const t = bootGame(); t.g.ctx.FLUX_IN_APP = 'TikTok'; t.hide(true);
    const tb = await t.raw(), tOpen = (JSON.parse(tb || '{"events":[]}').events || []).find((e) => e.e === 'open') || {};
    const o = bootGame(); o.g.ctx.FLUX_IN_APP = null; o.hide(true);
    const oOpen = (JSON.parse((await o.raw()) || '{"events":[]}').events || []).find((e) => e.e === 'open') || {};
    ck('C1 "open" says whether FLUX was opened in an app\'s built-in browser (yes in TikTok, no in a normal browser), never which app',
      tOpen.iab === true && oOpen.iab === false && !/TikTok/.test(tb), JSON.stringify([tOpen, oOpen]));
    const c = bootGame(); c.hide(true); c.hide(false); c.g.ctx.newGame(); c.hide(true);
    const cs = await c.sent();
    ck('C2 hidden once, back, first run started, closed mid-run: the first run is still sent (a second hidden send)', cs.length === 2 && /first_run/.test(cs[1]), JSON.stringify(cs));
    const b = bootGame(); b.g.ctx.newGame(); b.hide(true); b.hide(false); b.hide(true);
    const bs = await b.sent();
    ck('C2 ...opened, played, closed: one send as before (the first run went with it)', bs.length === 1 && /open,first_run/.test(bs[0]), JSON.stringify(bs));
    const n = bootGame({ fluxRunsPlayed: '3' }); n.hide(true); n.hide(false); n.run('fluxTrack("share");'); n.hide(true); n.hide(false); n.g.ctx.newGame(); n.hide(true);
    const ns = await n.sent();
    ck('C3 no first run waiting: still one hidden send per page load', ns.length === 1, JSON.stringify(ns));
    const m = bootGame(); m.hide(true); m.hide(false); m.g.ctx.newGame(); m.hide(true); m.hide(false); m.run('fluxTrack("first_run");'); m.hide(true);   // a first run waiting again (by hand): no third send
    const ms = await m.sent();
    ck('C3 ...and the extra send happens once at most', ms.length === 2, JSON.stringify(ms));
  } catch (e) { ck('game section ran', false, String(e.stack || e).slice(0, 300)); }

  // ---------------- Gateway ----------------
  try {
    const head = scriptsOf(gwHtml).find((s) => s.includes('window.FLUX_GAME_URL = window.location.origin')) || '';
    const link = (search) => { const w = { location: { origin: ORIGIN, search }, URLSearchParams, navigator: {}, document: { addEventListener() {} }, addEventListener() {} }; w.window = w; vm.runInNewContext(head, w); return [w.FLUX_GAME_URL, w.FLUX_GAME_LINK]; };
    const cases = [['?src=tiktok', ORIGIN + '/play/?src=tiktok'], ['?src=Instagram&x=1', ORIGIN + '/play/?src=instagram'], ['?src=%3Cscript%3E', ORIGIN + '/play/'], ['', ORIGIN + '/play/']];
    const got = cases.map(([s]) => link(s));
    ck('G1 the Gateway keeps a valid ?src= on the way to /play/ (lower case, nothing else), drops a bad one; the game URL constant is unchanged',
      got.every(([u, l], i) => u === ORIGIN + '/play/' && l === cases[i][1]), JSON.stringify(got.map((x) => x[1])));
    const nav = (gwHtml.match(/window\.location\.href = window\.FLUX_GAME_[A-Z]+;/g) || []);
    ck('G1 ...every PLAY path uses it: the PLAY buttons, the grid button and all three top-level navigations',
      nav.length === 3 && nav.every((x) => x.includes('FLUX_GAME_LINK')) && gwHtml.includes("a.href = window.FLUX_GAME_LINK;") && gwHtml.includes("href=\"'+window.FLUX_GAME_LINK+'\""), nav.join(' '));
  } catch (e) { ck('gateway section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const t0 = Date.now();
const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const res = await suite({ gameHtml: GAME_HTML, gwHtml: GW_HTML, workerMod: realMod });
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
async function control(label, expect, { game = (s) => s, gw = (s) => s, worker = (s) => s }) {
  const g2 = game(GAME_HTML), gw2 = gw(GW_HTML), w2 = worker(WORKER_SRC);
  if (g2 === GAME_HTML && gw2 === GW_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-frm-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const r = await suite({ gameHtml: g2, gwHtml: gw2, workerMod: await import(pathToFileURL(tmp).href), quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
await control('server drops the in-app flag', 'S1', { worker: rep('out.iab = e.iab === true;', 'out.iab = false;') });
await control('a returning in-app pilot counted again', 'S1', { worker: rep('    if (isNew) {\n      anAdd(day, groups, "new", 1);', '    if (true) {\n      if (isNew) anAdd(day, groups, "new", 1);') });
await control('in-app first runs not split', 'S1', { worker: rep('if (p.ia) anAdd(day, groups, "firstIab", 1);', '') });
await control('a junk flag counted as in-app', 'S1 ...old pages', { worker: rep('out.iab = e.iab === true;', 'out.iab = !!e.iab;') });
await control('the split left out of the finding', 'O1 the', { worker: rep(' + "). Split: " + oiFirstSplit(t) + "." }];', ' + ")." }];') });
await control('small groups shown with numbers', 'O1 ...a group', { worker: rep('(n >= OI_SMALL ? oiPct', '(n >= 0 ? oiPct') });
await control('the app\'s name sent instead of yes/no', 'C1', { game: rep("e.iab=!!window.FLUX_IN_APP;", "e.iab=window.FLUX_IN_APP||false;") });
await control('no extra hidden send for a waiting first run', 'C2', { game: rep("else if(!hideFirstSent && fluxStatsQueue.some(function(e){ return e.e==='first_run'; })){ hideFirstSent=true; fluxStatsFlush(); }", '') });
await control('extra hidden sends without a first run waiting', 'C3', { game: rep("else if(!hideFirstSent && fluxStatsQueue.some(function(e){ return e.e==='first_run'; }))", 'else if(!hideFirstSent)') });
await control('extra hidden send not limited to once', 'C3 ...and', { game: rep("else if(!hideFirstSent && fluxStatsQueue.some(", "else if(fluxStatsQueue.some(") });
await control('Gateway drops ?src= again', 'G1 the', { gw: rep("? window.FLUX_GAME_URL + '?src=' + s : window.FLUX_GAME_URL;", "? window.FLUX_GAME_URL : window.FLUX_GAME_URL;") });
await control('Gateway passes any tag through', 'G1 the', { gw: rep("return /^[a-z0-9_-]{1,24}$/.test(s) ? ", "return s ? ") });
await control('one PLAY path still drops ?src=', 'G1 ...every', { gw: rep("a.href = window.FLUX_GAME_LINK;", "a.href = window.FLUX_GAME_URL;") });
const total = res.F + NC;
console.log('\n' + (total ? 'FIRST-RUN MEASURE FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'FIRST-RUN MEASURE PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
