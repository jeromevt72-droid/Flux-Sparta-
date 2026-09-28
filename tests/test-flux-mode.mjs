// FLUX MODE without surprise, in the release gate. Real game page in the harness vm.
//   X1 on every difficulty a full meter first ANNOUNCES FLUX MODE: the HUD-strip
//      banner reads "FLUX MODE" / "STARTS IN 3", "2", "1" with a tick each second,
//      and only then does FLUX MODE start;
//   X2 during the countdown nothing speeds up and points are normal: no FLUX
//      speed limit, no +250, no screen filter, a fusion scores like normal play;
//   X3 once it starts: 6 s, the +250 bonus once (every difficulty: FULL POINTS),
//      screen filter, meter back to 0; FLUX MODE is a reward,
//      not a speed-up (TIME SPEED): no extra ball speed on Easy and Medium, a
//      short burst on Hard (x1.15, never above Hard's top speed);
//   X4 every difficulty below level 3 (SKILL LADDER): the meter fills and stays
//      full, FLUX MODE never starts;
//   X5 every difficulty: reaching level 3 with a full meter announces it, then it starts;
//   X6 FLUX MODE's own effects in the code (no speed on Easy/Medium, Hard burst
//      capped at the top, points, 6 s, +250);
//   X7 one countdown at a time: a full meter waits for a level-up countdown, and
//      a level-up waits for the FLUX countdown;
//   X8 the countdown banner never overlaps the launcher, the danger line, the HUD
//      or the play area (measured device layouts, as test-level-banner.mjs), >= 11px;
//   X9 it is drawn after the screen-shake transform is undone (it never moves).
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
// Same measured layouts as test-level-banner.mjs (Chromium, safe-area insets applied).
const DEVICES = [
  {"name":"iPhone 14 (notch 47)","W":390,"H":844,"stats":{"left":150.73,"top":55,"right":380,"bottom":98},"fluxbar":{"left":10,"top":113,"right":217.64,"bottom":157},"hud":[{"left":10,"top":113,"right":54,"bottom":157},{"left":0,"top":47,"right":390,"bottom":106},{"left":10,"top":113,"right":217.64,"bottom":157}]},
  {"name":"iPhone SE","W":375,"H":667,"stats":{"left":135.73,"top":28,"right":365,"bottom":71},"fluxbar":{"left":10,"top":86,"right":217.64,"bottom":130},"hud":[{"left":10,"top":86,"right":54,"bottom":130},{"left":0,"top":20,"right":375,"bottom":79},{"left":10,"top":86,"right":217.64,"bottom":130}]},
  {"name":"iPhone landscape","W":844,"H":390,"stats":{"left":530.22,"top":26,"right":828,"bottom":80},"fluxbar":{"left":16,"top":92,"right":304.28,"bottom":136},"hud":[{"left":16,"top":92,"right":60,"bottom":136},{"left":0,"top":16,"right":844,"bottom":90},{"left":16,"top":92,"right":304.28,"bottom":136}]},
  {"name":"iPad","W":820,"H":1180,"stats":{"left":506.22,"top":34,"right":804,"bottom":88},"fluxbar":{"left":16,"top":100,"right":304.28,"bottom":144},"hud":[{"left":16,"top":100,"right":60,"bottom":144},{"left":0,"top":24,"right":820,"bottom":98},{"left":16,"top":100,"right":304.28,"bottom":144}]},
  {"name":"iPad mini 4 (iPadOS 15.8)","W":768,"H":1024,"stats":{"left":454.22,"top":30,"right":752,"bottom":84},"fluxbar":{"left":16,"top":96,"right":304.28,"bottom":140},"hud":[{"left":16,"top":96,"right":60,"bottom":140},{"left":0,"top":20,"right":768,"bottom":94},{"left":16,"top":96,"right":304.28,"bottom":140}]},
  {"name":"iPad mini 6","W":744,"H":1133,"stats":{"left":430.22,"top":34,"right":728,"bottom":88},"fluxbar":{"left":16,"top":100,"right":304.28,"bottom":144},"hud":[{"left":16,"top":100,"right":60,"bottom":144},{"left":0,"top":24,"right":744,"bottom":98},{"left":16,"top":100,"right":304.28,"bottom":144}]},
  {"name":"iPad mini 6 landscape","W":1133,"H":744,"stats":{"left":819.22,"top":34,"right":1117,"bottom":88},"fluxbar":{"left":16,"top":100,"right":304.28,"bottom":144},"hud":[{"left":16,"top":100,"right":60,"bottom":144},{"left":0,"top":24,"right":1133,"bottom":98},{"left":16,"top":100,"right":304.28,"bottom":144}]}
];

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const code = scriptsOf(gameHtml).join('\n;\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Boot a game on a device layout, recording every canvas text drawn.
  const bootGame = (diff, d = DEVICES[0]) => {
    const { store } = makeStore({ fluxPlayerId: 'fm-1', fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: '9', fluxDifficulty: diff });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    const rectOf = (r) => ({ getBoundingClientRect: () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }) });
    g.win.document.querySelector = (sel) => sel === '.stats' ? rectOf(d.stats) : sel === '.fluxbar' ? rectOf(d.fluxbar) : g.win.document.getElementById('x');
    const cx = run('ctx'); const texts = [];
    cx.measureText = (t) => ({ width: String(t).length * parseFloat(String(cx.font).match(/(\d+(?:\.\d+)?)px/)[1]) * 0.72 });
    cx.fillText = (t, x, y) => { const px = parseFloat(String(cx.font).match(/(\d+(?:\.\d+)?)px/)[1]); const w = cx.measureText(t).width;
      const al = String(cx.textAlign || 'start'), bl = String(cx.textBaseline || 'alphabetic');
      const left = al === 'center' ? x - w / 2 : (al === 'right' || al === 'end') ? x - w : x;
      const top = bl === 'top' ? y : bl === 'middle' ? y - px / 2 : bl === 'bottom' ? y - px : y - px * 0.8;
      texts.push({ t: String(t), px, box: { left, right: left + w, top, bottom: top + px } }); };
    g.ctx.newGame();
    run('W=' + d.W + ';H=' + d.H + ';paddle.y=H-Math.max(42,Math.min(90,H*.095));paddle.handleH=W<=700?22:28;paddle.x=W/2;cachedHudRects=' + JSON.stringify(d.hud) + ';');
    run('var __ticks=0; var __tick0=playTick; playTick=function(){__ticks++;};');
    return { g, run, texts };
  };
  // One frame of calm play: no orbs, the ball crosses the field sideways (no catches, misses or points).
  // At level lv (>= 2) the first speed step is already done, so no SPEED UP countdown takes the slot (TIME SPEED).
  const atLv = (lv) => 'level=' + lv + ';speedLevel=' + lv + ';score=levelScoreAt(' + lv + ',difficulty);' + (lv >= 2 ? 'speedStep=1;speedShown=1;lastStepClock=runClock;' : '');
  const frame = (b) => { b.run('if(!playing){playing=true;paused=false;} targets=[]; ball.y=H*.4; ball.vy=0; if(Math.abs(ball.vx)<1)ball.vx=4;'); b.g.ctx.update(1 / 60); };
  const bannerNow = (b) => { b.texts.length = 0; b.g.ctx.draw(); return b.texts.filter((x) => /FLUX MODE|STARTS IN/.test(x.t)).map((x) => x.t).join('|'); };
  try {
    // X1/X2/X3 on every difficulty (Easy at level 3, where FLUX MODE is allowed).
    const x1 = [], x2 = [], x3 = [];
    for (const diff of ['easy', 'medium', 'hard']) {
      const b = bootGame(diff);
      b.run('playing=true;' + atLv(3));
      frame(b);
      const lim0 = b.run('normalMaxSpeed()'), s0 = b.run('score'), t0 = b.run('__ticks');
      b.run('addFlux(100);');
      const instant = b.run('fluxMode');   // must still be 0 right after the meter fills
      frame(b);
      const seen = []; let modeDuring = 0, limOk = true, filterOk = true, scoreOk = true, f = 0;
      for (; f < 400 && b.run('fluxMode') <= 0; f++) {
        const s = bannerNow(b); if (s && seen[seen.length - 1] !== s) seen.push(s);
        if (b.run('normalMaxSpeed()') !== lim0) limOk = false;
        if (b.run("String(document.getElementById('app').style.filter)") !== 'none') filterOk = false;
        if (b.run('score') !== s0) scoreOk = false;
        frame(b);
      }
      const secs = f / 60, ticks = b.run('__ticks') - t0;
      x1.push({ diff, ok: instant === 0 && seen.join(' > ') === 'FLUX MODE|STARTS IN 3 > FLUX MODE|STARTS IN 2 > FLUX MODE|STARTS IN 1' && secs > 2.9 && secs < 3.1 && ticks === 3, info: diff + ': ' + seen.join(' > ') + ' then start after ' + secs.toFixed(2) + ' s, ' + ticks + ' ticks' });
      // During the countdown a fusion scores like normal play (same points formula, no FLUX x1.15).
      const nb = bootGame(diff); nb.run('playing=true;' + atLv(3) + 'addFlux(100);'); frame(nb); frame(nb);
      const fuse = (bb) => bb.run('(function(){combo=3;orbValue=24;targets=[{x:W/2,y:H*.4,r:30,color:ball.color,age:0,vx:0,vy:0}];const s=score;try{fuse(targets[0]);}catch(e){return "err "+e.message;}return score-s;})()');
      const ref = bootGame(diff); ref.run('playing=true;' + atLv(3)); frame(ref); frame(ref);
      const gainCd = fuse(nb), gainRef = fuse(ref);
      x2.push({ diff, ok: limOk && filterOk && scoreOk && modeDuring === 0 && nb.run('fluxCountdown') > 0 && gainCd === gainRef, info: diff + ': limit same ' + limOk + ', filter off ' + filterOk + ', score same ' + scoreOk + ', fusion ' + gainCd + ' vs ' + gainRef });
      // X3: once running.
      const lim1 = b.run('normalMaxSpeed()'), top = b.run('topSpeed()'), mode = b.run('fluxMode'), gain = b.run('score') - s0, fl = b.run('flux'), filt = b.run("String(document.getElementById('app').style.filter)");
      const limWant = diff === 'hard' ? Math.min(top, lim0 * 1.15) : lim0, bonus = 250;   // FULL POINTS: the same on every difficulty
      frame(b); const filt2 = b.run("String(document.getElementById('app').style.filter)");
      let dur = 0; for (let i = 0; i < 600 && b.run('fluxMode') > 0; i++) { frame(b); dur += 1 / 60; }
      x3.push({ diff, ok: mode > 6 - 1.5 / 60 && mode <= 6 && gain === bonus && Math.abs(lim1 - limWant) < 1e-9 && lim1 <= top + 1e-9 && fl === 0 && filt2 === 'brightness(1.18) saturate(1.35)' && Math.abs(dur + 1 / 60 - 6) < .03, info: diff + ': ' + [mode.toFixed(3), '+' + gain, 'limit ' + (lim1 / lim0).toFixed(3) + 'x', 'meter ' + fl, filt2, dur.toFixed(2) + ' s'].join(', ') });
      void filt;
    }
    ck('X1 every difficulty: a full meter announces "FLUX MODE" with STARTS IN 3-2-1 (a tick each second) before it starts', x1.every((r) => r.ok), x1.map((r) => r.info).join(' | '));
    ck('X2 during the countdown nothing speeds up, no filter, no +250, a fusion scores like normal play', x2.every((r) => r.ok), x2.map((r) => r.info).join(' | '));
    ck('X3 once started: 6 s, the +250 bonus once (every difficulty), screen filter, meter back to 0; no extra ball speed on Easy and Medium, a x1.15 burst on Hard never above its top', x3.every((r) => r.ok), x3.map((r) => r.info).join(' | '));
    // X4: every difficulty, levels 1 and 2: the meter fills and stays full; no FLUX MODE for 20 s (run clock held: no speed step either).
    { const res = [];
      for (const diff of ['easy', 'medium', 'hard']) for (const lv of [1, 2]) { const b = bootGame(diff); b.run('playing=true;' + atLv(lv)); frame(b); const lim0 = b.run('normalMaxSpeed()');
        let fill = 0; for (let i = 0; i < 20 && b.run('flux') < 100; i++) { b.run('addFlux(8);'); frame(b); fill++; }
        let never = true, full = true, limOk = true; for (let i = 0; i < 1200; i++) { if (i % 30 === 0) b.run('addFlux(8);'); b.run('runClock=0;'); frame(b); b.run('if(level!==' + lv + '){level=' + lv + ';speedLevel=' + lv + ';pendingLevel=0;}');
          if (b.run('fluxMode') > 0 || b.run('fluxCountdown') > 0 || bannerNow(b)) never = false; if (b.run('flux') !== 100) full = false; if (b.run('normalMaxSpeed()') !== lim0) limOk = false; }
        res.push({ ok: fill > 0 && never && full && limOk, info: diff + ' L' + lv + ': filled in ' + fill + ' adds, full ' + full + ', no FLUX ' + never + ', speed same ' + limOk }); }
      ck('X4 every difficulty, levels 1-2: the meter fills and stays full, FLUX MODE never starts, nothing speeds up', res.every((r) => r.ok), res.filter((r) => !r.ok).concat(res).slice(0, 3).map((r) => r.info).join(' | ')); }
    // X5: every difficulty, level 2 -> 3 with a full meter: level-up countdown, then FLUX countdown, then FLUX MODE.
    { const res = [];
      for (const diff of ['easy', 'medium', 'hard']) { const b = bootGame(diff); b.run('playing=true;' + atLv(2) + 'addFlux(100);'); frame(b);
        b.run('score=levelScoreAt(3,difficulty);'); frame(b);
        const lvCd = b.run('pendingLevel'), cd0 = b.run('fluxCountdown');
        let tLevel = -1, tAnnounce = -1, tStart = -1; for (let i = 0; i < 900; i++) { frame(b);
          if (tLevel < 0 && b.run('level') === 3) tLevel = i; if (tAnnounce < 0 && b.run('fluxCountdown') > 0) tAnnounce = i; if (tStart < 0 && b.run('fluxMode') > 0) { tStart = i; break; } }
        res.push({ ok: lvCd === 3 && cd0 === 0 && tLevel >= 0 && tAnnounce >= tLevel && tStart > tAnnounce && Math.abs((tStart - tAnnounce) / 60 - 3) < .1,
          info: diff + ': level-up pending ' + lvCd + ', level 3 at ' + (tLevel / 60).toFixed(2) + ' s, announce at ' + (tAnnounce / 60).toFixed(2) + ' s, start at ' + (tStart / 60).toFixed(2) + ' s' }); }
      ck('X5 every difficulty: reaching level 3 with a full meter announces FLUX MODE, then it starts after the 3-2-1', res.every((r) => r.ok), res.map((r) => r.info).join(' | ')); }
    // X6: FLUX MODE's own effects in the code.
    ck('X6 FLUX MODE effects: no speed on Easy/Medium (fluxBurst 1), Hard x1.15 capped at the top, orb x1.15, fusion +60, overload +100, 6 s, +250, filter',
      /easy:\s*\{[^}]*fluxBurst:1\}/.test(code) && /medium:\{[^}]*fluxBurst:1\}/.test(code) && /hard:\s*\{[^}]*fluxBurst:1\.15\}/.test(code)
      && code.includes('return (fluxMode>6-FLUX_BURST_S && c.fluxBurst>1) ? Math.min(topSpeed(),s*c.fluxBurst) : s;') && !/18\.5/.test(code)
      && code.includes('*(fluxMode>0?1.15:1));') && code.includes('120+combo*10+(fluxMode>0?60:0)') && code.includes('200+combo*15+(fluxMode>0?100:0)')
      && /flux=0;fluxMode=6;score\+=250;/.test(code) && code.includes("if(fluxMode>0){fluxMode-=dt;document.getElementById('app').style.filter='brightness(1.18) saturate(1.35)';"));
    // X7: one countdown at a time. (Level 4 adds spawns, so it is set 15 s after the last speed step: DIFFICULTY BUDGET.)
    { const a = bootGame('medium'); a.run('playing=true;' + atLv(3) + 'lastStepClock=runClock-15;score=levelScoreAt(4,difficulty);'); frame(a); const lvPending = a.run('pendingLevel');
      a.run('addFlux(100);'); let fluxDuringLevel = false; for (let i = 0; i < 400 && a.run('pendingLevel'); i++) { frame(a); if (a.run('pendingLevel') && (a.run('fluxCountdown') > 0 || a.run('fluxMode') > 0)) fluxDuringLevel = true; }
      frame(a); const afterLevel = a.run('fluxCountdown') > 0;
      const b = bootGame('medium'); b.run('playing=true;' + atLv(3) + 'lastStepClock=runClock-15;addFlux(100);'); frame(b); const fcd = b.run('fluxCountdown') > 0;
      b.run('score=levelScoreAt(4,difficulty);'); let levelDuringFlux = false; for (let i = 0; i < 200 && b.run('fluxCountdown') > 0; i++) { frame(b); if (b.run('pendingLevel')) levelDuringFlux = true; }
      frame(b); const levelAfter = b.run('pendingLevel') === 4;
      ck('X7 one countdown at a time: FLUX waits for a level-up countdown, a level-up waits for the FLUX countdown (then follows)', lvPending === 4 && !fluxDuringLevel && afterLevel && fcd && !levelDuringFlux && levelAfter,
        [lvPending, fluxDuringLevel, afterLevel, fcd, levelDuringFlux, levelAfter].join(',')); }
    // X8: banner geometry on measured device layouts, at 3, 2 and 1.
    for (const d of DEVICES) {
      const b = bootGame('medium', d); b.run('playing=true;' + atLv(3) + 'addFlux(100);'); frame(b);
      const ceil = b.run('maxHudBottom()'); const pad = b.run('({left:paddle.x-paddle.w*.55-12,right:paddle.x+paddle.w*.55+12,top:paddle.y-paddle.h-12,bottom:paddle.y+paddle.handleH+6})');
      let bad = '', n = 0;
      for (let i = 0; i < 200 && b.run('fluxCountdown') > 0; i += 20) {
        b.texts.length = 0; b.g.ctx.draw(); const bt = b.texts.filter((x) => /^FLUX MODE$|^STARTS IN/.test(x.t)); n++;
        if (bt.length !== 2) { bad = 'drawn ' + bt.map((x) => x.t).join('|'); break; }
        const r = bt.reduce((a, x) => ({ left: Math.min(a.left, x.box.left), right: Math.max(a.right, x.box.right), top: Math.min(a.top, x.box.top), bottom: Math.max(a.bottom, x.box.bottom) }), bt[0].box);
        const hudHit = [d.stats, d.fluxbar].concat(d.hud.filter((x) => x.right - x.left < d.W * 0.9)).filter((x) => hit(r, x));
        if (!(r.bottom <= ceil - 4)) bad = 'on the danger line (' + Math.round(r.bottom) + ' vs ' + Math.round(ceil) + ')';
        else if (!(r.top >= 0 && r.left >= 0 && r.right <= d.W)) bad = 'off screen';
        else if (hit(r, pad)) bad = 'on the launcher';
        else if (hudHit.length) bad = 'on the HUD ' + JSON.stringify(hudHit[0]);
        else if (!bt.every((x) => x.px >= 11)) bad = 'text below 11px';
        if (bad) break;
        for (let k = 0; k < 20; k++) frame(b);
      }
      ck('X8 ' + d.name + ': countdown banner clear of the danger line, launcher, HUD and play area, >= 11px', !bad && n >= 3, bad || n + ' samples');
    }
    // X9: drawn after the shake transform is undone.
    const drawBody = (code.match(/function draw\(\)\{[\s\S]*?\n\}\n/) || [''])[0];
    const lastRestore = drawBody.lastIndexOf('\n ctx.restore();'), at = drawBody.indexOf('else if(fluxCountdown>0){');
    ck('X9 the countdown is drawn after the screen-shake transform is undone (it never moves)', at > 0 && lastRestore > 0 && at > lastRestore);
  } catch (e) { ck('FLUX mode section ran', false, String(e.stack || e).slice(0, 400)); }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('old behaviour: FLUX MODE starts the moment the meter is full', 'X1', rep('function addFlux(v){flux=Math.min(100,flux+v);}', 'function addFlux(v){flux=Math.min(100,flux+v);if(flux>=100&&!fluxMode){startFluxMode();}}'));
