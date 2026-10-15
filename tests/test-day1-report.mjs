// DAY-1 REPORT (owner, FLUX COMMAND): new pilots one by one, read-only. In the release gate.
// Server (REAL worker.js, fake Durable Object runtime):
//   R1 "open" carries the kind of phone ('ios' / 'android' / 'other'); anything else becomes 'other';
//   R2 the report lists every pilot who STARTED in the window (country, src, opened in, phone, first-run difficulty);
//   R3 run length is REAL play time ("play" seconds and the first run's "fs"), never the clock time;
//   R4 days are the PLAYER'S OWN calendar days (the phone's time zone): a Philippine player who starts at 8 PM and
//      plays again at 1 AM came back on day 1 (by UTC day they did not); a pilot whose own day 1 is not over
//      shows null, not "no"; runs on the first day count by their own day;
//   R5 pilots from before local days were recorded are only counted (UTC), never listed or mixed in;
//   R6 the report needs the admin password and writes nothing;
//   M1 marking: only with the admin password, a typed MY PHONE and a label; the code is one-time, expires after
//      15 minutes, and too many wrong codes cancel every open code;
//   M2 the phone marks itself with the code (works for a pilot that never posted a score); from then on it is
//      counted NOWHERE (day totals, retention, months, raw events) and never listed in the report, only counted;
//   M3 FLUX COMMAND never gets a marked phone's stats code, and there is no way to turn a pilot into a stats
//      code from FLUX COMMAND; COUNT AGAIN counts it again from then on;
// Game page:
//   G1 phone kind (iPadOS "Macintosh" + touch = iPhone/iPad); G2 the time zone goes with each stats batch;
//   G3 the RESTORE A PILOT box accepts a MARK code and sends it to /api/mark-device; anything else as before;
// Admin + privacy page:
//   A1 FLUX COMMAND: DAY-1 BY PILOT, MAKE A CODE FOR MY PHONE, COUNT AGAIN; no MARK AS MY DEVICE on FIND A PLAYER;
//   P1 the privacy page says the time zone, the per-code lines and the operator's own phones, honestly.
// Ends with negative controls: each defect re-inserted MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const PRIVACY_HTML = fs.readFileSync(path.join(ROOT, 'public', 'privacy.html'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.example.dev', DAY = 86400000, H = 3600000, T0 = Date.parse('2026-10-01T12:00:00Z');   // 8 PM in the Philippines
const PH = -480;   // Date.getTimezoneOffset() in the Philippines (UTC+8)
const id = (c, n) => c.repeat(8) + '-1111-4bbb-8ccc-00000000000' + n;
const A = id('a', 1), B = id('b', 2), C = id('c', 3), MINE = id('d', 4), LATE = id('e', 5), OLD = id('f', 6), D = id('9', 7);

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
const statsCode = async (x) => { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('flux-stats:' + x)); return Array.from(new Uint8Array(b)).slice(0, 8).map((v) => v.toString(16).padStart(2, '0')).join(''); };

