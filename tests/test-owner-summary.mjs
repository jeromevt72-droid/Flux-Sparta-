// OWNER SUMMARY: status, top findings by fixed rules, and the "Export report" text.
// Real worker.js (rule engine + routes) and the real admin.html script. In the release gate (auto-discovered).
//   C  confidence labels at 29/30/99/100/499/500
//   R  every rule fires at its threshold and minimum sample, and not just outside them
//   S  status: NOT ENOUGH DATA YET / HEALTHY / NEEDS ATTENTION (high rule >= PRELIMINARY, or an operational problem)
//   K  ranking: severity, then confidence, then effect size; top 3, one per rule
//   M  every finding has a "Measured:" fact (numbers, period) and a fixed "Possible reason:" hint
//   E  export text: last 7 and last 30 days, status, findings, operations
//   P  export has no personal data (ids, analytics codes, names, tags, device codes, IPs) and suppresses small cells
//   A  /api/admin/insights and the summary's insights need the session (+ CSRF) or the password
//   W  read-only: every data store is identical before and after (the login bookkeeping instance aside)
//   U  admin page: status + findings drawn as text at the top of TODAY and PLAYER STATS; EXPORT REPORT copies,
//      or shows a selectable box without a clipboard; property handlers only
//   G  the GUIDE and the worker comment document the rules
// Ends with negative controls: each re-inserted defect must be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', PW = 'owner-pass-123', DAY = 86400000;
const tick = () => new Promise((r) => setImmediate(r));

/* ---------- synthetic reports (for the rule edges) ---------- */
const TODAY = '2026-10-20', TD = Date.parse(TODAY + 'T00:00:00Z') / DAY;
const ds = (off) => new Date((TD + off) * DAY).toISOString().slice(0, 10);
function B() {
  const days = {}, cohorts = {};
  const add = (m, off, g, v) => { const d = m[off] || (m[off] = {}), o = d[g] || (d[g] = {}); for (const k of Object.keys(v)) o[k] = (o[k] || 0) + v[k]; };
  const api = {
    day(off, g, v) { add(days, off, g, v); return api; },
    coh(off, g, v) { add(cohorts, off, g, v); return api; },
    rep() {
      return { today: TODAY, days: Object.keys(days).map(Number).sort((a, b) => a - b).map((o) => ({ date: ds(o), groups: days[o] })),
        cohorts: Object.keys(cohorts).map(Number).sort((a, b) => a - b).map((o) => ({ date: ds(o), age: -o, groups: cohorts[o] })) };
    } };
  return api;
}
// A big, healthy base: no rule fires.
function healthy(b = B()) {
  return b.coh(-5, 'all', { n: 200, d1: 80 }).coh(-5, 's:tiktok', { n: 100, d1: 40 }).coh(-5, 's:direct', { n: 100, d1: 40 })
    .day(-3, 'all', { active: 300, new: 200, first: 180, runs: 900, sec: 90000, shares: 30, opens: 400, home: 60 })
    .day(-10, 'all', { active: 300, runs: 900, shares: 30, opens: 400, home: 60 })
    .day(-3, 's:tiktok', { new: 100, active: 150 }).day(-3, 's:direct', { new: 100, active: 150 })
    .day(-3, 'c:PH', { new: 120 }).day(-3, 'c:JP', { new: 80 })
    .day(-3, 'p:easy:0', { runs: 100, sec: 6000, hit: 500, wrong: 100, lost: 20 }).day(-3, 'p:easy:1', { runs: 60, sec: 3000, hit: 300, wrong: 60, lost: 10 });
}
const OPS_OK = { exceptions: { total: 0, flags: 0, delivery: 0 }, backup: { ok: true, lastDailyAt: Date.parse('2026-10-20T00:10:00Z') }, security: { failed24h: 0, lockedClients: 0, safetyUntil: 0, recent: [] } };
const ops = (o) => Object.assign({}, OPS_OK, o);

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { if (typeof k === 'object') { for (const [kk, vv] of Object.entries(k)) this.map.set(kk, structuredClone(vv)); } else this.map.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
  async list(o = {}) {
    let keys = [...this.map.keys()].sort();
    if (o.prefix) keys = keys.filter((k) => k.startsWith(o.prefix));
    if (o.start !== undefined) keys = keys.filter((k) => k >= o.start);
    if (o.startAfter !== undefined) keys = keys.filter((k) => k > o.startAfter);
    if (o.end !== undefined) keys = keys.filter((k) => k < o.end);
    if (o.limit) keys = keys.slice(0, o.limit);
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async transaction(fn) { const before = new Map(this.map); try { return await fn(this); } catch (e) { this.map = before; throw e; } }
}
let ipSeq = 0; const freshIp = () => '100.64.' + ((++ipSeq >> 8) & 255) + '.' + (ipSeq & 255);
function makeEnv(LeaderboardDO, clock) {
  const instances = new Map();
  const env = { ADMIN_TOKEN: PW, LEADERBOARD_DO: { idFromName: (n) => n, _instances: instances, get(id) {
    if (!instances.has(id)) { const o = new LeaderboardDO({ storage: new FakeStorage(), blockConcurrencyWhile: (fn) => fn() }, env); o.nowMs = () => clock.now; instances.set(id, o); }
    const o = instances.get(id);
    return { fetch(url, init) { const run = () => o.fetch(new Request(url, init)); const r = (o._chain || Promise.resolve()).then(run, run); o._chain = r.then(() => {}, () => {}); return r; } }; } } };
  return env;
}
const snapshot = (env) => { const out = {}; for (const [id, o] of env.LEADERBOARD_DO._instances) if (id !== 'admin-auth') out[id] = [...o.state.storage.map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)); return JSON.stringify(out); };