control('countdown with no announcement on screen', 'X1', rep('else if(fluxCountdown>0){', 'else if(false){'));
control('countdown too short (1 s)', 'X1', rep('const FLUX_COUNTDOWN_S=3,', 'const FLUX_COUNTDOWN_S=1,'));
control('ball speeds up during the countdown (Hard burst early)', 'X2', rep('return (fluxMode>6-FLUX_BURST_S && c.fluxBurst>1)', 'return ((fluxMode>6-FLUX_BURST_S||fluxCountdown>0) && c.fluxBurst>1)'));
control('FLUX bonus points during the countdown', 'X2', rep('*(fluxMode>0?1.15:1));', '*((fluxMode>0||fluxCountdown>0)?1.15:1));'));
control('FLUX MODE shorter once running', 'X3', rep('flux=0;fluxMode=6;score+=250;', 'flux=0;fluxMode=5;score+=250;'));
control('FLUX MODE speeds the ball up on Medium again', 'X3', rep('medium:{start:1.4,top:.9, every:30,steps:7,kick:1.025,kickCap:1.08,fluxBurst:1}', 'medium:{start:1.4,top:.9, every:30,steps:7,kick:1.025,kickCap:1.08,fluxBurst:1.15}'));
control('FLUX MODE old top speed 18.5 back', 'X3', rep('return (fluxMode>6-FLUX_BURST_S && c.fluxBurst>1) ? Math.min(topSpeed(),s*c.fluxBurst) : s;', 'return fluxMode>0 ? 18.5 : s;'));
control('level-3 rule removed (FLUX MODE from level 1)', 'X4', rep('function fluxModeAllowed(){ return level>=FLUX_FROM_LEVEL; }', 'function fluxModeAllowed(){ return true; }'));
control('old Easy-only rule back (Medium/Hard from level 1)', 'X4', rep('function fluxModeAllowed(){ return level>=FLUX_FROM_LEVEL; }', "function fluxModeAllowed(){ return !(difficulty==='easy' && level<FLUX_FROM_LEVEL); }"));
control('level rule off by one (level 4)', 'X5', rep('FLUX_FROM_LEVEL=3;', 'FLUX_FROM_LEVEL=4;'));
control('Hard burst no longer capped at the top', 'X6', rep('Math.min(topSpeed(),s*c.fluxBurst)', 's*c.fluxBurst'));
control('level-up no longer waits for the FLUX countdown', 'X7', rep(' if(pendingLevel || fluxCountdown>0 || speedCountdown>0 || level>=9) return;', ' if(pendingLevel || speedCountdown>0 || level>=9) return;'));
control('FLUX countdown starts during a level-up countdown', 'X7', rep('if(flux<100 || fluxMode>0 || fluxCountdown>0 || pendingLevel ||', 'if(flux<100 || fluxMode>0 || fluxCountdown>0 ||'));
control('banner drawn in the play area', 'X8', rep("const L=levelBannerLayout('FLUX MODE','STARTS IN '+Math.max(1,Math.ceil(fluxCountdown)));", "const L=levelBannerLayout('FLUX MODE','STARTS IN '+Math.max(1,Math.ceil(fluxCountdown)));L.y1=H*.5;L.y2=L.y1+L.f1+3;"));
const total = main.F + NC;
console.log('\n' + (total ? 'FLUX MODE FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'FLUX MODE PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
