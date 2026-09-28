// TIME SPEED, SKILL LADDER, COMBO HALVES, HUD difficulty, calmer effects, in the release gate.
// Real game page in the harness vm.
//   T1  the ball's speed follows run time, never the score, combo or FLUX points;
//   T2  one speed step per interval of run time: Easy 40 s, Medium 30 s, Hard 22 s,
//       up to the top (Easy 5 steps, Medium 7, Hard 8), never two steps closer;
//   T3  crossing time (seconds for the ball to cross the play area, measured from
//       real frames) at the start and at the top: Easy 1.6 -> 1.2, Medium 1.4 -> 0.9,
//       Hard 1.1 -> 0.7, the same on iPhone and iPad sizes; every step is +4% to +8%;
//   T4  every step is announced first: SPEED UP 3-2-1 in the LEVEL box and the HUD
//       strip (a level-up that brings the level-2 step counts SPEED UP 5-4-3-2-1);
//       one countdown at a time with the level-up and FLUX countdowns;
//   T5  never above the top speed: step, Hard's FLUX burst, the kick after an orb
//       hit, the overload kick, catches and launches, and in long simulated play;
//   T6  FLUX MODE adds no ball speed on Easy and Medium; Hard x1.15, capped;
//   T7  FLUX MODE never before level 3 on any difficulty (the meter may fill);
//   T8  a broken combo is halved (floor, at least x1), the popup reads COMBO HALVED
//       and stays below the HUD;
//   T9  the HUD shows EASY / MEDIUM / HARD under the logo during play;
//   T10 Reduce Motion (device setting, Safari 15 addListener): no screen shake,
//       softer and shorter flashes; normal effects otherwise;
//   T11 nothing flashes more than 3 times a second (full-screen flash limiter,
//       pulsing canvas effects, CSS pulses), also in busy simulated play;
//   T12 RECOVERY after a lost ball: 10% calmer for 5 s (the last second eases back),
//       only ever slower, no points;
//   T13 HOLDS: no step within 8 s of a lost ball (a running count is called off);
//       the level-2 step waits for a hold too;
//   T14 DIFFICULTY BUDGET: no single step raises more than one of speed, orb count,
//       spawn rate; a fuller Medium field is a little slower;
//   T15 SAME RULES FOR EVERY PLAYER: a player's history never changes speed or points
//       (first-run slow start and comeback ease are gone); it may only widen the catch
//       in the first 3 runs (generous catch), which never pays points;
//   T16 GAMEPLAY STATS: per speed step, seconds, orb hits, wrong-colour hits and lost
//       balls are sent at game over (difficulty and step only, no name);
//   T17 run time stops during countdowns, the miss notice and pauses;
//   T18 SKILL LADDER: 4 colours at levels 1-2, the 5th (star) and FLUX MODE at 3,
//       growing orbs from 4, hint ring from 5.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WANT = { easy: { start: 1.6, top: 1.2, every: 40, steps: 5 }, medium: { start: 1.4, top: 0.9, every: 30, steps: 7 }, hard: { start: 1.1, top: 0.7, every: 22, steps: 8 } };
const DIFFS = ['easy', 'medium', 'hard'];

