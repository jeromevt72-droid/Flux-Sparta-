// SCORE ALERTS (owner): scores are never blocked or delayed, but suspicious ones are listed in FLUX COMMAND
// (ALERTS, at the top, with a count badge) so the owner can check them and remove the pilot if fake.
// REAL worker.js on the fake Durable Object runtime of tests/test-remove-pilots.mjs (real SQLite, counted
// writes), on the NEW storage layout (the live one) and on the old one.
//   A1 each rule flags exactly when it should:
//        1 a new best above 300,000 (300,000 itself and a non-best 350,000 are not);
//        2 a new best above 50,000 that is more than 3x the previous best (exactly 3x, 50,000 itself and a
//          first score with no previous best are not);
//        3 a new #1 on that difficulty's board (a tie with the #1 and the #1 improving are not);
//        4 the country moves up one or more places on the World Grid (a raise that passes no one, a new
//          country entering at the bottom are not; a new country entering above others, and a pilot
//          moving its best to another country, are) -- also from an Every Run Counts share (not a new best);
//      one alert per upload, listing every rule met; normal scores make none (and write nothing more);
//      restricted pilots are never alerted;
//   A2 flagged scores still save and count right away (reply, board, World Grid); an alert that cannot be
//      written never fails the upload;
//   A3 FLUX COMMAND: admin only (401 without the login); newest first; every field; the unchecked count;
//      "Looks legit" marks it checked (saved); "Remove pilot" = REMOVE PILOTS (dry run first) and the
//      alert shows REMOVED; checked alerts are deleted 90 days after they were checked, unchecked ones stay;
//      a privacy deletion deletes the pilot's alerts (also in backups); at most 300 kept;
//   A4 the old storage layout does the same (rules 1, 3, 4, admin list and check);
//   A5 the page: ALERTS first, the badge, LOOKS LEGIT and REMOVE PILOT driven through the real page script;
//      guide; privacy policy (both copies); no change to the game; no new listener; text only.
// Ends with negative controls: each rule (and each other part) broken on purpose MUST be caught.
import fs from 'fs'; import path from 'path'; import util from 'util'; import v8 from 'v8'; import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeStore, universal } from './harness.mjs';
import { levelFor } from './level-rule.mjs';
process.removeAllListeners('warning');   // node:sqlite is "experimental" on this Node
const { DatabaseSync } = await import('node:sqlite');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const PRIV = ['privacy.html', path.join('welcome', 'privacy.html')].map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'));
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', H = { 'x-admin-token': 'pw' };
const T0 = Date.UTC(2026, 9, 21, 12, 0);
const MIN = 60000, DAY = 24 * 3600 * 1000;
let RUN = 0; const rid = () => 'run' + String(++RUN).padStart(13, '0') + 'x';
const ID = (n) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(n).padStart(12, '0');

/* ---------------- fake Durable Object runtime (as tests/test-remove-pilots.mjs) ---------------- */
class FakeSql {
  constructor(meter) { this.db = new DatabaseSync(':memory:'); this.m = meter; this.stmts = new Map(); }
  stmt(q) { let s = this.stmts.get(q); if (!s) { s = this.db.prepare(q); this.stmts.set(q, s); } return s; }
  exec(q, ...args) {
    args = args.map((a) => (a === undefined ? null : a));
    const write = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q);
    const before = write ? this.db.prepare('SELECT total_changes() AS c').get().c : 0;
    const rows = this.stmt(q).all(...args).map((r) => ({ ...r }));
    const ch = write ? this.db.prepare('SELECT total_changes() AS c').get().c - before : 0;
    this.m.read += write ? ch : rows.length; this.m.written += ch;
    return { toArray: () => rows, one: () => rows[0], rowsRead: write ? ch : rows.length, rowsWritten: ch, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  }
  tables() { return this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name); }
  dump(t) { try { return this.db.prepare('SELECT * FROM ' + t + ' ORDER BY ' + (t === 'pilots' ? 'seq' : 'id')).all().map((r) => ({ ...r })); } catch (e) { return null; } }
}
class FakeStorage {
  constructor(map, { limit = 2 * 1024 * 1024, sql = true } = {}) { this.map = map || new Map(); this.limit = limit; this.meter = { read: 0, written: 0 }; if (sql) this.sql = new FakeSql(this.meter); this.keyPuts = []; this.fail = null; }
  async get(k) { this.meter.read++; return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v }, keys = Object.keys(obj);
    if (this.fail && keys.some((x) => this.fail.has(x))) throw new Error('put failed (test)');
    if (keys.length > 128) throw new Error('put: more than 128 keys');
    for (const kk of keys) if (v8.serialize(obj[kk]).length > this.limit) throw new Error('put: value over the limit (' + kk + ')');
    this.meter.written += keys.length; this.keyPuts.push(keys);
    for (const kk of keys) this.map.set(kk, structuredClone(obj[kk]));
  }
  async delete(k) { const ks = [].concat(k); this.meter.written += ks.length; for (const x of ks) this.map.delete(x); }
  async list(o = {}) {
    let keys = [...this.map.keys()].sort();
    if (o.prefix) keys = keys.filter((k) => k.startsWith(o.prefix));
    if (o.startAfter !== undefined) keys = keys.filter((k) => k > o.startAfter);
    if (o.limit) keys = keys.slice(0, o.limit);
    this.meter.read += keys.length;
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async transaction(fn) { const before = new Map(this.map); try { return await fn(this); } catch (e) { this.map = before; throw e; } }
  transactionSync(fn) { this.sql.db.exec('BEGIN'); try { const r = fn(); this.sql.db.exec('COMMIT'); return r; } catch (e) { this.sql.db.exec('ROLLBACK'); throw e; } }
}
class FakeState {
  constructor(storage) { this.storage = storage; this.lock = Promise.resolve(); }
  blockConcurrencyWhile(fn) { const r = this.lock.then(fn); this.lock = r.then(() => {}, () => {}); return r; }
}
function makeEnv(mod, g) {
  const inst = new Map(), env = { ADMIN_TOKEN: 'pw', _g: g, _b: new FakeStorage(new Map(), { limit: 128 * 1024 }) };
  env.LEADERBOARD_DO = { idFromName: (n) => n, get(id) {
    if (!inst.has(id)) { const st = new FakeState(id === 'global' ? env._g : id === 'backups' ? env._b : new FakeStorage()); inst.set(id, { st, o: new mod.LeaderboardDO(st, env) }); }
    const x = inst.get(id);
    return { fetch: async (url, init) => { await x.st.lock; return x.o.fetch(new Request(url, init)); } }; } };
  return env;
}

