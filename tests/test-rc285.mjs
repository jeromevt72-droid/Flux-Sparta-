// RC2.8.5 -- D-39 play first / name later, D-40 first-run color hint,
// D-41 level cap (anti-cheat), D-42 truthful country-scoring copy.
// Real worker.js, real game page (harness vm), real Gateway HTML.
// Written against RC2.8.4 first: must FAIL there. Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'FLUX-Sparta', 'public');
const GAME_HTML = fs.readFileSync(path.join(PUB, 'play', 'index.html'), 'utf8');
const GW_HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'worker.js'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.jeromevt72.workers.dev';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

function makeEnv(DO) {
  class S { constructor() { this.map = new Map(); } async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
    async put(a, v) { const o = typeof a === 'object' ? a : { [a]: v }; for (const [k, val] of Object.entries(o)) this.map.set(k, structuredClone(val)); } }
  class St { constructor() { this.storage = new S(); } async blockConcurrencyWhile(fn) { return fn(); } }
  const inst = new Map(); let chain = Promise.resolve();
  return { ADMIN_TOKEN: 't', STORE_OPEN: 'false', SITE_URL: ORIGIN,
    LEADERBOARD_DO: { idFromName: (n) => n, get(id) { if (!inst.has(id)) inst.set(id, new DO(new St())); const o = inst.get(id);
      return { fetch(u, i) { const r = () => o.fetch(new Request(u, i)); const p = chain.then(r, r); chain = p.then(() => {}, () => {}); return p; } }; } } };
}
const submit = async (w, env, body) => { skew += 20000;
  const r = await w.fetch(new Request(ORIGIN + '/api/submit-score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
  return { status: r.status, data: await r.json().catch(() => null) }; };

async function suite({ gameHtml, gwHtml, workerMod, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const GAME = scriptsOf(gameHtml);

  /* ---------------- D-41 anti-cheat ---------------- */
  if (!quiet) console.log('== D-41: level cap ==');
  try {
    const w = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
    let r = await submit(w, env, { playerId: 'cheat-0000-4000-8000-000000000001', name: 'HAX', score: 5000000, level: 999, difficulty: 'hard', country: 'US' });
    ck('A1 the old attack (5,000,000 at level 999) is refused', r.status === 400, r.status);
    r = await submit(w, env, { playerId: 'cheat-0000-4000-8000-000000000002', name: 'HAX', score: 400000, level: 10, difficulty: 'hard', country: 'US' });
    ck('A2 any level above 9 is refused', r.status === 400, r.status);
    // RC2.8.7 D-51 replaced the per-level ceiling (level*50,000+5,000) with
    // "the level must be the one the score reaches" -- A3..A6 follow that rule.
    r = await submit(w, env, { playerId: 'cheat-0000-4000-8000-000000000003', name: 'HAX', score: 455001, level: 2, difficulty: 'hard', country: 'US' });
    ck('A3 a level the score does not reach is refused (D-51)', r.status === 422, r.status);
    r = await submit(w, env, { playerId: 'legit-0000-4000-8000-000000000004', name: 'PRO', score: 455000, level: 9, difficulty: 'hard', country: 'US' });
    ck('A4 a score sent with its own level is accepted', r.status === 200, r.status);
    r = await submit(w, env, { playerId: 'legit-0000-4000-8000-000000000005', name: 'TITAN', score: 26423, level: 6, difficulty: 'medium', country: 'US' });
    ck('A5 a real record run (26,423 = level 6 on Medium) is accepted', r.status === 200 && r.data.ok === true, r.status);
    ck('A6 the game really stops at level 9 (the cap matches the game)', /if\(pendingLevel \|\| level>=9\) return;/.test(gameHtml) && /while\(lv<9 && /.test(gameHtml));
  } catch (e) { ck('D-41 section ran', false, String(e.stack || e).slice(0, 200)); }

  /* ---------------- D-39 / D-43 / D-44 / D-40 in the real page ---------------- */
  if (!quiet) console.log('== D-43/D-44: auto name, Easy first; D-39 name rule ==');
  const bootGame = (init) => {
    const calls = [], bodies = []; const { store, mem } = makeStore(init);
    const fetchImpl = (u, o = {}) => { calls.push(String(u)); if (String(u).includes('submit-score')) { try { bodies.push(JSON.parse(o.body)); } catch (e) {} }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, isNewBest: true, public: true, rank: 1, tag: 'ABCDEFG', country: 'PH', difficulty: 'easy' }), { status: 200, headers: { 'Content-Type': 'application/json' } })); };
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, fetchImpl });
    const timers = []; g.win.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    const shown = {}; for (const id of ['goName', 'start']) { const el = g.win.document.getElementById(id);
      el.classList = { add: (c) => { if (c === 'hidden') shown[id] = false; }, remove: (c) => { if (c === 'hidden') shown[id] = true; }, contains: () => false, toggle() {} }; }
    const run = (c) => vm.runInContext(c, g.ctx);
    const flush = async () => { for (let i = 0; i < 6; i++) { timers.splice(0).forEach((f) => { try { f(); } catch (e) {} }); await new Promise((r) => setTimeout(r, 15)); } };
    const el = (id) => g.win.document.getElementById(id);
    return { g, mem, calls, bodies, run, flush, shown, el };
  };
  const uploads = (b) => b.calls.filter((u) => u.includes('/api/submit-score')).length;
  const playRun = async (b, pts = 1234) => { b.run(`score=${pts}; level=2;`); b.g.ctx.endGame(); await b.flush(); };
  try {
    const b = bootGame({ fluxPlayerId: 'new-0000-4000-8000-00000000000a' });
    const name = b.run('callsign');
    ck('C1 brand-new pilot gets a visible, unique default name', /^PILOT-[A-HJ-NP-Z2-9]{4}$/.test(name) && b.mem.fluxCallsign === name && b.mem.fluxAutoName === '1', name);
    ck('C1 ...no form to fill: the profile is complete', b.run('profileComplete') === true && b.mem.fluxProfileComplete === '1');
    ck('D44 brand-new pilot starts on EASY', b.run('difficulty') === 'easy' && b.mem.fluxDifficulty === 'easy');
    b.el('startBtn').onclick();
    ck('C1 ENTER THE FLUX starts the game in one tap', b.run('runActive===true || playing===true') && b.shown.start === false);
    await playRun(b);
    ck('C2 the first score uploads right away (counts for the country)', uploads(b) === 1 && b.bodies[0] && b.bodies[0].name === name, JSON.stringify(b.bodies[0] || {}).slice(0, 80));
    ck('C2 ...never as a silent PLAYER (D-16 intent kept)', b.bodies.every((x) => x.name && x.name !== 'PLAYER'));
    ck('C2 game over does NOT push a rename (owner decision)', !gameHtml.includes('goRename') && b.shown.goName !== true);
  } catch (e) { ck('D-43 section ran', false, String(e.stack || e).slice(0, 200)); }
  try {
    const b = bootGame({ fluxPlayerId: 'old-0000-4000-8000-00000000000b', fluxCallsign: 'TITAN', fluxCountry: 'US', fluxProfileComplete: '1', fluxDifficulty: 'hard' });
    ck('C5 existing named pilot keeps name and difficulty', b.run('callsign') === 'TITAN' && b.run('difficulty') === 'hard' && b.mem.fluxAutoName === undefined);
    b.el('startBtn').onclick(); await playRun(b);
    ck('C5 ...uploads immediately', uploads(b) === 1 && b.shown.goName !== true);
    const c = bootGame({ fluxPlayerId: 'old-0000-4000-8000-00000000000c', fluxCallsign: 'VEGA', fluxProfileComplete: '1' });
    ck('D44 an existing pilot with no saved difficulty is NOT moved to Easy', c.run('difficulty') === 'medium');
  } catch (e) { ck('C5 ran', false, String(e.stack || e).slice(0, 200)); }
  try {
    const b = bootGame({ fluxPlayerId: 'edit-0000-4000-8000-00000000000d' });
    const auto = b.run('callsign');
    b.el('startBtn').onclick(); await playRun(b);
    const n0 = uploads(b);
    b.run('profileComplete=false');                 // EDIT pressed in the menu
    b.el('callsign').value = 'Juan'; b.el('startBtn').onclick(); await b.flush();
    ck('C6 renaming through EDIT saves the name and clears the auto flag', b.mem.fluxCallsign === 'JUAN' && b.mem.fluxAutoName === undefined && auto !== 'JUAN');
    ck('C6 ...re-uploads so the board shows the new name', uploads(b) === n0 + 1 && b.bodies.at(-1).name === 'JUAN');
    ck('C6 ...same pilot identity', b.run('playerId') === 'edit-0000-4000-8000-00000000000d');
    const d = bootGame({ fluxPlayerId: 'edit-0000-4000-8000-00000000000e' });
    const auto2 = d.run('callsign'); d.run('profileComplete=false'); d.el('callsign').value = ''; d.el('startBtn').onclick();
    ck('C6 EDIT then an empty box keeps the current name', d.run('callsign') === auto2 && d.run('profileComplete') === true);
  } catch (e) { ck('C6 ran', false, String(e.stack || e).slice(0, 200)); }
  try {
    const b = bootGame({ fluxPlayerId: 'half-0000-4000-8000-00000000000f', fluxProfileComplete: '0', fluxCallsign: '' });
    ck('C7 D-39 still guards the unnamed state (upload waits for a name)', typeof b.g.ctx.uploadOrAskName === 'function' && /if\(profileComplete\)\{/.test(gameHtml) && /showNamePrompt\(\);\n\}/.test(gameHtml));
  } catch (e) { ck('C7 ran', false, String(e.stack || e).slice(0, 200)); }
  try {
    const b = bootGame({ fluxPlayerId: 'rest-0000-4000-8000-000000000010' });
    ck('C8 new auto pilot with nothing uploaded is offered restore-code ENTRY (lost-pilot case)', b.g.ctx.restoreHasPilot() === false);
    b.mem.fluxPublicTag = 'ABCDEFG';
    ck('C8 ...once it has scores, it gets its own code screen', b.g.ctx.restoreHasPilot() === true);
    const plan = b.g.ctx.buildRestorePlan({ name: 'TITAN', tag: 'KH2K8J7', country: 'US', bests: {}, skus: [] }, 'x-1');
    ck('C8 a restored pilot is never marked auto-named', plan.fluxAutoName === null);
  } catch (e) { ck('C8 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== D-40: first-run color hint ==');
  try {
    const b = bootGame({ fluxPlayerId: 'hint-0000-4000-8000-00000000000e' });
    let app1 = 0; b.el('app').appendChild = (e) => { if (e && e.className === 'colorHint') app1++; };
    b.el('startBtn').onclick();
    ck('H1 first run: hint shown and remembered', app1 === 1 && b.mem.fluxColorHintSeen === '1', app1);
    const b2 = bootGame({ fluxPlayerId: 'hint-0000-4000-8000-00000000000f', fluxColorHintSeen: '1' });
    let appended = 0; b2.el('app').appendChild = (e) => { if (e && e.className === 'colorHint') appended++; };
    b2.el('startBtn').onclick();
    ck('H2 later runs: no hint', appended === 0);
    ck('H4 the hint never blocks touches', /\.colorHint\{[^}]*pointer-events:none/.test(gameHtml));
    ck('H5 the hint states the rule', gameHtml.includes("HIT ORBS THAT <b>MATCH YOUR BALL\\u2019S COLOR</b>"));
  } catch (e) { ck('D-40 section ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== D-45: older devices (Safari 15) ==');
  try {
    const poly = (gameHtml.match(/\/\* D-45 \(RC2\.8\.5\) OLDER DEVICES[\s\S]*?\n\}\n/) || [''])[0];
    ck('O1 roundRect stand-in present in the game', poly.includes('CanvasRenderingContext2D.prototype.roundRect = function'));
    const ops = []; class C2D { moveTo(...a) { ops.push(['m', ...a]); } arcTo(...a) { ops.push(['a', ...a]); } closePath() { ops.push(['z']); } }
    vm.runInNewContext(poly, { CanvasRenderingContext2D: C2D, Math });
    const c = new C2D(); c.roundRect(10, 20, 100, 40, 12);
    ck('O2 on Safari 15 it draws a closed rounded box (4 corners)', ops.filter((o) => o[0] === 'a').length === 4 && ops[0][1] === 22 && ops.at(-1)[0] === 'z', JSON.stringify(ops[0]));
    const ops2 = []; class Big { moveTo(...a) { ops2.push(a); } arcTo() {} closePath() {} }
    vm.runInNewContext(poly, { CanvasRenderingContext2D: Big, Math }); new Big().roundRect(0, 0, 10, 10, 99);
    ck('O3 an oversized radius is clamped (no broken shapes)', ops2[0][0] === 5);
    class Native { roundRect() { return 'native'; } }
    vm.runInNewContext(poly, { CanvasRenderingContext2D: Native, Math });
    ck('O4 newer browsers keep their own roundRect', new Native().roundRect() === 'native');
    ck('O5 the game loop schedules the next frame before drawing', /function loop\(ts\)\{\n requestAnimationFrame\(loop\);/.test(gameHtml) && !/ draw\(\);\n requestAnimationFrame\(loop\)\n\}/.test(gameHtml));
    const hero = fs.readFileSync(path.join(PUB, 'hero-demo.html'), 'utf8');
    ck('O6 the Gateway gameplay preview has the stand-in before it draws', hero.indexOf('CanvasRenderingContext2D.prototype.roundRect = function') > 0 && hero.indexOf('CanvasRenderingContext2D.prototype.roundRect = function') < hero.indexOf('ctx.beginPath();ctx.roundRect('));
  } catch (e) { ck('D-45 section ran', false, String(e.stack || e).slice(0, 200)); }

  /* ---------------- D-42 truthful copy ---------------- */
  if (!quiet) console.log('== D-42: the Gateway says what the scoring does ==');
  const text = gwHtml.replace(/<[^>]+>/g, ' ');
  for (const bad of ['Every run counts', 'Every legitimate run', 'Real totals from every FLUX run', 'Every game you play adds', 'your score adds to your country']) {
    ck('T1 false claim gone: "' + bad + '"', !text.includes(bad));
  }
  ck('T2 the rule is stated where the grid is', text.includes("Each pilot's best score counts for their country"));
  ck('T2 ...in the why-cards', text.includes("Your best score counts toward your country's standing"));
  ck('T2 ...in the FAQ', text.includes("every new player and every new personal best moves the board"));
  ck('S1 the start button has exactly one handler (no dead copies)', (gameHtml.match(/getElementById\('startBtn'\)\.onclick/g) || []).length === 1);
  ck('T3 the server really counts one best per pilot (the copy matches the code)', /Each player counts once,\s*\n\s*at their single best public score/.test(WORKER_SRC));
  return { F, failed };
}

