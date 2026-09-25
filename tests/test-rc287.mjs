// RC2.8.7 -- D-50 score-based levels + SPEED UP countdown, D-51 server level
// rule, D-52 lives in the top box, D-53 pause in the FLUX row, D-54 no HUD
// clutter, D-55 11px text / 44px buttons, D-56 palettes + subtle symbols,
// D-57 game-over line, D-58 "Playing for", D-59 revive words, D-60 name offer,
// D-61 quiet sound start + rising combo pitch.
// Real worker.js, real game page (harness vm). Written to FAIL on RC2.8.6.
// Ends with negative controls: each old defect is put back and MUST be caught.
// Rendered sizes and 360px fit are measured separately in a real browser:
// test-rc287-browser.mjs (needs Chromium, so it is not in the gate).
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { LEVEL_SCORE_THRESHOLDS as RULE_T, LEVEL_SCORE_MULT as RULE_M, levelFor } from './level-rule.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'FLUX-Sparta', 'public');
const GAME_HTML = fs.readFileSync(path.join(PUB, 'play', 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'worker.js'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.jeromevt72.workers.dev';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const stylesOf = (h) => [...h.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

/* ---------- colour maths (D-56) ---------- */
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lum = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const Lstar = (h) => { const y = lum(h); return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y; };
const hue = (h) => { const [r, g, b] = rgb(h), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return NaN;
  let x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; x *= 60; return x < 0 ? x + 360 : x; };
const hueGap = (a, b) => { const d = Math.abs(hue(a) - hue(b)) % 360; return d > 180 ? 360 - d : d; };
const contrast = (a, b) => { const A = lum(a) + 0.05, B = lum(b) + 0.05; return Math.max(A, B) / Math.min(A, B); };
const isRed = (h) => { const x = hue(h); return x >= 345 || x <= 20; };
const isGreen = (h) => { const x = hue(h); return x >= 90 && x <= 150; };

/* ---------- worker env (same shape as the other server suites) ---------- */
function makeEnv(DO) {
  class S { constructor() { this.map = new Map(); } async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
    async put(a, v) { const o = typeof a === 'object' ? a : { [a]: v }; for (const [k, val] of Object.entries(o)) this.map.set(k, structuredClone(val)); } }
  class St { constructor() { this.storage = new S(); } async blockConcurrencyWhile(fn) { return fn(); } }
  const inst = new Map(); let chain = Promise.resolve();
  return { ADMIN_TOKEN: 't', STORE_OPEN: 'false', SITE_URL: ORIGIN,
    LEADERBOARD_DO: { idFromName: (n) => n, get(id) { if (!inst.has(id)) inst.set(id, new DO(new St())); const o = inst.get(id);
      return { fetch(u, i) { const r = () => o.fetch(new Request(u, i)); const p = chain.then(r, r); chain = p.then(() => {}, () => {}); return p; } }; } } };
}
let pidN = 0;
const submit = async (w, env, body) => { skew += 20000;
  const r = await w.fetch(new Request(ORIGIN + '/api/submit-score', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'rc287-' + (++pidN), name: 'T', country: 'US', ...body }) }), env);
  return r.status; };