/* ---------- a small DOM, enough for the admin script to draw into ---------- */
function miniDom() {
  const ids = {};
  class N {
    constructor(tag, text) { this.tagName = String(tag).toUpperCase(); this.children = []; this.className = ''; this._t = text || ''; this.hidden = false; this.value = ''; this.attrs = {}; this.style = {}; this.disabled = false; }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._t = String(v); this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); } focus() { this.focused = true; } select() { this.selected = true; }
    remove() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); } }
    addEventListener() {} all() { return [this].concat(...this.children.map((c) => c.all())); }
  }
  const document = { getElementById: (id) => ids[id] || (ids[id] = new N('div')), createElement: (t) => new N(t), createTextNode: (t) => new N('#text', String(t)), body: new N('body'), visibilityState: 'visible' };
  return { N, document, ids };
}
function bootAdmin(adminHtml) {
  const dom = miniDom();
  const fetch = async () => ({ status: 401, ok: false, json: async () => ({}), headers: { get: () => null } });
  const ctx = { document: dom.document, navigator: { onLine: true }, fetch, console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, confirm: () => true, prompt: () => null, alert() {},
    Promise, JSON, Date, Math, Number, String, Object, Array, Error, URL, isFinite, isNaN };
  ctx.window = ctx; vm.createContext(ctx);
  const errors = [];
  for (const s of scriptsOf(adminHtml)) { try { vm.runInContext(s, ctx, { timeout: 5000 }); } catch (e) { errors.push(String(e).slice(0, 200)); } }
  return { ctx, dom, errors, S: ctx.FLUX_ADMIN_STATS || {} };
}

