// DAY-1 REPORT (owner, FLUX COMMAND): new pilots one by one, read-only. In the release gate.
// Server (REAL worker.js, fake Durable Object runtime):
//   R1 "open" carries the kind of phone ('ios' / 'android' / 'other'); anything else becomes 'other',
//      and an "open" without it stays as before (no field);
//   R2 the report lists every pilot who STARTED in the window, with country, src, how FLUX was opened
//      (Home Screen app / browser tab / an app's built-in browser), phone, first-run difficulty;
//   R3 run length is REAL play time (the "play" seconds after each game over), never the clock time
//      between start and game over; the first run uses "fs" (seconds survived);
//   R4 runs on the first day; came back on day 1 = the same mark the totals use; a pilot whose
//      day 1 is not over shows "not over" (null), not "no";
//   R5 the default window is the owner summary's day-1 window (today-30 .. today-2);
//   R6 the report needs the admin password and writes nothing;
//   R7 the owner marks a device from a FIND A PLAYER result (pid): the stats instance keeps only the
//      one-way STATS code + the owner's label (never the raw player ID); the marked pilot is flagged
//      and can be unmarked; a bad or unknown pid is refused; marking needs the admin password;
// Game page:
//   G1 the app-open event carries fluxOsKind(): iPhone/iPad (incl. iPadOS "Macintosh" + touch) -> ios,
//      Android -> android, anything else -> other; nothing else about the device is sent;
// Admin page + privacy page:
//   A1 FLUX COMMAND has the DAY-1 BY PILOT section, MARK AS MY DEVICE on a found pilot, UNMARK, the
//      groups the owner asked for, a guide entry; the privacy page says what is recorded and shown.
// Ends with negative controls: each defect re-inserted MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { levelFor } from './level-rule.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const PRIVACY_HTML = fs.readFileSync(path.join(ROOT, 'public', 'privacy.html'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.example.dev', DAY = 86400000, T0 = Date.parse('2026-10-01T12:00:00Z');
const A = 'aaaaaaaa-1111-4bbb-8ccc-000000000001', B = 'bbbbbbbb-1111-4bbb-8ccc-000000000002', C = 'cccccccc-1111-4bbb-8ccc-000000000003';
const MINE = 'dddddddd-1111-4bbb-8ccc-000000000004', LATE = 'eeeeeeee-1111-4bbb-8ccc-000000000005', OLD = 'ffffffff-1111-4bbb-8ccc-000000000006';

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { if (typeof k === 'object') { for (const [kk, vv] of Object.entries(k)) this.map.set(kk, structuredClone(vv)); } else this.map.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
}
function makeEnv(LeaderboardDO) {
  const instances = new Map(); let chain = Promise.resolve();
  return { LEADERBOARD_DO: { idFromName: (n) => n, _instances: instances, get(id) {
    if (!instances.has(id)) instances.set(id, new LeaderboardDO({ storage: new FakeStorage(), blockConcurrencyWhile: (fn) => fn() }));
    const o = instances.get(id);
    return { fetch(url, init) { const run = () => o.fetch(new Request(url, init)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } }; } },
    ADMIN_TOKEN: 'secret-admin', STORE_OPEN: 'false' };
}
const statsCode = async (id) => { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('flux-stats:' + id)); return Array.from(new Uint8Array(b)).slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join(''); };