async function suite({ gameHtml, workerMod, workerSrc = WORKER_SRC, quiet = false }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const sec = (t) => { if (!quiet) console.log('== ' + t + ' =='); };
  const GAME = scriptsOf(gameHtml);
  const CSS = noComments(stylesOf(gameHtml));
  const CODE = noComments(GAME.join('\n;\n')).replace(/^\s*\/\/.*$/gm, '');

  // Boot the real page. Elements get a class tracker so visibility is observable.
  const bootGame = (init = {}) => {
    const calls = [], bodies = []; const { store, mem } = makeStore(init);
    const fetchImpl = (u, o = {}) => { calls.push(String(u)); if (String(u).includes('submit-score')) { try { bodies.push(JSON.parse(o.body)); } catch (e) {} }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, isNewBest: true, public: true, rank: 1, tag: 'ABCDEFG' }), { status: 200 })); };
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, fetchImpl });
    const timers = []; g.win.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    const cls = {};
    const el = (id) => g.win.document.getElementById(id);
    const track = (id, initial = []) => { const set = cls[id] = new Set(initial);
      el(id).classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, f) => { if (f === undefined ? !set.has(c) : f) set.add(c); else set.delete(c); } }; };
    for (const id of ['goClaim', 'goName', 'playingFor', 'profileEditor', 'profileSaved']) track(id, ['hidden']);
    for (const id of ['levelBox', 'livesBox']) track(id);
    const run = (c) => vm.runInContext(c, g.ctx);
    const flush = () => { for (let i = 0; i < 4; i++) timers.splice(0).forEach((f) => { try { f(); } catch (e) {} }); };
    const shown = (id) => cls[id] && !cls[id].has('hidden');
    return { g, mem, calls, bodies, run, el, cls, flush, shown };
  };

  /* ================= D-50 ================= */
  sec('D-50: levels come from score; SPEED UP countdown; smooth speed');
  try {
    const b = bootGame({ fluxPlayerId: 'lv-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxDifficulty: 'medium' });
    const T = b.run('JSON.stringify(LEVEL_SCORE_THRESHOLDS)'), M = b.run('JSON.stringify(LEVEL_SCORE_MULT)');
    ck('L1 Medium thresholds for levels 2-9 are 2500 6000 10000 15000 21000 28000 36000 45000', T === '[2500,6000,10000,15000,21000,28000,36000,45000]', T);
    ck('L1 Easy x0.75, Hard x1.35', M === '{"easy":0.75,"medium":1,"hard":1.35}', M);
    const lf = (s, d) => b.g.ctx.levelForScore(s, d);
    ck('L1 edges: Medium 2499->1, 2500->2, 44999->8, 45000->9, 10M->9', lf(2499, 'medium') === 1 && lf(2500, 'medium') === 2 && lf(44999, 'medium') === 8 && lf(45000, 'medium') === 9 && lf(1e7, 'medium') === 9);
    ck('L1 edges: Easy 1874->1, 1875->2, 33750->9; Hard 3374->1, 3375->2, 60750->9',
      lf(1874, 'easy') === 1 && lf(1875, 'easy') === 2 && lf(33750, 'easy') === 9 && lf(3374, 'hard') === 1 && lf(3375, 'hard') === 2 && lf(60750, 'hard') === 9);
    ck('L1 the game uses the same table as the server fixtures (level-rule.mjs)', [0, 1874, 1875, 2500, 9999, 26423, 44999, 45000, 60750, 99999].every((s) => ['easy', 'medium', 'hard'].every((d) => lf(s, d) === levelFor(s, d))));

    b.g.ctx.newGame(); b.flush();
    let ticks = 0, levelUps = 0; b.g.ctx.playTick = () => { ticks++; }; b.g.ctx.playLevelUp = () => { levelUps++; };
    // 20 real PERFECT paddle catches through update(): they score, but the level stays.
    b.run('score=0; targets=[];');
    let perfects = 0;
    for (let i = 0; i < 20; i++) {
      b.run('targets=[]; ball.x=paddle.x; ball.vx=0; ball.vy=6; ball.y=paddle.y-paddle.h/2-ball.r+2; comboTimer=2;');
      const before = b.run('score'); b.g.ctx.update(0.016); if (b.run('score') > before && b.run('ball.vy') < 0) perfects++;
    }
    ck('L2 perfect catches still score', perfects === 20 && b.run('score') > 0, perfects + ' catches, score ' + b.run('score'));
    ck('L2 ...but no longer drive the level', b.run('level') === 1 && b.run('pendingLevel') === 0 && b.run('score') < 2500 && !/levelPoints/.test(CODE));
    b.run('score=2400;');
    b.g.ctx.checkScoreLevel();
    ck('L2 below the threshold: still level 1, no countdown', b.run('level') === 1 && b.run('pendingLevel') === 0);
    b.run('score=2500;'); b.g.ctx.checkScoreLevel();
    ck('L3 at the threshold: level-up starts (banner + sound), level not yet changed', b.run('pendingLevel') === 2 && b.run('level') === 1 && b.run('levelBanner') > 0 && levelUps === 1);
    // banner draws NEXT LEVEL: 2
    const texts = []; b.run('ctx').fillText = (t) => { texts.push(String(t)); };
    b.g.ctx.draw();
    ck('L3 the level-up banner adds "NEXT LEVEL: 2"', texts.includes('NEXT LEVEL: 2'), texts.filter((t) => /LEVEL/.test(t)).join(' | '));
    ck('L4 LEVEL box turns amber and reads SPEED UP 5', b.cls.levelBox.has('speedUp') && b.el('levelLabel').textContent === 'SPEED UP' && String(b.el('level').textContent) === '5', b.el('levelLabel').textContent + ' ' + b.el('level').textContent);
    ck('L4 amber is a real style (.stat.speedUp)', /\.stat\.speedUp\{[^}]*border-color:#ffb020/.test(CSS));
    const shownN = [];
    for (let i = 0; i < 4; i++) { b.g.ctx.tickLevelUp(1); shownN.push(String(b.el('level').textContent)); }
    ck('L4 counts 5-4-3-2-1 with a soft tick each second', shownN.join('') === '4321' && ticks === 5 && b.run('pendingLevel') === 2, shownN.join(',') + ' ticks=' + ticks);
    b.g.ctx.tickLevelUp(1);
    ck('L5 after the countdown the new level starts and the box is LEVEL 2 again', b.run('level') === 2 && b.run('pendingLevel') === 0 && !b.cls.levelBox.has('speedUp') && b.el('levelLabel').textContent === 'LEVEL' && String(b.el('level').textContent) === '2');
    const sp0 = b.run('speedLevel'); b.g.ctx.tickLevelUp(1.0); const sp1 = b.run('speedLevel'); b.g.ctx.tickLevelUp(1.0); const sp2 = b.run('speedLevel');
    ck('L5 speed rises smoothly over ~2 s (1 -> 1.5 -> 2), never in one jump', sp0 === 1 && Math.abs(sp1 - 1.5) < 1e-9 && sp2 === 2, [sp0, sp1, sp2].join(' -> '));
    ck('L5 the speed limit follows that ramp', /Math\.min\(17\.5,\(12\+speedLevel\*\.48\)\*DIFFICULTY\[difficulty\]\.speed\)/.test(CODE));
    b.run('score=4250;'); b.g.ctx.updateHud();
    ck('L6 the LEVEL bar shows progress to the next level (4,250 of 2,500..6,000 = 50%)', String(b.el('levelProgress').style.width) === '50%', b.el('levelProgress').style.width);
    b.run('score=50000;'); b.g.ctx.checkScoreLevel();
    ck('L7 a big jump still goes one level at a time', b.run('pendingLevel') === 3);
    for (let i = 0; i < 6; i++) { b.g.ctx.tickLevelUp(1); b.g.ctx.checkScoreLevel(); }
    ck('L7 ...then the next countdown starts', b.run('level') === 3 && b.run('pendingLevel') === 4);
    // recorded + uploaded level = the level the score reaches
    const r = bootGame({ fluxPlayerId: 'lv-2', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxDifficulty: 'medium' });
    r.g.ctx.newGame(); r.run('score=26423; level=2;'); r.g.ctx.endGame(); r.flush(); await new Promise((ok) => setTimeout(ok, 30));
    const rec = JSON.parse(r.mem.fluxBestRun_medium || '{}');
    ck('L8 the saved best carries the level its score reaches (26,423 -> 6)', rec.score === 26423 && rec.level === 6, JSON.stringify(rec));
    ck('L8 ...and that is what is uploaded', r.bodies.length > 0 && r.bodies.at(-1).level === 6, JSON.stringify(r.bodies.at(-1) || {}));
    const o = bootGame({ fluxPlayerId: 'lv-3', fluxCallsign: 'OLD', fluxProfileComplete: '1',
      fluxBest_medium: '26423', fluxBestLevel_medium: '2', fluxBestRun_medium: JSON.stringify({ score: 26423, level: 2, difficulty: 'medium', playerId: 'lv-3', at: 1 }),
      fluxPendingSubmits: JSON.stringify([{ id: 'q', playerId: 'lv-3', name: 'OLD', score: 26423, level: 2, difficulty: 'medium', attempts: 0 }]) });
    ck('L9 bests saved by older versions get the level their score reaches (so the server accepts them)', JSON.parse(o.mem.fluxBestRun_medium).level === 6 && o.mem.fluxBestLevel_medium === '6' && JSON.parse(o.mem.fluxPendingSubmits)[0].level === 6);
    ck('L9 ...and the scores themselves are untouched', JSON.parse(o.mem.fluxBestRun_medium).score === 26423 && o.mem.fluxBest_medium === '26423');
  } catch (e) { ck('D-50 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-51 ================= */
  sec('D-51: the server checks level against score');
  try {
    const w = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
    ck('S1 a real run at its own level is accepted (Medium 26,423 at 6)', (await submit(w, env, { score: 26423, level: 6, difficulty: 'medium' })) === 200);
    ck('S1 one level either side is allowed (5 and 7)', (await submit(w, env, { score: 26423, level: 5, difficulty: 'medium' })) === 200 && (await submit(w, env, { score: 26423, level: 7, difficulty: 'medium' })) === 200);
    ck('S2 two levels off is refused (4 and 8)', (await submit(w, env, { score: 26423, level: 4, difficulty: 'medium' })) === 422 && (await submit(w, env, { score: 26423, level: 8, difficulty: 'medium' })) === 422);
    ck('S3 the difficulty scales it: Easy 33,750 is level 9, Hard 33,750 is level 7',
      (await submit(w, env, { score: 33750, level: 9, difficulty: 'easy' })) === 200 && (await submit(w, env, { score: 33750, level: 9, difficulty: 'hard' })) === 422 && (await submit(w, env, { score: 33750, level: 7, difficulty: 'hard' })) === 200);
    ck('S4 the old attack shape (huge score at a low level) is refused', (await submit(w, env, { score: 4999999, level: 1, difficulty: 'hard' })) === 422);
    ck('S5 other checks kept: level 10 -> 400, score above MAX -> 400, bad id -> 400',
      (await submit(w, env, { score: 60000, level: 10, difficulty: 'medium' })) === 400 && (await submit(w, env, { score: 5000001, level: 9, difficulty: 'medium' })) === 400 &&
      (await submit(w, env, { playerId: '__proto__', score: 100, level: 1 })) === 400);
    const pid = 'rc287-cool'; await submit(w, env, { playerId: pid, score: 100, level: 1 }); skew -= 19000;
    ck('S5 ...and the submit cooldown', (await submit(w, env, { playerId: pid, score: 200, level: 1 })) === 429);
    const wt = (workerSrc.match(/const LEVEL_SCORE_THRESHOLDS = (\[[^\]]*\])/) || [])[1];
    ck('S6 server and game use the same thresholds and multipliers', wt && JSON.stringify(JSON.parse(wt)) === JSON.stringify(RULE_T) && /LEVEL_SCORE_MULT = \{ easy: 0\.75, medium: 1, hard: 1\.35 \}/.test(workerSrc) && JSON.stringify(RULE_M) === '{"easy":0.75,"medium":1,"hard":1.35}');
  } catch (e) { ck('D-51 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-52 ================= */
  sec('D-52: lives in the top box; no FLUX LIVES box');
  try {
    ck('V1 the canvas no longer draws a FLUX LIVES box', !/fillText\('FLUX LIVES'/.test(CODE) && !/LEFT',bx\+boxW/.test(CODE));
    const b = bootGame({ fluxPlayerId: 'lives-1', fluxCallsign: 'T', fluxProfileComplete: '1' }); b.g.ctx.newGame();
    const st = () => [b.el('livesLabel').textContent, String(b.el('lives').textContent), b.cls.livesBox.has('lastLife')].join('/');
    b.run('misses=0;'); b.g.ctx.updateHud(); const s0 = st();
    b.run('misses=1;'); b.g.ctx.updateHud(); const s1 = st();
    b.run('misses=2;'); b.g.ctx.updateHud(); const s2 = st();
    ck('V2 the top box shows lives: LIVES 3, LIVES 2', s0 === 'LIVES/3/false' && s1 === 'LIVES/2/false', s0 + ' ' + s1);
    ck('V3 on the last life it turns red and says LAST LIFE', s2 === 'LAST LIFE/1/true' && /\.stat\.lastLife\{[^}]*border-color:#ff3b5c/.test(CSS), s2);
    ck('V3 no MISSES x/3 label left in the HUD', !/<span>MISSES<\/span>/.test(gameHtml));
  } catch (e) { ck('D-52 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-53 ================= */
  sec('D-53: pause in the FLUX meter row, safe-area aware');
  try {
    ck('P1 markup: [pause] FLUX ---- 100% in one row', /<div class="fluxbar"><button id="pauseBtn"[^>]*>[^<]*<\/button><span>FLUX<\/span><div><i id="fluxFill"><\/i><\/div><b id="fluxPct">/.test(gameHtml));
    const hud = gameHtml.slice(gameHtml.indexOf('<div class="hud">'), gameHtml.indexOf('<div id="pauseOverlay"'));
    ck('P2 the row is inside the HUD, whose top honours safe-area-inset-top', hud.includes('id="pauseBtn"') && /\.hud\{position:absolute;top:max\(16px,env\(safe-area-inset-top\)\)/.test(CSS));
    const pRules = [...CSS.matchAll(/#pauseBtn\{([^}]*)\}/g)].map((m) => m[1]).join(';');
    ck('P3 the pause button is not pinned at a fixed height any more (no absolute top)', !/position:absolute/.test(pRules) && !/(^|;)top:/.test(pRules), pRules.slice(0, 120));
    ck('P3 the pause button is 44px', /width:44px;height:44px/.test(pRules));
  } catch (e) { ck('D-53 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-54 ================= */
  sec('D-54: no HUD clutter during play');
  try {
    const hud = gameHtml.slice(gameHtml.indexOf('<div class="hud">'), gameHtml.indexOf('<div id="pauseOverlay"'));
    ck('C1 no tagline in the HUD', !/FLOW • LAUNCH/.test(hud) && !/class="sub"/.test(hud));
    const MARKUP = gameHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    ck('C2 no SOUND • ON and no FIELD • STABLE', !/SOUND • ON|FIELD • STABLE/.test(MARKUP) && !/SOUND • ON|FIELD • STABLE/.test(CODE) && !/id="audioBadge"|id="pressureBadge"/.test(MARKUP));
    const b = bootGame({ fluxPlayerId: 'clut-1', fluxCallsign: 'T', fluxProfileComplete: '1' }); b.g.ctx.newGame();
    const glow = b.el('pressureGlow'); let threw = null; try { b.run('updatePressureBadge()'); } catch (e) { threw = e; }
    ck('C3 the pressure glow still works without the badge', !threw && typeof glow.style.opacity === 'number', threw ? String(threw).slice(0, 80) : typeof glow.style.opacity);
    ck('C3 ...and nothing writes FIELD text anywhere', !/FIELD • (STABLE|PRESSURE|CRITICAL)/.test(CODE));
  } catch (e) { ck('D-54 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-55 ================= */
  sec('D-55: text >= 11px, buttons >= 44px');
  try {
    const small = [];
    for (const m of CSS.matchAll(/font-size:\s*([0-9.]+)(px|em|rem)/g)) { const v = parseFloat(m[1]); if ((m[2] === 'px' && v < 11) || (m[2] !== 'px' && v < 1)) small.push(m[0]); }
    for (const m of CSS.matchAll(/font:[^;}]*?([0-9.]+)px/g)) if (parseFloat(m[1]) < 11) small.push(m[0]);
    for (const m of gameHtml.matchAll(/style="[^"]*font-size:\s*([0-9.]+)px/g)) if (parseFloat(m[1]) < 11) small.push(m[0].slice(-30));
    ck('T1 no stylesheet or inline font size under 11px (and no shrinking em sizes)', small.length === 0, small.join(' '));
    const canvas = [...CODE.matchAll(/ctx\.font=([^;]+);/g)].map((m) => m[1]);
    const badCanvas = canvas.filter((f) => { const lit = f.match(/(\d+(?:\.\d+)?)px/); return lit ? parseFloat(lit[1]) < 11 : !/Math\.max\(11,/.test(f); });
    ck('T2 every canvas text is at least 11px (fixed sizes >= 11, scaled sizes clamped with Math.max(11, ...))', canvas.length > 3 && badCanvas.length === 0, badCanvas.join(' | '));
    const btnRule = (CSS.match(/(^|[}\n])button\{([^}]*)\}/) || [])[2] || '';
    ck('T3 every button is at least 44px tall (base rule)', /min-height:44px/.test(btnRule), btnRule.slice(-60));
    const overrides = [...CSS.matchAll(/([^{}]*button[^{}]*)\{([^}]*)\}/g)].filter((m) => /(^|;)\s*(max-height|height|min-height)\s*:\s*([0-9.]+)px/.test(m[2]) && parseFloat(m[2].match(/(?:max-height|height|min-height)\s*:\s*([0-9.]+)px/)[1]) < 44);
    ck('T3 ...and no button rule shrinks it', overrides.length === 0, overrides.map((m) => m[1].trim()).join(', '));
    ck('T4 EDIT keeps 44px despite its !important padding', /\.editProfile\{[^}]*min-height:44px/.test(CSS));
    ck('T5 EDIT, leaderboard, skins and EASY/MEDIUM/HARD are real <button>s (so the 44px rule reaches them)',
      /<button class="editProfile" id="editProfile">/.test(gameHtml) && /<button class="linkBtn" id="leaderBtn">/.test(gameHtml) && /<button class="linkBtn" id="skinsBtn">/.test(gameHtml) && (gameHtml.match(/<button data-d="(easy|medium|hard)">/g) || []).length === 6);
    ck('T6 360px: HUD labels never wrap, phone layout keeps four boxes narrow', /\.stat span\{[^}]*white-space:nowrap/.test(CSS) && /@media \(max-width: 430px\)\{[\s\S]*?\.stat\{min-width:50px;padding:4px 4px\}/.test(CSS));
  } catch (e) { ck('D-55 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-56 ================= */
  sec('D-56: palettes and subtle symbols');
  try {
    const b = bootGame({ fluxPlayerId: 'pal-1', fluxCallsign: 'T', fluxProfileComplete: '1' });
    const SK = JSON.parse(b.run('JSON.stringify(SKINS)'));
    const bgs = JSON.parse(b.run('JSON.stringify(CELESTIAL_THEMES)')).map((g) => (g.match(/#[0-9a-f]{6}/gi) || [])[1]).concat(['#050719']);
    ck('K1 default palette starts #ffd23f #35e6ff #ff4f98 #b48cff', SK.aurora.colors.slice(0, 4).join(' ') === '#ffd23f #35e6ff #ff4f98 #b48cff', SK.aurora.colors.slice(0, 4).join(' '));
    for (const [k, s] of Object.entries(SK)) {
      const c = s.colors; const f4 = c.slice(0, 4);
      const minC = Math.min(...c.flatMap((x) => bgs.map((bg) => contrast(x, bg))));
      ck('K2 ' + k + ': every colour bright on the field (contrast >= 4.5:1 on every level background)', minC >= 4.5, minC.toFixed(2));
      let minH = 999, minL = 999; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { minH = Math.min(minH, hueGap(f4[i], f4[j])); minL = Math.min(minL, Math.abs(Lstar(f4[i]) - Lstar(f4[j]))); }
      ck('K3 ' + k + ': first four differ in hue (>= 35 deg) AND lightness (no two alike)', minH >= 35 && minL >= 1.5, 'hue ' + minH.toFixed(0) + ' L* ' + minL.toFixed(1));
      ck('K4 ' + k + ': no red-vs-green pair', !(c.some(isRed) && c.some(isGreen)), c.filter((x) => isRed(x) || isGreen(x)).join(' '));
      ck('K5 ' + k + ': nine colours, all valid', c.length === 9 && c.every((x) => /^#[0-9a-f]{6}$/i.test(x)));
    }
    // Rendered: orb symbols subtle, ball brightest.
    b.g.ctx.newGame(); b.run('ball.color=0;');
    const ops = []; const cx = b.run('ctx'); const glyphs = JSON.parse(b.run('JSON.stringify(glyphs)'));
    cx.fillText = (t) => { ops.push({ t: String(t), a: cx.globalAlpha }); };
    const fills = []; cx.fill = () => { fills.push({ s: String(cx.fillStyle), a: cx.globalAlpha }); };
    b.g.ctx.draw();
    const gl = ops.filter((o) => glyphs.includes(o.t));
    ck('K6 orb symbols are drawn, and subtle (alpha <= 0.4)', gl.length > 0 && gl.every((o) => o.a <= 0.4), gl.map((o) => o.a).join(','));
    const orbFills = fills.filter((f) => /^#[0-9a-f]{8}$/i.test(f.s)).map((f) => parseInt(f.s.slice(7), 16) / 255);
    const ballFill = fills.find((f) => f.s === SK.aurora.colors[0] && f.a === 1);
    ck('K7 the ball is the brightest thing: a solid disc with a white core; orbs are translucent', !!ballFill && orbFills.length > 0 && Math.max(...orbFills) <= 0.25 && /glowCircle\(ball\.x,ball\.y,ball\.r\*\.55,'#ffffff'/.test(CODE), 'orb fill alpha max ' + Math.max(...orbFills).toFixed(2));
  } catch (e) { ck('D-56 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-57 ================= */
  sec('D-57: the score plus one line');
  try {
    const go = gameHtml.slice(gameHtml.indexOf('<div id="gameover"'), gameHtml.indexOf('<div class="gameoverModes">'));
    ck('G1 the three headlines are gone (FLUX OVERLOAD / THE FLOW BROKE / FLUX COLLAPSE)', !/OVERLOAD|THE FLOW BROKE|FLUX COLLAPSE|<h1/.test(go) && /class="goScore" id="finalScore"/.test(go) && (go.match(/class="goLine"/g) || []).length === 1);
    const b = bootGame({ fluxPlayerId: 'go-1', fluxCallsign: 'MARIA', fluxProfileComplete: '1', fluxCountry: 'PH', fluxDifficulty: 'medium',
      fluxBest_medium: '3000', fluxBestRun_medium: JSON.stringify({ score: 3000, level: 2, difficulty: 'medium', playerId: 'go-1', at: 1 }),
      fluxBest_easy: '4000', fluxBestRun_easy: JSON.stringify({ score: 4000, level: 4, difficulty: 'easy', playerId: 'go-1', at: 1 }) });
    const L = (a, p, o) => { const r = b.g.ctx.gameOverLine(a, p, o); return r.first + ' · ' + r.second; };
    ck('G2 new best that raises the country total: "NEW BEST! · 🇵🇭 +1,000 for Philippines"', L(5000, 3000, 4000) === 'NEW BEST! · 🇵🇭 +1,000 for Philippines', L(5000, 3000, 4000));
    ck('G3 new best that does not beat the pilot\'s counted best: "Beat 8,000 to add to 🇵🇭"', L(5000, 3000, 8000) === 'NEW BEST! · Beat 8,000 to add to 🇵🇭', L(5000, 3000, 8000));
    ck('G4 not a best: "<n> from your best"', L(2500, 3000, 4000) === '500 from your best · Beat 4,000 to add to 🇵🇭', L(2500, 3000, 4000));
    b.g.ctx.newGame(); b.run('score=5000;'); b.g.ctx.endGame(); b.flush();
    const html = String(b.el('goLine').innerHTML);
    ck('G5 a real game over shows it (counted best is the Easy 4,000 -> +1,000)', /NEW BEST!/.test(html) && html.includes('🇵🇭 +1,000 for Philippines') && String(b.el('finalScore').textContent) === (5000).toLocaleString(), html);
  } catch (e) { ck('D-57 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-58 ================= */
  sec('D-58: "Playing for <flag> <Country> · change" on first launch');
  try {
    const b = bootGame({ fluxCountry: 'PH' }); b.g.ctx.refreshMenu();
    ck('F1 first launch shows it, with the flag and country name', b.shown('playingFor') && String(b.el('playingForWho').textContent) === '🇵🇭 Philippines', b.el('playingForWho').textContent);
    ck('F1 it sits right under ENTER THE FLUX and ends with "change"', /<button id="startBtn">ENTER THE FLUX<\/button><button type="button" id="playingFor"[^>]*>Playing for <span id="playingForWho">[^<]*<\/span> · <u>change<\/u><\/button>/.test(gameHtml));
    ck('F2 it is a <button>, so the 44px rule gives it a 44px tap target', /<button type="button" id="playingFor"/.test(gameHtml) && /(^|[}\n])button\{[^}]*min-height:44px/.test(CSS));
    b.el('playingFor').onclick();
    ck('F3 "change" opens the profile editor (country picker)', b.run('profileComplete') === false);
    const c = bootGame({ fluxCountry: 'PH', fluxRunsPlayed: '1', fluxCallsign: 'T', fluxProfileComplete: '1' }); c.g.ctx.refreshMenu();
    ck('F4 not shown once the pilot has played', !c.shown('playingFor'));
  } catch (e) { ck('D-58 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-59 ================= */
  sec('D-59: revive wording');
  try {
    const b = bootGame({ fluxPlayerId: 'rev-1', fluxCallsign: 'T', fluxProfileComplete: '1' }); b.g.ctx.newGame();
    b.g.ctx.offerRevive();
    const html = String(b.g.win.document.createElement('div').innerHTML);
    ck('R1 "FREE extra life?" with YES, FREE / END RUN', /FREE extra life\?/.test(html) && />YES, FREE</.test(html) && />END RUN</.test(html) && !/OUT OF MISSES|one more miss/.test(html), html.slice(0, 160));
  } catch (e) { ck('D-59 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-60 ================= */
  sec('D-60: offer auto-named pilots a name, once');
  try {
    const auto = (extra = {}) => bootGame({ fluxPlayerId: 'auto-1', fluxCallsign: 'PILOT-7Q2K', fluxAutoName: '1', fluxProfileComplete: '1', fluxDifficulty: 'easy',
      fluxBest_easy: '1000', fluxBestRun_easy: JSON.stringify({ score: 1000, level: 1, difficulty: 'easy', playerId: 'auto-1', at: 1 }), ...extra });
    const end = (b, s) => { b.g.ctx.newGame(); b.run('score=' + s + ';'); b.g.ctx.endGame(); b.flush(); };
    let b = auto({ fluxRunsPlayed: '1' }); end(b, 2000);
    ck('N1 run 2+, auto name, new best: "Put your name on the board?" is offered', b.shown('goClaim') && b.mem.fluxNameClaimOffered === '1' && /Put your name on the board\?/.test(gameHtml));
    b.el('goClaimYes').onclick();
    ck('N2 YES opens the name box', !b.shown('goClaim') && b.shown('goName'));
    b = auto({ fluxRunsPlayed: '1' }); end(b, 2000); b.el('goClaimNo').onclick();
    ck('N3 it can be dismissed', !b.shown('goClaim') && !b.shown('goName'));
    end(b, 3000);
    ck('N4 offered only once', !b.shown('goClaim'));
    b = auto(); end(b, 2000);
    ck('N5 not on the first run', !b.shown('goClaim'));
    b = auto({ fluxRunsPlayed: '4' }); end(b, 500);
    ck('N6 not without a new best', !b.shown('goClaim'));
    b = bootGame({ fluxPlayerId: 'named-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '4' }); end(b, 2000);
    ck('N7 never for a pilot who chose a name', !b.shown('goClaim'));
  } catch (e) { ck('D-60 section ran', false, String(e.stack || e).slice(0, 300)); }

  /* ================= D-61 ================= */
  sec('D-61: quiet start, fade-in, combo pitch');
  try {
    const b = bootGame({ fluxPlayerId: 'snd-1', fluxCallsign: 'T', fluxProfileComplete: '1' });
    const log = [];
    const param = (name) => ({ value: 1, setValueAtTime(v, t) { log.push([name, 'set', v, t]); }, linearRampToValueAtTime(v, t) { log.push([name, 'ramp', v, t]); }, exponentialRampToValueAtTime(v, t) { log.push([name, 'exp', v, t]); } });
    const gains = [];
    b.g.win.AudioContext = function () { this.currentTime = 10; this.state = 'running'; this.destination = {};
      this.createGain = () => { const g = { gain: param('gain' + gains.length), connect() {} }; gains.push(g); return g; };
      this.createDynamicsCompressor = () => ({ threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect() {} });
      this.resume = () => Promise.resolve(); };
    b.g.ctx.initAudio();
    const mg = gains[0]; const ramp = log.find((l) => l[0] === 'gain0' && l[1] === 'ramp');
    ck('A1 sound starts silent and fades in over 1.5 s', mg && mg.gain.value === 0 && log.some((l) => l[0] === 'gain0' && l[1] === 'set' && l[2] === 0 && l[3] === 10) && ramp && Math.abs(ramp[3] - 11.5) < 1e-9, JSON.stringify(log.filter((l) => l[0] === 'gain0')));
    ck('A2 ...to about 30%', ramp && ramp[2] >= 0.25 && ramp[2] <= 0.35, ramp && ramp[2]);
    const initBody = (CODE.match(/function initAudio\(\)\{[\s\S]*?\n\}/) || [''])[0];
    const all = (CODE.match(/masterGain\.gain\b/g) || []).length, inInit = (initBody.match(/masterGain\.gain\b/g) || []).length;
    ck('A3 nothing else ever changes the volume (every master-gain write is the start-up fade in initAudio)', all > 0 && all === inInit && !/\.gain\.value\s*=\s*(?!0\b|SOUND_LEVEL)/.test(initBody), all + ' writes, ' + inInit + ' in initAudio');
    const tones = []; b.g.ctx.tone = (f) => { tones.push(f); }; b.g.ctx.noise = () => {};
    const firsts = []; for (let c = 1; c <= 12; c++) { tones.length = 0; b.g.ctx.playFusion(c); firsts.push(tones[0]); }
    ck('A4 combo sounds rise in pitch with every combo step up to x12', firsts.every((f, i) => i === 0 || f > firsts[i - 1]), firsts.map((f) => Math.round(f)).join(' '));
  } catch (e) { ck('D-61 section ran', false, String(e.stack || e).slice(0, 300)); }

  return { F, failed };
}

const real = await import(pathToFileURL(path.join(__dirname, 'FLUX-Sparta', 'worker.js')).href);
const main = await suite({ gameHtml: GAME_HTML, workerMod: real });

console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
async function control(label, { expect, game = (s) => s, workerSrc = (s) => s }) {
  const g2 = game(GAME_HTML), w2 = workerSrc(WORKER_SRC);
  if (g2 === GAME_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const tmp = path.join(__dirname, '.nc287-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const r = await suite({ gameHtml: g2, workerMod: mod, workerSrc: w2, quiet: true });
    const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!ok) NC++;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
const reps = (...pairs) => (s) => pairs.reduce((acc, [a, b]) => rep(a, b)(acc), s);
// D-50
await control('D-50 old thresholds put back', { expect: 'L1', game: rep('const LEVEL_SCORE_THRESHOLDS=[2500,6000,10000,15000,21000,28000,36000,45000];', 'const LEVEL_SCORE_THRESHOLDS=[140,210,300,410,540,690,860,1050];') });
await control('D-50 perfect catches drive the level again', { expect: 'L2', game: rep("     orbValue=Math.min(42,orbValue + 1);", "     window.levelPoints=(window.levelPoints||0)+1; if(level<9 && window.levelPoints>=10){ level++; window.levelPoints=0; }\n     orbValue=Math.min(42,orbValue + 1);") });
await control('D-50 level jumps at once (no countdown)', { expect: 'L3', game: rep('if(levelForScore(score,difficulty)>level) startLevelUp(level+1);', 'if(levelForScore(score,difficulty)>level){ pendingLevel=level+1; finishLevelUp(); }') });
await control('D-50 banner without NEXT LEVEL', { expect: 'L3', game: rep("ctx.fillText('NEXT LEVEL: '+pendingLevel,W/2,H*.22+52);", '') });
await control('D-50 LEVEL box not amber / no SPEED UP', { expect: 'L4', game: rep("lvLabel.textContent='SPEED UP'; lvBox.classList.add('speedUp');", "lvLabel.textContent='LEVEL';") });
await control('D-50 countdown silent', { expect: 'L4', game: rep('if(shown>=1 && shown<levelTickAt){ levelTickAt=shown; playTick(); updateHud(); }', 'if(shown>=1 && shown<levelTickAt){ levelTickAt=shown; updateHud(); }') });
await control('D-50 speed jumps instead of rising', { expect: 'L5', game: rep(' speedLevel=from;   // ramps up to the new level over LEVEL_RAMP_S', ' speedLevel=level;') });
await control('D-50 speed limit ignores the ramp', { expect: 'L5', game: rep('(12+speedLevel*.48)', '(12+level*.48)') });
await control('D-50 LEVEL bar shows the old perfect-catch progress', { expect: 'L6', game: rep('const pct=cur>=9?100:Math.max(0,Math.min(100,(score-levelScoreAt(cur,difficulty))/(levelScoreAt(cur+1,difficulty)-levelScoreAt(cur,difficulty))*100));', 'const pct=0;') });
await control('D-50 two levels at once', { expect: 'L7', game: rep('if(levelForScore(score,difficulty)>level) startLevelUp(level+1);', 'if(levelForScore(score,difficulty)>level) startLevelUp(levelForScore(score,difficulty));') });
await control('D-50 run recorded with the gameplay level', { expect: 'L8', game: rep('recordBestRun(score,levelForScore(score,difficulty));   // D-50: the level is the one this score reaches', 'recordBestRun(score,level);') });
await control('D-50 old saved levels left as they were', { expect: 'L9', game: rep('(function normalizeStoredLevels(){\n  try{', '(function normalizeStoredLevels(){\n  return;\n  try{') });
// D-51
await control('D-51 old per-level ceiling back on the server', { expect: 'S', workerSrc: rep('if (Math.abs(level - levelForScore(score, difficulty)) > LEVEL_TOLERANCE) {', 'if (score > level * 50000 + 5000) {') });
await control('D-51 no +/-1 tolerance', { expect: 'S1', workerSrc: rep('const LEVEL_TOLERANCE = 1;', 'const LEVEL_TOLERANCE = 0;') });
await control('D-51 difficulty ignored by the server', { expect: 'S3', workerSrc: rep('const m = LEVEL_SCORE_MULT[difficulty] || 1;', 'const m = 1;') });
await control('D-51 cooldown dropped along the way', { expect: 'S5', workerSrc: rep('if (now - last < SUBMIT_COOLDOWN_MS) {', 'if (false) {') });
await control('D-51 server table drifts from the game', { expect: 'S6', workerSrc: rep('const LEVEL_SCORE_THRESHOLDS = [2500, 6000, 10000, 15000, 21000, 28000, 36000, 45000];', 'const LEVEL_SCORE_THRESHOLDS = [2500, 6000, 10000, 15000, 21000, 28000, 36000, 46000];') });
// D-52
await control('D-52 FLUX LIVES box drawn again', { expect: 'V1', game: rep(" // D-52 (RC2.8.7): the bottom-right FLUX LIVES box is gone; lives live in the top LIVES box.\n", " ctx.fillText('FLUX LIVES',0,0);\n") });
await control('D-52 box back to MISSES x/3', { expect: 'V2', game: rep("document.getElementById('lives').textContent=lives;", "document.getElementById('lives').textContent=misses+'/3';") });
await control('D-52 last life not red', { expect: 'V3', game: rep("document.getElementById('livesLabel').textContent='LAST LIFE'; lvsBox.classList.add('lastLife');", "document.getElementById('livesLabel').textContent='LIVES';") });
// D-53
await control('D-53 pause button pinned outside the HUD again', { expect: 'P', game: reps(
  ['<div class="fluxbar"><button id="pauseBtn" class="hidden" aria-label="Pause">Ⅱ</button><span>FLUX</span>', '<div class="fluxbar"><span>FLUX</span>'],
  ['<div class="hud">', '<button id="pauseBtn" class="hidden" aria-label="Pause">Ⅱ</button>\n<div class="hud">'],
  ['#pauseBtn{position:relative;flex:none;', '#pauseBtn{position:absolute;top:78px;left:16px;flex:none;']) });
await control('D-53 42px pause button', { expect: 'P3', game: rep('#pauseBtn{position:relative;flex:none;width:44px;height:44px;', '#pauseBtn{position:relative;flex:none;width:42px;height:42px;') });
// D-54
await control('D-54 tagline back in the HUD', { expect: 'C1', game: rep('<div><div class="logo">FLUX</div></div>', '<div><div class="logo">FLUX</div><div class="sub">FLOW • LAUNCH • UNITE • XCELERATE</div></div>') });
await control('D-54 SOUND / FIELD badges back', { expect: 'C2', game: rep('<b id="fluxPct">0%</b></div>\n</div>', '<b id="fluxPct">0%</b></div>\n<div id="audioBadge" class="badge">SOUND • ON</div>\n<div id="pressureBadge" class="badge stable">FIELD • STABLE</div>\n</div>') });
// D-55
await control('D-55 a 7px label back', { expect: 'T1', game: rep('.linkBtn{flex:1;padding:9px 8px;font-size:11px;', '.linkBtn{flex:1;padding:9px 8px;font-size:7px;') });
await control('D-55 a shrinking em size back', { expect: 'T1', game: rep('.lbTag{opacity:.5;font-weight:600;font-size:11px;', '.lbTag{opacity:.5;font-weight:600;font-size:.8em;') });
await control('D-55 tiny canvas text back', { expect: 'T2', game: rep("ctx.font='900 12px -apple-system,sans-serif';ctx.fillStyle='#62eaff';", "ctx.font='900 10px -apple-system,sans-serif';ctx.fillStyle='#62eaff';") });
await control('D-55 unclamped orb symbol size', { expect: 'T2', game: rep("ctx.font=Math.max(11,t.r*.55)+'px -apple-system,sans-serif';", "ctx.font=(t.r*.55)+'px -apple-system,sans-serif';") });
await control('D-55 buttons may be short again', { expect: 'T3', game: rep('font-size:14px;min-height:44px}', 'font-size:14px}') });
await control('D-55 EDIT shrinks under its own padding', { expect: 'T4', game: rep('font-size:11px!important;letter-spacing:.1em!important;min-height:44px}', 'font-size:11px!important;letter-spacing:.1em!important}') });
// D-56
await control('D-56 old default palette', { expect: 'K1', game: rep("aurora:{name:'AURORA',price:null,colors:['#ffd23f','#35e6ff','#ff4f98','#b48cff',", "aurora:{name:'AURORA',price:null,colors:['#35e6ff','#5c9cff','#8c5cff','#c64dff',") });
await control('D-56 old TOXIC palette (four greens)', { expect: 'K3 toxic', game: rep("colors:['#d6ff3d','#2ee6b8','#5cb8ff','#b06bff',", "colors:['#9dff2e','#c8ff45','#5cff9c','#2effd6',") });
await control('D-56 red-vs-green pair', { expect: 'K4 aurora', game: rep("'#f0f4ff','#e05cff','#7dffea']},\n  toxic", "'#f0f4ff','#ff2a1a','#3dff5a']},\n  toxic") });
await control('D-56 a dim colour', { expect: 'K2 cosmic', game: rep("'#f0f4ff','#c46bff','#8cfff0']", "'#f0f4ff','#5a2a8a','#8cfff0']") });
await control('D-56 loud orb symbols', { expect: 'K6', game: rep('const ORB_GLYPH_ALPHA=.3;', 'const ORB_GLYPH_ALPHA=.85;') });
await control('D-56 ball loses its white core', { expect: 'K7', game: rep("glowCircle(ball.x,ball.y,ball.r*.55,'#ffffff',.5);", '') });
// D-57
await control('D-57 old headlines back', { expect: 'G1', game: rep('  <div class="goScore" id="finalScore">0</div>', '  <h1 style="font-size:38px">FLUX<br>OVERLOAD</h1>\n  <div class="goScore" id="finalScore">0</div>') });
await control('D-57 country gain counted against this difficulty only', { expect: 'G', game: rep('else if(sc>0 && sc>prevOverall) second=c.flag+\' +\'+(sc-prevOverall).toLocaleString()', 'else if(sc>0 && sc>prevBest) second=c.flag+\' +\'+(sc-prevBest).toLocaleString()') });
await control('D-57 no "from your best"', { expect: 'G4', game: rep("(prevBest-sc).toLocaleString()+' from your best'", "'GAME OVER'") });
// D-58
await control('D-58 Playing-for line never shown', { expect: 'F1', game: rep("  b.classList.remove('hidden');\n}\ndocument.getElementById('playingFor').onclick", "}\ndocument.getElementById('playingFor').onclick") });
await control('D-58 Playing-for line shown forever', { expect: 'F4', game: rep("let first=false; try{ first=!((+localStorage.fluxRunsPlayed||0)>0); }catch(e){}", 'let first=true;') });
await control('D-58 "change" does nothing', { expect: 'F3', game: rep("  document.getElementById('editProfile').onclick();\n  document.getElementById('playingFor').classList.add('hidden');", "  document.getElementById('playingFor').classList.add('hidden');") });
// D-59
await control('D-59 old revive wording', { expect: 'R1', game: rep(": 'FREE extra life?';", ": 'Get one more miss and keep this run alive?';") });
// D-60
await control('D-60 offered on the first run', { expect: 'N5', game: rep('runNo>=2 && sc>0', 'runNo>=1 && sc>0') });
await control('D-60 offered every time', { expect: 'N4', game: rep(" && localStorage.fluxNameClaimOffered!=='1';", ';') });
await control('D-60 offered to named pilots', { expect: 'N7', game: rep("return localStorage.fluxAutoName==='1' && /^PILOT-[A-Z0-9]{4}$/.test(callsign) &&", 'return true &&') });
await control('D-60 NOT NOW does nothing', { expect: 'N3', game: rep("document.getElementById('goClaimNo').onclick=function(){ document.getElementById('goClaim').classList.add('hidden'); };", '') });
// D-61
await control('D-61 loud start, no fade', { expect: 'A1', game: rep('      masterGain.gain.value=0;\n', '      masterGain.gain.value=.52;\n') });
await control('D-61 volume raised later', { expect: 'A3', game: rep('function playTick(){', "function raiseVolume(){ if(masterGain) masterGain.gain.value=1; }\nfunction playTick(){") });
await control('D-61 combo pitch stops rising at x7', { expect: 'A4', game: rep('const base=360*Math.pow(2,(Math.max(1,Math.min(12,comboNow))-1)/12);', 'const base=360+Math.min(7,comboNow)*42;') });

const total = main.F + NC;
console.log('\n' + (total ? ('RC2.8.7 FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)') : 'RC2.8.7 PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