async function suite({ adminHtml, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const LB = workerMod.LeaderboardDO, OI = LB.ownerInsights, conf = LB.oiConfidence, RULES = LB.ownerRules || [];
  if (typeof OI !== 'function') { ck('engine reachable (LeaderboardDO.ownerInsights)', false); return { F, failed }; }
  const run = (rep, o = OPS_OK, rules) => OI(rep, o, rules);
  const fired = (ins, id) => { const c = (ins.checked || []).find((r) => r.id === id); return !!(c && c.fired); };
  const find = (ins, id) => (ins.findings || []).find((f) => f.id === id);
  const allFindings = [];
  const keep = (ins) => { (ins.findings || []).forEach((f) => allFindings.push(f)); return ins; };

  /* ---------------- C: confidence ---------------- */
  try {
    const got = [0, 29, 30, 99, 100, 499, 500, 5000].map(conf).join(',');
    ck('C1 confidence: 29 INSUFFICIENT, 30 PRELIMINARY, 99 PRELIMINARY, 100 MODERATE, 499 MODERATE, 500 STRONG',
      got === 'INSUFFICIENT,INSUFFICIENT,PRELIMINARY,PRELIMINARY,MODERATE,MODERATE,STRONG,STRONG', got);
  } catch (e) { ck('confidence section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- R: every rule at its edges ---------------- */
  try {
    const base = run(healthy().rep());
    ck('R0 the healthy base fires nothing and is HEALTHY', base.status === 'HEALTHY' && base.firedCount === 0 && RULES.length >= 11, base.status + ' ' + (base.checked || []).filter((c) => c.fired).map((c) => c.id));
    // D1_LOW: below 20%, min 30 players (day 1 over)
    const d1 = (n, back) => keep(run(B().coh(-5, 'all', { n, d1: back }).rep()));
    const a = d1(30, 5), b = d1(30, 6), c = d1(29, 0);
    ck('R-D1_LOW fires at 16.7% of 30 (PRELIMINARY), not at exactly 20% of 30, not with 29 players',
      fired(a, 'D1_LOW') && find(a, 'D1_LOW').confidence === 'PRELIMINARY' && find(a, 'D1_LOW').n === 30 && !fired(b, 'D1_LOW') && !fired(c, 'D1_LOW'), [fired(a, 'D1_LOW'), fired(b, 'D1_LOW'), fired(c, 'D1_LOW')].join('/'));
    const d1c = run(B().coh(-1, 'all', { n: 100, d1: 0 }).rep());
    ck('R-D1_LOW only counts players whose day 1 is over (started yesterday: not counted, in the rule or the export)', !fired(d1c, 'D1_LOW') && d1c.main.day1Players.n === 0 && /Came back on day 1: — /.test(d1c.export), (d1c.export.match(/Came back on day 1: [^\n]*/) || [''])[0]);
    // D1_SOURCE_LOW: 10 points or more below the other sources, min 30 in the source (and in the rest)
    const src = (n, back) => keep(run(B().coh(-5, 'all', { n: n + 30, d1: back + 6 }).coh(-5, 's:tiktok', { n, d1: back }).coh(-5, 's:direct', { n: 30, d1: 6 }).rep()));
    const s1 = src(30, 3), s2 = src(30, 4), s3 = src(29, 0);
    ck('R-D1_SOURCE_LOW fires at 10% vs 20% (10 points), not at 13% vs 20%, not with 29 in the source',
      fired(s1, 'D1_SOURCE_LOW') && /TIKTOK/.test(find(s1, 'D1_SOURCE_LOW').title) && !fired(s2, 'D1_SOURCE_LOW') && !fired(s3, 'D1_SOURCE_LOW'), [fired(s1, 'D1_SOURCE_LOW'), fired(s2, 'D1_SOURCE_LOW'), fired(s3, 'D1_SOURCE_LOW')].join('/'));
    // FIRST_RUN_LOW: under 60% of last week's new players start a run, min 30
    const fr = (n, first) => keep(run(B().day(-2, 'all', { new: n, first, active: n }).rep()));
    const f1 = fr(30, 17), f2 = fr(30, 18), f3 = fr(29, 0), f4 = run(B().day(-9, 'all', { new: 100, first: 0 }).rep());
    ck('R-FIRST_RUN_LOW fires at 57% of 30, not at 60%, not with 29, not for new players outside the last 7 complete days',
      fired(f1, 'FIRST_RUN_LOW') && !fired(f2, 'FIRST_RUN_LOW') && !fired(f3, 'FIRST_RUN_LOW') && !fired(f4, 'FIRST_RUN_LOW'), [fired(f1, 'FIRST_RUN_LOW'), fired(f2, 'FIRST_RUN_LOW'), fired(f3, 'FIRST_RUN_LOW'), fired(f4, 'FIRST_RUN_LOW')].join('/'));
    const ft = run(B().day(0, 'all', { new: 100, first: 0 }).rep());
    ck('R-FIRST_RUN_LOW ignores today (a half day)', !fired(ft, 'FIRST_RUN_LOW'));
    // RUNS_DROP: runs per player per day down 20% or more, min 30 player-days in both weeks
    const rd = (act, runs) => keep(run(B().day(-3, 'all', { active: act, runs }).day(-10, 'all', { active: act, runs: act * 2.5 }).rep()));
    const r1 = rd(30, 60), r2 = rd(30, 61), r3 = rd(29, 29 * 1.5);
    ck('R-RUNS_DROP fires at -20% (2.0 vs 2.5), not at -18.7%, not with 29 player-days',
      fired(r1, 'RUNS_DROP') && !fired(r2, 'RUNS_DROP') && !fired(r3, 'RUNS_DROP'), [fired(r1, 'RUNS_DROP'), fired(r2, 'RUNS_DROP'), fired(r3, 'RUNS_DROP')].join('/'));
    // SHORT_RUNS: a difficulty's average run under 30 s, min 30 runs
    const sr = (runs, sec) => keep(run(B().day(-12, 'p:hard:0', { runs, sec }).rep()));
    const h1 = sr(30, 870), h2 = sr(30, 900), h3 = sr(29, 0);
    ck('R-SHORT_RUNS fires at 29 s over 30 HARD runs, not at 30 s, not with 29 runs',
      fired(h1, 'SHORT_RUNS') && /HARD/.test(find(h1, 'SHORT_RUNS').title) && !fired(h2, 'SHORT_RUNS') && !fired(h3, 'SHORT_RUNS'), [fired(h1, 'SHORT_RUNS'), fired(h2, 'SHORT_RUNS'), fired(h3, 'SHORT_RUNS')].join('/'));
    // MISS_JUMP: misses/min x1.5 and +2/min from one step to the next, min 30 runs at both
    const mj = (runs1, wrong1, sec0 = 600, wrong0 = 40) => keep(run(B().day(-4, 'p:easy:0', { runs: 30, sec: sec0, wrong: wrong0, lost: 0 }).day(-4, 'p:easy:1', { runs: runs1, sec: 600, wrong: wrong1, lost: 0 }).rep()));
    const m1 = mj(30, 60), m2 = mj(30, 59), m3 = mj(29, 90), m4 = mj(30, 30, 600, 20);
    ck('R-MISS_JUMP fires at 4 -> 6 misses/min (x1.5, +2), not at 5.9, not with 29 runs at the step, not at 2 -> 3 (x1.5 but +1)',
      fired(m1, 'MISS_JUMP') && /step 1/.test(find(m1, 'MISS_JUMP').title) && !fired(m2, 'MISS_JUMP') && !fired(m3, 'MISS_JUMP') && !fired(m4, 'MISS_JUMP'),
      [fired(m1, 'MISS_JUMP'), fired(m2, 'MISS_JUMP'), fired(m3, 'MISS_JUMP'), fired(m4, 'MISS_JUMP')].join('/'));
    // SHARE_CHANGE: 50% or more up or down (and 0.5 points), min 100 runs in both weeks
    const sh = (runs, a1, b1) => keep(run(B().day(-2, 'all', { runs, shares: a1 }).day(-9, 'all', { runs, shares: b1 }).rep()));
    const c1 = sh(100, 5, 10), c2 = sh(100, 6, 10), c3 = sh(99, 0, 10), c4 = sh(100, 15, 10);
    ck('R-SHARE_CHANGE fires at 5% vs 10% (fell) and 15% vs 10% (rose), not at 6% vs 10%, not with 99 runs',
      fired(c1, 'SHARE_CHANGE') && /fell/.test(find(c1, 'SHARE_CHANGE').title) && fired(c4, 'SHARE_CHANGE') && /rose/.test(find(c4, 'SHARE_CHANGE').title) && !fired(c2, 'SHARE_CHANGE') && !fired(c3, 'SHARE_CHANGE'),
      [fired(c1, 'SHARE_CHANGE'), fired(c2, 'SHARE_CHANGE'), fired(c3, 'SHARE_CHANGE'), fired(c4, 'SHARE_CHANGE')].join('/'));
    // HOME_LOW: under 5% of opens from the Home Screen app, min 100 opens
    const ho = (opens, home) => keep(run(B().day(-20, 'all', { opens, home }).rep()));
    const o1 = ho(100, 4), o2 = ho(100, 5), o3 = ho(99, 0);
    ck('R-HOME_LOW fires at 4% of 100 opens, not at 5%, not with 99 opens', fired(o1, 'HOME_LOW') && find(o1, 'HOME_LOW').confidence === 'MODERATE' && !fired(o2, 'HOME_LOW') && !fired(o3, 'HOME_LOW'), [fired(o1, 'HOME_LOW'), fired(o2, 'HOME_LOW'), fired(o3, 'HOME_LOW')].join('/'));
    // operational
    const e1 = keep(run(B().rep(), ops({ exceptions: { total: 1, flags: 0, delivery: 1 } }))), e0 = run(B().rep(), ops({ exceptions: { total: 0, flags: 0, delivery: 0 } }));
    ck('R-OPS_EXCEPTIONS fires at 1 waiting (a direct count), not at 0', fired(e1, 'OPS_EXCEPTIONS') && find(e1, 'OPS_EXCEPTIONS').confidence === 'DIRECT COUNT' && !fired(e0, 'OPS_EXCEPTIONS'));
    const b1 = keep(run(B().rep(), ops({ backup: { ok: false, stale: true, lastDailyAt: null, lastError: { at: Date.parse('2026-10-20T01:00:00Z'), error: 'x' } } }))),
      b0 = run(B().rep(), ops({ backup: { ok: true } })), bn = run(B().rep(), ops({ backup: null }));
    ck('R-OPS_BACKUP fires when backups are not OK (stale / failed), not when OK or unavailable', fired(b1, 'OPS_BACKUP') && /failed/.test(find(b1, 'OPS_BACKUP').measured) && !fired(b0, 'OPS_BACKUP') && !fired(bn, 'OPS_BACKUP'));
    const l1 = keep(run(B().rep(), ops({ security: { failed24h: 10, lockedClients: 0 } }))), l0 = run(B().rep(), ops({ security: { failed24h: 9, lockedClients: 0 } })),
      l2 = run(B().rep(), ops({ security: { failed24h: 1, lockedClients: 1 } }));
    ck('R-OPS_LOGINS fires at 10 wrong passwords in 24 h or any locked device, not at 9', fired(l1, 'OPS_LOGINS') && fired(l2, 'OPS_LOGINS') && !fired(l0, 'OPS_LOGINS'));
  } catch (e) { ck('rules section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- S: status ---------------- */
  try {
    const empty = run(B().rep());
    ck('S1 no data, no operational problem -> NOT ENOUGH DATA YET (main samples INSUFFICIENT)', empty.status === 'NOT ENOUGH DATA YET' && empty.main.day1Players.confidence === 'INSUFFICIENT', empty.status);
    const thin = run((() => { const b = B(); b.coh(-5, 'all', { n: 29, d1: 12 }).day(-3, 'all', { active: 300, new: 200, first: 180, runs: 900, sec: 90000 }).day(-10, 'all', { active: 300, runs: 900 }); return b.rep(); })());
    const ok30 = run((() => { const b = B(); b.coh(-5, 'all', { n: 30, d1: 12 }).day(-3, 'all', { active: 300, new: 200, first: 180, runs: 900, sec: 90000 }).day(-10, 'all', { active: 300, runs: 900 }); return b.rep(); })());
    ck('S2 29 new players with day 1 over -> NOT ENOUGH DATA YET; 30 -> HEALTHY', thin.status === 'NOT ENOUGH DATA YET' && ok30.status === 'HEALTHY', thin.status + ' / ' + ok30.status);
    const wk = run((() => { const b = B(); b.coh(-5, 'all', { n: 200, d1: 80 }).day(-3, 'all', { active: 29 }); return b.rep(); })());
    ck('S2 29 player-days in the last 7 days -> NOT ENOUGH DATA YET', wk.status === 'NOT ENOUGH DATA YET', wk.status);
    const opsA = [ops({ exceptions: { total: 2, flags: 2, delivery: 0 } }), ops({ backup: { ok: false, stale: true } }), ops({ security: { failed24h: 40, lockedClients: 3 } })];
    const sA = opsA.map((o) => run(B().rep(), o).status), sB = opsA.map((o) => run(healthy().rep(), o).status);
    ck('S3 an operational problem (exceptions, backup, failed-login spike) -> NEEDS ATTENTION, even with no data', sA.every((s) => s === 'NEEDS ATTENTION') && sB.every((s) => s === 'NEEDS ATTENTION'), sA.join(',') + ' | ' + sB.join(','));
    const hi = run((() => { const b = healthy(); b.coh(-6, 'all', { n: 300, d1: 0 }); return b.rep(); })());
    ck('S4 a high-severity rule with PRELIMINARY+ confidence (Day-1 return low) -> NEEDS ATTENTION', hi.status === 'NEEDS ATTENTION' && fired(hi, 'D1_LOW'), hi.status);
    const med = run((() => { const b = healthy(); b.day(-12, 'p:hard:0', { runs: 200, sec: 2000 }); return b.rep(); })());
    ck('S5 only a medium rule fired, samples enough -> HEALTHY (the finding is still listed)', med.status === 'HEALTHY' && fired(med, 'SHORT_RUNS') && med.findings.length === 1, med.status);
    const R = (id, severity, n, effect, kind = 'stat') => ({ id, severity, kind, minSample: 0, unit: 'x', title: () => id, reason: () => 'hint ' + id, sample: () => n, check: () => [{ n, effect, measured: 'measured ' + n }] });
    const gate10 = run(healthy().rep(), OPS_OK, [R('HI', 'high', 10, 1)]), gate30 = run(healthy().rep(), OPS_OK, [R('HI', 'high', 30, 1)]);
    ck('S6 a high-severity finding with INSUFFICIENT confidence (n=10) does not make NEEDS ATTENTION; at n=30 it does', gate10.status === 'HEALTHY' && gate10.findings[0].confidence === 'INSUFFICIENT' && gate30.status === 'NEEDS ATTENTION', gate10.status + ' / ' + gate30.status);

    /* ---------------- K: ranking ---------------- */
    const k1 = run(healthy().rep(), OPS_OK, [R('LOW_STRONG', 'low', 900, 9), R('MED_PRE_BIG', 'medium', 40, 0.9), R('MED_STRONG', 'medium', 800, 0.1), R('HIGH_MOD', 'high', 150, 0.1), R('MED_PRE_SMALL', 'medium', 40, 0.5)]);
    ck('K1 ranking: severity first, then confidence, then effect size; top 3 shown of 5 fired',
      k1.findings.map((f) => f.id).join(',') === 'HIGH_MOD,MED_STRONG,MED_PRE_BIG' && k1.firedCount === 5, k1.findings.map((f) => f.id).join(','));
    const k2 = run(healthy().rep(), ops({ exceptions: { total: 1, flags: 1, delivery: 0 } }), [R('HIGH_STRONG', 'high', 900, 5)].concat(RULES.filter((r) => r.id === 'OPS_EXCEPTIONS')));
    ck('K2 an operational finding (direct count) ranks above a STRONG high-severity sample finding', k2.findings.map((f) => f.id).join(',') === 'OPS_EXCEPTIONS,HIGH_STRONG', k2.findings.map((f) => f.id).join(','));
    const many = { id: 'MANY', severity: 'medium', kind: 'stat', minSample: 0, unit: 'x', title: (c) => 'm' + c.k, reason: () => 'r', sample: () => 50, check: () => [{ n: 50, effect: 0.2, k: 1, measured: 'a' }, { n: 50, effect: 0.7, k: 2, measured: 'b' }] };
    const k3 = run(healthy().rep(), OPS_OK, [many]);
    ck('K3 one finding per rule: the biggest effect of that rule', k3.findings.length === 1 && k3.findings[0].title === 'm2', k3.findings.map((f) => f.title).join(','));
  } catch (e) { ck('status section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- M: measured / possible reason ---------------- */
  try {
    const ids = [...new Set(allFindings.map((f) => f.id))].sort();
    const statOk = allFindings.filter((f) => f.kind === 'stat').every((f) => /\d/.test(f.measured) && /\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/.test(f.measured) && /rule:/.test(f.measured));
    const all = allFindings.every((f) => f.measured && f.reason && f.reason.length > 30 && f.reason !== f.measured && /\d/.test(f.measured) && f.sampleText && f.confidence);
    ck('M1 every rule\'s finding has a Measured fact (numbers; sample findings also the period and the rule) and a fixed Possible reason', ids.length === 11 && statOk && all, ids.join(','));
    const two = run(B().rep(), ops({ backup: { ok: false, stale: true } }));
    const again = run(B().rep(), ops({ backup: { ok: false, stale: true } }));
    ck('M2 deterministic: the same data gives the same result', JSON.stringify(two) === JSON.stringify(again));
  } catch (e) { ck('measured section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- E / P: export text (synthetic) ---------------- */
  try {
    const b = healthy(); b.day(-3, 's:rare', { new: 3, active: 3 }).coh(-5, 's:rare', { n: 3, d1: 3 }).day(-3, 'c:QZ', { new: 2 })
      .day(-3, 's:zza', { new: 3 }).day(-3, 's:zzb', { new: 2 }).day(-3, 'p:hard:0', { runs: 3, sec: 30 });
    const ins = run(b.rep(), ops({ exceptions: { total: 1, flags: 1, delivery: 0 } })), t = ins.export || '';
    ck('E1 export: status, the findings with Measured and Possible reason lines, LAST 7 DAYS and LAST 30 DAYS with their dates, operations',
      /^FLUX OWNER REPORT/.test(t) && /STATUS: NEEDS ATTENTION/.test(t) && (t.match(/\n\s+Measured: /g) || []).length === ins.findings.length && (t.match(/\n\s+Possible reason \(a guess, not measured\): /g) || []).length === ins.findings.length
      && t.includes('LAST 7 DAYS (' + ds(-7) + ' to ' + ds(-1) + ', UTC)') && t.includes('LAST 30 DAYS (' + ds(-30) + ' to ' + ds(-1) + ', UTC)') && /OPERATIONS \(now\)/.test(t) && /Exceptions waiting: 1/.test(t), t.slice(0, 80));
    ck('E2 export numbers: 7 days show 200 new players (90% started a run), 900 runs, 1m 40s average run; sources and countries listed', /New players: 200 · started a first run: 90%/.test(t) && /Runs: 900 · runs per player per day: 3\.0 · average run: 1m 40s/.test(t) && /TIKTOK 100 new, day 1 40%/.test(t) && /PH 120 new/.test(t), (t.match(/New players: [^\n]*/) || [''])[0]);
    ck('P1 small cells: a source with 3 players and a country with 2 are not named; groups under 5 are merged into "other"; "other" under 5 shows no numbers; GAMEPLAY under 5 runs shows no numbers',
      !/RARE|\bZZA\b|\bZZB\b|\bQZ\b/.test(t) && /other \(3\) 8 new/.test(t) && /other: fewer than 5 new players/.test(t) && /HARD fewer than 5 runs/.test(t), (t.match(/By source: [^\n]*/) || [''])[0]);
  } catch (e) { ck('export section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- real worker: routes, auth, privacy, read-only ---------------- */
  let realIns = null;
  try {
    const clock = { now: Date.parse('2026-10-20T15:00:00Z') }, env = makeEnv(LB, clock), worker = workerMod.default;
    const req = async (p, { body, headers = {}, ip = freshIp(), cookie, csrf = true } = {}) => {
      const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers };
      if (csrf) h['X-FLUX-Admin'] = '1'; if (cookie) h.Cookie = 'flux_admin=' + cookie;
      const res = await worker.fetch(new Request(ORIGIN + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) }), env, {});
      let data = null; try { data = await res.json(); } catch (e) {} return { status: res.status, data, setCookie: res.headers.get('set-cookie') || '' };
    };
    const pids = { tiktok: [], direct: [], rare: [] }, names = ['TITAN', 'NOVA7', 'ZEPHYR9'];
    const start = clock.now - 6 * DAY;
    for (const [srcName, n, country] of [['tiktok', 40, 'PH'], ['direct', 35, 'JP'], ['rare', 3, 'IS']]) for (let i = 0; i < n; i++) pids[srcName].push(crypto.randomUUID());
    clock.now = start;
    for (const [srcName, country] of [['tiktok', 'PH'], ['direct', 'JP'], ['rare', 'IS']]) for (const pid of pids[srcName]) {
      await req('/api/events', { body: { pid, src: srcName, country, events: [{ e: 'open', home: srcName === 'direct' }, { e: 'first_run' }, { e: 'run_end', sec: 75, lvl: 2, diff: 'easy' },
        { e: 'play', diff: 'easy', st: 0, sec: 60, hit: 30, wrong: 6, lost: 1 }, { e: 'play', diff: 'easy', st: 1, sec: 15, hit: 8, wrong: 2, lost: 1 }, { e: 'share' }] } });
    }
    clock.now = start + DAY;
    for (const pid of pids.tiktok.slice(0, 20)) await req('/api/events', { body: { pid, src: 'tiktok', country: 'PH', events: [{ e: 'open' }, { e: 'run_end', sec: 90, lvl: 2, diff: 'easy' }] } });
    for (let i = 0; i < names.length; i++) await req('/api/submit-score', { body: { playerId: pids.tiktok[i], name: names[i], score: 50, level: 1, difficulty: 'easy', country: 'PH', season: 1 } });
    clock.now = Date.parse('2026-10-20T15:00:00Z');
    await req('/api/admin/login', { body: { password: 'wrong-guess' }, ip: '203.0.113.77' });
    const tok = (/^flux_admin=([^;]*)/.exec((await req('/api/admin/login', { body: { password: PW } })).setCookie) || [])[1];
    const sum0 = await req('/api/admin/summary', { cookie: tok });
    const before = snapshot(env);
    const r1 = await req('/api/admin/insights', { cookie: tok }), r2 = await req('/api/admin/insights', { csrf: false, headers: { 'x-admin-token': PW } });
    const sum = await req('/api/admin/summary', { cookie: tok });
    const after = snapshot(env);
    const ins = (r1.data || {}).insights || {}; realIns = ins;
    ck('A1 /api/admin/insights with the session answers status + findings + export; the summary carries the same insights (one request for the first screen)',
      r1.status === 200 && ['HEALTHY', 'NEEDS ATTENTION', 'NOT ENOUGH DATA YET'].includes(ins.status) && typeof ins.export === 'string' && r2.status === 200 && sum.status === 200 && JSON.stringify(sum.data.insights) === JSON.stringify(ins), r1.status + ' ' + ins.status);
    const noAuth = await req('/api/admin/insights', {}), wrong = await req('/api/admin/insights', { csrf: false, headers: { 'x-admin-token': 'nope' } }), noCsrf = await req('/api/admin/insights', { cookie: tok, csrf: false });
    ck('A2 insights need the session or the password: none -> 401, wrong password -> 401, cookie without X-FLUX-Admin -> 403; nothing leaks',
      noAuth.status === 401 && wrong.status === 401 && noCsrf.status === 403 && ![noAuth, wrong, noCsrf].some((r) => /insights|export|status"/.test(JSON.stringify(r.data))), [noAuth.status, wrong.status, noCsrf.status].join('/'));
    ck('W1 read-only: leaderboard, stats and backups storage identical before and after insights and summary', before === after && before.length > 1000 && sum0.status === 200, before.length + ' / ' + after.length);
    const d1 = ins.main && ins.main.day1Players;
    ck('A3 real data: 78 new players with day 1 over; DIRECT returns 0% vs TIKTOK 50% -> "come back less" finding (PRELIMINARY, 35 players); no daily backup yet -> NEEDS ATTENTION first',
      d1 && d1.n === 78 && find(ins, 'D1_SOURCE_LOW') && /DIRECT/.test(find(ins, 'D1_SOURCE_LOW').title) && find(ins, 'D1_SOURCE_LOW').confidence === 'PRELIMINARY' && ins.status === 'NEEDS ATTENTION' && ins.findings[0].id === 'OPS_BACKUP',
      JSON.stringify((ins.findings || []).map((f) => [f.id, f.n, f.confidence])));
    const t7 = ins.export || '', sec = (sum.data || {}).security || {};
    const tags = []; for (const nm of names) { const m = await req('/api/admin/find-player', { body: { query: nm }, cookie: tok }); for (const x of ((m.data || {}).matches || [])) tags.push(x.tag, x.pid); }
    const aCodes = pids.tiktok.concat(pids.direct, pids.rare).map((p) => crypto.createHash('sha256').update('flux-stats:' + p).digest('hex').slice(0, 16));
    const devCodes = (sec.recent || []).map((x) => x.c).filter(Boolean);
    const leaks = [].concat(pids.tiktok, pids.direct, pids.rare, aCodes, names, tags.filter(Boolean), devCodes, [PW, '203.0.113.77']).filter((s) => s && t7.includes(s));
    const ipLike = /\b\d{1,3}(\.\d{1,3}){3}\b/.test(t7), uuidLike = /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t7), hexLike = /\b[0-9a-f]{12,}\b/i.test(t7), emailLike = /@/.test(t7);
    ck('P2 export (last 7 and 30 days) has no player ids, analytics codes, names, tags, leaderboard hashes, device codes or IP-like strings',
      tags.length >= 2 && devCodes.length >= 1 && aCodes.length === 78 && !leaks.length && !ipLike && !uuidLike && !hexLike && !emailLike && /LAST 7 DAYS/.test(t7) && /LAST 30 DAYS/.test(t7),
      'leaks: ' + leaks.slice(0, 3).join(',') + ' ip ' + ipLike + ' uuid ' + uuidLike + ' hex ' + hexLike);
    ck('P3 real data: the source with 3 players and its country are not named in the export ("other")', !/RARE|\bIS\b/.test(t7) && /other: fewer than 5 new players/.test(t7) && /TIKTOK 40 new/.test(t7) && /DIRECT 35 new/.test(t7), (t7.match(/By source: [^\n]*/) || [''])[0]);
  } catch (e) { ck('real worker section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- U: the admin page ---------------- */
  const js = scriptsOf(adminHtml).join('\n');
  try {
    ck('U5 shown at the top of TODAY (first screen) and of PLAYER STATS, from the one summary request; PLAYER STATS refreshes it with insights',
      /<h2>HOW FLUX IS DOING<\/h2>\s*<div id="insights"><\/div>\s*<h2>TODAY<\/h2>/.test(adminHtml) && /<h2>PLAYER STATS<\/h2>\s*<div id="stInsights"><\/div>/.test(adminHtml)
      && /renderInsights\(\$\('insights'\), d\.insights\); renderInsights\(\$\('stInsights'\), d\.insights\);/.test(js) && (js.match(/call\('summary'\)/g) || []).length === 1 && /call\('insights'\)/.test(js));
    const oiJs = js.slice(js.indexOf('/* ---------------- owner summary: status'), js.indexOf('async function act('));
    ck('U6 property handlers only (the page still has exactly two addEventListener calls), text only (no innerHTML)', (adminHtml.match(/addEventListener\(/g) || []).length === 2 && oiJs.length > 500 && !/innerHTML|addEventListener/.test(oiJs) && !/innerHTML/.test(js));
    const w = WORKER_SRC_OF(workerMod);
    const guide = adminHtml.slice(adminHtml.indexOf('<details id="guide"'), adminHtml.indexOf('<details id="advanced">'));
    ck('G1 the GUIDE explains the status, confidence labels, Measured / Possible reason, every rule and the export privacy',
      /Owner summary \(status and findings\)/.test(guide) && /INSUFFICIENT<\/b> under 30/.test(guide) && /PRELIMINARY<\/b> 30–99/.test(guide) && /MODERATE<\/b> 100–499/.test(guide) && /STRONG<\/b> 500/.test(guide)
      && /NOT ENOUGH DATA YET/.test(guide) && /Possible reason/.test(guide) && /EXPORT REPORT/.test(guide) && /fewer than 5/.test(guide) && (guide.match(/<li><b>[^<]+<\/b> \((high|medium|low)\)/g) || []).length === 8);
    ck('G2 worker.js documents the rule table (data, sample, minimum, threshold, severity) in a comment block, and lists the follow-up rules',
      !w || (/OWNER SUMMARY: status, top findings by fixed rules/.test(w) && ['D1_LOW', 'D1_SOURCE_LOW', 'FIRST_RUN_LOW', 'RUNS_DROP', 'SHORT_RUNS', 'MISS_JUMP', 'SHARE_CHANGE', 'HOME_LOW', 'OPS_EXCEPTIONS', 'OPS_BACKUP', 'OPS_LOGINS'].every((id) => new RegExp('\\n     ' + id + ' ').test(w)) && /Follow-ups once their data is on main/.test(w)));
  } catch (e) { ck('admin page static section ran', false, String(e.stack || e).slice(0, 300)); }
  try {
    const g = bootAdmin(adminHtml), S = g.S;
    const ins = realIns || run(healthy().rep(), ops({ exceptions: { total: 1, flags: 1, delivery: 0 } }));
    const box = g.dom.document.createElement('div');
    S.renderInsights(box, ins);
    const nodes = box.all(), text = box.textContent;
    const finds = nodes.filter((n) => /\bfind\b/.test(n.className));
    ck('U1 the page draws the status and each finding with "Measured:", "Possible reason:", sample and confidence (as text)',
      g.errors.length === 0 && text.includes(ins.status) && finds.length === ins.findings.length && finds.every((f) => /Measured: /.test(f.textContent) && /Possible reason: /.test(f.textContent) && (f.textContent.includes('CONFIDENCE: ' + ins.findings[finds.indexOf(f)].confidence) || /DIRECT COUNT \(NOT A SAMPLE\)/.test(f.textContent))),
      g.errors.join(';') + ' ' + finds.length);
    const btnOf = () => box.all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'EXPORT REPORT');
    g.ctx.navigator.clipboard = undefined;
    btnOf().onclick(); await tick();
    const ta = box.all().find((n) => n.tagName === 'TEXTAREA');
    ck('U2 EXPORT REPORT without a clipboard: the text appears in a read-only box, selected', !!ta && ta.value === ins.export && ta.readOnly === true && ta.selected === true);
    let copied = null; g.ctx.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve(); } };
    S.renderInsights(box, ins); btnOf().onclick(); await tick(); await tick();
    ck('U3 EXPORT REPORT copies the export text to the clipboard and says so', copied === ins.export && /Report copied/.test(box.textContent) && !box.all().some((n) => n.tagName === 'TEXTAREA'));
    g.ctx.navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) };
    S.renderInsights(box, ins); btnOf().onclick(); await tick(); await tick();
    const ta2 = box.all().find((n) => n.tagName === 'TEXTAREA');
    ck('U4 copying refused: falls back to the selectable box', !!ta2 && ta2.value === ins.export);
  } catch (e) { ck('admin page section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}
const WORKER_SRC_OF = (m) => m.__src || '';

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ adminHtml: ADMIN_HTML, workerMod: Object.assign({ __src: WORKER_SRC }, realMod) });
console.log('== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, { admin = (s) => s, worker = (s) => s }) {
  const a2 = admin(ADMIN_HTML), w2 = worker(WORKER_SRC);
  if (a2 === ADMIN_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc-owner-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const r = await suite({ adminHtml: a2, workerMod: Object.assign({ __src: w2 }, await import(pathToFileURL(tmp).href)), quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('confidence boundary off by one (100 -> 101)', 'C1', { worker: rep('[100, "MODERATE"]', '[101, "MODERATE"]') });
await control('Day-1 rule fires ON the threshold', 'R-D1_LOW', { worker: rep('if (r.n1 < this.minSample || !(v < this.threshold - OI_EPS)) return [];', 'if (r.n1 < this.minSample || !(v <= this.threshold + OI_EPS)) return [];') });
await control('Day-1 rule ignores its minimum sample', 'R-D1_LOW', { worker: rep('if (r.n1 < this.minSample || !(v < this.threshold - OI_EPS)) return [];', 'if (!(v < this.threshold - OI_EPS)) return [];') });
await control('Day-1 counted before day 1 is over', 'R-D1_LOW only', { worker: rep('if (age >= 2) { t.n1 += v.n;', 'if (age >= 1) { t.n1 += v.n;') });
await control('source rule ignores its minimum sample', 'R-D1_SOURCE_LOW', { worker: rep('if (r.n1 < this.minSample || restN < this.minSample) continue;', 'if (restN < this.minSample) continue;') });
await control('first-run rule counts today', 'R-FIRST_RUN_LOW ignores', { worker: rep('const W7 = [today - 7, today - 1]', 'const W7 = [today - 6, today]') });
await control('runs-drop threshold 25%', 'R-RUNS_DROP', { worker: rep('{ id: "RUNS_DROP", severity: "medium", kind: "stat", minSample: 30, threshold: 0.20,', '{ id: "RUNS_DROP", severity: "medium", kind: "stat", minSample: 30, threshold: 0.25,') });
await control('short-runs minimum sample 20', 'R-SHORT_RUNS', { worker: rep('{ id: "SHORT_RUNS", severity: "medium", kind: "stat", minSample: 30,', '{ id: "SHORT_RUNS", severity: "medium", kind: "stat", minSample: 20,') });
await control('miss jump without the +2/min floor', 'R-MISS_JUMP', { worker: rep(' || !(mb - ma >= this.minRise - OI_EPS)) continue;', ') continue;') });
await control('share change only looks at drops', 'R-SHARE_CHANGE', { worker: rep('if (!(Math.abs(ch) >= this.threshold - OI_EPS)', 'if (!(-ch >= this.threshold - OI_EPS)') });
await control('Home Screen rule ignores its minimum', 'R-HOME_LOW', { worker: rep('if (t.opens < this.minSample || !(v < this.threshold - OI_EPS)) return [];', 'if (!t.opens || !(v < this.threshold - OI_EPS)) return [];') });
await control('failed-login spike threshold 20', 'R-OPS_LOGINS', { worker: rep('{ id: "OPS_LOGINS", severity: "high", kind: "ops", threshold: 10,', '{ id: "OPS_LOGINS", severity: "high", kind: "ops", threshold: 20,') });
await control('operational problems left out of the status', 'S3', { worker: rep('fired.some((f) => f.kind === "ops" || (f.severity', 'fired.some((f) => (f.kind !== "ops" && f.severity') });
await control('a high finding with INSUFFICIENT confidence counts', 'S6', { worker: rep('(f.severity === "high" && OI_CONF_RANK[f.confidence] >= OI_CONF_RANK.PRELIMINARY)', '(f.severity === "high")') });
await control('no NOT ENOUGH DATA YET', 'S1', { worker: rep('(d1n < 30 || weekN < 30 ? "NOT ENOUGH DATA YET" : "HEALTHY")', '"HEALTHY"') });
await control('ranking ignores confidence', 'K1', { worker: rep('(OI_CONF_RANK[b.confidence] - OI_CONF_RANK[a.confidence]) || ', '') });
await control('ranking shows every finding', 'K1', { worker: rep('findings: fired.slice(0, 3)', 'findings: fired') });
await control('a finding without its Possible reason', 'M1', { worker: rep('measured: best.measured, reason: r.reason(best),', 'measured: best.measured, reason: "",') });
await control('export without the Measured lines', 'E1', { worker: rep('L.push("     Measured: " + f.measured);', '') });
await control('export leaks the failed-login device codes', 'P2', { worker: rep('(o.security ? (o.security.failed24h || 0) : "unavailable")', '(o.security ? (o.security.failed24h || 0) + " " + (o.security.recent || []).map((r) => r.c).join(" ") : "unavailable")') });
await control('export names small groups', 'P1', { worker: rep('const big = rows.filter((r) => r.t.new >= OI_SMALL)', 'const big = rows.filter((r) => r.t.new >= 0)') });
await control('insights without the password', 'A2', { worker: rep('async function adminSummary(request, env) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminSummary(request, env) {') });
await control('insights write to storage', 'W1', { worker: rep('if (last >= 1 && last <= 400) { to = today; from = today - last + 1; }', 'if (last >= 1 && last <= 400) { to = today; from = today - last + 1; await st.put("an:ownerRead", Date.now()); }') });
await control('page drops the Possible reason label', 'U1', { admin: rep("p2.appendChild(el('b', null, 'Possible reason: '));", '') });
await control('no fallback box without a clipboard', 'U2', { admin: rep("if (!cb || typeof cb.writeText !== 'function') { showBox('This browser cannot copy by itself. The report is selected below: copy it.'); return; }", "if (!cb || typeof cb.writeText !== 'function') return;") });
await control('page uses a new addEventListener', 'U6', { admin: rep("var row = el('div', 'actions'); row.appendChild(btn('EXPORT REPORT', 'ghost', function () { exportReport(ins['export'] || '', out); }));",
  "var row = el('div', 'actions'); var eb = btn('EXPORT REPORT', 'ghost', null); eb.addEventListener('click', function () { exportReport(ins['export'] || '', out); }); row.appendChild(eb);") });
await control('guide loses the confidence labels', 'G1', { admin: rep('<b>PRELIMINARY</b> 30–99', '<b>EARLY</b> 30–99') });
const total = main.F + NC;
console.log('\n' + (total ? 'OWNER SUMMARY FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'OWNER SUMMARY PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
