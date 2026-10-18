// FREEZE RECORDER (owner only, OFF for every player). The REAL shipped page in the harness.
//   R1 OFF by default: no game function is wrapped, a long frame writes nothing, nothing shows at game over;
//   R2 /play/?freezelog=1 turns it on (kept on the device); ?freezelog=0 turns it off and forgets the list;
//   R3 ON: a frame gap over 300 ms during a run is written down with time in run, level, score, orbs,
//      particles, texts, FLUX MODE, backdrop, Lite, combo, heap (when the browser tells it) and the last
//      game event before it (e.g. "FLUX MODE start", "LEVEL UP to 9"); 300 ms or less is not;
//   R4 not counted: on the menu (no run), while paused, across a hide / return of the app;
//   R5 the last 20 are kept;
//   R6 game over lists them (newest first) only while ON;
//   R7 nothing sent (no fetch / beacon in the recorder), no new button, no new listener or timer;
//   R8 the old 0.85 s level-up freeze (D-50) cannot come back: no level-up hold left in the game, and
//      through a real 8 -> 9 level-up the game never stops (playing on every frame, the ball moving).
// Ends with negative controls: each defect re-inserted MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const ORIGIN = 'https://flux.example';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let MAIN_HTML = null; try { MAIN_HTML = execFileSync('git', ['show', 'origin/main:public/play/index.html'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) {}

