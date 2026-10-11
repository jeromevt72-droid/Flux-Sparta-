// LEADERBOARD SCROLL (owner). The real game page in the harness vm.
//   L1 outside a run, a finger moving inside a panel that really scrolls (the leaderboard list) is NOT
//      cancelled, so the list scrolls to its last row and to the pilot's own pinned row;
//   L2 during a run every finger move is cancelled exactly as before (a swipe never moves the page), even over
//      a scrollable element; a paused run lets the pause panel scroll;
//   L3 a move over something that does not scroll (the field, a short panel, a panel with overflow hidden) is
//      still cancelled; the paddle still follows the finger in every case (pointer() runs first);
//   L4 the leaderboard list itself: overflow auto (as before), contained, top 10 rows per tab + the pinned row.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    const { store } = makeStore({ fluxPlayerId: 'ls-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1' });
    const g = boot(scriptsOf(html), { origin: 'https://fluxsparta.com', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    const handlers = g.listeners.touchmove || [];
    ck('L0 one touchmove listener, as before', handlers.length === 1, handlers.length);
    const body = g.ctx.document.body, html0 = g.ctx.document.documentElement;
    const el = (o) => Object.assign({ nodeType: 1, scrollHeight: 100, clientHeight: 100, overflowY: 'visible', parentElement: body }, o);
    g.ctx.getComputedStyle = (e) => ({ overflowY: e.overflowY || 'visible' });
    const lbBody = el({ scrollHeight: 900, clientHeight: 400, overflowY: 'auto' }), row = el({ parentElement: lbBody }), name = el({ parentElement: row });
    const shortPanel = el({ scrollHeight: 300, clientHeight: 300, overflowY: 'auto' }), inShort = el({ parentElement: shortPanel });
    const hidden = el({ scrollHeight: 900, clientHeight: 400, overflowY: 'hidden' }), inHidden = el({ parentElement: hidden });
    const canvas = el({ parentElement: body });
    let paddleCalls = 0; run('var __p0=pointer; pointer=function(e){ globalThis.__pc=(globalThis.__pc||0)+1; };');
    const move = (target) => { let prevented = false; const e = { target, touches: [], preventDefault() { prevented = true; } }; for (const f of handlers) f(e); return prevented; };
    const state = (p, q) => run('playing=' + p + '; paused=' + q + ';');
    state(false, false);
    ck('L1 menu / game over: a finger on a leaderboard row scrolls the list (not cancelled)', move(name) === false && move(row) === false);
    ck('L3 ...but over the field, a short panel or an overflow-hidden box it is still cancelled', move(canvas) === true && move(inShort) === true && move(inHidden) === true && move(undefined) === true);
    state(true, false);
    ck('L2 during a run EVERY move is cancelled, even over a scrollable element (a swipe never moves anything)', move(name) === true && move(canvas) === true);
    state(true, true);
    ck('L2 paused: the pause panel may scroll', move(name) === false);
    ck('L3 the paddle still gets every finger move first (pointer() runs in all cases)', (g.ctx.__pc || 0) === 9, g.ctx.__pc);
    const css = (html.match(/\.lbBody\{[^}]*\}/) || [''])[0];
    ck('L4 the list box: overflow auto as before, scrolling contained to the list (no visual change)', /overflow:auto/.test(css) && /overscroll-behavior:contain/.test(css) && /flex:1;min-height:0/.test(css), css);
    ck('L4 top 10 rows per tab; the pilot\'s own row is highlighted in them or pinned below them, inside the same scrolling list', /const FLUX_LB_SHOW=10;/.test(html) && /<div id="lbBody" class="lbBody">/.test(html) && /h\+='<div class="lbPinned">'/.test(html));
  } catch (e) { ck('section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}
const res = suite(GAME);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, a, b) {
  if (!GAME.includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(GAME.split(a).join(b), true); const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
control('every move cancelled again (today\'s bug)', 'L1', "if(!fluxTouchScrollsPanel(e))e.preventDefault()", 'e.preventDefault()');
control('scrolling allowed during a run', 'L2 during a run', "  if(playing && !paused) return false;                 // a run in progress: never\n", '');
control('any panel counts, even one that does not scroll', 'L3 ...but over', "if(el.scrollHeight>el.clientHeight+1){ const oy=getComputedStyle(el).overflowY; if(oy==='auto' || oy==='scroll') return true; }", 'return true;');
const total = res.F + NC;
console.log('\n' + (total ? 'LEADERBOARD SCROLL FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'LEADERBOARD SCROLL PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