/* ---------------- datasets ---------------- */
const best = (score, d, at) => ({ score, level: levelFor(score, d), updatedAt: at });
/* World Grid at the start (weights easy .09, medium .21, hard 1): US 1.5M+ (#1), JP 135,000, PH 60,000,
   FR 30,000, BR 10,000. KING tops Medium and Hard; EZTOP tops Easy (40,000). */
const PILOTS = [
  ['KING', 'US', { medium: 3000000, hard: 1500000 }], ['JP1', 'JP', { hard: 100000 }], ['JP2', 'JP', { hard: 35000 }],
  ['PH1', 'PH', { hard: 60000 }], ['FR1', 'FR', { hard: 30000 }], ['BR1', 'BR', { hard: 10000 }],
  ['EZTOP', 'US', { easy: 40000 }], ['UE', 'US', { easy: 30000 }], ['UHIGH', 'US', { hard: 250000 }],
  ['UJUMP', 'US', { medium: 25000 }], ['JUMP2', 'US', { medium: 20000 }], ['LOW2', 'US', { medium: 10000 }], ['LOW3', 'US', { medium: 10000 }],
  ['RST', 'US', { hard: 100000 }],
];
const PID = Object.fromEntries(PILOTS.map((p, i) => [p[0], ID(i + 1)]));
PID.NEWBIE = ID(50); PID.CA1 = ID(51); PID.DE1 = ID(52);
function seed(list = PILOTS) {
  const m = new Map(), players = {};
  list.forEach(([name, cc, b], i) => {
    const bests = {}; for (const d of Object.keys(b)) bests[d] = best(b[d], d, 1790000000000 + i);
    players[PID[name]] = { playerId: PID[name], name, country: cc, updatedAt: 1790000000000 + i, bests };
  });
  m.set('players', players); m.set('season', 1); m.set('nameRulesV1', 1);
  m.set('entitlements', {}); m.set('lastSubmit', {}); m.set('restricted', {});
  return m;
}

/* ---------------- a tiny DOM for the admin page (real elements, so cards and buttons can be found) ---------------- */
function bootAdmin(scripts, { fetchImpl }) {
  const U = universal(), els = {};
  const mk = (tag) => {
    const t = { tagName: String(tag).toUpperCase(), children: [], _text: '', _removed: false, hidden: false, value: '', disabled: false, className: '', style: {}, onclick: null, placeholder: '',
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.unshift(c); return c; }, remove() { this._removed = true; },
      setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; }, scrollIntoView() {}, focus() {}, select() {}, blur() {}, click() { if (this.onclick) this.onclick(); },
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
    Object.defineProperty(t, 'textContent', { get() { return t._text + t.children.filter((c) => !c._removed).map((c) => c.textContent || '').join(''); }, set(v) { t._text = String(v); t.children = []; }, enumerable: true });
    return new Proxy(t, { get: (o, k) => (k in o ? o[k] : U), set: (o, k, v) => { o[k] = v; return true; }, has: () => true });
  };
  const byId = (id) => (els[id] = els[id] || mk('div'));
  byId('app').hidden = true; byId('alertBadge').hidden = true;   // as in the page's HTML (hidden attributes)
  const doc = new Proxy({ hidden: false, visibilityState: 'visible', readyState: 'complete', referrer: '', cookie: '' }, {
    get: (t, k) => (k in t ? t[k] : k === 'getElementById' ? byId : k === 'createElement' ? mk : k === 'createTextNode' ? (s) => ({ textContent: String(s) }) : k === 'addEventListener' ? () => {} : U),
    set: (t, k, v) => { t[k] = v; return true; } });
  const win = {
    document: doc, location: { origin: ORIGIN, pathname: '/admin.html', search: '', hash: '', host: 'flux.example', href: ORIGIN + '/admin.html', reload() {}, replace() {}, assign() {} },
    localStorage: makeStore({}).store, sessionStorage: makeStore({}).store,
    navigator: { standalone: true, onLine: true, platform: 'iPhone', userAgent: 'iPhone', clipboard: { writeText: () => Promise.resolve() }, serviceWorker: { register: () => Promise.resolve({}), addEventListener() {} } },
    fetch: fetchImpl, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, getComputedStyle: () => U, history: { replaceState() {}, pushState() {} }, performance: { now: () => 0 },
    Headers, URL, URLSearchParams, Blob: function () { return U; }, FileReader: function () { return U; }, console: { log() {}, warn() {}, error() {} },
    alert() {}, confirm() { return true; }, prompt() { return ''; },
    Math, Date, JSON, Promise, Set, Map, Array, Object, String, Number, Boolean, Symbol, Error, Proxy, Reflect, isFinite, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  };
  win.window = win; win.self = win; win.globalThis = win;
  const ctx = vm.createContext(win), errors = [];
  for (const s of scripts) { try { vm.runInContext(s, ctx, { timeout: 5000 }); } catch (e) { errors.push(String(e).slice(0, 200)); } }
  return { win, els, byId, errors };
}
const kids = (e) => (e.children || []).filter((c) => !c._removed);
const findBtn = (card, label) => { for (const c of kids(card)) { if (c.tagName === 'BUTTON' && c._text === label) return c; const f = findBtn(c, label); if (f) return f; } return null; };