const real = await import(pathToFileURL(path.join(__dirname, 'FLUX-Sparta', 'worker.js')).href);
const main = await suite({ gameHtml: GAME_HTML, gwHtml: GW_HTML, workerMod: real });

console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
async function control(label, { expect, game = (s) => s, gw = (s) => s, workerSrc = (s) => s }) {
  const g2 = game(GAME_HTML), gw2 = gw(GW_HTML), w2 = workerSrc(WORKER_SRC);
  if (g2 === GAME_HTML && gw2 === GW_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc39-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try { const mod = await import(pathToFileURL(tmp).href); const r = await suite({ gameHtml: g2, gwHtml: gw2, workerMod: mod, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++; } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('level 999 accepted again', { expect: 'A1', workerSrc: rep('const MAX_LEVEL = 9;', 'const MAX_LEVEL = 999;') });
await control('no auto name for new pilots', { expect: 'C1', game: rep("if (localStorage.fluxProfileComplete === '1' || localStorage.fluxCallsign) return;", "return;") });
await control('new pilots not started on Easy', { expect: 'D44', game: rep("if (!localStorage.fluxDifficulty) { difficulty = 'easy'; localStorage.fluxDifficulty = 'easy'; }", "") });
await control('Easy forced on existing pilots too', { expect: 'D44', game: rep("if (localStorage.fluxProfileComplete === '1' || localStorage.fluxCallsign) return;", "if (localStorage.fluxProfileComplete === '1' || localStorage.fluxCallsign) { difficulty = 'easy'; return; }") });
await control('rename keeps the auto flag', { expect: 'C6', game: rep("if (typed !== was) { try { localStorage.removeItem('fluxAutoName'); } catch (e) {} } submitScore();", "submitScore();") });
await control('rename does not re-upload', { expect: 'C6', game: rep("if (typed !== was) { try { localStorage.removeItem('fluxAutoName'); } catch (e) {} } submitScore();", "if (typed !== was) { try { localStorage.removeItem('fluxAutoName'); } catch (e) {} }") });
await control('rename suggestion added back at game over', { expect: 'C2', game: rep('<div id="goName" class="goName hidden">', '<div id="goRename"></div><div id="goName" class="goName hidden">') });
await control('roundRect stand-in removed', { expect: 'O1', game: rep("CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {", "CanvasRenderingContext2D.prototype.roundRectX = function (x, y, w, h, r) {") });
await control('loop freezes on a bad frame again', { expect: 'O5', game: (s) => s.replace(" requestAnimationFrame(loop);   // D-45: next frame first, so one bad frame can never freeze the game\n", "").replace(" draw();\n}\nrequestAnimationFrame(loop);", " draw();\n requestAnimationFrame(loop)\n}\nrequestAnimationFrame(loop);") });
await control('hint shown every run', { expect: 'H2', game: rep("if(localStorage.getItem('fluxColorHintSeen')==='1') return; ", "") });
await control('dead start handler added back', { expect: 'S1', game: (s) => s.replace("document.getElementById('againBtn').onclick=", "document.getElementById('startBtn').onclick=()=>{};\ndocument.getElementById('againBtn').onclick=") });
await control('false copy restored', { expect: 'T1', gw: rep("Real totals, grouped by country. Each pilot's best score counts for their country — beat your best and your flag climbs.", "Real totals from every FLUX run, grouped by country. Play a run, and your score adds to your country's total below.") });

const total = main.F + NC;
console.log('\n' + (total ? ('RC2.8.5 FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)') : 'RC2.8.5 PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