async function suite({ workerMod, workerSrc, gameHtml, adminHtml, privacyHtml, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
  let now = T0;
  const realNow = Date.now; Date.now = () => now;
  const call = async (p, { body, admin = false } = {}) => {
    const headers = { 'Content-Type': 'application/json' }; if (admin) headers['x-admin-token'] = 'secret-admin';
    const r = new Request(ORIGIN + p, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    Object.defineProperty(r, 'cf', { value: { country: 'PH' } });
    const res = await worker.fetch(r, env, { waitUntil() {} }); let data = null; try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
  let bn = 0;
  const send = (pid, events, extra = {}) => call('/api/events', { body: { pid, events, tz: PH, bid: 'bid' + (++bn) + 'xxxxxxxxxx', country: 'PH', src: 'direct', ...extra } });
  const inst = () => env.LEADERBOARD_DO._instances.get('analytics');
  const dump = () => JSON.stringify([...inst().state.storage.map.entries()]);
  const day1 = (body = {}) => call('/api/admin/day1', { body, admin: true });
  const rowOf = async (rep, pid) => { const h = (await statsCode(pid)).slice(0, 6); return (rep.rows || []).find((r) => r.code === h); };
  const W = { from: '2026-09-20', to: '2026-10-05' };
  try {
    await call('/api/admin/analytics', { body: {}, admin: true });
    inst().nowMs = () => now;
    // ---- 2026-10-01 20:00 in the Philippines (12:00 UTC)
    await send(A, [{ e: 'open', home: false, iab: false, os: 'android' }, { e: 'first_run' },
      { e: 'run_end', sec: 7000, lvl: 1, diff: 'easy', st: 0, bad: 0, fs: 42 }, { e: 'play', diff: 'easy', st: 0, sec: 30, hit: 5, wrong: 1, lost: 1 }, { e: 'play', diff: 'easy', st: 1, sec: 12, hit: 2, wrong: 0, lost: 2 },
      { e: 'run_end', sec: 600, lvl: 2, diff: 'easy', st: 1, bad: 0 }, { e: 'play', diff: 'easy', st: 0, sec: 90, hit: 9, wrong: 0, lost: 3 }], { src: 'tiktok' });
    await send(B, [{ e: 'open', home: true, iab: false, os: 'ios' }, { e: 'first_run' }, { e: 'run_end', sec: 95, lvl: 1, diff: 'medium', st: 1, bad: 0, fs: 80 },
      { e: 'play', diff: 'medium', st: 0, sec: 80, hit: 4, wrong: 0, lost: 3 }], { country: 'US' });
    await send(C, [{ e: 'open', home: false, iab: true, os: 'windows-phone' }], { src: 'facebook' });
    await send(OLD, [{ e: 'open', home: false }], { tz: undefined, src: 'share' });   // a page from before: no time zone
    await send(MINE, [{ e: 'open', home: true, os: 'android' }, { e: 'first_run' }, { e: 'run_end', sec: 20, lvl: 1, diff: 'hard', st: 0, bad: 0, fs: 15 }]);   // the owner's phone, no score posted
    const raw = dump();
    ck('R1 open carries the phone kind; an unknown value becomes "other"', raw.includes('"os":"android"') && raw.includes('"os":"ios"') && raw.includes('"os":"other"') && !raw.includes('windows-phone'));
    // ---- 01:00 in the Philippines on Oct 2 (17:00 UTC Oct 1): C plays again -> their own day 1. A plays a 3rd run late on day 0? no: next day.
    now = T0 + 5 * H;
    await send(C, [{ e: 'open', home: false, os: 'other' }]);
    // ---- 09:00 PH Oct 2 (01:00 UTC Oct 2): A comes back
    now = T0 + 13 * H;
    await send(A, [{ e: 'open', home: false, os: 'android' }, { e: 'run_end', sec: 50, lvl: 1, diff: 'easy', st: 0, bad: 0 }]);
    // D starts at 23:30 PH Oct 2, plays again at 10:00 PH Oct 4 (their day 2: not day 1)
    now = T0 + DAY + 3.5 * H; await send(D, [{ e: 'open', home: false, os: 'android' }]);
    now = T0 + 2 * DAY + 14 * H; await send(D, [{ e: 'open', home: false, os: 'android' }]);
    // LATE starts at 08:00 PH Oct 5 (00:00 UTC Oct 5): their day 1 is not over when the report is read
    now = Date.parse('2026-10-05T00:00:00Z'); await send(LATE, [{ e: 'open', home: false, os: 'android' }, { e: 'first_run' }]);
    now = Date.parse('2026-10-06T10:00:00Z');   // 18:00 PH Oct 6

    // ---- M1 a one-time code for the owner's phone
    const noPw = await call('/api/admin/day1-mark-code', { body: { label: 'my BLU', confirm: 'MY PHONE' } });
    const noConfirm = await call('/api/admin/day1-mark-code', { body: { label: 'my BLU', confirm: 'yes' }, admin: true });
    const noLabel = await call('/api/admin/day1-mark-code', { body: { label: '  ', confirm: 'MY PHONE' }, admin: true });
    ck('M1 a code needs the admin password, a typed MY PHONE and a label', (noPw.status === 401 || noPw.status === 403) && noConfirm.status === 400 && noLabel.status === 400, [noPw.status, noConfirm.status, noLabel.status].join(' '));
    const old1 = (await call('/api/admin/day1-mark-code', { body: { label: 'old', confirm: 'my phone' }, admin: true })).data || {};
    now += 16 * 60000;
    const expired = await call('/api/mark-device', { body: { pid: MINE, code: old1.code } });
    ck('M1 a code expires after 15 minutes', /^MARK-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(String(old1.code)) && expired.status === 404, old1.code + ' ' + expired.status);
    const mk = (await call('/api/admin/day1-mark-code', { body: { label: 'my BLU <b>Chrome', confirm: 'MY PHONE' }, admin: true })).data || {};
    const wrong = await call('/api/mark-device', { body: { pid: MINE, code: 'MARK-2222-2222' } });
    ck('M1 a wrong code is refused', wrong.status === 404);
    // ---- M2 the phone marks itself; totals before and after
    const dayKey = 'an:day:' + Math.floor(now / DAY), noUse = (x) => { const { _use, ...g } = x || {}; return JSON.stringify(g); }, before = noUse(await inst().state.storage.get(dayKey));   // _use: the free-plan request counter, which still counts
    const ok = await call('/api/mark-device', { body: { pid: MINE, code: mk.code.toLowerCase() } });
    const again = await call('/api/mark-device', { body: { pid: B, code: mk.code } });
    ck('M2 the phone marks itself (no score needed); the code works only once', ok.status === 200 && ok.data.ok === true && again.status === 404, ok.status + ' ' + again.status);
    const retBefore = JSON.stringify(await inst().state.storage.get('an:ret:' + Math.floor(T0 / DAY))), evBefore = dump().split('"an:ev:').length;
    await send(MINE, [{ e: 'open', home: true, os: 'android' }, { e: 'run_end', sec: 30, lvl: 1, diff: 'hard', st: 0, bad: 0 }]);
    const after = noUse(await inst().state.storage.get(dayKey));
    ck('M2 a marked phone is counted nowhere: day totals, retention, raw events', before === after && retBefore === JSON.stringify(await inst().state.storage.get('an:ret:' + Math.floor(T0 / DAY))) && evBefore === dump().split('"an:ev:').length, before + ' -> ' + after);
    const list = (await call('/api/admin/day1-marked', { body: {}, admin: true })).data || {};
    const mineH = await statsCode(MINE), listTxt = JSON.stringify(list);
    ck('M3 FLUX COMMAND gets labels and dates only, never the stats code', list.marked && list.marked.length === 1 && list.marked[0].label === 'my BLU bChrome' && !listTxt.includes(mineH) && !listTxt.includes(mineH.slice(0, 6)), listTxt);
    ck('M3 there is no way to turn a pilot into a stats code from FLUX COMMAND', !/admin-stats-code|"\/api\/admin\/day1-mark":/.test(workerSrc) && (await call('/api/admin/day1-mark', { body: { pid: '0123456789abcdef' }, admin: true })).status === 404);

    // ---- the report
    const noPwR = await call('/api/admin/day1', { body: {} });
    ck('R6 the report needs the admin password', noPwR.status === 401 || noPwR.status === 403, String(noPwR.status));
    const s0 = dump(); const rep = (await day1(W)).data || {}; const s1 = dump();
    ck('R6 reading the report writes nothing', s0 === s1);
    const a = await rowOf(rep, A), b = await rowOf(rep, B), c = await rowOf(rep, C), d = await rowOf(rep, D), l = await rowOf(rep, LATE), m = await rowOf(rep, MINE), o = await rowOf(rep, OLD);
    ck('R2 every new pilot with local days is listed (A B C D LATE); the owner\'s phone and the older pilot are not', rep.ok && (rep.rows || []).length === 5 && !m && !o, String((rep.rows || []).length));
    ck('M2 the marked phone is only counted', rep.markedLeftOut === 1 && !JSON.stringify(rep).includes(mineH.slice(0, 6)), String(rep.markedLeftOut));
    ck('R2 country, src, opened in, phone, first-run difficulty', a && a.country === 'PH' && a.src === 'tiktok' && a.openedIn === 'browser' && a.os === 'android' && a.firstDiff === 'easy' &&
      b && b.country === 'US' && b.openedIn === 'home' && b.os === 'ios' && b.firstDiff === 'medium' && c && c.openedIn === 'inapp' && c.os === 'other' && c.started === false, JSON.stringify([a, c]));
    ck('R3 first run = real seconds (42), not the 7,000 s on the clock; day-0 play 42 + 90 = 132 s', a.firstSec === 42 && a.playSec === 132 && a.avgRunSec === 66, a.firstSec + ' ' + a.playSec + ' ' + a.avgRunSec);
    ck('R4 start dates are their own days (A and C on Oct 1, D on Oct 2, LATE on Oct 5)', a.start === '2026-10-01' && c.start === '2026-10-01' && d.start === '2026-10-02' && l.start === '2026-10-05');
    ck('R4 C played again at 1 AM their time: back on day 1 (by UTC day it was the same day)', c.back1 === true, String(c.back1));
    ck('R4 A back next morning; B not; D only on day 2 = no; LATE: day 1 not over (null)', a.back1 === true && b.back1 === false && d.back1 === false && l.back1 === null, JSON.stringify([a.back1, b.back1, d.back1, l.back1]));
    ck('R4 runs on the first day count by their own day (A: 2 on Oct 1, the run on Oct 2 is not day 0)', a.runs === 2, String(a.runs));
    ck('R5 the older pilot (no time zone) is only counted, by UTC day', rep.older && rep.older.n === 1 && rep.days === 'local', JSON.stringify(rep.older));
    // ---- M3 COUNT AGAIN
    const un = await call('/api/admin/day1-unmark', { body: { id: list.marked[0].id }, admin: true });
    const b2 = noUse(await inst().state.storage.get(dayKey));
    await send(MINE, [{ e: 'open', home: true, os: 'android' }]);
    ck('M3 COUNT AGAIN: counted again from then on', un.status === 200 && (un.data.marked || []).length === 0 && noUse(await inst().state.storage.get(dayKey)) !== b2);
    // ---- M1 too many wrong codes cancel every open code
    const mk2 = (await call('/api/admin/day1-mark-code', { body: { label: 'iPad', confirm: 'MY PHONE' }, admin: true })).data || {};
    for (let i = 0; i < 20; i++) await call('/api/mark-device', { body: { pid: id(String(i % 10), (i % 9) + 1).replace(/^(.)/, 'a'), code: 'MARK-3333-' + String(4444 + i).slice(-4).replace(/[01]/g, '9') } });
    const late = await call('/api/mark-device', { body: { pid: B, code: mk2.code } });
    ck('M1 20 wrong codes cancel every open code', late.status === 404, String(late.status));
  } catch (e) { ck('no exception', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
  finally { Date.now = realNow; }

  // ---- game page
  try {
    const fn = /function fluxOsKind\(\)\{[\s\S]*?\n\}/.exec(gameHtml);
    const kind = (ua, touch = 0) => { const sb = { navigator: { userAgent: ua, maxTouchPoints: touch } }; vm.createContext(sb); vm.runInContext(fn[0] + ';this.r=fluxOsKind();', sb); return sb.r; };
    ck('G1 phone kind: iPhone and iPadOS (Macintosh + touch) -> ios, Android -> android, a Mac / Windows -> other',
      kind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)') === 'ios' && kind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5) === 'ios' &&
      kind('Mozilla/5.0 (Linux; Android 13; BLU G45)') === 'android' && kind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0) === 'other' && kind('Mozilla/5.0 (Windows NT 10.0)') === 'other');
    ck('G1 the app-open event carries it', /fluxTrack\('open',\{home:[^}]*,os:fluxOsKind\(\)\}\)/.test(gameHtml));
    ck('G2 the time zone goes with each stats batch (score upload and beacon), and survives merging queued batches',
      /const s=\{src:fluxStatsSrc\(\),events:fluxStatsEvents\(\),tz:fluxTz\(\)\};/.test(gameHtml) && /events:fluxStatsEvents\(\),tz:fluxTz\(\)\}\);/.test(gameHtml) && /tz:stats\.tz!==undefined \? stats\.tz : \(item\.stats && item\.stats\.tz\)/.test(gameHtml));
    const mf = /function fluxIsMarkCode\(raw\)\{[^\n]*\}/.exec(gameHtml);
    const isMark = (v) => { const sb = {}; vm.createContext(sb); vm.runInContext(mf[0] + ';this.r=fluxIsMarkCode(' + JSON.stringify(v) + ');', sb); return sb.r; };
    ck('G3 the restore box takes a MARK code (any case, spaces, dashes) and nothing else',
      !!mf && isMark('MARK-AB2C-DE3F') && isMark(' mark-ab2c–de3f ') && isMark('MARKAB2CDE3F') && !isMark('FX1-abc-1234') && !isMark('MARK-0000-0000') && !isMark(''));
    ck('G3 ...and sends it with this phone\'s own player ID, before the usual restore steps',
      /if\(fluxIsMarkCode\(raw\)\)\{[^\n]*fluxMarkThisPhone\(raw\)/.test(gameHtml) && /fetch\('\/api\/mark-device',\{method:'POST'[^\n]*pid:playerId,code:/.test(gameHtml) &&
      gameHtml.indexOf('if(fluxIsMarkCode(raw))') < gameHtml.indexOf('const parsed=await parseRestoreCode(raw);'));
  } catch (e) { ck('G no exception', false, String(e)); }

  // ---- admin + privacy
  const d1js = adminHtml.slice(adminHtml.indexOf('/* ---------------- DAY-1 BY PILOT'), adminHtml.indexOf('async function loadStats'));
  ck('A1 FLUX COMMAND: DAY-1 BY PILOT, MAKE A CODE FOR MY PHONE (label + MY PHONE), COUNT AGAIN, text only',
    adminHtml.includes('<h2>DAY-1 BY PILOT</h2>') && adminHtml.includes('id="d1Code"') && adminHtml.includes('placeholder="Type MY PHONE"') &&
    adminHtml.includes("call('day1-mark-code', { label: $('d1Label').value, confirm: $('d1Confirm').value })") && adminHtml.includes("'COUNT AGAIN'") && d1js.length > 1000 && !/innerHTML/.test(d1js));
  ck('A1 no MARK AS MY DEVICE on FIND A PLAYER, no "(yours)" line, clears on logout',
    !adminHtml.includes('MARK AS MY DEVICE') && !adminHtml.includes('(yours)') && /'day1', 'd1Marked', 'd1CodeOut', /.test(adminHtml) && /'d1Label', 'd1Confirm', /.test(adminHtml));
  ck('A1 admin listeners unchanged (2)', (adminHtml.match(/addEventListener\(/g) || []).length === 2);
  const flat = privacyHtml.replace(/\s+/g, ' ');
  ck('P1 privacy: time zone, per-code lines that cannot be linked to a pilot, the operator\'s own phones only on the phone itself',
    flat.includes('the time zone set on the phone (for example UTC+8)') && flat.includes('the admin page has no way to find out which pilot a line belongs to') &&
    flat.includes('This can only be done on the phone itself, by typing a one-time code into it') && flat.includes('statistics cannot be matched to a leaderboard entry or a pilot name'));
  return { F, failed };
}

const main = await suite({ workerMod: await import(pathToFileURL(path.join(ROOT, 'worker.js')).href), workerSrc: WORKER_SRC, gameHtml: GAME_HTML, adminHtml: ADMIN_HTML, privacyHtml: PRIVACY_HTML });

console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { worker = (s) => s, game = (s) => s, admin = (s) => s }) {
  const w2 = worker(WORKER_SRC), g2 = game(GAME_HTML), a2 = admin(ADMIN_HTML);
  if (w2 === WORKER_SRC && g2 === GAME_HTML && a2 === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-day1-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ workerMod: mod, workerSrc: w2, gameHtml: g2, adminHtml: a2, privacyHtml: PRIVACY_HTML, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('phone kind not cleaned', 'R1', { worker: rep('out.os = AN_OS.has(e.os) ? e.os : "other";', 'out.os = String(e.os);') });
await control('first run from the clock, not real play time', 'R3', { worker: rep('firstSec = Number(d01[fi].fs) || 0; }', 'firstSec = Number(d01[fi].sec) || 0; }') });
await control('UTC day used for coming back', 'R4', { worker: rep('back1: p.lb ? true : day1Over ? false : null,', 'back1: p.r & 1 ? true : day1Over ? false : null,') });
await control('day 1 not over shown as "no"', 'R4', { worker: rep('back1: p.lb ? true : day1Over ? false : null,', 'back1: !!p.lb,') });
await control('a missing time zone taken as UTC', 'R5', { worker: rep('if (typeof v !== "number") return null;', 'v = Number(v);') });
await control('older pilots mixed into the list', 'R2', { worker: rep('if (!Number.isFinite(p.lf)) {   // started', 'if (false) {   // started') });
await control('report open without the admin password', 'R6', { worker: rep('async function adminDay1(request, env) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminDay1(request, env) {') });
await control('no typed confirmation', 'M1', { worker: rep('if (String(b.confirm || "").trim().toUpperCase() !== DAY1_CONFIRM)', 'if (false)') });
await control('codes never expire', 'M1', { worker: (s) => s.split('.filter((x) => x.exp > nowMs)').join('') });
await control('marked phone still counted in the totals', 'M2', { worker: rep('if ((await this.anMarkList()).some((x) => x.h === h)) { await this.anAddUse(b.use); return json({ ok: true, marked: true }); }', '') });
await control('marked phone listed in the report', 'M2', { worker: rep('if (markedSet.has(h)) { markedSeen++; continue; }', 'if (markedSet.has(h)) { markedSeen++; }') });
await control('a code works twice', 'M2', { worker: rep('pend = pend.filter((x) => x !== hit);', '') });
await control('FLUX COMMAND gets the stats code', 'M3', { worker: rep('anMarkedOut(list) { return list.map((x) => ({ id: x.id, label: x.label, at: x.at })); }', 'anMarkedOut(list) { return list.map((x) => ({ id: x.id, label: x.label, at: x.at, code: x.h })); }') });
await control('the game sends no time zone', 'G2', { game: rep('events:fluxStatsEvents(),tz:fluxTz()};', 'events:fluxStatsEvents()};') });
await control('the restore box ignores MARK codes', 'G3', { game: rep("if(fluxIsMarkCode(raw)){", "if(false){") });
await control('MARK AS MY DEVICE back on FIND A PLAYER', 'A1', { admin: rep("var a = el('div', 'actions');", "var a = el('div', 'actions'); a.appendChild(btn('MARK AS MY DEVICE', 'ghost', function () {}));") });
const total = main.F + NC;
console.log('\n' + (total ? 'DAY-1 REPORT FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'DAY-1 REPORT PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