/* ---------------- the suite ---------------- */
async function suite({ workerMod, adminHtml, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + String(x).slice(0, 300) + ']' : '')); if (!c) { F++; failed.push(l); } };
  const src = workerMod.__src || WORKER_SRC;
  const realNow = Date.now; let now = T0; Date.now = () => now;
  const realErr = console.error; console.error = () => {};
  const mk = async ({ v2 = true, list = PILOTS, extra = null } = {}) => {
    const m = seed(list); if (extra) extra(m);
    const g = new FakeStorage(m), env = makeEnv(workerMod, g);
    const req = async (p, body, headers = {}, method = 'POST') => {
      const res = await workerMod.default.fetch(new Request(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, {});
      const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: res.status, data, text };
    };
    const admin = (route, body) => req('/api/admin/' + route, body, H);
    if (v2) {
      await admin('backup-now'); const dr = await admin('migrate-storage-dry-run');
      let r = null; for (let i = 0; i < 50; i++) { r = await admin('migrate-storage', { confirm: dr.data && dr.data.confirm }); if (r.status !== 200 || !r.data.more) break; }
      if (g.map.get('storageLayout') !== 'v2') throw new Error('storage move failed: ' + (r && r.text.slice(0, 200)));
    }
    now += 61 * MIN;
    /* one upload: a run id, the level its score reaches, this season; 15 s apart so no cooldown */
    const up = async (name, score, d, cc, o = {}) => {
      now += 15000;
      return req('/api/submit-score', { playerId: PID[name], name, score, level: levelFor(score, d), difficulty: d, country: cc, season: 1, runId: rid() });
    };
    const tag = async (name) => (await req('/api/restore-check', { playerId: PID[name] })).data.tag;
    const alerts = async () => (await admin('alerts')).data;
    const board = async (d) => (await req('/api/leaderboard?limit=100' + (d ? '&difficulty=' + d : ''), null, {}, 'GET')).data;
    return { g, env, req, admin, up, tag, alerts, board };
  };
  const rulesOf = (a) => (a ? a.rules.map((x) => x.r).join(',') : 'none');
  try {
    /* ================= new storage layout ================= */
    const S = await mk(), g = S.g;
    ck('A0 (setup) the new storage layout holds the pilots; no alerts yet', g.map.get('storageLayout') === 'v2' && !g.map.has('alerts'));
    let seen = 0;
    /* the alert this upload made (or null); checks one alert at most per upload */
    const step = async (name, score, d, cc) => {
      const putsBefore = g.keyPuts.length, r = await S.up(name, score, d, cc);
      const list = (await S.alerts()).alerts, fresh = list.length > seen ? list[0] : null, n = list.length - seen; seen = list.length;
      const wroteAlerts = g.keyPuts.slice(putsBefore).filter((k) => k.includes('alerts')).length;
      return { r, a: fresh, n, wroteAlerts };
    };

    /* ---- normal scores ---- */
    const normal = [await step('UHIGH', 200000, 'hard', 'US'), await step('UJUMP', 26000, 'medium', 'US'), await step('NEWBIE', 200000, 'medium', 'US'),
      await step('BR1', 9000, 'hard', 'BR'), await step('CA1', 5000, 'hard', 'CA')];
    ck('A1 normal scores make no alert (a non-best, a small new best, a first score of 200,000 with no previous best, a new country entering at the bottom)',
      normal.every((x) => x.r.status === 200 && x.n === 0), normal.map((x) => x.r.status + '/' + x.n).join(' '));
    ck('A1 ...and write nothing more (the "alerts" value is never written)', normal.every((x) => x.wroteAlerts === 0) && !g.map.has('alerts'));

    /* ---- rule 1 ---- */
    const r1a = await step('UHIGH', 300000, 'hard', 'US'), r1b = await step('UHIGH', 300001, 'hard', 'US'), r1c = await step('UHIGH', 299000, 'hard', 'US');
    ck('A1 rule 1: a new best of exactly 300,000 is not flagged', r1a.r.status === 200 && r1a.n === 0, r1a.n);
    ck('A1 rule 1: a new best of 300,001 is flagged (rule 1 only), in ONE write', r1b.n === 1 && rulesOf(r1b.a) === '1' && r1b.wroteAlerts === 1, rulesOf(r1b.a) + ' writes ' + r1b.wroteAlerts);
    ck('A1 rule 1 ...a score below the pilot\'s best (299,000) is not flagged', r1c.n === 0);
    const r1d = await step('UHIGH', 350000, 'hard', 'US'); const r1e = await step('UHIGH', 340000, 'hard', 'US');
    ck('A1 rule 1 ...a later new best above 300,000 is flagged again; a score above 300,000 that is not a new best (340,000 under 350,000) is not', r1d.n === 1 && rulesOf(r1d.a) === '1' && r1e.n === 0);

    /* ---- rule 2 ---- */
    const r2a = await step('UJUMP', 78000, 'medium', 'US');   // exactly 3 x 26,000
    const r2b = await step('JUMP2', 60001, 'medium', 'US');   // > 50,000 and > 3 x 20,000
    const r2c = await step('LOW2', 50000, 'medium', 'US');    // 5 x but not above 50,000
    const r2d = await step('LOW3', 50001, 'medium', 'US');    // 5 x and above 50,000
    ck('A1 rule 2: exactly 3x the previous best is not flagged', r2a.r.status === 200 && r2a.n === 0, r2a.n);
    ck('A1 rule 2: above 50,000 and more than 3x the previous best is flagged (rule 2 only)', r2b.n === 1 && rulesOf(r2b.a) === '2' && r2b.a.prevBest === 20000, rulesOf(r2b.a));
    ck('A1 rule 2: 5x the previous best but not above 50,000 (50,000) is not flagged', r2c.n === 0);
    ck('A1 rule 2: 50,001 (5x) is flagged', r2d.n === 1 && rulesOf(r2d.a) === '2', rulesOf(r2d.a));

    /* ---- rule 3 ---- */
    const r3a = await step('UE', 40000, 'easy', 'US');        // ties EZTOP (who was there first)
    const r3b = await step('UE', 40001, 'easy', 'US');
    const r3c = await step('EZTOP', 45000, 'easy', 'US');     // back to #1
    const r3d = await step('EZTOP', 46000, 'easy', 'US');     // already #1
    ck('A1 rule 3: a tie with the #1 (who was first) is not flagged', r3a.r.status === 200 && r3a.n === 0);
    ck('A1 rule 3: a new #1 on the Easy board is flagged (rule 3 only)', r3b.n === 1 && rulesOf(r3b.a) === '3', rulesOf(r3b.a));
    ck('A1 rule 3: the old #1 taking it back is flagged; the #1 improving is not', r3c.n === 1 && rulesOf(r3c.a) === '3' && r3d.n === 0, rulesOf(r3c.a) + ' / ' + r3d.n);
    const top0 = (await S.board('easy')).top[0];
    ck('A1 rule 3 ...(EZTOP is the Easy #1 now)', top0 && top0.name === 'EZTOP' && top0.score === 46000);

    /* ---- rule 4 ---- */
    const r4a = await step('JP2', 1000, 'hard', 'FR');        // not a best; its 35,000 moves to FR: FR 65,000 passes PH 60,000
    const r4b = await step('PH1', 64000, 'hard', 'PH');       // PH 64,000: still under FR
    const r4c = await step('PH1', 100001, 'hard', 'PH');      // passes FR and JP
    const r4d = await step('DE1', 20000, 'hard', 'DE');       // a new country entering above BR and CA
    ck('A1 rule 4: a pilot moving its best to another country that then passes one is flagged (rule 4: FR #4 -> #3), though not a new best',
      r4a.r.status === 200 && r4a.n === 1 && rulesOf(r4a.a) === '4' && r4a.a.country === 'FR' && r4a.a.rules[0].from === 4 && r4a.a.rules[0].to === 3, JSON.stringify(r4a.a && r4a.a.rules));
    ck('A1 rule 4: a raise that passes no country is not flagged', r4b.n === 0);
    ck('A1 rule 4: PH passing FR and JP is flagged (#4 -> #2)', r4c.n === 1 && rulesOf(r4c.a) === '4' && r4c.a.rules[0].from === 4 && r4c.a.rules[0].to === 2, JSON.stringify(r4c.a && r4c.a.rules));
    ck('A1 rule 4: a new country entering above others is flagged (new, at #5); one entering at the bottom (CA, above) is not',
      r4d.n === 1 && rulesOf(r4d.a) === '4' && r4d.a.rules[0].from === null && r4d.a.rules[0].to === 5 && normal[4].n === 0, JSON.stringify(r4d.a && r4d.a.rules));

    /* ---- restricted ---- */
    const tR = await S.tag('RST'), fR = (await S.admin('find-player', { query: 'RST #' + tR })).data.matches[0];
    await S.admin('restrict', { pid: fR.pid, reason: 'test' });
    const rr = await step('RST', 400000, 'hard', 'US');
    const fR2 = (await S.admin('find-player', { query: 'RST #' + tR })).data.matches[0];
    ck('A1 a restricted pilot is never alerted (400,000 = 4x its best); the score is still saved', rr.r.status === 200 && rr.n === 0 && JSON.stringify(fR2.bests || fR2).includes('400000'), rr.n);

    /* ---- every rule at once ---- */
    const rm = await step('BR1', 1600000, 'hard', 'BR');      // > 300,000, > 3x 10,000, beats KING's 1,500,000, BR goes to #1
    ck('A1 one upload meeting every rule makes ONE alert listing rules 1, 2, 3 and 4', rm.n === 1 && rulesOf(rm.a) === '1,2,3,4' && rm.wroteAlerts === 1, rulesOf(rm.a));

    /* ---- A2 saved and counted at once ---- */
    const hb = await S.board('hard'), all = await S.board(null), bi = all.countries.findIndex((c) => c.country === 'BR');
    ck('A2 a flagged score is saved and counted at once: reply ok, new best, rank 1; #1 on the Hard board; BR\'s World Grid total has it, at the place the alert says',
      rm.r.data && rm.r.data.ok === true && rm.r.data.isNewBest === true && rm.r.data.rank === 1 && hb.top[0].name === 'BR1' && hb.top[0].score === 1600000
      && bi >= 0 && all.countries[bi].totalScore >= 1600000 && rm.a.rules[3].to === bi + 1,
      JSON.stringify({ rank: rm.r.data && rm.r.data.rank, top: hb.top[0] && hb.top[0].name, bi, rule: rm.a && rm.a.rules[3] }));
    g.fail = new Set(['alerts']);
    const before = (await S.alerts()).alerts.length;
    const fx = await S.up('JP1', 2000000, 'hard', 'JP');       // every rule again, but the alert cannot be written
    g.fail = null;
    const hb2 = await S.board('hard');
    ck('A2 an alert that cannot be written never fails the upload: 200, saved, #1 on the board', fx.status === 200 && fx.data.ok === true && hb2.top[0].name === 'JP1' && hb2.top[0].score === 2000000, fx.status + ' ' + fx.text.slice(0, 120));
    const after = (await S.alerts()).alerts.length; seen = after;
    ck('A2 ...(the alert is kept in memory and saved with the next write)', after === before + 1);

    /* ---- A3 FLUX COMMAND ---- */
    const noAuth = [(await S.req('/api/admin/alerts', {})).status, (await S.req('/api/admin/alerts', {}, { 'x-admin-token': 'nope' })).status,
      (await S.req('/api/admin/alert-check', { id: 'x' })).status, (await S.req('/api/admin/alert-check', { id: 'x' }, { 'x-admin-token': 'nope' })).status];
    ck('A3 admin only: the list and "Looks legit" answer 401 without the login', noAuth.every((s) => s === 401), noAuth.join(','));
    ck('A3 the routes are in the admin map behind requireAdmin (adminDO / adminAlertCheck)',
      /"\/api\/admin\/alerts":\s*\(\) => adminDO\(request, env, "\/admin-alerts", \{\}\)/.test(src) && /"\/api\/admin\/alert-check":\s*\(\) => adminAlertCheck\(request, env\)/.test(src)
      && /async function adminAlertCheck\(request, env\) \{[^\n]*\n  const denied = requireAdmin\(request, env\); if \(denied\) return denied;/.test(src));
    const L = await S.alerts(), list = L.alerts;
    ck('A3 newest first, with the unchecked count', list.length === 11 && L.unchecked === 11 && list.every((a, i) => i === 0 || list[i - 1].at >= a.at), list.length + ' ' + L.unchecked);
    const tH = await S.tag('UHIGH'), aH = list.find((a) => a.score === 300001);
    ck('A3 every field: name + #TAG, country, difficulty, score, level, previous best, the rule, when',
      aH && aH.name === 'UHIGH' && aH.tag === tH && aH.country === 'US' && aH.difficulty === 'hard' && aH.score === 300001 && aH.level === levelFor(300001, 'hard') && aH.prevBest === 300000
      && util.isDeepStrictEqual(aH.rules, [{ r: 1 }]) && typeof aH.at === 'number' && aH.checkedAt === null && aH.nameNow === 'UHIGH' && aH.tagNow === tH, JSON.stringify(aH));
    ck('A3 nothing new about a pilot: an alert holds only the pilot code, name, #TAG, country, difficulty, score, level, previous best, rules, time (and checked)',
      list.every((a) => Object.keys(a).every((k) => ['id', 'pid', 'tag', 'name', 'country', 'difficulty', 'score', 'level', 'prevBest', 'rules', 'at', 'checkedAt', 'outcome', 'nameNow', 'tagNow', 'onBoard'].includes(k)))
      && (g.map.get('alerts') || []).every((a) => !JSON.stringify(a).includes('aaaaaaaa-bbbb')), Object.keys(list[0]).join(','));
    const ok1 = await S.admin('alert-check', { id: aH.id }), L2 = await S.alerts(), aH2 = L2.alerts.find((a) => a.id === aH.id);
    const stored = (g.map.get('alerts') || []).find((a) => a.id === aH.id);
    ck('A3 "Looks legit" marks it checked: saved, the count drops by one', ok1.status === 200 && aH2.checkedAt === now && aH2.outcome === 'legit' && L2.unchecked === 10 && stored && stored.checkedAt === now, ok1.status + ' ' + L2.unchecked);
    const again = await S.admin('alert-check', { id: aH.id }), none = await S.admin('alert-check', { id: 'no-such-alert' });
    ck('A3 ...again: already checked; an unknown alert: 404', again.status === 200 && again.data.already === true && none.status === 404, again.status + ' ' + none.status);
    /* Remove pilot = REMOVE PILOTS with its dry run first */
    const aD = L2.alerts.find((a) => a.name === 'DE1'), line = aD.nameNow + ' #' + aD.tagNow;
    const dry = await S.admin('remove-pilots-dry-run', { lines: [line] });
    ck('A3 "Remove pilot": the alert gives the exact NAME #TAG and the REMOVE PILOTS dry run finds that one pilot (nothing removed)',
      dry.status === 200 && dry.data.canRemove === true && dry.data.pilots.length === 1 && dry.data.pilots[0].tag === aD.tagNow && (await S.alerts()).alerts.find((a) => a.id === aD.id).checkedAt === null, dry.text.slice(0, 160));
    await S.admin('backup-now');
    const rmv = await S.admin('remove-pilots', { lines: [line], id: dry.data.id, confirm: dry.data.confirm });
    const L3 = await S.alerts(), aD2 = L3.alerts.find((a) => a.id === aD.id);
    ck('A3 ...after REMOVE NOW the alert shows REMOVED (checked) and the count drops', rmv.status === 200 && rmv.data.ok === true && aD2.checkedAt === now && aD2.outcome === 'removed' && aD2.onBoard === false && L3.unchecked === 9, rmv.status + ' ' + JSON.stringify(aD2));
    /* retention */
    const n3 = L3.alerts.length;
    now += 89 * DAY; const L4 = await S.alerts();
    ck('A3 89 days after checking: checked alerts are still kept', L4.alerts.length === n3 && L4.alerts.some((a) => a.id === aH.id));
    now += 2 * DAY; const L5 = await S.alerts();
    ck('A3 90+ days after checking: checked alerts are deleted (also from storage); unchecked ones stay, however old',
      L5.alerts.length === n3 - 2 && !L5.alerts.some((a) => a.checkedAt) && L5.unchecked === 9 && !(g.map.get('alerts') || []).some((a) => a.id === aH.id || a.id === aD.id), L5.alerts.length + ' of ' + n3);
    /* privacy deletion */
    const aE = L5.alerts.filter((a) => a.name === 'EZTOP');
    await S.admin('privacy-delete', { pid: aE[0].pid, removePurchases: false });
    const L6 = await S.alerts();
    ck('A3 a privacy deletion deletes the pilot\'s alerts', aE.length === 1 && !L6.alerts.some((a) => a.pid === aE[0].pid) && !(g.map.get('alerts') || []).some((a) => a.pid === aE[0].pid) && L6.unchecked === 8, aE.length + ' ' + L6.unchecked);
    ck('A3 ...and from every backup (the backup erase handles the alerts value)', /if \(k === ALERT_KEY && Array\.isArray\(v\) && v\.some\(\(a\) => a && a\.pid === pid\)\) \{ touched = true; return \[k, v\.filter\(\(a\) => !\(a && a\.pid === pid\)\)\]; \}/.test(src));

    /* ---- rule 4 from an Every Run Counts share ---- */
    const C = await mk({ list: [['KING', 'US', { hard: 1500000 }], ['JP1', 'JP', { hard: 50000 }], ['PH1', 'PH', { hard: 49000 }]] });
    await C.admin('backup-now'); const on = await C.admin('cg-switch', { on: true, confirm: 'EVERY RUN ON' });
    const c1 = await C.up('PH1', 10000, 'hard', 'PH'), n1 = (await C.alerts()).alerts.length;    // share 500: PH 49,500
    const c2 = await C.up('PH1', 40000, 'hard', 'PH'), l2 = (await C.alerts()).alerts;           // share 2,000: PH 51,500 > JP 50,000
    ck('A1 rule 4 counts what players see: with Every Run Counts ON, a run below the best whose share moves PH past JP is flagged; a smaller share is not',
      on.status === 200 && c1.status === 200 && c2.status === 200 && n1 === 0 && l2.length === 1 && rulesOf(l2[0]) === '4' && l2[0].rules[0].from === 3 && l2[0].rules[0].to === 2 && c2.data.isNewBest === false,
      on.status + ' ' + n1 + ' ' + JSON.stringify(l2[0] && l2[0].rules));

    /* ================= old storage layout ================= */
    const O = await mk({ v2: false });
    const o1 = await O.up('UHIGH', 300001, 'hard', 'US'), o2 = await O.up('UE', 40001, 'easy', 'US'), o3 = await O.up('PH1', 140000, 'hard', 'PH'), o4 = await O.up('UJUMP', 30000, 'medium', 'US');
    const OL = await O.alerts();
    ck('A4 old layout: rules 1, 3 and 4 flag the same way; a normal score does not',
      [o1, o2, o3, o4].every((x) => x.status === 200) && OL.alerts.length === 3 && OL.alerts.map(rulesOf).join(' ') === '4 3 1' && OL.alerts[0].rules[0].from === 3 && OL.alerts[0].rules[0].to === 2, OL.alerts.map(rulesOf).join(' '));
    const oc = await O.admin('alert-check', { id: OL.alerts[2].id }), OL2 = await O.alerts();
    ck('A4 old layout: "Looks legit" works and is saved', oc.status === 200 && OL2.unchecked === 2 && (O.g.map.get('alerts') || []).find((a) => a.id === OL.alerts[2].id).checkedAt === now);
    /* at most 300 */
    const fake = []; for (let i = 0; i < 300; i++) fake.push({ id: 'f' + i, pid: 'p' + i, tag: 'T', name: 'F' + i, country: 'US', difficulty: 'hard', score: 1, level: 1, prevBest: 0, rules: [{ r: 1 }], at: now - 1000 + i, checkedAt: i % 2 ? now - 1000 + i : null });   // f0 (the oldest) is not checked, f1 is
    const K = await mk({ v2: false, extra: (m) => m.set('alerts', fake) });
    await K.up('UHIGH', 300001, 'hard', 'US');
    const KL = (K.g.map.get('alerts') || []);
    ck('A3 at most 300 alerts are kept: a new one drops the oldest CHECKED alert first (f1), never an older unchecked one (f0)', KL.length === 300 && KL.some((a) => a.id === 'f0') && !KL.some((a) => a.id === 'f1') && KL.some((a) => a.id === 'f2') && KL[KL.length - 1].score === 300001, KL.length);

    /* ================= A5 the page ================= */
    try {
      const Pg = await mk();
      await Pg.up('UHIGH', 300001, 'hard', 'US'); await Pg.up('DE1', 20000, 'hard', 'DE');
      const sent = [], replies = [];
      const fetchImpl = async (url, init = {}) => {
        const h = new Headers(init.headers || {}); h.set('x-admin-token', 'pw');
        sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
        const res = await workerMod.default.fetch(new Request(new URL(url, ORIGIN), { method: init.method || 'GET', headers: h, body: init.body }), Pg.env, {});
        const txt = await res.clone().text(); try { replies.push({ url: String(url), status: res.status, data: JSON.parse(txt) }); } catch (e) {}
        return res;
      };
      const tick = () => new Promise((r) => setImmediate(r));
      const until = async (fn, n = 20000) => { for (let i = 0; i < n; i++) { if (fn()) return true; await tick(); } return false; };
      const gp = bootAdmin(scriptsOf(adminHtml), { fetchImpl }), E = new Proxy({}, { get: (t, k) => gp.byId(k) });
      await until(() => kids(E.alerts).length >= 2);
      const cards = kids(E.alerts);
      ck('A5 page: on opening, ALERTS lists the alerts (newest first) and the badge shows how many to check',
        gp.errors.length === 0 && cards.length === 2 && /DE1 #/.test(cards[0].textContent) && /UHIGH #/.test(cards[1].textContent) && E.alertBadge.hidden === false && E.alertBadge.textContent === '2',
        gp.errors.join('; ') + ' cards ' + cards.length + ' badge ' + E.alertBadge.textContent + '/' + E.alertBadge.hidden);
      ck('A5 page: each card shows country, difficulty, score, level, previous best, the rule in words, when, and TO CHECK',
        /US · hard · score 300,001 · level 19 · previous best 250,000/.test(cards[1].textContent) && /DE · hard · score 20,000 · level \d+ · previous best none/.test(cards[0].textContent) && /new best above 300,000/.test(cards[1].textContent) && /TO CHECK/.test(cards[1].textContent)
        && /moved DE up the World Grid \(new, at #\d\)/.test(cards[0].textContent), cards[1].textContent.slice(0, 200));
      const legit = findBtn(cards[1], 'LOOKS LEGIT'); legit.onclick.call(legit);
      await until(() => replies.some((r) => /alert-check$/.test(r.url)) && E.alertBadge.textContent === '1');
      const chk = sent.find((s) => /alert-check$/.test(s.url));
      ck('A5 page: LOOKS LEGIT sends that alert\'s id; the card turns CHECKED and the badge drops to 1',
        chk && chk.body.id === (await Pg.alerts()).alerts[1].id && E.alertBadge.textContent === '1' && /CHECKED/.test(kids(E.alerts)[1].textContent) && !findBtn(kids(E.alerts)[1], 'LOOKS LEGIT'), E.alertBadge.textContent);
      const rmb = findBtn(kids(E.alerts)[0], 'REMOVE PILOT'), n0 = sent.length; rmb.onclick.call(rmb);
      await until(() => replies.some((r) => /remove-pilots-dry-run$/.test(r.url)) && E.rpGo.hidden === false);
      const dr = sent.slice(n0).find((s) => /remove-pilots-dry-run$/.test(s.url));
      ck('A5 page: REMOVE PILOT fills REMOVE PILOTS with NAME #TAG and runs its DRY RUN (nothing removed; the phrase box appears)',
        E.rpLines.value === 'DE1 #' + await Pg.tag('DE1') && dr && util.isDeepStrictEqual(dr.body, { lines: ['DE1 #' + await Pg.tag('DE1')] }) && E.rpGo.hidden === false && !sent.some((s) => /remove-pilots$/.test(s.url)), E.rpLines.value);
    } catch (e) { ck('A5 page: the page flow ran', false, String(e.stack || e).slice(0, 300)); }
    const A = scriptsOf(adminHtml).join('\n'), app = adminHtml.slice(adminHtml.indexOf('<div id="app" hidden>'));
    ck('A5 ALERTS is the first section, with the badge, above HOW FLUX IS DOING', app.indexOf('<h2>ALERTS<span id="alertBadge" class="alertBadge" hidden') > 0 && app.indexOf('<h2>ALERTS') < app.indexOf('<h2>HOW FLUX IS DOING</h2>')
      && app.indexOf('<h2>ALERTS') === app.indexOf('<h2>'));
    const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'));
    ck('A5 guide: "Score alerts" with the four rules, Looks legit, Remove pilot (dry run), 90 days', /<h3>Score alerts<\/h3>/.test(guide) && /above <b>300,000<\/b>/.test(guide) && /more than <b>3×<\/b>/.test(guide) && /new <b>#1<\/b>/.test(guide) && /<b>World Grid<\/b>/.test(guide) && /<b>Looks legit<\/b>/.test(guide) && /<b>dry run<\/b>/.test(guide) && /90 days/.test(guide));
    ck('A5 privacy policy (both copies): moderation records name score alerts, what they hold, kept until checked then 90 days, deleted on request',
      PRIV.every((h) => /Unusual-score notes and score alerts/.test(h) && /becomes\n#1 on a leaderboard, or moves a country up the World Grid/.test(h) && /Score alerts are kept until checked and then for 90 days/.test(h) && /deletion request/.test(h)) && PRIV[0] === PRIV[1]);
    let gameSame = false; try { execFileSync('git', ['-C', ROOT, 'diff', '--quiet', 'origin/main', '--', 'public/play', 'public/index.html']); gameSame = true; } catch (e) { gameSame = false; }
    ck('A5 no change to the game or the Gateway (public/play and public/index.html equal origin/main)', gameSame);
    ck('A5 addEventListener( pinned: 17 in the game, 2 in admin.html; text only (no innerHTML)', (GAME_HTML.match(/addEventListener\(/g) || []).length === 17 && (adminHtml.match(/addEventListener\(/g) || []).length === 2 && !/innerHTML/.test(A),
      (adminHtml.match(/addEventListener\(/g) || []).length);
  } catch (e) { ck('suite ran to the end', false, String(e.stack || e).slice(0, 600)); }
  finally { Date.now = realNow; console.error = realErr; }
  return { F, failed };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ workerMod: realMod, adminHtml: ADMIN_HTML });

console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { worker = (s) => s, admin = (s) => s }) {
  const w2 = worker(WORKER_SRC), a2 = admin(ADMIN_HTML);
  if (w2 === WORKER_SRC && a2 === ADMIN_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-sa-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ workerMod: Object.assign({ __src: w2 }, mod), adminHtml: a2, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('rule 1 at 400,000 instead of 300,000', 'A1 rule 1: a new best of 300,001', { worker: rep('const ALERT_HIGH = 300_000;', 'const ALERT_HIGH = 400_000;') });
await control('rule 1 also "at" 300,000', 'A1 rule 1: a new best of exactly 300,000', { worker: rep('if (isNewBest && score > ALERT_HIGH)', 'if (isNewBest && score >= ALERT_HIGH)') });
await control('rule 1 on any score, not only a new best', 'A1 rule 1 ...a later new best above 300,000 is flagged again', { worker: rep('if (isNewBest && score > ALERT_HIGH)', 'if (score > ALERT_HIGH)') });
await control('rule 2 missing', 'A1 rule 2: above 50,000', { worker: rep('  if (isNewBest && score > ALERT_JUMP_MIN && prevBest > 0 && score > prevBest * ALERT_JUMP) out.push({ r: 2 });\n', '') });
await control('rule 2 at 3x or more', 'A1 rule 2: exactly 3x', { worker: rep('score > prevBest * ALERT_JUMP)', 'score >= prevBest * ALERT_JUMP)') });
await control('rule 2 without the 50,000 floor', 'A1 rule 2: 5x the previous best but not above 50,000', { worker: rep('ALERT_JUMP_MIN = 50_000;', 'ALERT_JUMP_MIN = 0;') });
await control('rule 2 on a first score (no previous best)', 'A1 normal scores make no alert', { worker: rep('prevBest > 0 && score > prevBest * ALERT_JUMP', '(prevBest === 0 || score > prevBest * ALERT_JUMP)') });
await control('rule 3 missing', 'A1 rule 3: a new #1', { worker: rep('  if (isTop && !wasTop) out.push({ r: 3 });\n', '') });
await control('rule 3 also when already #1', 'A1 rule 3: the old #1 taking it back', { worker: rep('if (isTop && !wasTop) out.push', 'if (isTop) out.push') });
await control('rule 4 missing', 'A1 rule 4: PH passing', { worker: rep('  if (grid) out.push({ r: 4, from: grid.from, to: grid.to });\n', '') });
await control('rule 4 also when no country is passed', 'A1 normal scores make no alert', { worker: rep('return passed > 0 ? {', 'return passed >= 0 ? {') });
await control('rule 4 ignores Every Run Counts (not what players see)', 'A1 rule 4 counts what players see', { worker: (s) => s.split('alertGridOrder(this.cgCountries(this.countryList()))').join('alertGridOrder(this.countryList())') });
await control('restricted pilots alerted too', 'A1 a restricted pilot', { worker: (s) => s.split('const alertOn = !ownGet(o.restricted, pid);').join('const alertOn = true;') });
await control('an alert that cannot be written fails the upload', 'A2 an alert that cannot be written', { worker: rep('    try { await this.state.storage.put({ [ALERT_KEY]: next }); } catch (e) { /* the score is already saved; the alert is best-effort */ }', '    await this.state.storage.put({ [ALERT_KEY]: next });') });
await control('"alerts" written on every upload', 'A1 ...and write nothing more', { worker: rep('      if (rules.length) await o.saveAlert(', '      await o.state.storage.put({ alerts: o.alerts }); if (rules.length) await o.saveAlert(') });
await control('no admin login on "Looks legit" (adminDO still checks it: the route check catches it)', 'A3 the routes are in the admin map behind requireAdmin', { worker: rep('async function adminAlertCheck(request, env) {   // SCORE ALERTS\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminAlertCheck(request, env) {   // SCORE ALERTS') });
await control('no admin login on the list', 'A3 admin only', { worker: rep('"/api/admin/alerts":            () => adminDO(request, env, "/admin-alerts", {}),', '"/api/admin/alerts":            () => forwardToDO(request, env, "/admin-alerts", { method: "POST", body: "{}" }),') });
await control('"Looks legit" not saved', 'A3 "Looks legit" marks it checked', { worker: rep('    await this.state.storage.put({ [ALERT_KEY]: next });\n    this.alerts = next;\n    return json({ ok: true, checkedAt: now });', '    this.alerts = next;\n    return json({ ok: true, checkedAt: now });') });
await control('oldest first (the newest alert is no longer on top)', 'A1 rule 2: above 50,000', { worker: rep('kept.slice().sort((a, b) => b.at - a.at)', 'kept.slice().sort((a, b) => a.at - b.at)') });
await control('REMOVE PILOTS leaves the alert open', 'A3 ...after REMOVE NOW', { worker: rep('const nextAlerts = alertsCheckPids(o.alerts, pids, Date.now(), "removed");', 'const nextAlerts = o.alerts;') });
await control('checked alerts never deleted', 'A3 90+ days after checking', { worker: rep('const ALERT_CHECKED_KEEP_MS = 90 * 24 * 3600 * 1000;', 'const ALERT_CHECKED_KEEP_MS = 900 * 24 * 3600 * 1000;') });
await control('unchecked alerts deleted after 90 days too', 'A3 90+ days after checking', { worker: rep('!(a.checkedAt && now - a.checkedAt >= ALERT_CHECKED_KEEP_MS)', '!(now - (a.checkedAt || a.at) >= ALERT_CHECKED_KEEP_MS)') });
await control('a privacy deletion keeps the alerts', 'A3 a privacy deletion', { worker: rep('nextAlerts = (await o.alertsLoad()).filter((x) => x && x.pid !== pid);', 'nextAlerts = await o.alertsLoad();') });
await control('the cap drops the oldest alert, checked or not', 'A3 at most 300', { worker: rep('const i = out.findIndex((a) => a.checkedAt);', 'const i = 0;') });
await control('old layout: no alerts', 'A4 old layout: rules 1, 3 and 4', { worker: rep('      if (rules.length) await this.saveAlert(', '      if (false) await this.saveAlert(') });
await control('page: badge never shown', 'A5 page: on opening', { admin: rep("badge.hidden = !d.unchecked;", 'badge.hidden = true;') });
await control('page: LOOKS LEGIT posts to the wrong route', 'A5 page: LOOKS LEGIT', { admin: rep("await call('alert-check', { id: a.id });", "await call('dismiss-flag', { id: a.id });") });
await control('page: REMOVE PILOT removes without a dry run', 'A5 page: REMOVE PILOT', { admin: rep("$('rpLines').value = (a.nameNow || a.name) + ' #' + (a.tagNow || a.tag); guard(rpDryRun)();", "$('rpLines').value = (a.nameNow || a.name) + ' #' + (a.tagNow || a.tag);") });
await control('page: ALERTS below HOW FLUX IS DOING', 'A5 ALERTS is the first section', { admin: (s) => s.replace('  <h2>HOW FLUX IS DOING</h2>\n  <div id="insights"></div>\n', '').replace('  <div id="status" role="status" aria-live="polite"></div>\n', '  <div id="status" role="status" aria-live="polite"></div>\n  <h2>HOW FLUX IS DOING</h2>\n  <div id="insights"></div>\n') });
await control('page: an event listener instead of a property handler', 'A5 addEventListener', { admin: rep("$('rpDry').onclick = guard(rpDryRun);", "$('rpDry').addEventListener('click', guard(rpDryRun));") });

console.log(main.F || NC ? '\nFAILED: ' + main.F + ' check(s), ' + NC + ' control(s) not caught' : '\nALL PASS (score alerts) + every negative control caught');
process.exit(main.F || NC ? 1 : 0);