async function suite({ workerMod, gameHtml, adminHtml, privacyHtml, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
  let now = T0;
  const realNow = Date.now; Date.now = () => now;   // the score upload's cooldowns and the stats day follow the test clock
  const call = async (p, { method = 'POST', body, admin = false, cf } = {}) => {
    const headers = { 'Content-Type': 'application/json' }; if (admin) headers['x-admin-token'] = 'secret-admin';
    const r = new Request(ORIGIN + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (cf) Object.defineProperty(r, 'cf', { value: cf });
    const res = await worker.fetch(r, env, { waitUntil() {} }); let data = null; try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
  const send = (pid, events, extra = {}) => call('/api/events', { body: { pid, events, ...extra }, cf: { country: 'PH' } });
  const inst = () => env.LEADERBOARD_DO._instances.get('analytics');
  const day1 = (body = {}) => call('/api/admin/day1', { body, admin: true });
  const row = (rep, id) => statsCode(id).then((h) => (rep.rows || []).find((r) => r.code === h));
  try {
    await call('/api/admin/analytics', { body: {}, admin: true });   // creates the stats instance
    inst().nowMs = () => now;
    // ---- day 0 (2026-10-01)
    await send(A, [{ e: 'open', home: false, iab: false, os: 'android' }, { e: 'first_run' }], { country: 'PH', src: 'tiktok' });
    // A's first run: 9,999 s on the clock (left paused in the background), 42 s of real play; then 2 more runs.
    await send(A, [{ e: 'run_end', sec: 7000, lvl: 1, diff: 'easy', st: 0, bad: 0, fs: 42 }, { e: 'play', diff: 'easy', st: 0, sec: 30, hit: 5, wrong: 1, lost: 1 }, { e: 'play', diff: 'easy', st: 1, sec: 12, hit: 2, wrong: 0, lost: 2 },
      { e: 'run_end', sec: 600, lvl: 2, diff: 'easy', st: 1, bad: 0 }, { e: 'play', diff: 'easy', st: 0, sec: 50, hit: 9, wrong: 0, lost: 1 }, { e: 'play', diff: 'easy', st: 1, sec: 40, hit: 7, wrong: 1, lost: 2 },
      { e: 'run_end', sec: 300, lvl: 1, diff: 'easy', st: 0, bad: 1 }, { e: 'play', diff: 'easy', st: 0, sec: 18, hit: 3, wrong: 2, lost: 3 }], { country: 'PH', src: 'tiktok' });
    await send(B, [{ e: 'open', home: true, iab: false, os: 'ios' }, { e: 'first_run' }, { e: 'run_end', sec: 95, lvl: 1, diff: 'medium', st: 1, bad: 0, fs: 80 },
      { e: 'play', diff: 'medium', st: 0, sec: 50, hit: 4, wrong: 0, lost: 1 }, { e: 'play', diff: 'medium', st: 1, sec: 30, hit: 3, wrong: 0, lost: 2 }], { country: 'US', src: 'direct' });
    await send(C, [{ e: 'open', home: false, iab: true, os: 'windows-phone' }], { country: 'PH', src: 'facebook' });   // in-app browser, never started
    await send(OLD, [{ e: 'open', home: false }], { country: 'JP', src: 'share' });   // an older page: no os field
    // The owner's own device: a pilot on the board (named, uploads a score) that also sends stats.
    await call('/api/submit-score', { body: { season: 1, playerId: MINE, name: 'OWNERTEST', country: 'US', score: 3000, level: levelFor(3000, 'medium'), difficulty: 'medium' }, cf: { country: 'US' } });
    await send(MINE, [{ e: 'open', home: true, os: 'ios' }, { e: 'first_run' }, { e: 'run_end', sec: 20, lvl: 1, diff: 'hard', st: 0, bad: 0, fs: 15 }], { country: 'US', src: 'direct' });
    const raw = JSON.stringify([...inst().state.storage.map.entries()]);
    ck('R1 open carries the phone kind: android / ios kept, an unknown value becomes "other", an old page sends none',
      raw.includes('"os":"android"') && raw.includes('"os":"ios"') && raw.includes('"os":"other"') && !raw.includes('windows-phone'));
    // ---- day 1: A and the owner's device come back; B does not
    now = T0 + DAY;
    await send(A, [{ e: 'open', home: false, os: 'android' }], { country: 'PH' });
    await send(MINE, [{ e: 'open', home: true, os: 'ios' }], { country: 'US' });
    // ---- day 2: LATE starts (day 1 not over when the report is read on day 3)
    now = T0 + 2 * DAY;
    await send(LATE, [{ e: 'open', home: false, os: 'android' }, { e: 'first_run' }], { country: 'PH', src: 'tiktok' });
    now = T0 + 3 * DAY;

    const noPw = await call('/api/admin/day1', { body: {} });
    ck('R6 the report needs the admin password', noPw.status === 401 || noPw.status === 403, String(noPw.status));
    const before = JSON.stringify([...inst().state.storage.map.entries()]);
    let rep = (await day1({ from: '2026-09-20', to: '2026-10-03' })).data || {};
    const after = JSON.stringify([...inst().state.storage.map.entries()]);
    ck('R6 reading the report writes nothing', before === after);
    const a = await row(rep, A), b = await row(rep, B), c = await row(rep, C), o = await row(rep, OLD), m = await row(rep, MINE), l = await row(rep, LATE);
    ck('R2 every pilot who started in the window is listed (6)', rep.ok === true && (rep.rows || []).length === 6, String((rep.rows || []).length));
    ck('R2 country, src, opened in, phone',
      a && a.country === 'PH' && a.src === 'tiktok' && a.openedIn === 'browser' && a.os === 'android' &&
      b && b.country === 'US' && b.openedIn === 'home' && b.os === 'ios' &&
      c && c.openedIn === 'inapp' && c.os === 'other' && o && o.os === 'unknown' && o.country === 'JP', JSON.stringify([a, c, o]));
    ck('R2 first-run difficulty; a pilot who never started a run says so', a.firstDiff === 'easy' && b.firstDiff === 'medium' && c.started === false && c.firstDiff === null);
    ck('R3 first run = real seconds survived (42), not the 7,000 s on the clock', a.firstSec === 42, String(a.firstSec));
    ck('R3 run length is real play time: A played 42 + 90 + 18 = 150 s over 3 runs (avg 50 s)', a.playSec === 150 && a.avgRunSec === 50, a.playSec + ' / ' + a.avgRunSec);
    ck('R4 runs on the first day (A 3, B 1, C 0)', a.runs === 3 && b.runs === 1 && c.runs === 0);
    ck('R4 came back on day 1: A yes, B no; LATE: day 1 not over (null)', a.back1 === true && b.back1 === false && l && l.back1 === null, JSON.stringify([a.back1, b.back1, l && l.back1]));
    // default window: today-30 .. today-2 (today = 2026-10-04)
    const def = (await day1({})).data || {};
    ck('R5 default window = the owner summary day-1 window (today-30 .. today-2)', def.from === '2026-09-04' && def.to === '2026-10-02', def.from + '..' + def.to);

    // ---- R7 mark the owner's device from FIND A PLAYER
    const found = (await call('/api/admin/find-player', { body: { query: 'OWNERTEST' }, admin: true })).data || {};
    const pid = ((found.matches || [])[0] || {}).pid;
    const noPwMark = await call('/api/admin/day1-mark', { body: { pid, label: 'my iPhone' } });
    ck('R7 marking needs the admin password', noPwMark.status === 401 || noPwMark.status === 403, String(noPwMark.status));
    const bad = await call('/api/admin/day1-mark', { body: { pid: 'nope', label: 'x' }, admin: true });
    const unknown = await call('/api/admin/day1-mark', { body: { pid: '0123456789abcdef', label: 'x' }, admin: true });
    ck('R7 a bad pid is refused (400), an unknown pid is not found (404)', bad.status === 400 && unknown.status === 404, bad.status + ' ' + unknown.status);
    const mark = await call('/api/admin/day1-mark', { body: { pid, label: 'my iPhone <b>' }, admin: true });
    const mineCode = await statsCode(MINE);
    ck('R7 marked by pid: the stats instance gets the one-way code + the label (markup removed)',
      mark.status === 200 && (mark.data.excluded || []).some((x) => x.code === mineCode && x.label === 'my iPhone b'), JSON.stringify(mark.data));
    const store = JSON.stringify([...inst().state.storage.map.entries()]);
    ck('R7 the raw player ID is never stored in the stats instance', !store.includes(MINE) && !store.includes(A));
    rep = (await day1({ from: '2026-09-20', to: '2026-10-03' })).data || {};
    const m2 = await row(rep, MINE), a2 = await row(rep, A);
    ck('R7 the marked pilot is flagged in the report; others are not', m2 && m2.excluded === true && a2 && a2.excluded === false && m && m.excluded === false);
    const un = await call('/api/admin/day1-unmark', { body: { code: mineCode }, admin: true });
    rep = (await day1({ from: '2026-09-20', to: '2026-10-03' })).data || {};
    ck('R7 unmark puts it back', un.status === 200 && (un.data.excluded || []).length === 0 && (await row(rep, MINE)).excluded === false);
  } catch (e) { ck('no exception', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
  finally { Date.now = realNow; }

  // ---- G1 the game page
  try {
    const fn = /function fluxOsKind\(\)\{[\s\S]*?\n\}/.exec(gameHtml);
    const kind = (ua, touch = 0) => { const sb = { navigator: { userAgent: ua, maxTouchPoints: touch } }; vm.createContext(sb); vm.runInContext(fn[0] + ';this.r=fluxOsKind();', sb); return sb.r; };
    ck('G1 phone kind: iPhone -> ios, iPadOS (Macintosh + touch) -> ios, Android -> android, a Mac / Windows -> other',
      !!fn && kind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)') === 'ios' && kind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5) === 'ios' &&
      kind('Mozilla/5.0 (Linux; Android 13; BLU G45)') === 'android' && kind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0) === 'other' && kind('Mozilla/5.0 (Windows NT 10.0)') === 'other');
    ck('G1 the app-open event carries it', /fluxTrack\('open',\{home:[^}]*,os:fluxOsKind\(\)\}\)/.test(gameHtml));
    ck('G1 only the kind leaves the page (no user agent, model or version is sent)', !/fluxTrack\([^)]*userAgent/.test(gameHtml) && !/os:navigator/.test(gameHtml));
  } catch (e) { ck('G1 no exception', false, String(e)); }

  // ---- A1 admin page + privacy page
  ck('A1 FLUX COMMAND: DAY-1 BY PILOT section, SHOW, report text, MARK AS MY DEVICE, UNMARK',
    adminHtml.includes('<h2>DAY-1 BY PILOT</h2>') && adminHtml.includes('id="d1Load"') && adminHtml.includes("call('day1',") &&
    adminHtml.includes("'MARK AS MY DEVICE'") && adminHtml.includes("call('day1-mark', { pid: m.pid") && adminHtml.includes("call('day1-unmark'"));
  ck('A1 the groups asked for: country, opened in, phone, first-run difficulty, first-run length, runs on the first day, src',
    ['COUNTRY (the flag they picked)', 'OPENED FLUX IN', "'PHONE'", 'FIRST-RUN DIFFICULTY', 'FIRST RUN LASTED (real play time)', 'RUNS ON THEIR FIRST DAY', 'WHERE THEY CAME FROM (src)'].every((t) => adminHtml.includes(t)));
  ck('A1 small groups are labelled "too few"; the guide explains the report', adminHtml.includes("' (too few)'") && adminHtml.includes('<h3>Day-1 by pilot</h3>'));
  ck('A1 privacy page: the kind of phone, and one line per one-way code for the first two days',
    /iPhone or iPad, an Android phone, or\s+something else/.test(privacyHtml) && /one line per\s+one-way code/.test(privacyHtml));
  return { F, failed };
}

const main = await suite({ workerMod: await import(pathToFileURL(path.join(ROOT, 'worker.js')).href), gameHtml: GAME_HTML, adminHtml: ADMIN_HTML, privacyHtml: PRIVACY_HTML });

console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { worker = (s) => s, game = (s) => s, admin = (s) => s }) {
  const w2 = worker(WORKER_SRC), g2 = game(GAME_HTML), a2 = admin(ADMIN_HTML);
  if (w2 === WORKER_SRC && g2 === GAME_HTML && a2 === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-day1-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ workerMod: mod, gameHtml: g2, adminHtml: a2, privacyHtml: PRIVACY_HTML, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('phone kind not cleaned (any text stored)', 'R1', { worker: rep('out.os = AN_OS.has(e.os) ? e.os : "other";', 'out.os = String(e.os);') });
await control('run length from the clock, not real play time', 'R3', { worker: rep('if (fi >= 0) { firstDiff = d01[fi].diff || null; firstSec = Number(d01[fi].fs) || 0; }', 'if (fi >= 0) { firstDiff = d01[fi].diff || null; firstSec = Number(d01[fi].sec) || 0; }') });
await control('real play time not summed per run', 'R3', { worker: rep('sec += Number(list[j].sec) || 0; any = true;', 'sec = Number(list[j].sec) || 0; any = true;') });
await control('day 1 not over shown as "did not come back"', 'R4', { worker: rep('back1: today - p.f >= 2 ? !!(p.r & 1) : null,', 'back1: !!(p.r & 1),') });
await control('report open without the admin password', 'R6', { worker: rep('async function adminDay1(request, env) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminDay1(request, env) {') });
await control('the marked list ignored', 'R7', { worker: rep('excluded: exclSet.has(h),', 'excluded: false,') });
await control('the raw player ID stored with the mark', 'R7', { worker: (s) =>
  rep('body: JSON.stringify({ add: { h: d.code, label: day1Label(b.label) || "test device" } }) });', 'body: JSON.stringify({ add: { h: d.code, label: d.id } }) });')(
  rep('return json({ ok: true, code: await analyticsCode(id) });\n  }\n\n  /* Remove score', 'return json({ ok: true, code: await analyticsCode(id), id });\n  }\n\n  /* Remove score')(s)) });
await control('the game sends the user agent instead of the kind', 'G1', { game: rep(',os:fluxOsKind()});', ',os:navigator.userAgent});') });
await control('MARK AS MY DEVICE missing from FIND A PLAYER', 'A1', { admin: rep("'MARK AS MY DEVICE'", "'MARK'") });
const total = main.F + NC;
console.log('\n' + (total ? 'DAY-1 REPORT FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'DAY-1 REPORT PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
