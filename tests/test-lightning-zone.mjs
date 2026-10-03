// LIGHTNING ZONE (owner, real iPhone, Jupiter/Hard level 6: a lightning burst low on the screen fired
// the ball at the launcher with no time to react). The growing orb spawns, grows and turns into a
// lightning orb (⚡) only in the upper-middle of the play field: from the bottom of the score bar down
// to halfway to the launcher, 10-90% of the screen width. Real game page in the harness vm, on Easy,
// Medium and Hard, at iPhone 390x844, iPad 820x1180 and iPad mini 4 768x1024.
//   Z1 the zone: top = score bar, bottom = halfway to the launcher, 10-90% of the width (per device);
//   Z2 every growing orb spawns with its centre inside the zone;
//   Z3 while it grows and once it is ⚡, its centre never leaves the zone, even when it drifts fast;
//      it still turns into ⚡ after the same 4.2 s;
//   Z4 safety net: it only turns into ⚡ while its centre is inside the zone (outside it waits, full size);
//   Z5 unchanged: timer 13-19 s, one at a time, 4.2 s growth, bonus, 1.35x kick, about as many
//      lightning orbs per run as before (same random seed, main vs this build);
//   Z6 unchanged: regular orbs (spawn area down to 79%, drift bounds), the launcher position, orb
//      colours and the flash effect.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
let MAIN_HTML = null;
try { MAIN_HTML = execFileSync('git', ['-C', ROOT, 'show', 'origin/main:public/play/index.html'], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { MAIN_HTML = null; }
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const DEVICES = [['iPhone', 390, 844, 34], ['iPad', 820, 1180, 20], ['iPad mini 4', 768, 1024, 0]];
const DIFFS = ['easy', 'medium', 'hard'];
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function bootGame(html, diff, dev, seed) {
  const { store } = makeStore({ fluxPlayerId: 'lz-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '9', fluxColorHintSeen: '1', fluxDifficulty: diff, fluxSeason: '1' });
  const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
  const run = (c) => vm.runInContext(c, g.ctx);
  if (seed != null) { const r = seeded(seed); g.ctx.Math = Object.assign(Object.create(Math), { random: r }); }
  g.ctx.readSafeBottom = () => dev[3]; run(`innerWidth=${dev[1]}; innerHeight=${dev[2]};`); g.ctx.resize();
  run(`difficulty=${JSON.stringify(diff)};`); g.ctx.newGame(); run('playing=true; paused=false; level=6; registerMiss=function(){};');
  return { g, run };
}
// The ball is parked at the launcher every frame, so only the orbs move.
const PARK = 'ball.x=paddle.x; ball.y=paddle.y-40; ball.vx=0; ball.vy=0;';

function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const pct = (v, of) => (100 * v / of).toFixed(1) + '%';
  try {
    const rows = []; let ok = true;
    for (const dev of DEVICES) {
      const b = bootGame(html, 'hard', dev);
      const z = b.run('lightningZone()'), top = b.run('maxHudBottom()'), py = b.run('paddle.y'), W = dev[1], H = dev[2];
      const good = Math.abs(z.top - top) < 1e-6 && Math.abs(z.bottom - (top + (py - top) / 2)) < 1e-6 && Math.abs(z.left - W * .1) < 1e-6 && Math.abs(z.right - W * .9) < 1e-6;
      if (!good) ok = false;
      rows.push(dev[0] + ': ' + pct(z.top, H) + '-' + pct(z.bottom, H) + ' of the height, 10-90% of the width');
    }
    ck('Z1 the zone is the upper half of the play field (score bar to halfway to the launcher), 10-90% of the width, on every device', ok, rows.join(' | '));
  } catch (e) { ck('Z1 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    let ok = true, n = 0; const bad = [];
    for (const dev of DEVICES) for (const diff of DIFFS) {
      const b = bootGame(html, diff, dev, 11);
      for (let i = 0; i < 60; i++) {
        b.run('targets=targets.filter(function(t){ return !t.growing; }); spawnGrowingOrb();');
        const o = b.run('(function(){ const t=targets.find(function(x){ return x.growing; }); return t ? { x:t.x, y:t.y, in:inLightningZone(t) } : null; })()');
        n++; if (!o || !o.in) { ok = false; bad.push(dev[0] + '/' + diff); }
      }
    }
    ck('Z2 every growing orb spawns with its centre inside the zone (60 spawns x 3 difficulties x 3 devices)', ok, n + ' spawns' + (bad.length ? ', outside: ' + bad.slice(0, 3).join(',') : ''));
  } catch (e) { ck('Z2 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    let ok = true, matOk = true; const notes = [];
    for (const dev of DEVICES) for (const diff of DIFFS) {
      const b = bootGame(html, diff, dev, 23);
      b.run('spawnTarget=function(){}; spawnBonusOrb=function(){}; growTimer=1e9; targets=targets.filter(function(t){ return !t.growing; }); spawnGrowingOrb();');
      b.run('(function(){ const t=targets.find(function(x){ return x.growing; }); t.vx=2.6; t.vy=2.2; })()');   // much faster drift than the game uses, to push at every edge
      let t = 0, out = 0, maturedAt = null, worst = 0;
      while (t < 30) {
        b.run(PARK); b.g.ctx.update(1 / 60); t += 1 / 60;
        const o = b.run('(function(){ const g=targets.find(function(x){ return x.growing; }); if(!g) return null; const z=lightningZone(); return { x:g.x, y:g.y, m:g.matured, below:g.y-z.bottom, in:inLightningZone(g) }; })()');
        if (!o) break;
        if (!o.in) { out++; worst = Math.max(worst, o.below); }
        if (o.m && maturedAt === null) maturedAt = t;
      }
      if (out) ok = false;
      if (maturedAt === null || Math.abs(maturedAt - 4.2) > 0.1) matOk = false;
      notes.push(dev[0] + '/' + diff[0] + ':' + (maturedAt == null ? 'never' : maturedAt.toFixed(2) + 's') + (out ? ' OUT ' + out : ''));
    }
    ck('Z3 while it grows and once it is ⚡, its centre stays in the zone (30 s of fast drift, every device and difficulty)', ok, notes.join(' '));
    ck('Z3 ...and it still turns into ⚡ after 4.2 s', matOk, notes.join(' '));
  } catch (e) { ck('Z3 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const b = bootGame(html, 'medium', DEVICES[0], 5);
    b.run('spawnTarget=function(){}; spawnBonusOrb=function(){}; growTimer=1e9; targets=targets.filter(function(t){ return !t.growing; }); spawnGrowingOrb();');
    b.run('var __inZ=inLightningZone; inLightningZone=function(){ return false; };');
    for (let i = 0; i < 6 * 60; i++) { b.run(PARK); b.g.ctx.update(1 / 60); }
    const held = b.run('(function(){ const g=targets.find(function(x){ return x.growing; }); return { m:g.matured, full:g.r>=g.maxR }; })()');
    b.run('inLightningZone=__inZ;'); b.run(PARK); b.g.ctx.update(1 / 60);
    const after = b.run('targets.find(function(x){ return x.growing; }).matured');
    ck('Z4 safety net: outside the zone it waits at full size and only turns into ⚡ once its centre is inside', held.full && !held.m && after === true, JSON.stringify(held) + ' then ' + after);
  } catch (e) { ck('Z4 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const A = scriptsOf(html).join('\n');
    ck('Z5 unchanged: timer 13-19 s from level 4, one at a time, 4.2 s growth, the bonus and the 1.35x kick',
      /if\(growTimer<=0 && playing && level>=GROWING_LEVEL\)\{spawnGrowingOrb\(\);growTimer=rand\(13,19\);\}/.test(A) && /function spawnGrowingOrb\(\)\{\n if\(targets\.some\(t=>t\.growing\)\) return;/.test(A)
      && /t\.r=Math\.min\(t\.maxR,12\+\(t\.age\/4\.2\)\*\(t\.maxR-12\)\);/.test(A) && /const points=Math\.round\(200\+combo\*15\+\(fluxMode>0\?100:0\)\);/.test(A)
      && /const kickSpeed=Math\.min\(maxSpeed,Math\.max\(9,Math\.hypot\(ball\.vx,ball\.vy\)\*1\.35\+2\)\);/.test(A), '');
    const b = bootGame(html, 'hard', DEVICES[0]);
    b.run('targets=targets.filter(function(t){ return !t.growing; }); spawnGrowingOrb(); spawnGrowingOrb();');
    ck('Z5 ...never two at once', b.run('targets.filter(function(t){ return t.growing; }).length') === 1, '');
    if (MAIN_HTML) {
      const count = (h) => { let tot = 0; for (const dev of DEVICES) for (const diff of DIFFS) { const b = bootGame(h, diff, dev, 77); b.run('spawnTarget=function(){}; spawnBonusOrb=function(){};');
        let n = 0, was = false; for (let i = 0; i < 180 * 30; i++) { b.run(PARK); b.g.ctx.update(1 / 30); const m = b.run('targets.some(function(t){ return t.growing && t.matured; })'); if (m && !was) n++; was = m; if (m) b.run('targets=targets.filter(function(t){ return !(t.growing && t.matured); });'); } tot += n; } return tot; };
      const now = count(html), before = count(MAIN_HTML);
      ck('Z5 about as many lightning orbs per run as before (3 min x 3 difficulties x 3 devices, same seed)', before > 0 && Math.abs(now - before) <= Math.max(2, before * .1), now + ' now vs ' + before + ' on main');
    } else ck('Z5 main build available for the frequency comparison', false, 'git show origin/main failed');
  } catch (e) { ck('Z5 section ran', false, String(e.stack || e).slice(0, 300)); }

  try {
    const A = scriptsOf(html).join('\n');
    ck('Z6 regular orbs unchanged: spawn area down to 79% and drift bounds', /function spawnTarget\(/.test(A) && /const \[x,y\]=safeSpawnPoint\(30,lightningZone\(\)\);/.test(A) && (A.match(/lightningZone\(\)/g) || []).length === 4
      && /const topBound=maxHudBottom\(\)\+t\.r, botBound=Math\.max\(topBound\+60,H\*\.79\)-t\.r;/.test(A) && /bottom=zone\?zone\.bottom:Math\.max\(top\+80,H\*\.79\);/.test(A), '');
    if (MAIN_HTML) {
      const M = scriptsOf(MAIN_HTML).join('\n');
      const pick = (src, re) => (re.exec(src) || [''])[0];
      const same = (re) => pick(A, re) !== '' && pick(A, re) === pick(M, re);
      ck('Z6 the launcher position, orb colours and the flash effect are exactly as on main', same(/paddle\.y=Math\.min\([^;]*\);/) && same(/const SKINS=\{[\s\S]*?\n\};/) && same(/function flash\([^]*?\n\}/) && same(/function burst\([^]*?\n\}/), '');
      const pos = DEVICES.map((dev) => { const a = bootGame(html, 'hard', dev), m = bootGame(MAIN_HTML, 'hard', dev); return a.run('paddle.y') === m.run('paddle.y'); });
      ck('Z6 ...and the launcher sits at the same height as on main on iPhone, iPad and iPad mini', pos.every(Boolean), pos.join(','));
      const regular = DEVICES.map((dev) => { const a = bootGame(html, 'medium', dev, 9), m = bootGame(MAIN_HTML, 'medium', dev, 9); const f = 'JSON.stringify(Array.from({length:40},function(){ return safeSpawnPoint(20).map(Math.round); }))'; return a.run(f) === m.run(f); });
      ck('Z6 ...and regular orbs spawn exactly where they did on main (same seed)', regular.every(Boolean), regular.join(','));
    }
  } catch (e) { ck('Z6 section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const t0 = Date.now();
const res = suite(GAME_HTML);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
function control(label, expect, mut) {
  const h = mut(GAME_HTML);
  if (h === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(h, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
control('the growing orb spawns anywhere again', 'Z2 every growing orb spawns', rep('const [x,y]=safeSpawnPoint(30,lightningZone());', 'const [x,y]=safeSpawnPoint(30);'));
control('the growing orb may drift out of the zone', 'Z3 while it grows', rep("     if(t.y<z.top || t.y>z.bottom){t.vy=(t.y<z.top?1:-1)*Math.abs(t.vy);t.y=Math.max(z.top,Math.min(z.bottom,t.y));}\n", ''));
control('it turns into ⚡ anywhere', 'Z4 safety net', rep('if(t.r>=t.maxR && inLightningZone(t)){t.matured=true;', 'if(t.r>=t.maxR){t.matured=true;'));
control('the zone reaches down to the launcher', 'Z1 the zone', rep('bottom:Math.max(top+60,top+(paddle.y-top)/2) }', 'bottom:paddle.y }'));
control('the zone is the full width', 'Z1 the zone', rep('left:W*.10, right:W*.90', 'left:0, right:W'));
control('growth made faster', 'Z3 ...and it still turns', rep('t.r=Math.min(t.maxR,12+(t.age/4.2)*(t.maxR-12));', 't.r=Math.min(t.maxR,12+(t.age/2.5)*(t.maxR-12));'));
control('regular orbs moved into the zone too', 'Z6', rep(' const xLo=zone?zone.left:pad, xHi=zone?zone.right:W-pad;', ' zone=zone||lightningZone(); const xLo=zone.left, xHi=zone.right;'));
const total = res.F + NC;
console.log('\n' + (total ? 'LIGHTNING ZONE FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'LIGHTNING ZONE PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