function suite(gameHtml, quiet = false, only = '') {
  let F = 0; const failed = [];
  const on = (...k) => !only || k.includes(only);   // a negative control runs only the section it must fail
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const realRandom = Math.random;
  const code = scriptsOf(gameHtml).join('\n;\n');
  const bootGame = (diff, { w = 390, h = 844, runs = '5', seed = 7 } = {}) => {
    Math.random = seeded(seed);
    const { store, mem } = makeStore({ fluxPlayerId: 'ts-' + seed, fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: runs, fluxDifficulty: diff });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    run(`innerWidth=${w}; innerHeight=${h}; resize();`);
    const texts = []; const cx = run('ctx'); cx.fillText = (t) => { texts.push(String(t)); };
    g.ctx.newGame(); run('playing=true; paused=false;');
    return { g, run, mem, texts };
  };
  // A calm frame: no orbs, the ball crosses sideways (no catches, misses or points).
  const calm = (b, n = 1) => { for (let i = 0; i < n; i++) { b.run('if(!playing){playing=true;paused=false;} targets=[]; ball.y=H*.4; ball.vy=0; if(Math.abs(ball.vx)<1)ball.vx=4;'); b.g.ctx.update(1 / 60); } };
  const crossing = (b) => b.run('playAreaHeight()/(normalMaxSpeed()*60)');
  // Measured crossing: the ball flies straight up at the limit for 20 real frames.
  const measured = (b) => { b.run('targets=[]; ball.x=W/2; ball.y=paddle.y-60; ball.vx=0; ball.vy=-normalMaxSpeed(); var __y0=ball.y;');
    for (let i = 0; i < 20; i++) { b.run('targets=[];'); b.g.ctx.update(1 / 60); } return b.run('playAreaHeight()/((__y0-ball.y)*3)'); };
  try {
    /* T1 time, not score */
    if (on('T1')) { const b = bootGame('medium'); const s0 = b.run('normalMaxSpeed()');
      b.run('score=99999; combo=12; flux=99; orbValue=42;'); const s1 = b.run('normalMaxSpeed()');
      b.run('score=0; combo=1; flux=0;'); calm(b, 60 * 34); const s2 = b.run('normalMaxSpeed()');
      ck('T1 the speed limit ignores score, combo and the FLUX meter, and rises with run time', s1 === s0 && s2 > s0 * 1.04 && b.run('speedStep') === 1, [s0, s1, s2].map((x) => x.toFixed(3)).join(' / ')); }
    /* T2 + T4 + T13a steps by time, each announced */
    const t2 = [], t4 = [];
    if (on('T2', 'T4')) for (const d of DIFFS) {
      const b = bootGame(d); const W0 = WANT[d]; let prev = b.run('speedStep'), cdFrames = 0, labelOk = true, bannerOk = true, lastCd = 0; const clocks = [], walls = [], cds = [];
      for (let f = 1; f <= 60 * (W0.every + 4) * (W0.steps + 1); f++) {
        calm(b);
        if (b.run('speedCountdown') > 0) { cdFrames++; lastCd = cdFrames;
          if (cdFrames % 30 === 1) { if (b.g.win.document.getElementById('levelLabel').textContent !== 'SPEED UP') labelOk = false; b.texts.length = 0; b.g.ctx.draw(); if (!b.texts.includes('SPEED UP') || !b.texts.some((t) => /^IN [123]$/.test(t))) bannerOk = false; } }
        const st = b.run('speedStep');
        if (st !== prev) { clocks.push(b.run('runClock')); walls.push(f / 60); cds.push(lastCd / 60); cdFrames = 0; lastCd = 0; prev = st; }
      }
      const gaps = clocks.map((c, i) => c - (i ? clocks[i - 1] : 0));
      t2.push({ d, ok: clocks.length === W0.steps && gaps.every((g) => Math.abs(g - W0.every) < 0.05) && b.run('speedStep') === W0.steps, info: d + ': ' + clocks.length + ' steps, gaps ' + gaps.map((g) => g.toFixed(1)).join(',') + ' s (wall ' + walls.map((x) => x.toFixed(0)).join(',') + ')' });
      t4.push({ d, ok: cds.length === W0.steps && cds.every((c) => c > 2.95 && c < 3.05) && labelOk && bannerOk, info: d + ': counts ' + cds.map((c) => c.toFixed(2)).join(',') + ' label ' + labelOk + ' banner ' + bannerOk });
    }
    if (on('T2', 'T4')) ck('T2 one speed step per run-time interval (Easy 40 s, Medium 30 s, Hard 22 s) up to the top (5 / 7 / 8 steps), never closer', t2.every((r) => r.ok), t2.map((r) => r.info).join(' | '));
    if (on('T2', 'T4')) ck('T4 every step is announced first: SPEED UP 3-2-1 in the LEVEL box and the HUD strip, then the step', t4.every((r) => r.ok), t4.map((r) => r.info).join(' | '));
    /* T4b the level-2 step comes with the level-up's SPEED UP count; T13 holds */
    if (on('T4', 'T13')) { const b = bootGame('medium'); b.run('score=levelScoreAt(2,difficulty);'); calm(b);
      const lab = b.g.win.document.getElementById('levelLabel').textContent, p = b.run('pendingLevel'), st0 = b.run('speedStep');
      let stepDuring = false; for (let i = 0; i < 60 * 5 + 5 && b.run('pendingLevel'); i++) { calm(b); if (b.run('pendingLevel') && b.run('speedStep') !== st0) stepDuring = true; }
      ck('T4 reaching level 2 counts SPEED UP 5-4-3-2-1 and brings the first step only when the count ends (level 2 "a little faster")', lab === 'SPEED UP' && p === 2 && !stepDuring && b.run('level') === 2 && b.run('speedStep') === 1 && b.run('speedCountdown') === 0, [lab, p, stepDuring, b.run('speedStep')].join(',')); }
    if (on('T13')) { const b = bootGame('medium'); calm(b, 60 * 34); const st1 = b.run('speedStep');   // step 1 by time
      b.run('score=levelScoreAt(2,difficulty);'); calm(b); const lab = b.g.win.document.getElementById('levelLabel').textContent; calm(b, 60 * 6);
      ck('T13 a level-2 step right after a time step waits for the step hold (the level-up reads LEVEL UP and brings no step)', st1 === 1 && lab === 'LEVEL UP' && b.run('level') === 2 && b.run('speedStep') === 1, [st1, lab, b.run('speedStep')].join(',')); }
    if (on('T13')) { const b = bootGame('medium'); calm(b, 60 * 29); b.g.ctx.registerMiss(); b.run('playing=true;'); const t0 = b.run('runClock'); let firstCd = -1;
      for (let i = 0; i < 60 * 12 && firstCd < 0; i++) { calm(b); if (b.run('speedCountdown') > 0) firstCd = i / 60; }
      const b2 = bootGame('medium'); calm(b2, 60 * 30 + 30); const cd = b2.run('speedCountdown'); b2.g.ctx.registerMiss(); b2.run('playing=true;'); const cd2 = b2.run('speedCountdown'); calm(b2, 60 * 4); const st = b2.run('speedStep');
      ck('T13 no speed step within 8 s of a lost ball: a due step waits (count starts ' + (firstCd).toFixed(2) + ' s after the miss) and a running SPEED UP count is called off', firstCd >= 7.95 && t0 > 28 && cd > 0 && cd2 === 0 && st === 0, [firstCd.toFixed(2), cd.toFixed(2), cd2, st].join(','));
      // The step it held back comes late; the next one still waits a full interval after it (never two steps back to back).
      let c1 = -1, c2 = -1; for (let i = 0; i < 60 * 80 && c2 < 0; i++) { calm(b); if (c1 < 0 && b.run('speedStep') === 1) c1 = b.run('runClock'); if (b.run('speedStep') === 2) c2 = b.run('runClock'); }
      ck('T13 after a held-back step the next one still waits a full interval (' + c1.toFixed(1) + ' s -> ' + c2.toFixed(1) + ' s of run time)', c1 > 31 && c2 - c1 >= 30 - 1e-6, [c1, c2].map((x) => x.toFixed(2)).join(','));
      const b3 = bootGame('easy'); calm(b3, 60); b3.g.ctx.registerMiss(); b3.run('playing=true; score=levelScoreAt(2,difficulty);'); calm(b3, 60 * 5 + 10); const s3 = b3.run('speedStep'), l3 = b3.run('level'); calm(b3, 60 * 6); const cd3 = b3.run('speedCountdown') > 0 || b3.run('speedStep') === 1;
      ck('T13 the level-2 step waits for the lost-ball hold too, then comes with its own count', l3 === 2 && s3 === 0 && cd3, [l3, s3, cd3].join(',')); }
    /* T3 crossing times, iPhone and iPad sizes, step sizes */
    if (on('T3')) { const bad = []; const sizes = [[390, 844], [820, 1180], [744, 1133]];
      for (const d of DIFFS) for (const [w, h] of sizes) {
        const b = bootGame(d, { w, h }); const W0 = WANT[d];
        const c0 = measured(b); b.run('speedStep=speedShown=speedCurve().steps;'); const cT = measured(b);
        if (Math.abs(c0 - W0.start) > W0.start * 0.02 || Math.abs(cT - W0.top) > W0.top * 0.02) bad.push(d + ' ' + w + 'x' + h + ': ' + c0.toFixed(3) + ' -> ' + cT.toFixed(3));
      }
      ck('T3 crossing time (measured in real frames) at the start and the top: Easy 1.6 -> 1.2 s, Medium 1.4 -> 0.9 s, Hard 1.1 -> 0.7 s, on iPhone, iPad and iPad mini sizes', bad.length === 0, bad.join(' | '));
      const steps = []; let stepOk = true;
      for (const d of DIFFS) { const b = bootGame(d); const n = WANT[d].steps; const r = [];
        for (let k = 0; k < n; k++) { const q = b.run('crossingTimeAt(' + k + ')/crossingTimeAt(' + (k + 1) + ')'); r.push(q); if (q < 1.04 - 1e-9 || q > 1.08 + 1e-9) stepOk = false; }
        steps.push(d + ' +' + r.map((q) => ((q - 1) * 100).toFixed(1)).join('/+') + '%'); }
      ck('T3 every step raises the speed by 4% to 8%', stepOk, steps.join(' | ')); }
    /* T5 + T6 never above the top; FLUX */
    if (on('T5', 'T6')) { const bad = [];
      for (const d of DIFFS) { const b = bootGame(d);
        b.run('speedStep=speedShown=speedCurve().steps; fluxMode=6;'); if (b.run('normalMaxSpeed()') > b.run('topSpeed()') + 1e-9) bad.push(d + ' FLUX at top');
        b.run('fluxMode=0;'); const top = b.run('topSpeed()');
        if (b.run('fuseKickSpeed(topSpeed())') > top + 1e-9 || b.run('fuseKickSpeed(topSpeed()*.99)') > top + 1e-9) bad.push(d + ' kick');
        if (b.run('launchSpeed(99)') > top + 1e-9) bad.push(d + ' launch');
        b.run('targets=[{x:W/2,y:H/2,r:34,maxR:34,color:0,growing:true,matured:true,vx:0,vy:0,phase:0,age:0}]; ball.x=W/2+30; ball.y=H/2; ball.vx=0; ball.vy=-top;'); b.g.ctx.burstGrowing(b.run('targets[0]'), b.run('normalMaxSpeed()*speedHelp()'));
        if (b.run('Math.hypot(ball.vx,ball.vy)') > top + 1e-9) bad.push(d + ' overload kick');
      }
      // Long simulated play (steady player) on every difficulty from the top step: the ball never goes faster than the top.
      for (const d of DIFFS) { const b = bootGame(d, { seed: 3 }); b.run('speedStep=speedShown=speedCurve().steps; var __mx=0;');
        for (let f = 0; f < 60 * 90; f++) { b.run('if(!playing&&!paused){newGame();speedStep=speedShown=speedCurve().steps;} if(paused){paused=false;playing=true;} paddle.x+=Math.max(-28,Math.min(28,ball.x-paddle.x)); setPaddle(paddle.x);'); b.g.ctx.update(1 / 60); b.run('__mx=Math.max(__mx,Math.hypot(ball.vx,ball.vy)/topSpeed());'); }
        const mx = b.run('__mx'); if (mx > 1 + 1e-9) bad.push(d + ' play x' + mx.toFixed(3)); }
      ck('T5 never above the top speed: FLUX burst, orb-hit kick, overload kick, launches, and 90 s of play at the top step', bad.length === 0, bad.join(' | '));
      const f6 = [];
      for (const d of DIFFS) { const b = bootGame(d); b.run('speedStep=speedShown=2;'); const n0 = b.run('normalMaxSpeed()'); b.run('fluxMode=6;'); const n1 = b.run('normalMaxSpeed()'); b.run('fluxMode=2;'); const n2 = b.run('normalMaxSpeed()');
        f6.push({ d, ok: d === 'hard' ? Math.abs(n1 - Math.min(b.run('topSpeed()'), n0 * 1.15)) < 1e-9 && n1 > n0 && n2 === n0 : n1 === n0 && n2 === n0, info: d + ' x' + (n1 / n0).toFixed(3) + ' then x' + (n2 / n0).toFixed(3) }); }
      ck('T6 FLUX MODE adds no ball speed on Easy and Medium; Hard: x1.15 for its first 3 s (never above the top)', f6.every((r) => r.ok), f6.map((r) => r.info).join(' | '));
      const kick = []; for (const d of ['easy', 'medium']) { const b = bootGame(d); const n = b.run('normalMaxSpeed()'); const k1 = b.run('fuseKickSpeed(' + n + ')') / n; let s = n; for (let i = 0; i < 20; i++) s = b.run('fuseKickSpeed(' + s + ')'); kick.push({ d, k1, cap: s / n }); }
      ck('T5 the kick after an orb hit is small on Easy (+1.5%, at most +4%) and Medium (+2.5%, at most +8%)', Math.abs(kick[0].k1 - 1.015) < 1e-9 && kick[0].cap <= 1.04 + 1e-9 && Math.abs(kick[1].k1 - 1.025) < 1e-9 && kick[1].cap <= 1.08 + 1e-9, kick.map((k) => k.d + ' ' + k.k1.toFixed(3) + ' cap ' + k.cap.toFixed(3)).join(' | ')); }
    /* T7 FLUX from level 3 */
    if (on('T7')) { const r = []; for (const d of DIFFS) { const b = bootGame(d); const a = [1, 2, 3, 5].map((lv) => b.run('level=' + lv + '; fluxModeAllowed()')); r.push(d + ':' + a.join(',')); }
      ck('T7 FLUX MODE never before level 3 on any difficulty', r.every((x) => /:false,false,true,true$/.test(x)), r.join(' | ')); }
    /* T8 combo halves */
    if (on('T8')) { const b = bootGame('medium'); const seq = []; b.run('texts=[]; combo=8; comboTimer=0;'); b.g.ctx.update(1 / 60); seq.push(b.run('combo'));
      const pop = b.run('texts.map(t=>t.s).join("|")'); b.run('comboTimer=0;'); b.g.ctx.update(1 / 60); seq.push(b.run('combo')); b.run('comboTimer=0;'); b.g.ctx.update(1 / 60); seq.push(b.run('combo'));
      b.run('combo=7; comboTimer=0;'); b.g.ctx.update(1 / 60); seq.push(b.run('combo')); b.run('combo=1; comboTimer=0; texts=[];'); b.g.ctx.update(1 / 60); seq.push(b.run('combo'), b.run('texts.length'));
      b.run('combo=6; comboTimer=0.01; texts=[];'); calm(b, 2); const tm = b.run('comboTimer');
      ck('T8 a broken combo is halved (x8 -> x4 -> x2 -> x1, x7 -> x3), never below x1, popup COMBO HALVED; the halved combo gets a fresh timer', seq.join(',') === '4,2,1,3,1,0' && pop === 'COMBO HALVED' && b.run('combo') === 3 && tm > 2.5, seq.join(',') + ' ' + pop + ' ' + tm);
      const draw = (code.match(/const textTop=maxHudBottom\(\)\+14;[^\n]*\n[^\n]*/) || [''])[0];
      ck('T8 the popup (like every popup) is drawn below the HUD / FLUX row', /Math\.max\(t\.y,textTop\)/.test(draw)); }
    /* T9 HUD difficulty label */
    if (on('T9')) { const hud = gameHtml.slice(gameHtml.indexOf('<div class="hud">'), gameHtml.indexOf('<div class="stats">'));
      const lab = DIFFS.map((d) => { const b = bootGame(d); b.g.ctx.updateHud(); return b.g.win.document.getElementById('hudDiff').textContent; });
      ck('T9 the HUD shows EASY / MEDIUM / HARD under the logo during play, at least 11px', /<div class="logo">FLUX<\/div><div id="hudDiff" class="hudDiff">/.test(hud) && lab.join(',') === 'EASY,MEDIUM,HARD' && /\.hudDiff\{[^}]*font-size:11px/.test(gameHtml), lab.join(',')); }
    /* T10 Reduce Motion */
    if (on('T10')) { const iife = (code.match(/\(function\(\)\{ try\{ if\(!window\.matchMedia\) return;[\s\S]*?\}catch\(e\)\{\} \}\)\(\);/) || [''])[0];
      const b = bootGame('hard'); b.run('var __mq={matches:true,media:"",addListener:function(f){__mq.f=f;}}; matchMedia=function(q){__mq.media=q;return __mq;};'); b.run(iife);
      const on = b.run('reduceMotion'), media = b.run('__mq.media'); b.run('__mq.matches=false; __mq.f();'); const off = b.run('reduceMotion');
      const flashOf = (rm) => { const bb = bootGame('hard'); bb.run('reduceMotion=' + rm + '; var __to=[]; setTimeout=function(f,d){__to.push(d);return 0;}; performance.now=function(){return 5000;}; flashLastAt=-1e9;');
        bb.g.ctx.flash(0.34); const o = +bb.g.win.document.getElementById('flash').style.opacity; bb.run('shake=12;'); bb.g.ctx.draw(); return { o, d: bb.run('__to[0]'), shake: bb.run('shake') }; };
      const calmFx = flashOf(true), normal = flashOf(false);
      ck('T10 Reduce Motion is read from the device setting (Safari 15: addListener) and follows changes', iife.length > 0 && on === true && off === false && media === '(prefers-reduced-motion: reduce)' && !/addEventListener/.test(iife), [on, off, media].join(','));
      ck('T10 with Reduce Motion: no screen shake, softer (<= .08) and shorter (50 ms) flashes; without it: the normal flash (.34, 80 ms) and shake', calmFx.shake === 0 && calmFx.o <= 0.08 && calmFx.d === 50 && normal.o === 0.34 && normal.d === 80 && normal.shake > 0, JSON.stringify([calmFx, normal]));
      ck('T10 Reduce Motion also stops the pulsing CSS glow', /@media \(prefers-reduced-motion: reduce\)\{#pressureGlow\.critical\{animation:none\}/.test(gameHtml)); }
    /* T11 flashing <= 3 per second */
    if (on('T11')) { const b = bootGame('hard'); b.run('var __ms=0, __st=[]; performance.now=function(){return __ms;}; flashLastAt=-1e9;');
      for (let f = 0; f < 600; f++) { b.run('__ms=' + (f * 1000 / 60) + '; var __n=flashStarts; flash(.2); if(flashStarts>__n) __st.push(__ms);'); }
      const st = b.run('__st'); let worst = 0; for (let i = 0; i < st.length; i++) { let n = 0; for (let j = i; j < st.length && st[j] < st[i] + 1000; j++) n++; worst = Math.max(worst, n); }
      ck('T11 the full-screen flash starts at most 3 times in any second, even if asked every frame (' + st.length + ' in 10 s)', worst <= 3 && st.length >= 20, 'worst ' + worst + ' per second');
      // Busy play: steady player on Hard at the top step, real flash calls, clock tied to frames.
      const p = bootGame('hard', { seed: 5 }); p.run('speedStep=speedShown=speedCurve().steps; var __ms=0,__st=[]; performance.now=function(){return __ms;};');
      for (let f = 0; f < 60 * 60; f++) { p.run('__ms=' + (f * 1000 / 60) + '; var __n=flashStarts; if(!playing&&!paused){newGame();} if(paused){paused=false;playing=true;} paddle.x+=Math.max(-28,Math.min(28,ball.x-paddle.x)); setPaddle(paddle.x); update(1/60); if(flashStarts>__n) __st.push(__ms);'); }
      const ps = p.run('__st'); let pw = 0; for (let i = 0; i < ps.length; i++) { let n = 0; for (let j = i; j < ps.length && ps[j] < ps[i] + 1000; j++) n++; pw = Math.max(pw, n); }
      ck('T11 ...and in 60 s of busy Hard play (' + ps.length + ' flashes)', pw <= 3 && ps.length > 5, 'worst ' + pw + ' per second');
      // Pulsing effects: canvas sine pulses and CSS pulse animations stay at or below 3 Hz.
      const hz = []; for (const m of code.matchAll(/Math\.sin\(performance\.now\(\)\*([\d.]+)/g)) hz.push(+m[1] * 1000 / (2 * Math.PI));
      for (const m of code.matchAll(/Math\.sin\(nowT\*([\d.]+)/g)) hz.push(+m[1] / (2 * Math.PI));
      const css = []; for (const m of gameHtml.matchAll(/animation:(pulseCritical|coachDown|coachUp|gummyBounce|candyFloat) ([\d.]+)s/g)) css.push(1 / +m[2]);
      const gp = (code.match(/gripPulse\*Math\.PI\*([\d.]+)|\(1\.6-gripPulse\)\*Math\.PI\*([\d.]+)/) || []); const grip = gp.length ? +(gp[1] || gp[2]) / 2 : 99;
      ck('T11 pulsing effects stay at or below 3 Hz (canvas pulses, CSS pulses, the grip pulse)', hz.length >= 3 && hz.every((x) => x <= 3) && css.length >= 3 && css.every((x) => x <= 3) && grip <= 3, 'canvas ' + hz.map((x) => x.toFixed(2)).join(',') + ' Hz; css ' + css.map((x) => x.toFixed(2)).join(',') + ' Hz; grip ' + grip); }
    /* T12 recovery */
    if (on('T12')) { const b = bootGame('medium'); calm(b, 60); const n = b.run('normalMaxSpeed()'); b.g.ctx.registerMiss(); b.run('playing=true;');
      const at = []; for (const s of [0.1, 2, 3.9, 4.6, 5.2]) { calm(b, Math.round(s * 60) - (at.length ? Math.round([0.1, 2, 3.9, 4.6, 5.2][at.length - 1] * 60) : 0)); at.push(b.run('speedHelp()')); }
      const lim = b.run('normalMaxSpeed()'), body = (code.match(/function recoverFactor\(\)[^\n]*\n[^\n]*\nfunction speedAfterLostBall\(\)[^\n]*/) || [''])[0];
      ck('T12 after a lost ball the top speed is 10% lower for 5 s (the last second eases back), only ever slower, no points', Math.abs(at[0] - 0.9) < 1e-9 && Math.abs(at[1] - 0.9) < 1e-9 && at[2] <= 0.9 + 0.01 && at[3] > 0.9 && at[3] < 1 && at[4] === 1 && lim === n && body.length > 0 && !/score|combo|misses|lives/.test(body), at.map((x) => x.toFixed(3)).join(',')); }
    /* T14 difficulty budget */
    if (on('T14')) { const bad = [];
      for (const d of DIFFS) for (const w of [390, 820]) { const b = bootGame(d, { w, h: w > 700 ? 1180 : 844 });
        for (let lv = 2; lv <= 9; lv++) { const more = b.run('fieldCapAt(' + lv + ')>fieldCapAt(' + (lv - 1) + ')'), spawn = lv === b.run('GROWING_LEVEL') || lv === b.run('SPAWN_MORE_LEVEL');
          if ((more ? 1 : 0) + (spawn ? 1 : 0) > 1) bad.push(d + ' ' + w + ' L' + lv + ' orbs+spawns');
          if ((more || spawn) !== b.run('fieldGrowsAt(' + lv + ')')) bad.push(d + ' ' + w + ' L' + lv + ' not marked'); } }
      // Level-ups with a speed step due: a level that adds orbs or spawns never brings the step, and the step then waits 10 s.
      for (const d of DIFFS) { const b = bootGame(d, { w: 820, h: 1180 });
        for (let lv = 2; lv <= 9; lv++) {
          b.run('level=' + (lv - 1) + '; speedLevel=level; pendingLevel=0; speedCountdown=0; lostBallHold=0; fieldHoldUntil=0; speedStep=Math.min(speedStep,speedCurve().steps-1); speedShown=speedStep; lastStepClock=runClock-speedCurve().every-1;');
          const st0 = b.run('speedStep'), cap0 = b.run('targetCap()'); b.run('pendingLevel=level+1;'); b.g.ctx.finishLevelUp();
          const grew = b.run('fieldGrowsAt(level)'), st1 = b.run('speedStep');
          if (grew && st1 !== st0) bad.push(d + ' L' + lv + ' speed + field together');
          if (!grew && st1 === st0 && lv !== 1) bad.push(d + ' L' + lv + ' due step not brought');
          if (st1 !== st0 && b.run('targetCap()') !== cap0) bad.push(d + ' L' + lv + ' speed + orbs');
          if (grew) { let first = -1; for (let i = 0; i < 60 * 12 && first < 0; i++) { calm(b); if (b.run('speedCountdown') > 0) first = i / 60; } if (first < 9.9) bad.push(d + ' L' + lv + ' step ' + first + ' s after'); calm(b, 60 * 3 + 5); } }
      }
      // ...and a level that adds orbs or spawns waits 10 s after a speed step.
      { const b = bootGame('medium'); b.run('level=3; speedLevel=3; speedStep=2; speedShown=2; lastStepClock=runClock; score=levelScoreAt(4,difficulty);'); calm(b); const w0 = b.run('pendingLevel'); calm(b, 60 * 10 + 10); const w1 = b.run('pendingLevel');
        if (!(w0 === 0 && w1 === 4)) bad.push('level 4 right after a step: ' + w0 + ',' + w1); }
      ck('T14 no single step raises more than one of speed, orb count and spawn rate (every difficulty, phone and iPad, levels 2-9)', bad.length === 0, bad.slice(0, 5).join(' | '));
      const m = bootGame('medium'); const c1 = crossing(m); m.run('level=5;'); const c5 = crossing(m);
      ck('T14 a fuller field is a little slower: Medium on a phone gets its 6th orb at level 5 and a 3% longer crossing', Math.abs(c5 / c1 - 1.03) < 1e-9 && m.run('targetCap()') === 6, (c5 / c1).toFixed(4)); }
    /* T15 same rules for every player */
    if (on('T15')) { const a = bootGame('easy', { runs: '0' }), z = bootGame('easy', { runs: '40' });
      const same = a.run('normalMaxSpeed()*speedHelp()') === z.run('normalMaxSpeed()*speedHelp()') && a.run('speedHelp()') === 1 && z.run('speedHelp()') === 1;
      const edge = (b) => { b.run('targets=[]; paddle.x=W/2; ball.vx=0; ball.vy=6; ball.x=paddle.x+paddle.w/2+ball.r+6; ball.y=paddle.y-paddle.h/2-ball.r-2;'); b.g.ctx.update(1 / 60); return b.run('ball.vy') < 0; };
      const caughtA = edge(a), caughtZ = edge(z);
      const two = bootGame('medium', { runs: '0' }); calm(two, 60); two.g.ctx.registerMiss(); two.run('playing=true;'); calm(two, 60 * 3); two.g.ctx.registerMiss(); two.run('playing=true;'); calm(two, 30); const k = two.run('speedHelp()');
      const s0 = a.run('score');
      ck('T15 a first run and a 41st run have the same speed rules (no first-run slow start); only the first-run catch is wider (generous catch, first 3 runs) and it pays nothing', same && caughtA && !caughtZ && a.run('score') === s0 && a.run('score') === 0, [same, caughtA, caughtZ, a.run('score')].join(','));
      ck('T15 no comeback ease: two quick misses only bring the fixed recovery (x0.9), the same for everyone; the old speed helps are gone from the code',
        Math.abs(k - 0.9) < 1e-9 && !/firstRunSlowOn|easeFactor|FIRST_RUN_SLOW|EASE_SLOW/.test(code) && (code.match(/SPEED_HELPS\.push\(/g) || []).length === 1, k.toFixed(3)); }
    /* T16 gameplay stats */
    if (on('T16')) { const b = bootGame('hard'); b.g.ctx.Blob = Blob; const beacons = []; b.g.win.navigator.sendBeacon = (u, body) => { beacons.push(body); return true; };
      calm(b, 120); b.run('targets=[]; addTarget(ball.color,ball.x,ball.y,20);'); b.g.ctx.fuse(b.run('targets[0]'));
      b.run('targets=[{x:ball.x,y:ball.y,r:20,color:(ball.color+1)%4,vx:0,vy:0,phase:0,age:0,spin:0}];'); b.g.ctx.update(1 / 60); b.g.ctx.registerMiss(); b.run('playing=true;');
      const ps = b.run('JSON.stringify(playStats)'); b.run('fluxStatsQueue=[];'); b.g.ctx.endGame();
      const q = []; for (const x of beacons) { try { q.push(...JSON.parse(Buffer.from(x._b || '').toString() || '{}').events); } catch (e) {} }
      const pb = b.run('JSON.stringify(fluxStatsQueue)'); void pb;
      const rec = JSON.parse(ps)[0] || {};
      ck('T16 per speed step the run counts seconds, orb hits, wrong-colour hits and lost balls', rec.sec > 1.9 && rec.hit === 1 && rec.wrong === 1 && rec.lost === 1, ps);
      const src = (code.match(/try\{ playStats\.forEach\(function\(s,i\)\{[^\n]*/) || [''])[0];
      ck('T16 at game over one "play" event per step goes with the other stats: difficulty, step, seconds, hits, wrong hits, lost balls (no name, no score)',
        /fluxTrack\('play',\{diff:difficulty,st:i,sec:Math\.round\(s\.sec\),hit:s\.hit,wrong:s\.wrong,lost:s\.lost\}\)/.test(src) && !/callsign|score|playerId/.test(src)); }
    /* T17 run time */
    if (on('T17')) { const b = bootGame('medium'); calm(b, 60); const c0 = b.run('runClock');
      b.run('pendingLevel=2; levelCountdown=99;'); calm(b, 60); const c1 = b.run('runClock'); b.run('pendingLevel=0; levelCountdown=0; fluxCountdown=2.5;'); calm(b, 30); const c2 = b.run('runClock');
      b.run('fluxCountdown=0; missNotice=2;'); calm(b, 60); const c3 = b.run('runClock'); b.run('missNotice=0;'); b.g.ctx.startSpeedCountdown(); calm(b, 60); const c4 = b.run('runClock');
      b.run('speedCountdown=0;'); calm(b, 60); const c5 = b.run('runClock');
      ck('T17 run time stops during level-up, FLUX and SPEED UP countdowns and the miss notice (and pauses: update() does not run), and counts otherwise', Math.abs(c0 - 1) < 1e-6 && c1 === c0 && c2 === c1 && c3 === c2 && c4 === c3 && Math.abs(c5 - c4 - 1) < 1e-6, [c0, c1, c2, c3, c4, c5].map((x) => x.toFixed(2)).join(',')); }
    /* T18 skill ladder */
    if (on('T18')) { const b = bootGame('hard'); const cols = [1, 2, 3, 4, 9].map((lv) => b.run('level=' + lv + '; coloursInPlay()'));
      const grow = (lv) => { b.run('level=' + lv + '; targets=[]; growTimer=0; playing=true;'); b.g.ctx.update(1 / 60); return b.run('targets.some(t=>t.growing)'); };
      const g3 = grow(3), g4 = grow(4);
      ck('T18 SKILL LADDER: 4 colours at levels 1-2, the 5th (star) from 3; growing orbs from level 4, not at 3; hint ring from 5', cols.join(',') === '4,4,5,5,5' && !g3 && g4 && /if\(\(level>=5 \|\| colorHintLeft>0\) && ball\)\{/.test(code), cols.join(',') + ' grow ' + g3 + '/' + g4); }
  } catch (e) { ck('time speed section ran', false, String(e.stack || e).slice(0, 400)); }
  finally { Math.random = realRandom; }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true, expect); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('speed from the score again', 'T1', rep('crossingSpeed(crossingTimeAt(speedShown)*fieldSlow())', 'crossingSpeed(crossingTimeAt(Math.min(9,score/1000))*fieldSlow())'));
control('Easy steps twice as often', 'T2', rep('easy:  {start:1.6,top:1.2, every:40,', 'easy:  {start:1.6,top:1.2, every:20,'));
control('steps may come back to back (no step hold)', 'T13', rep('  return runClock-lastStepClock>=c.every;', '  return Math.floor(runClock/c.every)>speedStep;'));
control('Easy starts at Medium\'s speed', 'T3', rep('easy:  {start:1.6,top:1.2,', 'easy:  {start:1.4,top:1.2,'));
control('big speed steps (Hard in 4 steps of ~12%)', 'T3', rep('hard:  {start:1.1,top:.7, every:22,steps:8,', 'hard:  {start:1.1,top:.7, every:22,steps:4,'));
control('speed from the play-area width (different on iPad)', 'T3', rep('function crossingSpeed(sec){ return playAreaHeight()/sec/60; }', 'function crossingSpeed(sec){ return W*1.6/sec/60; }'));
control('step without a countdown', 'T4', rep('function startSpeedCountdown(){ speedCountdown=SPEED_COUNTDOWN_S;', 'function startSpeedCountdown(){ applySpeedStep(); return; speedCountdown=SPEED_COUNTDOWN_S;'));
control('Hard FLUX burst above the top', 'T5', rep('Math.min(topSpeed(),s*c.fluxBurst)', 's*c.fluxBurst'));
control('Hard orb-hit kick uncapped', 'T5', rep('return Math.min(top,17.5,sp*1.045+0.18+speedLevel*.025);', 'return Math.min(17.5,sp*1.045+0.18+speedLevel*.025);'));
control('big orb-hit kick on Easy', 'T5', rep('kick:1.015,kickCap:1.04,', 'kick:1.045,kickCap:1.2,'));
control('FLUX MODE speeds the ball up on Easy', 'T6', rep('easy:  {start:1.6,top:1.2, every:40,steps:5,kick:1.015,kickCap:1.04,fluxBurst:1}', 'easy:  {start:1.6,top:1.2, every:40,steps:5,kick:1.015,kickCap:1.04,fluxBurst:1.2}'));
control('FLUX MODE from level 1 again', 'T7', rep('function fluxModeAllowed(){ return level>=FLUX_FROM_LEVEL; }', 'function fluxModeAllowed(){ return true; }'));
control('combo back to x1 when it breaks', 'T8', rep('combo=Math.max(1,Math.floor(combo/2));', 'combo=1;'));
control('no difficulty in the HUD', 'T9', rep(" document.getElementById('hudDiff').textContent=String(difficulty).toUpperCase();", ''));
control('screen shake with Reduce Motion', 'T10', rep(' if(reduceMotion) shake=0;', ''));
control('Reduce Motion ignored by the flash', 'T10', rep(' if(reduceMotion) v=Math.min(.08,v*.35);', ''));
control('flash limiter removed (strobing)', 'T11', rep('if(now-flashLastAt<FLASH_GAP_MS)', 'if(false)'));
control('a 5 Hz pulse', 'T11', rep('const pulse=.75+.25*Math.sin(performance.now()*.012+t.phase);', 'const pulse=.75+.25*Math.sin(performance.now()*.032+t.phase);'));
control('no recovery after a lost ball', 'T12', rep('SPEED_HELPS.push(recoverFactor);', ''));
control('no lost-ball hold for the next step', 'T13', rep('if(speedStep>=c.steps || lostBallHold>0 || runClock<fieldHoldUntil) return false;', 'if(speedStep>=c.steps || runClock<fieldHoldUntil) return false;'));
control('a level-up that adds orbs also brings the speed step', 'T14', rep(' if(fieldGrowsAt(level)) fieldHoldUntil=runClock+FIELD_HOLD_S;   // DIFFICULTY BUDGET: more orbs/spawns now, so no speed step now or for FIELD_HOLD_S\n else if(speedDue()) applySpeedStep();', ' if(speedDue()) applySpeedStep();'));
control('orbs and spawns at the same level (extra spawns back at level 5)', 'T14', rep('STAR_LEVEL=3, GROWING_LEVEL=4, SPAWN_MORE_LEVEL=6;', 'STAR_LEVEL=3, GROWING_LEVEL=4, SPAWN_MORE_LEVEL=5;'));
control('first-run slow start back', 'T15', rep('SPEED_HELPS.push(recoverFactor);', "SPEED_HELPS.push(recoverFactor); SPEED_HELPS.push(function(){ try{ return (+localStorage.getItem('fluxRunsPlayed')||0)===0?.92:1; }catch(e){ return 1; } });"));
control('generous catch pays points', 'T15', rep('const paddlePoints=marginCatch?0:', 'const paddlePoints=marginCatch?2:'));
control('lost balls not counted in the stats', 'T16', rep(" playCount('lost',1);   // GAMEPLAY STATS\n", ''));
control('run time counts during countdowns', 'T17', rep('  if(pendingLevel || fluxCountdown>0 || missNotice>0) return;   // countdowns and the miss notice are not run time\n', ''));
control('star colour back at level 2', 'T18', rep('function coloursInPlay(){ return Math.min(colors.length,level>=STAR_LEVEL?5:4); }', 'function coloursInPlay(){ return Math.min(colors.length,4+Math.floor(level/2)); }'));
const total = main.F + NC;
console.log('\n' + (total ? 'TIME SPEED FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'TIME SPEED PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
