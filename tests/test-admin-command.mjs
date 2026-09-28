// FLUX COMMAND: the admin page as an installable Home Screen app with a real
// login session, lockout and an owner summary. Real worker.js, real admin.html
// script, real sw.js, real manifests. In the release gate (auto-discovered).
//   L  login: right password -> 200 + cookie; wrong -> 401, no cookie
//   C  cookie: HttpOnly, Secure, SameSite=Strict, Path=/api/admin, 12 h Max-Age; 256-bit random token
//   S  session: authorises admin routes; stored ONLY as a SHA-256; idle (30 min) and absolute (12 h) expiry; logout ends it
//   X  CSRF: cookie requests and the login need X-FLUX-Admin: 1; a cross-site preflight never allows that header
//   K  lockout: 5 wrong from one client -> 429 + Retry-After for 15 min; other clients unaffected; recovers
//      after 15 min; x-admin-token guesses count too; the raw IP is never stored
//   G  global safety: 50 failures in 15 min -> one wrong password locks a client, but a clean client (the owner)
//      still logs in; a new ADMIN_TOKEN clears every lock and ends every session
//   F  failed logins are recorded for the owner (count, time, short client code; never a password)
//   T  constant-time password comparison, no early exit on length
//   R  every /api/admin/* route refuses a request without a session or the header
//   M  /api/admin/summary aggregates today's stats, exceptions, purchases and failed logins; needs auth
//   P  admin manifest valid and scoped to the admin page; iOS meta; the player manifest unchanged
//   W  sw.js never caches the admin page or the admin API; offline admin = "reconnect", never the game
//   U  admin page: login screen, error texts incl. "Locked for N min", 401 -> login without losing typed data, logout
// Ends with negative controls: each re-inserted defect must be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta'), PUB = path.join(ROOT, 'public');
const rd = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const ADMIN_HTML = rd('admin.html'), SW_SRC = rd('sw.js'), ADMIN_MANIFEST = rd('admin.webmanifest');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const PLAYER_MANIFEST = rd('manifest.webmanifest'), GAME_HTML = rd('play/index.html'), GW_HTML = rd('index.html');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ORIGIN = 'https://flux.example', PW = 'correct-horse-battery', MIN = 60000, HOUR = 3600000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tick = () => new Promise((r) => setImmediate(r));

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { if (typeof k === 'object') { for (const [kk, vv] of Object.entries(k)) this.map.set(kk, structuredClone(vv)); } else this.map.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
}
function makeKV() {
  const m = new Map();
  return { _m: m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}
function makeEnv(LeaderboardDO, clock, extra = {}) {
  const instances = new Map(); let chain = Promise.resolve();
  return { ADMIN_TOKEN: PW, LEADERBOARD: makeKV(), ...extra, LEADERBOARD_DO: { idFromName: (n) => n, _instances: instances, get(id) {
    if (!instances.has(id)) { const o = new LeaderboardDO({ storage: new FakeStorage(), blockConcurrencyWhile: (fn) => fn() }); o.nowMs = () => clock.now; instances.set(id, o); }
    const o = instances.get(id);
    return { fetch(url, init) { const run = () => o.fetch(new Request(url, init)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } }; } } };
}
function allStorage(env) {   // everything every DO instance and the KV hold, as text
  let out = '';
  for (const [, o] of env.LEADERBOARD_DO._instances) for (const [k, v] of o.state.storage.map) out += k + '=' + JSON.stringify(v) + '\n';
  for (const [k, v] of env.LEADERBOARD._m) out += k + '=' + v + '\n';
  return out;
}
const cookieOf = (setCookie) => { const m = /^flux_admin=([^;]*)/.exec(setCookie || ''); return m ? m[1] : null; };
function pngSize(file) { const b = fs.readFileSync(file); return b.slice(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; }

async function suite({ adminHtml, workerMod, swSrc, manifestSrc, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const worker = workerMod.default;
  const fresh = (extra) => { const clock = { now: Date.now() }; return { clock, env: makeEnv(workerMod.LeaderboardDO, clock, extra) }; };
  const req = async (env, p, { body, headers = {}, cookie, ip = '203.0.113.7', csrf = true, method = 'POST' } = {}) => {
    const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers };
    if (csrf) h['X-FLUX-Admin'] = '1';
    if (cookie) h.Cookie = 'flux_admin=' + cookie;
    const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: method === 'POST' ? JSON.stringify(body || {}) : undefined }), env, {});
    let data = null; try { data = await res.clone().json(); } catch (e) {}
    return { status: res.status, data, headers: res.headers, setCookie: res.headers.get('set-cookie') || '' };
  };
  const login = (env, password, opts = {}) => req(env, '/api/admin/login', { body: { password }, ...opts });

  /* ---------------- L / C / S: login, cookie, session ---------------- */
  try {
    const { env, clock } = fresh();
    const ok = await login(env, PW), tok = cookieOf(ok.setCookie);
    ck('L1 right password -> 200 and a session cookie', ok.status === 200 && ok.data.ok === true && !!tok, ok.status);
    const bad = await login(env, 'nope', { ip: '198.51.100.1' });
    ck('L2 wrong password -> 401, no cookie, attempts left shown', bad.status === 401 && !cookieOf(bad.setCookie) && bad.data.attemptsLeft === 4, bad.status + ' ' + JSON.stringify(bad.data));
    const sc = ok.setCookie;
    ck('C1 cookie is HttpOnly, Secure, SameSite=Strict, Path=/api/admin, Max-Age 12 h',
      /;\s*HttpOnly/i.test(sc) && /;\s*Secure/i.test(sc) && /;\s*SameSite=Strict/i.test(sc) && /;\s*Path=\/api\/admin(;|$)/.test(sc) && /;\s*Max-Age=43200(;|$)/.test(sc), sc);
    const tok2 = cookieOf((await login(env, PW)).setCookie);
    ck('C2 token is 256 random bits (base64url), different every login, from crypto.getRandomValues',
      /^[A-Za-z0-9_-]{43}$/.test(tok || '') && tok !== tok2 && /crypto\.getRandomValues\(b\)/.test(workerMod.__src || WORKER_SRC), (tok || '').length);
    const use = await req(env, '/api/admin/find-player', { cookie: tok, body: { query: 'X' } });
    const sess = await req(env, '/api/admin/session', { cookie: tok });
    ck('S1 the session cookie opens admin routes (no password sent)', use.status === 200 && sess.status === 200 && sess.data.via === 'session', use.status + '/' + sess.status);
    const dump = allStorage(env);
    ck('S2 only the SHA-256 of the session is stored, never the token', !dump.includes(tok) && !dump.includes(tok2) && dump.includes(sha(tok)) && !dump.includes(PW));
    // idle: 29 min later still fine (and that use restarts the clock), 31 min after the last use -> gone
    clock.now += 29 * MIN; const i1 = await req(env, '/api/admin/session', { cookie: tok });
    clock.now += 29 * MIN; const i2 = await req(env, '/api/admin/session', { cookie: tok });
    clock.now += 31 * MIN; const i3 = await req(env, '/api/admin/session', { cookie: tok });
    ck('S3 idle timeout: kept alive by use, ends 30 min after the last request', i1.status === 200 && i2.status === 200 && i3.status === 401 && i3.data.expired === true && /Max-Age=0/.test(i3.setCookie), [i1.status, i2.status, i3.status].join('/'));
    // absolute: used every 20 minutes, still ends 12 h after login
    const t3 = cookieOf((await login(env, PW)).setCookie), start = clock.now; let alive = true, lastOk = 0;
    while (clock.now - start < 12 * HOUR + 30 * MIN) { clock.now += 20 * MIN; const r = await req(env, '/api/admin/session', { cookie: t3 }); if (r.status === 200) lastOk = clock.now - start; else { alive = false; break; } }
    ck('S4 absolute limit: an active session still ends at 12 h', !alive && lastOk < 12 * HOUR && lastOk >= 11 * HOUR, (lastOk / HOUR).toFixed(2) + ' h');
    const t4 = cookieOf((await login(env, PW)).setCookie);
    const out = await req(env, '/api/admin/logout', { cookie: t4 }), after = await req(env, '/api/admin/session', { cookie: t4 });
    ck('S5 logout ends the session on the server and clears the cookie', out.status === 200 && /^flux_admin=;/.test(out.setCookie) && /Max-Age=0/.test(out.setCookie) && after.status === 401 && !allStorage(env).includes(sha(t4)), out.status + '/' + after.status);
  } catch (e) { ck('login/session section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- X: CSRF ---------------- */
  try {
    const { env } = fresh();
    const tok = cookieOf((await login(env, PW)).setCookie);
    const noHdr = await req(env, '/api/admin/find-player', { cookie: tok, csrf: false, body: { query: 'X' } });
    ck('X1 a cookie request without X-FLUX-Admin: 1 is refused (403)', noHdr.status === 403, noHdr.status);
    const noHdrLogin = await login(env, PW, { csrf: false });
    ck('X2 the login itself needs X-FLUX-Admin: 1 (no cookie without it)', noHdrLogin.status === 403 && !cookieOf(noHdrLogin.setCookie), noHdrLogin.status);
    const pre = await worker.fetch(new Request(ORIGIN + '/api/admin/summary', { method: 'OPTIONS' }), env, {});
    ck('X3 a cross-site preflight never allows the X-FLUX-Admin header', !/x-flux-admin/i.test(pre.headers.get('access-control-allow-headers') || ''));
  } catch (e) { ck('CSRF section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- K: lockout per client ---------------- */
  try {
    const { env, clock } = fresh();
    const A = '192.0.2.10', B = '192.0.2.20', C = '192.0.2.30';
    const tries = []; for (let i = 0; i < 5; i++) tries.push(await login(env, 'guess-' + i, { ip: A }));
    const fifth = tries[4];
    ck('K1 5 wrong passwords -> 429 with Retry-After 900 and "Locked for 15 min"', tries.slice(0, 4).every((r) => r.status === 401) && fifth.status === 429 && fifth.headers.get('retry-after') === '900' && /Locked for 15 min/.test(fifth.data.error), tries.map((r) => r.status).join(','));
    const locked = await login(env, PW, { ip: A });
    ck('K1 while locked even the right password is refused (429), no cookie', locked.status === 429 && !cookieOf(locked.setCookie) && Number(locked.headers.get('retry-after')) > 0, locked.status);
    const other = await login(env, PW, { ip: B });
    ck('K2 the lock is per client: another client logs in', other.status === 200, other.status);
    clock.now += 15 * MIN + 1000;
    const back = await login(env, PW, { ip: A });
    ck('K3 after 15 minutes the locked client can log in again', back.status === 200, back.status);
    const dump = allStorage(env);
    ck('K4 no raw IP and no typed password is ever stored', ![A, B, C].some((ip) => dump.includes(ip)) && !/guess-\d/.test(dump) && !dump.includes(PW));
    const hdr = []; for (let i = 0; i < 5; i++) hdr.push(await req(env, '/api/admin/find-player', { ip: C, csrf: false, headers: { 'x-admin-token': 'bad-' + i }, body: { query: 'X' } }));
    const hdrOk = await req(env, '/api/admin/find-player', { ip: C, csrf: false, headers: { 'x-admin-token': PW }, body: { query: 'X' } });
    ck('K5 x-admin-token guesses count too: 5 wrong -> that client is locked, even with the right header', hdr[4].status === 429 && hdrOk.status === 429, hdr.map((r) => r.status).join(',') + ' -> ' + hdrOk.status);
    const hdrOther = await req(env, '/api/admin/find-player', { ip: B, csrf: false, headers: { 'x-admin-token': PW }, body: { query: 'X' } });
    ck('K6 the header still works for existing tools (no X-FLUX-Admin needed)', hdrOther.status === 200, hdrOther.status);
  } catch (e) { ck('lockout section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- G: global safety, recovery by a new secret ---------------- */
  try {
    const { env, clock } = fresh();
    let n = 0;
    for (let c = 0; c < 10; c++) for (let i = 0; i < 5; i++) { await login(env, 'x' + n, { ip: '10.0.' + c + '.1' }); n++; }
    const d1 = await login(env, 'wrong-once', { ip: '10.9.9.1' });
    ck('G1 after 50 failures from all clients, ONE wrong password locks a new client (slowed down)', d1.status === 429 && /Locked for 15 min/.test(d1.data.error), d1.status + ' ' + JSON.stringify(d1.data));
    const owner = await login(env, PW, { ip: '10.9.9.2' });
    ck('G2 the owner is never locked out by others: a clean client with the right password logs in', owner.status === 200, owner.status);
    clock.now += 15 * MIN + 1000;
    const normal = await login(env, 'one-slip', { ip: '10.9.9.3' });
    ck('G3 safety mode ends after 15 minutes (a wrong password is a plain 401 again, 4 left)', normal.status === 401 && normal.data.attemptsLeft === 4, normal.status + ' ' + JSON.stringify(normal.data));
    // Recovery: a new ADMIN_TOKEN (Cloudflare dashboard) clears every lock and ends every session.
    const tok = cookieOf(owner.setCookie);
    for (let i = 0; i < 5; i++) await login(env, 'y' + i, { ip: '10.7.7.7' });
    const stillLocked = await login(env, PW, { ip: '10.7.7.7' });
    env.ADMIN_TOKEN = 'a-brand-new-secret';
    const unlocked = await login(env, 'a-brand-new-secret', { ip: '10.7.7.7' });
    const oldSession = await req(env, '/api/admin/session', { cookie: tok });
    ck('G4 a new ADMIN_TOKEN clears every lock and logs every old session out', stillLocked.status === 429 && unlocked.status === 200 && oldSession.status === 401, [stillLocked.status, unlocked.status, oldSession.status].join('/'));
    /* F: the failed-login log */
    const sum = await req(env, '/api/admin/summary', { cookie: cookieOf(unlocked.setCookie) });
    const s = sum.data && sum.data.security;
    ck('F1 failed logins are recorded for the owner: count, time, short client code, no password',
      !!s && s.failed24h === 57 && typeof s.lastFailedAt === 'number' && s.recent.length === 5 && s.recent.every((x) => typeof x.at === 'number' && /^[0-9a-f]{6}$/.test(x.c)) && !/x\d+|wrong-once|one-slip|"y\d/.test(allStorage(env)),
      s ? s.failed24h + ' / ' + JSON.stringify(s.recent[0]) : 'none');
  } catch (e) { ck('global section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- T: constant-time comparison ---------------- */
  try {
    const src = workerMod.__src || WORKER_SRC;
    const fn = (/function timingSafeEqual\(a, b\) \{[\s\S]*?\n\}/.exec(src) || [''])[0];
    const f = vm.runInNewContext('(' + fn.replace('function timingSafeEqual', 'function') + ')');
    const right = f('abc', 'abc') && !f('abc', 'abd') && !f('ab', 'abc') && !f('abc', 'ab') && !f('abc\u0000', 'abc') && !f('', 'x');
    ck('T1 constant-time compare: no early exit on length, loops over the longer string; login and header both use it',
      right && !/length !== b\.length\) return false|a\.length !== b\.length/.test(fn) && /Math\.max\(a\.length, b\.length\)/.test(fn) &&
      /timingSafeEqual\(password, env\.ADMIN_TOKEN\)/.test(src) && /ok: timingSafeEqual\(supplied, env\.ADMIN_TOKEN\)/.test(src));
  } catch (e) { ck('T1 constant-time compare', false, String(e).slice(0, 200)); }

  /* ---------------- R: every admin route needs the session or the header ---------------- */
  try {
    const { env } = fresh();
    const src = workerMod.__src || WORKER_SRC;
    const routes = [...new Set([...src.matchAll(/"(\/api\/admin\/[a-z0-9-]+)"/g)].map((m) => m[1]))].filter((r) => r !== '/api/admin/login' && r !== '/api/admin/logout');
    const tok = cookieOf((await login(env, PW)).setCookie);
    const bad = [];
    for (const r of routes) {
      const none = await req(env, r, { body: { pid: '0123456789abcdef', query: 'X', name: 'X', id: 'x', session: 'cs_x', email: 'a@b.cd' } });
      const fake = await req(env, r, { cookie: 'A'.repeat(43), body: {} });
      if (none.status !== 401 || fake.status !== 401) bad.push(r + ':' + none.status + '/' + fake.status);
    }
    ck('R1 every /api/admin/* route refuses a request with no session and no password (401), and a made-up cookie (401)', routes.length >= 19 && bad.length === 0, routes.length + ' routes ' + bad.join(' '));
    const accepted = [];
    for (const r of ['/api/admin/exceptions', '/api/admin/analytics', '/api/admin/season-archive', '/api/admin/summary', '/api/admin/session', '/api/admin/find-player', '/api/admin/import-kv']) {
      const x = await req(env, r, { cookie: tok, body: { query: 'X' } }); if (x.status === 401 || x.status === 403) accepted.push(r + ':' + x.status);
    }
    ck('R2 a valid session is accepted on the admin routes (import-kv included)', accepted.length === 0, accepted.join(' '));
    const noCache = await req(env, '/api/admin/summary', { cookie: tok }), noCache401 = await req(env, '/api/admin/summary', {});
    ck('R3 admin responses are never cached (no-store), refusals included', /no-store/.test(noCache.headers.get('cache-control') || '') && /no-store/.test(noCache401.headers.get('cache-control') || ''));
  } catch (e) { ck('route section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- M: the owner summary ---------------- */
  try {
    const { env, clock } = fresh();
    const ev = (pid, events, extra = {}) => req(env, '/api/events', { csrf: false, body: { pid, events, src: 'tiktok', country: 'PH', ...extra } });
    await ev('pilot-aaaa-1', [{ e: 'open', home: true }, { e: 'run_end', sec: 60, lvl: 2, diff: 'easy' }, { e: 'share' }]);
    await ev('pilot-bbbb-2', [{ e: 'open' }, { e: 'run_end', sec: 120, lvl: 3, diff: 'easy' }, { e: 'run_end', sec: 90, lvl: 3, diff: 'easy' }]);
    // one unusual-score flag and one payment not delivered = 2 exceptions; one purchase delivered today
    const lb = env.LEADERBOARD_DO.get('global');
    await lb.fetch('https://do.internal/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: 'pilot-aaaa-1', sku: 'solar', sessionId: 'cs_test_1' }) });
    const g = env.LEADERBOARD_DO._instances.get('global');
    await g.state.storage.put('flags', [{ id: 'f1', at: Date.now(), name: 'X', pid: '0123456789abcdef', difficulty: 'easy', score: 1, reason: 'test' }]); g.ready = false;
    await env.LEADERBOARD.put('exception:delivery:cs_test_2', JSON.stringify({ session: 'cs_test_2', reason: 'test', at: Date.now() }));
    await login(env, 'oops', { ip: '198.51.100.9' });
    const tok = cookieOf((await login(env, PW)).setCookie);
    const r = await req(env, '/api/admin/summary', { cookie: tok }), d = r.data || {}, p = d.players || {};
    const ex = (await req(env, '/api/admin/exceptions', { cookie: tok })).data || {};
    ck('M1 summary: today\'s active 2, new 2, runs 3, avg run 90 s, share rate 1/3, Home Screen opens 1',
      r.status === 200 && p.active === 2 && p.newPlayers === 2 && p.runs === 3 && p.avgRunSec === 90 && Math.abs(p.shareRate - 1 / 3) < 1e-9 && p.homeOpens === 1 && p.date === new Date(clock.now).toISOString().slice(0, 10), JSON.stringify(p));
    ck('M2 summary: exceptions = the CHECK EXCEPTIONS list (1 flag + 1 delivery), purchases today 1, failed logins 1',
      d.exceptions && d.exceptions.total === 2 && d.exceptions.total === (ex.flags || []).length + (ex.delivery || []).length && d.purchases && d.purchases.today === 1 && d.security && d.security.failed24h === 1,
      JSON.stringify([d.exceptions, d.purchases, d.security && d.security.failed24h]));
    const noAuth = await req(env, '/api/admin/summary', {}), wrong = await req(env, '/api/admin/summary', { csrf: false, headers: { 'x-admin-token': 'nope' } });
    ck('M3 summary needs the session or the password', noAuth.status === 401 && wrong.status === 401 && !JSON.stringify(noAuth.data).includes('active'), noAuth.status + '/' + wrong.status);
    ck('M4 the admin page loads it in ONE request after login and on REFRESH', (scriptsOf(adminHtml).join('\n').match(/call\('summary'\)/g) || []).length === 1);
  } catch (e) { ck('summary section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- P: manifest, iOS meta, the player app untouched ---------------- */
  try {
    const m = JSON.parse(manifestSrc);
    const inScope = (u) => u.startsWith(m.scope);
    const icons = (m.icons || []).map((i) => ({ i, size: pngSize(path.join(PUB, i.src.replace(/^\//, ''))) }));
    const bg = (/--bg:(#[0-9a-f]{6})/i.exec(adminHtml) || [])[1];
    ck('P1 admin manifest: FLUX COMMAND, start_url /admin.html inside a scope limited to the admin page, standalone, admin theme colours',
      m.name === 'FLUX COMMAND' && m.short_name === 'FLUX COMMAND' && m.start_url === '/admin.html' && inScope(m.start_url) && inScope('/admin') &&
      !inScope('/') && !inScope('/play/') && !inScope('/index.html') && !inScope('/api/admin/summary') && m.display === 'standalone' &&
      m.theme_color === bg && m.background_color === bg && m.id === '/admin.html', JSON.stringify([m.scope, m.start_url, m.theme_color, bg]));
    ck('P2 icons exist at their declared sizes (192, 512, 512 maskable) and differ from the game icon',
      icons.length >= 3 && icons.every((x) => x.size && x.i.sizes === x.size.join('x')) && icons.some((x) => x.i.purpose === 'maskable') &&
      !icons.some((x) => /\/icon-\d+\.png$/.test(x.i.src)), JSON.stringify(icons.map((x) => [x.i.src, x.size])));
    const touch = (/<link rel="apple-touch-icon" href="([^"]+)">/.exec(adminHtml) || [])[1];
    ck('P3 admin.html links ONLY its own manifest, apple-touch-icon 180x180, iOS web-app meta, viewport-fit=cover, safe-area insets',
      /<link rel="manifest" href="\/admin\.webmanifest">/.test(adminHtml) && (adminHtml.match(/rel="manifest"/g) || []).length === 1 &&
      touch && String(pngSize(path.join(PUB, touch.replace(/^\//, '')))) === '180,180' &&
      /<meta name="apple-mobile-web-app-capable" content="yes">/.test(adminHtml) && /<meta name="apple-mobile-web-app-title" content="FLUX COMMAND">/.test(adminHtml) &&
      /viewport-fit=cover/.test(adminHtml) && /safe-area-inset-left/.test(adminHtml) && /safe-area-inset-right/.test(adminHtml) && /safe-area-inset-bottom/.test(adminHtml) && /safe-area-inset-top/.test(adminHtml), touch);
    const pm = JSON.parse(PLAYER_MANIFEST);
    ck('P4 the player game\'s manifest is unchanged and never points at the admin page; game pages never link the admin manifest',
      pm.short_name === 'FLUX' && pm.start_url === '/' && pm.scope === '/' && !/admin/i.test(PLAYER_MANIFEST) && !/admin\.webmanifest|admin-icon/.test(GAME_HTML + GW_HTML));
    ck('P5 the admin page still registers no service worker and stays out of search engines',
      !/serviceWorker/.test(scriptsOf(adminHtml).join('\n')) && /<meta name="robots" content="noindex,nofollow">/.test(adminHtml));
  } catch (e) { ck('manifest section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- W: the site's service worker ---------------- */
  try {
    const W = swWorld(swSrc);
    await W.install();
    const puts0 = W.puts.length;
    const online = await W.fetchEvent(ORIGIN + '/admin.html', 'navigate', () => ({ status: 200, body: 'ADMIN-PAGE' }));
    const online2 = await W.fetchEvent(ORIGIN + '/admin', 'navigate', () => ({ status: 200, body: 'ADMIN-PAGE' }));
    await tick(); await tick();
    ck('W1 online, the admin page comes from the network and is never stored', online.handled && online.res.body === 'ADMIN-PAGE' && online2.res && online2.res.body === 'ADMIN-PAGE' && W.puts.length === puts0 && !W.cached('/admin'), W.puts.slice(puts0).join(','));
    const off = await W.fetchEvent(ORIGIN + '/admin.html', 'navigate', () => { throw new TypeError('offline'); });
    const offBody = off.res ? String(off.res.body) : '';
    ck('W2 offline, the admin page says "Offline — reconnect" (503) -- never the game, never old admin data', off.handled && off.res.status === 503 && /Offline — reconnect/.test(offBody) && !off.res.redirectTo && !/SHELL/.test(offBody), off.res ? off.res.status + ' ' + (off.res.redirectTo || '') : 'none');
    const apis = ['/api/admin/summary', '/api/admin/session', '/api/admin/exceptions', '/admin.webmanifest', '/admin-icon-192.png'];
    const handled = [];
    for (const u of apis) { const r = await W.fetchEvent(ORIGIN + u, 'cors', () => ({ status: 200, body: 'DATA' })); if (r.handled) handled.push(u); }
    await tick();
    ck('W3 GETs to /api/admin/* and the admin manifest/icons are left to the network, never cached', handled.length === 0 && !W.puts.slice(puts0).some((k) => /admin/.test(k)), handled.join(','));
    const game = await W.fetchEvent(ORIGIN + '/play/', 'navigate', () => { throw new TypeError('offline'); });
    ck('W4 the player game still works offline from its cache (unchanged)', game.handled && game.res && game.res.status === 200 && game.res.body === 'SHELL');
  } catch (e) { ck('service worker section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ---------------- U: the admin page itself ---------------- */
  try {
    const { env, clock } = fresh();
    const jar = { v: null }, sent = []; let ip = '203.0.113.50';
    const fetchImpl = async (url, init = {}) => {
      const h = new Headers(init.headers || {}); sent.push({ url: String(url), headers: Object.fromEntries(h), credentials: init.credentials, body: init.body });
      h.set('CF-Connecting-IP', ip); if (jar.v) h.set('Cookie', 'flux_admin=' + jar.v);
      const res = await worker.fetch(new Request(new URL(url, ORIGIN), { method: init.method || 'GET', headers: h, body: init.body }), env, {});
      const sc = res.headers.get('set-cookie'); if (sc) jar.v = /Max-Age=0/.test(sc) ? null : cookieOf(sc);
      return res;
    };
    const until = async (fn, n = 400) => { for (let i = 0; i < n; i++) { if (fn()) return true; await tick(); } return false; };
    const { store } = makeStore({});
    const g = boot(scriptsOf(adminHtml), { origin: ORIGIN, path: '/admin.html', store, fetchImpl });
    const E = g.els;
    await until(() => E.login && E.login.hidden === false && E.loginMsg && E.loginMsg.textContent !== 'Connecting…');
    ck('U1 with no session the page opens on the login screen', g.errors.length === 0 && E.login.hidden === false && E.app.hidden === true && sent[0] && /\/api\/admin\/session$/.test(sent[0].url), g.errors.join(';') + ' ' + E.loginMsg.textContent);
    const submit = async (pw) => { E.token.value = pw; const n = sent.length; await E.loginForm.onsubmit({ preventDefault() {} }); await until(() => sent.length > n && E.loginBtn.disabled === false); };
    await submit('nope-1');
    ck('U2 wrong password: clear message with tries left; the field is emptied', /^Wrong password\. 4 tries left before a 15-minute lock\.$/.test(E.loginMsg.textContent) && E.token.value === '' && E.app.hidden === true, E.loginMsg.textContent);
    for (let i = 2; i <= 5; i++) await submit('nope-' + i);
    ck('U3 locked: "Too many wrong passwords. Locked for 15 min." (with the recovery hint)', /Too many wrong passwords\. Locked for 15 min\./.test(E.loginMsg.textContent) && /ADMIN_TOKEN/.test(E.loginMsg.textContent), E.loginMsg.textContent);
    ip = '203.0.113.51';
    await submit(PW);
    await until(() => sent.some((s) => /\/summary$/.test(s.url)));
    ck('U4 right password: the app opens, the password field is cleared, the summary is fetched once', E.app.hidden === false && E.login.hidden === true && E.logout.hidden === false && E.token.value === '' && sent.filter((s) => /\/summary$/.test(s.url)).length === 1 && !!jar.v);
    const adminCalls = sent.filter((s) => /\/api\/admin\//.test(s.url));
    ck('U5 every request carries X-FLUX-Admin: 1 and same-origin credentials; the password is sent only to /login, never as x-admin-token',
      adminCalls.every((s) => s.headers['x-flux-admin'] === '1' && s.credentials === 'same-origin' && !('x-admin-token' in s.headers)) &&
      adminCalls.filter((s) => (s.body || '').includes(PW)).every((s) => /\/login$/.test(s.url)), adminCalls.length);
    // the session expires while the owner is typing: 401 -> login screen, what they typed is kept
    E.q.value = 'SWIFT COMET'; clock.now += 31 * MIN;
    E.find.onclick(); await until(() => E.app.hidden === true);
    ck('U6 session expired (401): back to the login screen, typed search kept', E.app.hidden === true && E.login.hidden === false && E.q.value === 'SWIFT COMET' && /session ended/i.test(E.loginMsg.textContent), E.loginMsg.textContent);
    await submit(PW);
    ck('U7 logging in again returns to the same page with the typed data', E.app.hidden === false && E.q.value === 'SWIFT COMET');
    const n = sent.length; E.logout.onclick(); await until(() => E.login.hidden === false && sent.length > n);
    await until(() => E.loginMsg.textContent === 'Logged out.');
    ck('U8 LOG OUT: the server session ends, the page clears what it showed and typed, back to login', /\/logout$/.test(sent[n].url) && jar.v === null && E.q.value === '' && E.app.hidden === true && E.loginMsg.textContent === 'Logged out.', E.loginMsg.textContent);
    ck('U9 no player storage, no innerHTML, script parses', !/localStorage|sessionStorage|indexedDB|innerHTML/.test(scriptsOf(adminHtml).join('\n')) && g.errors.length === 0);
  } catch (e) { ck('admin page section ran', false, String(e.stack || e).slice(0, 300)); }

  return { F, failed };
}

/* A minimal service-worker world (same idea as test-sw.mjs): real sw.js, fake caches. */
function swWorld(src) {
  const ORIG = ORIGIN; const store = new Map(); const puts = [];
  let net = () => ({ status: 200, body: 'SHELL' });
  const R = (status, body) => ({ status, type: 'basic', body, clone() { return R(status, body); } });
  const call = async (u) => { const r = await net(u); return R(r.status, r.body); };
  const norm = (u) => String(typeof u === 'string' ? u : u.url).split('#')[0];
  const cacheAPI = {
    async open(n) { if (!store.has(n)) store.set(n, new Map()); const m = store.get(n);
      return { async addAll(list) { for (const u of list) m.set(norm(u), R(200, 'SHELL')); },
        async put(u, r) { puts.push(norm(u)); m.set(norm(u), r); },
        async match(u, o) { const k = norm(u); if (m.has(k)) return m.get(k); if (o && o.ignoreSearch) { for (const [kk, v] of m) if (kk.split('?')[0] === k.split('?')[0]) return v; } return undefined; } }; },
    async keys() { return [...store.keys()]; }, async delete(n) { return store.delete(n); },
    async match(u, o) { for (const n of store.keys()) { const h = await (await cacheAPI.open(n)).match(u, o); if (h) return h; } return undefined; },
  };
  class Req { constructor(url, mode) { this.url = String(url); this.mode = mode || 'same-origin'; this.method = 'GET'; } }
  class Resp { static redirect(url, status) { const r = new Resp('', { status: status || 302 }); r.redirectTo = String(url); return r; }
    constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.type = 'basic'; } clone() { return this; } }
  const L = {};
  const self_ = { location: { origin: ORIG, href: ORIG + '/sw.js', toString() { return this.href; } }, addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); },
    clients: { claim() { return Promise.resolve(); } }, skipWaiting() {} };
  const fetchFn = async (req) => call(typeof req === 'string' ? req : req.url);
  new Function('self', 'caches', 'fetch', 'URL', 'Response', src)(self_, cacheAPI, fetchFn, URL, Resp);
  return {
    puts, cached: (p) => [...store.values()].some((m) => [...m.keys()].some((k) => new URL(k).pathname.startsWith(p))),
    async install() { const w = []; for (const f of L.install || []) f({ waitUntil: (p) => w.push(p) }); await Promise.all(w); },
    async fetchEvent(url, mode, handler) {
      net = handler; let p = null;
      for (const f of L.fetch || []) f({ request: new Req(url, mode), respondWith: (x) => { p = x; } });
      let res = null; if (p) { try { res = await p; } catch (e) { res = null; } }
      return { handled: !!p, res };
    },
  };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const main = await suite({ adminHtml: ADMIN_HTML, workerMod: Object.assign({ __src: WORKER_SRC }, realMod), swSrc: SW_SRC, manifestSrc: ADMIN_MANIFEST });

console.log('\n== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
async function control(label, expect, { worker = (s) => s, admin = (s) => s, sw = (s) => s, manifest = (s) => s }) {
  const w2 = worker(WORKER_SRC), a2 = admin(ADMIN_HTML), s2 = sw(SW_SRC), m2 = manifest(ADMIN_MANIFEST);
  if (w2 === WORKER_SRC && a2 === ADMIN_HTML && s2 === SW_SRC && m2 === ADMIN_MANIFEST) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.ncfc-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ adminHtml: a2, workerMod: Object.assign({ __src: w2 }, mod), swSrc: s2, manifestSrc: m2, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const caught = hit.length > 0;
    console.log((caught ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (caught ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!caught) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.split(a).join(b) : s);
const reps = (...pairs) => (s) => pairs.reduce((x, [a, b]) => rep(a, b)(x), s);
// worker.js
await control('cookie readable by scripts (no HttpOnly)', 'C1', { worker: rep('; Path=/api/admin; HttpOnly; Secure;', '; Path=/api/admin; Secure;') });
await control('cookie SameSite=Lax', 'C1', { worker: rep('SameSite=Strict', 'SameSite=Lax') });
await control('cookie sent to the whole site (Path=/)', 'C1', { worker: rep('; Path=/api/admin;', '; Path=/;') });
await control('short, predictable token', 'C2', { worker: rep('const b = new Uint8Array(32);', 'const b = new Uint8Array(8);') });
await control('raw session token stored', 'S2', { worker: reps(['hash: ok ? await sha256Hex(token) : ""', 'hash: ok ? token : ""'], ['{ fp, hash: await sha256Hex(tok) }', '{ fp, hash: tok }'], ['const CMD_HASH = /^[0-9a-f]{64}$/', 'const CMD_HASH = /^[A-Za-z0-9_-]{40,}$/']) });
await control('no idle timeout', 'S3', { worker: rep('if (!x || now - x.l >= COMMAND_IDLE_MS || now - x.c >= COMMAND_MAX_MS)', 'if (!x || now - x.c >= COMMAND_MAX_MS)') });
await control('no absolute limit', 'S4', { worker: rep('if (!x || now - x.l >= COMMAND_IDLE_MS || now - x.c >= COMMAND_MAX_MS)', 'if (!x || now - x.l >= COMMAND_IDLE_MS)') });
await control('logout leaves the session alive', 'S5', { worker: rep('if (CMD_HASH.test(b.hash || "") && st.s[b.hash]) { delete st.s[b.hash]; st.dirty = 1; }', '') });
await control('cookie requests without the CSRF header', 'X1', { worker: rep('  if (!commandCsrfOk(request)) return json({ error: "Missing X-FLUX-Admin header" }, 403);\n  const r = await commandDO(env, "/auth-check"', '  const r = await commandDO(env, "/auth-check"') });
await control('login without the CSRF header', 'X2', { worker: rep('async function commandLogin(request, env) {\n  if (!commandCsrfOk(request)) return json({ error: "Missing X-FLUX-Admin header" }, 403);', 'async function commandLogin(request, env) {') });
await control('CORS allows X-FLUX-Admin from anywhere', 'X3', { worker: rep('"Content-Type, x-admin-token"', '"Content-Type, x-admin-token, X-FLUX-Admin"') });
await control('no lockout', 'K1', { worker: rep('const COMMAND_CLIENT_FAILS = 5;', 'const COMMAND_CLIENT_FAILS = 500;') });
await control('locked client can still log in with the right password', 'K1', { worker: rep('  if (k.u > now) return { ok: false, locked: true, retryAfter: Math.ceil((k.u - now) / 1000) };', '') });
await control('lock shared by every client (IP ignored)', 'K2', { worker: rep('env.ADMIN_TOKEN + ":" + ip', 'env.ADMIN_TOKEN') });
await control('lock never ends', 'K3', { worker: rep('k.u = now + COMMAND_LOCK_MS;', 'k.u = now + 1000 * COMMAND_LOCK_MS;') });
await control('raw IP stored in the log', 'K4', { worker: reps(['st.a.push({ at: now, c: client.slice(0, 6),', 'st.a.push({ at: now, ip: b.ip, c: client.slice(0, 6),'], ['"/auth-attempt", { fp, client, ok, hash:', '"/auth-attempt", { fp, client, ip: request.headers.get("CF-Connecting-IP"), ok, hash:']) });
await control('x-admin-token guesses not counted', 'K5', { worker: rep('  if (supplied) {\n    const r = await commandDO', '  if (supplied) { return null;\n    const r = await commandDO') });
await control('no global safety', 'G1', { worker: rep('const COMMAND_GLOBAL_FAILS = 50;', 'const COMMAND_GLOBAL_FAILS = 5000;') });
await control('global lock shuts the owner out too', 'G2', { worker: rep('  if (b.ok === true) {\n    if (st.k[client])', '  if (st.g.u > now) return { ok: false, locked: true, retryAfter: 900 };\n  if (b.ok === true) {\n    if (st.k[client])') });
await control('safety mode never ends', 'G3', { worker: rep('st.g.u = now + COMMAND_LOCK_MS;', 'st.g.u = now + 1000 * COMMAND_LOCK_MS;') });
await control('a new secret does not clear locks and sessions', 'G4', { worker: rep('if (saved && typeof saved === "object" && saved.fp === fp) return saved;', 'if (saved && typeof saved === "object") return saved;') });
await control('failed logins not recorded', 'F1', { worker: rep('  st.a.push({ at: now, c: client.slice(0, 6), lock: locked ? 1 : 0, g: safetyOn ? 1 : 0 });', '') });
await control('comparison exits early on length', 'T1', { worker: rep('  if (typeof a !== "string" || typeof b !== "string") return false;\n  const n', '  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;\n  const n') });
await control('summary route without the password', 'M3', { worker: rep('async function adminSummary(request, env) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminSummary(request, env) {') });
await control('session route without the password', 'R1', { worker: rep('async function adminSession(request, env) {\n  const denied = requireAdmin(request, env); if (denied) return denied;', 'async function adminSession(request, env) {') });
await control('summary share rate per player instead of per run', 'M1', { worker: rep('shareRate: g.runs ? (g.shares || 0) / g.runs : null', 'shareRate: g.active ? (g.shares || 0) / g.active : null') });
await control('summary exceptions miss payment deliveries', 'M2', { worker: rep('total: (flags || 0) + (del || 0)', 'total: flags || 0') });
await control('admin responses cacheable again', 'R3', { worker: rep('  r.headers.set("Cache-Control", "no-store");\n  return r;', '  return r;') });
// admin.html
await control('page stops sending the CSRF header', 'U4', { admin: rep("'X-FLUX-Admin': '1' }", "'X-Other': '1' }") });
await control('page keeps the password in the field after login', 'U4', { admin: rep("if (r.ok) { tokenEl.value = ''; loginSay('');", "if (r.ok) { loginSay('');") });
await control('page wipes typed data on a 401', 'U6', { admin: rep('function sessionEnded() { if', 'function sessionEnded() { wipe(); if') });
await control('page shows no lock time', 'U3', { admin: rep("'Too many wrong passwords. Locked for ' + m + ' min.", "'Too many wrong passwords." ) });
await control('logout does not clear the page', 'U8', { admin: rep('    wipe(); showLogin(\'Logged out.\', \'ok\');', "    showLogin('Logged out.', 'ok');") });
await control('page links the player manifest', 'P3', { admin: rep('<link rel="manifest" href="/admin.webmanifest">', '<link rel="manifest" href="/manifest.webmanifest">') });
await control('no safe-area insets', 'P3', { admin: rep('max(18px, env(safe-area-inset-right))', '18px') });
await control('page loads the summary twice', 'M4', { admin: rep("var d = await call('summary');", "var d = await call('summary'); await call('summary');") });
// manifest
await control('manifest scope is the whole site', 'P1', { manifest: rep('"scope": "/admin"', '"scope": "/"') });
await control('manifest opens the game', 'P1', { manifest: rep('"start_url": "/admin.html"', '"start_url": "/play/"') });
// sw.js
await control('offline admin page redirected into the game', 'W2', { sw: rep("  if (req.mode === 'navigate' && isAdmin(url)) {\n    event.respondWith(fetch(req).catch(adminOffline));   // FLUX COMMAND: network only, never stored\n    return;\n  }\n", '') });
await control('service worker caches the admin API', 'W3', { sw: rep("return url.pathname.startsWith('/api/') || isAdmin(url);", 'return false;') });

console.log('\n' + '='.repeat(56));
if (main.F || NC) console.log('  FLUX COMMAND FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)');
else console.log('  FLUX COMMAND PASSED: all checks and all negative controls');
console.log('='.repeat(56));
process.exit(main.F || NC ? 1 : 0);
