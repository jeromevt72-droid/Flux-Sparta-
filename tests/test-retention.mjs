// RETENTION measurements + "run it back", in the release gate.
// Real game page and real admin page in the harness vm; the real worker with a fake Durable Object.
//   S1 the server adds game overs, restarts (+ delay buckets), sessions (games, how they ended) and
//      first-run survival into day totals for everyone, by difficulty ("d:") and by source ("s:"),
//      never by country; bad / all game overs by difficulty and speed step ("p:");
//   S2 "sess_back" takes a hide's session count back; old pages' run_end (no step) adds no game over;
//   S3 junk is clamped or dropped, nothing about a person is stored, the per-pilot daily cap holds;
//   C1 the game: run_end carries the speed step, bad (2 lives within 10 s) and, on the very first run
//      only, the seconds survived; a run after a game over in the same session sends "again" with the delay;
//   C2 sessions: hide = counted end (after a game over / mid-run / menu), back within 30 min = taken back,
//      30 min hidden or idle = a new session (no "again" across it), a reload inside 30 min is the same sitting;
//   C3 bad failure: 2 lives within 10 s of play (boundary 10 s), by difficulty and step, end to end;
//   C4 no personal data in the new events;
//   A1 PLAYER STATS: restart rate, restart delay median + p75, games/session, session end shares,
//      first-run survival median, by difficulty and by source;
//   A2 BAD FAILURES table: bad vs normal by difficulty and step;
//   A3 both tables are drawn in PLAYER STATS (text only) and the guide explains them;
//   E1 no "CLOSE!" edge-catch effect (owner: removed; the game looks exactly as before this PR);
//   R1 RUN IT BACK: in the game loop the ball moves on the first frame after the tap (< 1 s), at
//      level 1, speed step 0, with no countdown, banner or hold; the first-ever run keeps its hint.
// Ends with negative controls (each mutates the sources and must be caught).
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', T0 = Date.parse('2026-10-01T12:00:00Z'), H = { 'x-admin-token': 'pw' }, MIN = 60000;
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
function fakeDom() {   // just enough DOM for the admin's PLAYER STATS drawing
  const mk = (tag) => { const n = { tag, className: '', children: [], hidden: false, value: '', _t: '',
    appendChild(c) { this.children.push(c); return c; }, remove() {} };
    Object.defineProperty(n, 'textContent', { get() { return n._t + n.children.map((c) => c.textContent).join(''); }, set(v) { n._t = String(v); n.children = []; } });
    return n; };
  return mk;
}
const walk = (n, f) => { f(n); (n.children || []).forEach((c) => walk(c, f)); };