async function suite(gameHtml, quiet) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const GAME = scriptsOf(gameHtml);
  const keep = { fluxSeason: '1', fluxPlayerId: 'p-frz-1', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxRunsPlayed: '9', fluxWelcomeDone: '1', fluxDifficulty: 'hard',
    fluxEntitlementsV1: JSON.stringify({ v: 1, source: 'server', playerId: 'p-frz-1', skus: [], verifiedAt: Date.now() }),
    fluxLbCache: JSON.stringify({ at: Date.now(), data: { top: [], countries: [], boards: { easy: [], medium: [], hard: [] } } }) };
  const fakeEl = () => { const cls = new Set(['hidden']); return { textContent: '', style: {}, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, v) => { if (v === undefined ? !cls.has(c) : v) cls.add(c); else cls.delete(c); } }, _cls: cls }; };
  const B = (init, search = '') => {
    const { store, mem } = makeStore(Object.assign({}, keep, init));
    const calls = [];
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', search, store, standalone: false, fetchImpl: (u) => { calls.push(String(u)); return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })); } });
    g.ctx.Blob = Blob; g.win.navigator.sendBeacon = () => { calls.push('beacon'); return true; };
    let now = 0; g.win.performance.now = () => now;
    const run = (c) => vm.runInContext(c, g.ctx);
    // frames: the real loop, with the given timestamps
    const frame = (ts) => { now = ts; g.ctx.loop(ts); };
    const log = () => { try { return JSON.parse(mem.fluxFreezeLog || '[]'); } catch (e) { return []; } };
    g.els.goFreeze = fakeEl();
    return { g, mem, run, frame, log, calls, setNow: (t) => { now = t; } };
  };
  const startRun = (b) => { b.frame(984); b.g.ctx.newGame();   // the loop runs on the menu first (as in the game)
    b.run('difficulty="hard"; level=8; score=248000; combo=14;'); b.frame(1000); b.frame(1016); };
  try {
    /* R1 */
    if (!quiet) console.log('== R1 OFF by default ==');
    const off = B({});
    startRun(off); off.frame(2600);   // a 1.6 s gap
    ck('R1 OFF: not on, no game function wrapped, a 1.6 s frame gap writes nothing', off.run('fluxFrzOn') === false && !/fluxFrzNote/.test(off.run('String(startLevelUp)+String(startFluxMode)+String(endGame)')) && off.log().length === 0 && !('fluxFreezeLog' in off.mem));
    off.g.ctx.endGame();
    ck('R1 OFF: nothing shows at game over', off.g.els.goFreeze._cls.has('hidden') && off.g.els.goFreeze.textContent === '');
    /* R2 */
    if (!quiet) console.log('== R2 turned on / off by the address ==');
    const on1 = B({}, '?freezelog=1');
    const kept = B({ fluxFreezeOn: '1' });
    const offAgain = B({ fluxFreezeOn: '1', fluxFreezeLog: JSON.stringify([{ at: 1, gap: 999 }]) }, '?freezelog=0');
    const other = B({}, '?src=tiktok&freezelog=2');
    ck('R2 ?freezelog=1 turns it on and keeps it on this device; a later visit without it stays on', on1.run('fluxFrzOn') === true && on1.mem.fluxFreezeOn === '1' && kept.run('fluxFrzOn') === true);
    ck('R2 ?freezelog=0 turns it off and forgets the list; anything else changes nothing', offAgain.run('fluxFrzOn') === false && !('fluxFreezeOn' in offAgain.mem) && !('fluxFreezeLog' in offAgain.mem) && other.run('fluxFrzOn') === false);
    /* R3 */
    if (!quiet) console.log('== R3 ON: a long frame is written down with what the game was doing ==');
    const a = B({ fluxFreezeOn: '1' });
    startRun(a);
    a.frame(1316);   // exactly 300 ms: not a freeze
    ck('R3 a gap of 300 ms or less is not written down', a.log().length === 0);
    a.setNow(1400); a.run('startFluxMode()');
    a.frame(1416); a.frame(2836);   // 1,420 ms gap
    const e = a.log()[0] || {};
    ck('R3 a 1,420 ms gap during a run is written down: gap, time in run (real time since the run started), level, score, difficulty',
      a.log().length === 1 && e.gap === 1420 && e.t === 0 && e.level === 8 && e.score >= 248000 && e.diff === 'hard', JSON.stringify(e));
    ck('R3 ...with orbs, particles, texts, FLUX MODE, backdrop, Lite, combo and heap (null when the browser does not tell it)',
      Number.isInteger(e.orbs) && Number.isInteger(e.parts) && Number.isInteger(e.texts) && e.flux === 1 && e.bg === 'none' && (e.lite === 0 || e.lite === 1) && e.combo >= 1 && 'heap' in e, JSON.stringify(e));
    ck('R3 ...and the last game event before it ("FLUX MODE start", 0 s before)', /FLUX MODE/.test(e.ev) && typeof e.evAgo === 'number', e.ev + ' ' + e.evAgo);
    a.setNow(3000); a.run('startLevelUp(9)'); a.frame(3016); a.frame(4800);
    ck('R3 ...time in run counts from the start of the run (run began at 0.98 s, the gap at 3.02 s: 2 s)', (a.log()[1] || {}).t === 2, String((a.log()[1] || {}).t));
    ck('R3 a level-up countdown is named as the last event ("LEVEL UP countdown to 9")', (a.log()[1] || {}).ev === 'LEVEL UP countdown to 9', (a.log()[1] || {}).ev);
    /* R4 */
    if (!quiet) console.log('== R4 not counted: menu, paused, hide / return ==');
    const n0 = a.log().length;
    a.run('paused=true;'); a.frame(5000); a.frame(7000); a.run('paused=false;'); a.frame(7016);
    a.setNow(7500); a.g.win.document.hidden = false; a.g.win.document.onvisibilitychange(); a.frame(9000);   // shown again at 7.5 s: the gap 7.0 -> 9.0 s crossed it
    const m = B({ fluxFreezeOn: '1' }); m.frame(1000); m.frame(3000);   // on the menu
    ck('R4 a gap while paused, across a hide / return, or on the menu (no run) is not written down', a.log().length === n0 && m.log().length === 0, a.log().length + ' vs ' + n0);
    /* R5 */
    let ts = 10000; for (let i = 0; i < 25; i++) { a.frame(ts); ts += 500; }
    ck('R5 only the last 20 are kept', a.log().length === 20 && a.log()[19].gap === 500, String(a.log().length));
    /* R6 */
    a.g.ctx.endGame();
    const txt = String(a.g.els.goFreeze.textContent);
    ck('R6 ON: game over lists them, newest first, with what the game was doing', !a.g.els.goFreeze._cls.has('hidden') && /^FREEZE RECORDER ON · last 20 \(newest first\)/.test(txt) && /\n1\. \d\d\/\d\d \d\d:\d\d  500 ms at /.test(txt) && /orbs \d+ · particles \d+ · texts \d+ · FLUX MODE (on|off) · backdrop none/.test(txt) && /last event: /.test(txt), txt.slice(0, 220));
    const empty = B({ fluxFreezeOn: '1' }); startRun(empty); empty.g.ctx.endGame();
    ck('R6 ON with nothing recorded: says so, and how to turn it off', /no frame over 300 ms recorded yet/.test(String(empty.g.els.goFreeze.textContent)) && /freezelog=0/.test(String(empty.g.els.goFreeze.textContent)));
    /* R7 */
    const block = gameHtml.slice(gameHtml.indexOf('FREEZE RECORDER (owner only; OFF for every player)'), gameHtml.indexOf("if(typeof end==='function') window.endGame"));
    const cnt = (h, re) => (h.match(re) || []).length;
    ck('R7 nothing is sent: no fetch, beacon or request in the recorder; no network call during a recorded freeze', block.length > 500 && !/fetch\(|sendBeacon|XMLHttpRequest|WebSocket/.test(block) && !a.calls.some((u) => /freeze/i.test(u)));
    ck('R7 no new button, listener or timer in the game (counts equal main\'s)', !MAIN_HTML || (cnt(gameHtml, /<button\b/g) === cnt(MAIN_HTML, /<button\b/g) && cnt(gameHtml, /addEventListener\(/g) === cnt(MAIN_HTML, /addEventListener\(/g) && cnt(gameHtml, /setInterval\(|setTimeout\(|requestAnimationFrame\(/g) === cnt(MAIN_HTML, /setInterval\(|setTimeout\(|requestAnimationFrame\(/g)));
    ck('R7 OFF costs one check per frame in the loop', /\n if\(fluxFrzOn && runActive\) fluxFrzFrame\(ts-last,ts\);/.test(gameHtml));
    /* R8 */
    if (!quiet) console.log('== R8 the old level-up freeze cannot come back ==');
    ck('R8 no level-up hold left in the game (levelHold gone: declaration, loop branch, still-field check)', !/levelHold/.test(gameHtml));
    const lv = B({}); startRun(lv);
    lv.run('level=8; pendingLevel=0; fluxCountdown=0; speedCountdown=0; missNotice=0; startLevelUp(9);');
    let stopped = 0, still = 0, t2 = 1016, px = lv.run('ball.x'), py = lv.run('ball.y');
    for (let i = 0; i < 400; i++) { if (lv.run('level') === 9 && i > 0 && lv.run('!pendingLevel')) { if (i > 330) break; } t2 += 16; lv.run('misses=0;'); lv.frame(t2); if (!lv.run('playing')) stopped++; const x = lv.run('ball.x'), y = lv.run('ball.y'); if (x === px && y === py) still++; px = x; py = y; }
    ck('R8 through a real 8 -> 9 level-up (countdown, LEVEL 9, backdrop, speed ramp) the game never stops: playing on every frame, the ball moves on every frame',
      lv.run('level') === 9 && stopped === 0 && still === 0, 'level ' + lv.run('level') + ' · frames stopped ' + stopped + ' · ball still ' + still);
  } catch (e) { ck('suite ran without an exception', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  return { F, failed };
}

const res = await suite(GAME_HTML, false);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
async function control(label, expect, edit) {
  const g2 = edit(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = await suite(g2, true); const hit = r.failed.filter((f) => f.startsWith(expect));
  console.log((hit.length ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (hit[0] || 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!hit.length) NC++;
}
await control('ON for everyone', 'R1', rep("fluxFrzOn=localStorage.getItem(FLUX_FRZ_KEY)==='1';", 'fluxFrzOn=true;'));
await control('the game functions wrapped even when OFF', 'R1', rep("(function(){\n  if(!fluxFrzOn) return;\n  const hook=", "(function(){\n  const hook="));
await control('?freezelog=0 keeps the list', 'R2', rep("localStorage.removeItem(FLUX_FRZ_KEY); localStorage.removeItem(FLUX_FRZ_LOG);", 'localStorage.removeItem(FLUX_FRZ_KEY);'));
await control('the threshold at 150 ms', 'R3', rep("FLUX_FRZ_MS=300", 'FLUX_FRZ_MS=150'));
await control('no last event', 'R3', rep("function fluxFrzNote(name){ fluxFrzEv=name; fluxFrzEvAt=performance.now(); }", 'function fluxFrzNote(name){}'));
await control('a gap across a hide / return counted', 'R4', rep("  if(fluxFrzVisAt>=ts-gap) return;   // the app was hidden / shown during this gap\n", ''));
await control('recorded on the menu too', 'R4', rep(' if(fluxFrzOn && runActive) fluxFrzFrame(ts-last,ts);', ' if(fluxFrzOn) fluxFrzFrame(ts-last,ts);'));
await control('the list never trimmed', 'R5', rep('while(a.length>FLUX_FRZ_MAX) a.shift();', ''));
await control('nothing shown at game over', 'R6', rep("  if(typeof end==='function') window.endGame=function(){ const r=end.apply(this,arguments); fluxFrzShow(); return r; };", ''));
await control('the list sent to the server', 'R7', rep("    localStorage.setItem(FLUX_FRZ_LOG,JSON.stringify(a));\n", "    localStorage.setItem(FLUX_FRZ_LOG,JSON.stringify(a)); try{ fetch('/api/events',{ method:'POST', body:JSON.stringify({ freeze:e }) }); }catch(z){}\n"));
await control('the old level-up hold back (0.85 s, D-50)', 'R8', (h) => rep('perfectFlash=0,orbValue=20', 'perfectFlash=0,levelHold=0,orbValue=20')(rep(' if(playing && !paused) update(dt);', ' if(playing && !paused) update(dt);\n else if(!paused && levelHold>0){ levelHold-=dt; if(levelHold<=0){ levelHold=0; playing=true; } }')(rep(' applyCelestialBackground(level);\n popup(W/2,155,', ' applyCelestialBackground(level); levelHold=.85; playing=false;\n popup(W/2,155,')(h))));
await control('a level-up that stops the game another way', 'R8', rep(' applyCelestialBackground(level);\n popup(W/2,155,', " applyCelestialBackground(level); playing=false; setTimeout(function(){ playing=true; },850);\n popup(W/2,155,"));
const total = res.F + NC;
console.log('\n' + (total ? 'FREEZE RECORDER FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'FREEZE RECORDER PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