async function suite({ gameHtml, adminHtml, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
  const call = async (p, body, headers = {}) => { const res = await worker.fetch(new Request(ORIGIN + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }), env, {}); let d = null; try { d = await res.json(); } catch (e) {} return { status: res.status, data: d }; };
  let now = T0;
  await call('/api/admin/analytics', {}, H); const an = env.LEADERBOARD_DO._instances.get('analytics'); an.nowMs = () => now;
  const ev = (pid, events, src, country = 'PH') => call('/api/events', { pid, events, src, country });
  const day = async () => { const r = (await call('/api/admin/analytics', { from: '2026-10-01', to: '2026-10-01' }, H)).data; return { rep: r, g: (r.days[0] || { groups: {} }).groups }; };
  const bootGame = (init = {}) => {
    const { store, mem } = makeStore(Object.assign({ fluxPlayerId: 'rt-pilot-1', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: '4', fluxDifficulty: 'medium' }, init));
    const g = boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store });
    g.ctx.Blob = Blob; const beacons = []; g.win.navigator.sendBeacon = (u, b) => { beacons.push(b); return true; };
    const run = (c) => vm.runInContext(c, g.ctx);
    const q = () => JSON.parse(run('JSON.stringify(fluxStatsQueue)'));
    const sent = async () => { const out = []; for (const b of beacons) { try { out.push(...JSON.parse(await b.text()).events); } catch (e) {} } return out.concat(q()); };
    const hide = (h) => { g.win.document.hidden = h; g.win.document.onvisibilitychange(); };
    return { g, mem, run, q, sent, hide, beacons };
  };
  const gameOver = (x) => { x.run('revivesUsedThisRun=1;'); x.g.ctx.endGame(); };

  // ---------------- server ----------------
  try {
    await ev(P(1), [{ e: 'run_end', sec: 50, lvl: 2, diff: 'easy', st: 1, bad: 1 }, { e: 'again', diff: 'easy', d: 0.5 }, { e: 'run_end', sec: 40, lvl: 1, diff: 'easy', st: 0, bad: 0 },
      { e: 'again', diff: 'easy', d: 2.5 }, { e: 'run_end', sec: 60, lvl: 2, diff: 'easy', st: 2, bad: 0 }, { e: 'again', diff: 'easy', d: 12 },
      { e: 'run_end', sec: 30, lvl: 1, diff: 'easy', st: 2, bad: 1, fs: 25 }], 'tiktok');
    await ev(P(1), [{ e: 'sess_end', g: 4, end: 'over', diff: 'easy' }, { e: 'sess_end', g: 1, end: 'run', diff: 'easy' }, { e: 'sess_back', g: 1, end: 'run', diff: 'easy' }, { e: 'sess_end', g: 2, end: 'menu', diff: 'easy' }], 'tiktok');
    await ev(P(2), [{ e: 'run_end', sec: 70, lvl: 3, diff: 'hard', st: 3, bad: 1, fs: 70 }, { e: 'sess_end', g: 1, end: 'over', diff: 'hard' }], 'direct', 'JP');
    await ev(P(3), [{ e: 'run_end', sec: 5, lvl: 1, diff: 'hard', st: 0, bad: 0, fs: 5 }, { e: 'run_end', sec: 9, lvl: 1, diff: 'medium' }], 'direct', 'JP');   // the 2nd: an old page (no step)
    const { rep, g } = await day();
    const a = g.all || {}, tk = g['s:tiktok'] || {}, de = g['d:easy'] || {}, dh = g['d:hard'] || {};
    ck('S1 everyone: 6 game overs (3 bad), 3 restarts in buckets 0 / 2 / 10 s, 3 sessions of 7 games (2 after a game over, 1 from the menu), 3 first runs',
      a.go === 6 && a.bad === 3 && a.ag === 3 && a.rd0 === 1 && a.rd2 === 1 && a.rd10 === 1 && a.ss === 3 && a.sg === 7 && a.se_over === 2 && a.se_menu === 1 && !a.se_run && a.frn === 3 && a.fs0 === 1 && a.fs20 === 1 && a.fs60 === 1,
      JSON.stringify(a));
    ck('S1 ...by difficulty and by source (TikTok = the Easy pilot)', de.go === 4 && de.ag === 3 && de.ss === 2 && de.sg === 6 && dh.go === 2 && dh.frn === 2 && !dh.ag && tk.go === 4 && tk.ag === 3 && tk.frn === 1 && tk.fs20 === 1 && (g['s:direct'] || {}).go === 2,
      JSON.stringify([de, dh, tk]));
    const cKeys = Object.keys(g).filter((k) => /^c:/.test(k)), noCountry = cKeys.length && cKeys.every((k) => ['go', 'ag', 'ss', 'sg', 'frn', 'bad'].every((f) => !(f in g[k])) && !Object.keys(g[k]).some((f) => /^(rd|fs|se_)/.test(f)));
    ck('S1 ...never by country', noCountry, cKeys.map((k) => k + ':' + Object.keys(g[k]).join('/')).join(' '));
    const pk = (k) => g[k] || {};
    ck('S1 bad vs all game overs by difficulty and speed step (p:<difficulty>:<step>)', pk('p:easy:1').go === 1 && pk('p:easy:1').bad === 1 && pk('p:easy:0').go === 1 && !pk('p:easy:0').bad && pk('p:easy:2').go === 2 && pk('p:easy:2').bad === 1 && pk('p:hard:3').bad === 1 && pk('p:hard:0').go === 1,
      JSON.stringify(Object.fromEntries(Object.entries(g).filter(([k]) => /^p:/.test(k)))));
    ck('S2 a session taken back (sess_back) is not counted; an old page\'s run_end adds a run but no game over', !a.se_run && a.ss === 3 && a.runs === 7 && a.go === 6 && !(g['d:medium'] || {}).go, 'runs ' + a.runs + ', go ' + a.go);
    // S3: junk and personal data (the next day, so the totals above stay as they are for the admin checks)
    now = T0 + 86400000;
    await ev(P(4), [{ e: 'again', diff: 'x', d: -40, name: 'TITAN', email: 'a@b.c' }, { e: 'sess_end', g: 5000, end: 'crash', diff: 'easy' }, { e: 'sess_end', g: 5000, end: 'over', diff: 'nope', pid: P(4) },
      { e: 'run_end', sec: 10, lvl: 1, diff: 'medium', st: 99, bad: 7, fs: 999999 }, { e: 'again', diff: 'hard', d: 99999 }], 'share');
    const day2 = async () => (await call('/api/admin/analytics', { from: '2026-10-02', to: '2026-10-02' }, H)).data.days[0].groups;
    const g2 = await day2(), sh = g2['s:share'] || {};
    const raw = JSON.stringify([...an.state.storage.map.entries()]);
    ck('S3 junk is clamped or dropped (bad end dropped, g <= 99, step <= 8, bad 0/1, delay 0..1800 s, survival <= 7200 s)',
      sh.ag === 2 && sh.rd0 === 1 && sh.rd1200 === 1 && sh.ss === 1 && sh.sg === 99 && sh.se_over === 1 && (g2['p:medium:8'] || {}).go === 1 && !(g2['p:medium:8'] || {}).bad && sh.fs1800 === 1 && (g2['d:medium'] || {}).ss === 1, JSON.stringify(sh));
    ck('S3 ...nothing about a person is stored (no name, email or pilot ID)', !raw.includes('TITAN') && !raw.includes('a@b.c') && !raw.includes(P(4)) && !raw.includes(P(1)), String(raw.length));
    const flood = []; for (let i = 0; i < 16; i++) flood.push(ev(P(5), Array.from({ length: 40 }, () => ({ e: 'again', diff: 'medium', d: 3 })), 'capped'));
    await Promise.all(flood); const ag5 = ((await day2())['s:capped'] || {}).ag || 0;
    ck('S3 ...the per-pilot daily cap (~500 events) holds for the new events', ag5 >= 400 && ag5 <= 520, String(ag5));
  } catch (e) { ck('server section ran', false, String(e.stack || e).slice(0, 300)); }

  // ---------------- game: events ----------------
  try {
    const n = bootGame({ fluxRunsPlayed: '0', fluxDifficulty: 'easy' });
    n.g.ctx.newGame(); n.run('speedStep=2; playStats=[{sec:20,hit:0,wrong:0,lost:0},{sec:10,hit:0,wrong:0,lost:0},{sec:7.4,hit:0,wrong:0,lost:0}];'); gameOver(n);
    let evs = await n.sent(); const re1 = evs.filter((e) => e.e === 'run_end');
    ck('C1 first run: run_end carries the speed step (2), bad (0: no lives lost) and the seconds survived (37)', re1.length === 1 && re1[0].st === 2 && re1[0].bad === 0 && re1[0].fs === 37 && re1[0].diff === 'easy', JSON.stringify(re1));
    n.run('localStorage.fluxRunsPlayed="1";'); n.g.ctx.newGame(); gameOver(n); evs = await n.sent();
    const re2 = evs.filter((e) => e.e === 'run_end'), ag = evs.filter((e) => e.e === 'again');
    ck('C1 ...only the very first run has it; a run started after a game over in the same session sends "again" (diff, delay)', re2.length === 2 && !('fs' in re2[1]) && ag.length === 1 && ag[0].diff === 'easy' && ag[0].d >= 0 && ag[0].d < 5, JSON.stringify(ag));
    n.run('fluxSess.go=Date.now()-4200; fluxStatsQueue=[];'); n.g.ctx.newGame();
    const ag2 = n.q().filter((e) => e.e === 'again');
    ck('C1 ...the delay is the seconds from the game over to the next run starting (4.2 s)', ag2.length === 1 && Math.abs(ag2[0].d - 4.2) < 0.15, JSON.stringify(ag2));
    const firstRun = bootGame({ fluxRunsPlayed: '0' }); firstRun.g.ctx.newGame();
    ck('C1 ...the first run of a session is not a restart', !firstRun.q().some((e) => e.e === 'again'));

    // C2 sessions
    const s = bootGame(); s.g.ctx.newGame(); gameOver(s); s.run('fluxStatsQueue=[];'); s.beacons.length = 0;
    s.hide(true); let e2 = await s.sent(); const end1 = e2.filter((e) => e.e === 'sess_end');
    ck('C2 hidden after a game over: the session is counted as ended "over" with its runs', end1.length === 1 && end1[0].end === 'over' && end1[0].g === 1 && end1[0].diff === 'medium', JSON.stringify(end1));
    s.beacons.length = 0; s.run('fluxSess.h=Date.now()-29*60000;'); s.hide(false); const back = s.q().filter((e) => e.e === 'sess_back');
    ck('C2 back within 30 min: the count is taken back (same runs / end) and the sitting goes on', back.length === 1 && back[0].end === 'over' && back[0].g === 1 && s.run('fluxSess.g') === 1);
    s.run('fluxStatsQueue=[];'); s.g.ctx.newGame(); const again = s.q().filter((e) => e.e === 'again');
    ck('C2 ...so RUN IT BACK after it is still a restart', again.length === 1 && s.run('fluxSess.g') === 2);
    s.run('fluxStatsQueue=[];'); s.hide(true); const mid = s.q().concat(await s.sent()).filter((e) => e.e === 'sess_end');
    ck('C2 hidden mid-run: ended "run"', mid.length >= 1 && mid[mid.length - 1].end === 'run' && mid[mid.length - 1].g === 2, JSON.stringify(mid));
    s.run('fluxStatsQueue=[]; fluxSess.h=Date.now()-31*60000;'); s.beacons.length = 0; s.hide(false);
    ck('C2 hidden more than 30 min: nothing taken back, a new session starts', !s.q().some((e) => e.e === 'sess_back') && s.run('fluxSess.g') === 0);
    const idle = bootGame(); idle.g.ctx.newGame(); gameOver(idle); idle.run('fluxStatsQueue=[]; fluxSess.a=Date.now()-31*60000; fluxSess.go=fluxSess.a;'); idle.g.ctx.newGame();
    const iq = idle.q();
    ck('C2 30 min without activity (page left open): that session ended "over", and the next run is not a restart', iq.some((e) => e.e === 'sess_end' && e.end === 'over' && e.g === 1) && !iq.some((e) => e.e === 'again'), JSON.stringify(iq));
    const m = bootGame(); m.g.ctx.newGame(); gameOver(m); m.g.win.document.getElementById('gameoverMenuBtn').onclick(); m.run('fluxStatsQueue=[];'); m.hide(true);
    const mq = (await m.sent()).filter((e) => e.e === 'sess_end');
    const qm = bootGame(); qm.g.ctx.newGame(); qm.g.win.document.getElementById('pauseMenuBtn').onclick(); qm.hide(true);
    const qq = (await qm.sent()).filter((e) => e.e === 'sess_end');
    ck('C2 from the menu (after a game over, or a run quit to the menu): ended "menu"', mq.length === 1 && mq[0].end === 'menu' && qq.length === 1 && qq[0].end === 'menu', JSON.stringify([mq, qq]));
    const r1 = bootGame(); r1.g.ctx.newGame(); gameOver(r1); r1.hide(true);
    const r2 = bootGame(r1.mem); const rq = r2.q();
    ck('C2 a reload inside 30 min is the same sitting (taken back, runs kept)', rq.some((e) => e.e === 'sess_back' && e.g === 1) && r2.run('fluxSess.g') === 1);

    // C3 bad failure
    const lose = (times, step, diff = 'medium') => { const x = bootGame({ fluxDifficulty: diff }); x.g.ctx.newGame(); x.run('speedStep=' + step + '; revivesUsedThisRun=1; fluxStatsQueue=[];');
      for (const t of times) { x.run('playStats=[{sec:' + t + ',hit:0,wrong:0,lost:0}]; if(!playing){playing=true;}'); x.g.ctx.registerMiss(); }
      const r = x.q().concat([]).filter((e) => e.e === 'run_end'); return { x, r }; };
    const b1 = lose([30, 35, 38], 3, 'hard'), b2 = lose([30, 50, 70], 1), b3 = lose([30, 60, 70], 2), b4 = lose([30, 60, 70.5], 2);
    const got = async (b) => (await b.x.sent()).filter((e) => e.e === 'run_end')[0] || {};
    const [x1, x2, x3, x4] = [await got(b1), await got(b2), await got(b3), await got(b4)];
    ck('C3 bad failure = the last two lives lost within 10 s of play (10.0 s counts, 10.5 s does not), with the step and difficulty',
      x1.bad === 1 && x1.st === 3 && x1.diff === 'hard' && x2.bad === 0 && x2.st === 1 && x3.bad === 1 && x4.bad === 0, JSON.stringify([x1, x2, x3, x4].map((r) => [r.bad, r.st, r.diff])));
    // end to end: the client events through the real worker
    now = T0 + 3 * 86400000;
    await ev(P(6), [x1, x2, x3, x4].map((r) => Object.assign({}, r)), 'e2e');
    const d3 = (await call('/api/admin/analytics', { from: '2026-10-04', to: '2026-10-04' }, H)).data.days[0].groups;
    ck('C3 ...counted end to end by difficulty and step', d3['p:hard:3'].bad === 1 && d3['p:medium:1'].go === 1 && !d3['p:medium:1'].bad && d3['p:medium:2'].go === 2 && d3['p:medium:2'].bad === 1, JSON.stringify([d3['p:hard:3'], d3['p:medium:2']]));

    // C4 no personal data
    const pool = []; for (const y of [n, idle, m, qm, b1.x, b3.x]) pool.push(...(await y.sent())); pool.push(...r2.q());
    const all = pool.filter((e) => /^(again|sess_end|sess_back|run_end)$/.test(e.e));
    const keysOk = all.every((e) => Object.keys(e).every((k) => ['e', 'diff', 'd', 'g', 'end', 'sec', 'lvl', 'st', 'bad', 'fs'].includes(k)));
    ck('C4 the new events carry only numbers, a difficulty and an end kind: no name, pilot ID or country', all.length >= 5 && keysOk && !JSON.stringify(all).includes('TITAN') && !JSON.stringify(all).includes('rt-pilot-1'), all.length + ' ' + JSON.stringify(all.filter((e) => Object.keys(e).some((k) => !['e', 'diff', 'd', 'g', 'end', 'sec', 'lvl', 'st', 'bad', 'fs'].includes(k)))));
  } catch (e) { ck('game events section ran', false, String(e.stack || e).slice(0, 300)); }

  // ---------------- admin ----------------
  try {
    now = T0;
    const rep = (await call('/api/admin/analytics', { from: '2026-10-01', to: '2026-10-01' }, H)).data;
    const { store } = makeStore({});
    const fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(rep), headers: { get: () => null } });
    const g = boot(scriptsOf(adminHtml), { origin: ORIGIN, path: '/admin.html', store, fetchImpl });
    const S = vm.runInContext('typeof FLUX_ADMIN_STATS!=="undefined"?FLUX_ADMIN_STATS:null', g.ctx);
    const rows = S.summarizeRetention(rep).rows, row = (k) => rows.find((r) => r.key === k) || {};
    const al = row('all'), e = row('d:easy'), tk = row('s:tiktok'), h = row('d:hard');
    const r2 = (x) => Math.round(x * 100) / 100;
    ck('A1 restart rate 3 of 6 game overs (50%), delay median 2.5 s and p75 11.25 s, 7 games in 3 sessions (2.33), ends 67% after a game over, 0% mid-run, 33% menu, first-run survival median 25 s',
      r2(al.restartRate) === 0.5 && r2(al.delayMed.v) === 2.5 && r2(al.delayP75.v) === 11.25 && r2(al.gamesPerSession) === 2.33 && r2(al.endOver) === 0.67 && al.endRun === 0 && r2(al.endMenu) === 0.33 && al.frn === 3 && r2(al.firstMed.v) === 25,
      JSON.stringify([al.restartRate, al.delayMed, al.delayP75, al.gamesPerSession, al.endOver, al.endRun, al.endMenu, al.firstMed]));
    ck('A1 ...by difficulty (Easy 75%, 3 games/session; Hard no restarts) and by source (TikTok 75%)', r2(e.restartRate) === 0.75 && e.gamesPerSession === 3 && h.restartRate === 0 && r2(tk.restartRate) === 0.75 && rows[0].key === 'all' && rows[1].key === 'd:easy',
      rows.map((r) => r.key + ' ' + r2(r.restartRate)).join(', '));
    ck('A1 ...shown in seconds ("2.5 s", "11 s", "1200 s+" for the open last bucket)', S.secs(al.delayMed) === '2.5 s' && S.secs(al.delayP75) === '11 s' && S.secs({ v: 1200, open: true }) === '1200 s+' && S.secs({ v: NaN }) === '—');
    const bad = S.summarizeBad(rep).rows.map((c) => [c.diff, c.step, c.go, c.bad, c.normal, Math.round(c.badShare * 100)].join(':')).join(' ');
    ck('A2 BAD FAILURES by difficulty and step: bad vs normal and the bad share', bad === 'easy:0:1:0:1:0 easy:1:1:1:0:100 easy:2:2:1:1:50 hard:0:1:0:1:0 hard:3:1:1:0:100', bad);
    // draw PLAYER STATS into a small fake DOM
    const mk = fakeDom(), box = mk('div'), orig = g.win.document.getElementById, stLoad = orig('stLoad');
    const fakes = { stats: box, stRange: Object.assign(mk('select'), { value: '30' }), stBy: Object.assign(mk('select'), { value: 'all' }) };
    g.win.document.getElementById = (id) => fakes[id] || orig(id); g.win.document.createElement = mk;
    await stLoad.onclick(); for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const h2 = [], tables = [];
    walk(box, (n) => { if (n.tag === 'h2') h2.push(n.textContent); if (n.tag === 'table') tables.push(n); });
    const headOf = (t) => (t.children[0].children || []).map((c) => c.textContent).join('|'), bodyOf = (t) => t.children.slice(1).map((r) => r.children.map((c) => c.textContent).join('|'));
    const rt = tables.find((t) => /Restart rate/.test(headOf(t))), sst = tables.find((t) => /Games \/ session/.test(headOf(t))), bt = tables.find((t) => /Bad share/.test(headOf(t)));
    ck('A3 PLAYER STATS draws RETENTION and SESSIONS tables (everyone, each difficulty, each source) and a BAD FAILURES table',
      h2.includes('RETENTION') && h2.includes('SESSIONS') && h2.includes('BAD FAILURES') && rt && sst && bt && bodyOf(rt)[0] === 'Everyone|6|50%|2.5 s · 11 s|3|25 s' && bodyOf(rt).some((r) => r.startsWith('EASY|4|75%')) && bodyOf(rt).some((r) => r.startsWith('src tiktok|4|75%'))
      && bodyOf(sst)[0] === 'Everyone|3|2.3|67% · 0% · 33%' && bodyOf(sst).some((r) => r === 'EASY|2|3.0|50% · 0% · 50%') && bodyOf(bt).includes('EASY|2|2|1|1|50%'), JSON.stringify([h2, rt && bodyOf(rt).slice(0, 3), sst && bodyOf(sst).slice(0, 2), bt && bodyOf(bt).slice(0, 3)]));
    const js = scriptsOf(adminHtml).join('\n'), statsJs = js.slice(js.indexOf('/* ---------------- player stats'), js.indexOf('function guard('));
    const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'), adminHtml.indexOf('<details id="advanced">'));
    ck('A3 ...as text only, and the guide explains session, restart rate / delay, games per session, session end, first-run survival and bad failures',
      !/innerHTML/.test(statsJs) && /Reading RETENTION and BAD FAILURES/.test(guide) && /30 minutes/.test(guide) && /Restart rate/.test(guide) && /Restart delay/.test(guide) && /Games \/ session/.test(guide) && /First-run survival/.test(guide) && /within 10 seconds/.test(guide));
  } catch (e) { ck('admin section ran', false, String(e.stack || e).slice(0, 300)); }

  // ---------------- no edge catch (owner: "CLOSE!" removed) ----------------
  ck('E1 no "CLOSE!" edge-catch effect: no text, no burst, nothing extra in the game loop or the drawing',
    !/CLOSE!|closeFx|closeCatchFx|isEdgeCatch|EDGE_CATCH|edgeCatch/.test(gameHtml));

  // ---------------- run it back ----------------
  try {
    const x = bootGame(); const doc = x.g.win.document;
    doc.getElementById('startBtn').onclick(); x.run('speedStep=3; level=4; score=9000; pendingLevel=0; fluxCountdown=0;'); gameOver(x);
    let ts = 1000; x.run('last=' + ts + ';');
    doc.getElementById('againBtn').onclick();
    const s0 = JSON.parse(x.run('JSON.stringify({x:ball.x,y:ball.y,level,speedStep,score,playing,paused,pendingLevel,levelHold,levelBanner,speedCountdown,fluxCountdown,missNotice})'));
    let frames = 0; const bx = s0.x, by = s0.y;
    for (; frames < 120; frames++) { ts += 1000 / 60; x.g.ctx.loop(ts); if (x.run('ball.x') !== bx || x.run('ball.y') !== by) { frames++; break; } }
    ck('R1 RUN IT BACK: the ball moves on the first frame after the tap (' + frames + ' frame = ' + Math.round(frames * 1000 / 60) + ' ms < 1 s), at level 1, speed step 0, no countdown, banner or hold',
      frames === 1 && s0.level === 1 && s0.speedStep === 0 && s0.score === 0 && s0.playing && !s0.paused && !s0.pendingLevel && !s0.levelHold && !s0.levelBanner && !s0.speedCountdown && !s0.fluxCountdown && !s0.missNotice, JSON.stringify(s0));
    ck('R1 ...the first-ever run keeps its intro (the colour hint after ENTER THE FLUX); RUN IT BACK has none',
      /newGame\(\);\s*paused = false;\s*document\.getElementById\('pauseBtn'\)\.textContent = 'Ⅱ';\s*showColorHint\(\);/.test(gameHtml) && !/getElementById\('againBtn'\)\.onclick=\(\)=>\{[^\n]*(showColorHint|levelHold|setTimeout)/.test(gameHtml));
  } catch (e) { ck('run it back section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ gameHtml: GAME_HTML, adminHtml: ADMIN_HTML, workerMod: realMod });
console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { game = (s) => s, admin = (s) => s, worker = (s) => s }) {
  const g2 = game(GAME_HTML), a2 = admin(ADMIN_HTML), w2 = worker(WORKER_SRC);
  if (g2 === GAME_HTML && a2 === ADMIN_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-retention-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const r = await suite({ gameHtml: g2, adminHtml: a2, workerMod: await import(pathToFileURL(tmp).href), quiet: true });
    const hitF = r.failed.filter((f) => f.startsWith(expect)); const ok = hitF.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hitF[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => { if (!s.includes(a)) return s; return s.replace(a, b); };
await control('server counts the new totals by country too', 'S1', { worker: rep('const rg = ["all", "s:" + p.s, "d:" + e.diff]; anAdd(day, rg, "ag", 1);', 'const rg = ["all", "s:" + p.s, "d:" + e.diff, "c:" + country]; anAdd(day, rg, "ag", 1);') });
await control('restart delay put in the wrong bucket', 'S1', { worker: rep('anAdd(day, rg, "rd" + anBucket(AN_RD_EDGES, e.d), 1);', 'anAdd(day, rg, "rd" + Math.round(e.d), 1);') });
await control('sess_back adds instead of taking back', 'S2', { worker: rep('const k = e.e === "sess_end" ? 1 : -1,', 'const k = 1,') });
await control('old pages\' run_end counted as game overs', 'S2', { worker: rep('if (e.e === "run_end" && e.st !== undefined) {', 'if (e.e === "run_end") {') });
await control('session end kinds not checked', 'S3', { worker: rep('if (!AN_SESS_END.has(e.end)) return null;', '') });
await control('per-pilot cap removed', 'S3', { worker: rep('if (p.k >= 500) return json({ ok: true, capped: true });', '') });
await control('first-run survival sent on every run', 'C1', { game: rep("if(!(+localStorage.fluxRunsPlayed>0) && localStorage.fluxStatFirstSec!=='1'){ localStorage.fluxStatFirstSec='1'; fluxFirstRunNow=true; }", "fluxFirstRunNow=true;") });
await control('restart counted without a game over before it', 'C1', { game: rep("if(fluxSess.st==='over' && fluxSess.go && now>=fluxSess.go)", "if(true)") });
await control('session gap 5 minutes instead of 30', 'C2', { game: rep('const FLUX_SESSION_GAP_MS=30*60000', 'const FLUX_SESSION_GAP_MS=5*60000') });
await control('return after a hide not taken back', 'C2', { game: rep("fluxTrack('sess_back',fluxSess.rep); fluxSess.rep=null;", 'fluxSess.rep=null;') });
await control('going back to the menu not tracked', 'C2', { game: rep('const r=f.apply(this,arguments); fluxSessMenu(); return r;', 'return f.apply(this,arguments);') });
await control('bad-failure window 30 s', 'C3', { game: rep('FLUX_BAD_WINDOW_S=10', 'FLUX_BAD_WINDOW_S=30') });
await control('bad failure uses wall-clock-free run count (any 2 lives)', 'C3', { game: rep('if(n>=2 && fluxLossAt[n-1]-fluxLossAt[n-2]<=FLUX_BAD_WINDOW_S) o.bad=1;', 'if(n>=2) o.bad=1;') });
await control('pilot name added to the restart event', 'C4', { game: rep("fluxTrack('again',{ diff:difficulty,", "fluxTrack('again',{ who:callsign, diff:difficulty,") });
await control('restart rate over sessions instead of game overs', 'A1', { admin: rep('c.restartRate = c.go > 0 ? Math.min(1, c.ag / c.go) : NaN;', 'c.restartRate = c.ss > 0 ? Math.min(1, c.ag / c.ss) : NaN;') });
await control('median read at the bucket start', 'A1', { admin: rep('return isFinite(hi) ? { v: keys[i] + (hi - keys[i]) * (want - acc) / c, open: false }', 'return isFinite(hi) ? { v: keys[i], open: false }') });
await control('bad share over normal game overs', 'A2', { admin: rep('c.badShare = c.go ? c.bad / c.go : NaN;', 'c.badShare = c.normal ? c.bad / c.normal : NaN;') });
await control('RETENTION table not drawn', 'A3', { admin: rep("box.appendChild(el('h2', null, 'RETENTION'));", '') });
await control('guide loses the retention note', 'A3', { admin: rep('<h3>Reading RETENTION and BAD FAILURES</h3>', '<h3>Retention</h3>') });
await control('a "CLOSE!" text drawn at an edge catch', 'E1', { game: rep(' if(paddle.hitFlash>0) paddle.hitFlash=', ' if(ball && Math.abs(ball.x-paddle.x)>paddle.w*.35) texts.push({s:\'CLOSE!\',x:ball.x,y:paddle.y-30,life:.6,col:\'#ffd45c\'});\n if(paddle.hitFlash>0) paddle.hitFlash=') });
await control('a 1.5 s intro hold added to RUN IT BACK', 'R1', { game: rep("classList.remove('hidden');newGame();paused=false;", "classList.remove('hidden');newGame();levelHold=1.5;playing=false;paused=false;") });
const total = main.F + NC;
console.log('\n' + (total ? 'RETENTION FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'RETENTION PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
