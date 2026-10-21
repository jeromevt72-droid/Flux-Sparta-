// MILESTONE LEVELS 10-99 (owner). Real worker.js, real game page (harness vm), origin/main for comparison.
//   M1 the rule: levels 1-9 unchanged; level n (10-99) at (45,000 + (n - 9) x 50,000) x LEVEL_SCORE_MULT;
//      the game, the server and tests/level-rule.mjs give the same level for every score at every
//      threshold edge, level 1 to 99, on every difficulty; never above 99;
//   M2 the caps: the game stops points at the difficulty's level-99 score (MAX SCORE only there); the
//      server's ceiling is the level-99 score plus one level, per difficulty; MAX_SCORE allows it;
//   M3 the server: 300,000 on Hard is accepted (level 19, and 18 within the one-level tolerance); a score
//      above the ceiling, a level two off its score, and a level above 99 are refused; stats and imports
//      keep levels up to 99;
//   M4 play is unchanged: seeded Hard runs from level 9 that pass level 10 mid-chain (and later 11)
//      equal main on every frame -- score, combo, ball, launcher, speed and every orb; the game's own
//      level stays 9 and the background stays on the level 9 theme;
//   M5 the celebration: banner "LEVEL n", the LEVEL box reads LEVEL UP (the number, never a countdown)
//      for ~2 s, then LEVEL again; no countdown, pause, speed step or ramp; the burst uses the effects'
//      own random numbers and goes through the per-frame caps (#94);
//   M6 shown everywhere levels are shown: HUD number, progress bar toward the next milestone (not 100%),
//      menu BEST LEVEL from the saved best score (257,614 Hard -> 17) without rewriting saved data, the
//      level saved with a new best, and the level sent with an upload.
// Ends with negative controls: each defect re-inserted MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
import { levelFor as ruleLevelFor, levelScoreAt as ruleScoreAt } from './level-rule.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
let MAIN_HTML = null; try { MAIN_HTML = execFileSync('git', ['show', 'origin/main:public/play/index.html'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) {}
const ORIGIN = 'https://flux.example';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const DIFFS = ['easy', 'medium', 'hard'];
const MULT = { easy: 1.5, medium: 1, hard: 0.55 };
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
let pidN = 0;
const submit = async (w, env, body) => { skew += 20000;
  const r = await w.fetch(new Request(ORIGIN + '/api/submit-score', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'mlv-' + (++pidN), name: 'T', country: 'US', season: 1, runId: 'run' + String(pidN).padStart(13, '0') + 'x', ...body }) }), env);
  return r.status; };

/* The level functions of a page / of the worker, run on their own. */
function pageRule(html) {
  const pick = (re) => (re.exec(html) || [''])[0];
  const src = [pick(/const LEVEL_SCORE_THRESHOLDS=[^\n]*/), pick(/const LEVEL_SCORE_MULT=[^\n]*/), pick(/const LEVEL_PLAY_MAX=[^\n]*/), pick(/function levelScoreAt\(lv,d\)\{[\s\S]*?\n\}/), pick(/function levelForScore\(sc,d\)\{[\s\S]*?\n\}/), pick(/const RUN_SCORE_CAPS=[^\n]*/)].join('\n');
  return vm.runInContext(src + '\n;({levelScoreAt:typeof levelScoreAt==="function"?levelScoreAt:null,levelForScore:typeof levelForScore==="function"?levelForScore:null,caps:typeof RUN_SCORE_CAPS==="object"?RUN_SCORE_CAPS:null})', vm.createContext({ Math }));
}
function workerRule(src) {
  const pick = (re) => (re.exec(src) || [''])[0];
  const code = [pick(/const MAX_SCORE = [^\n]*/), pick(/const MAX_LEVEL = [^\n]*/), pick(/const LEVEL_PLAY_MAX = [^\n]*/), pick(/const LEVEL_SCORE_THRESHOLDS = [^\n]*/), pick(/const LEVEL_SCORE_MULT = [^\n]*/), pick(/const SCORE_CEILINGS = [^\n]*/), pick(/function levelScoreAt\(lv, difficulty\) \{[\s\S]*?\n\}/), pick(/function levelForScore\(score, difficulty\) \{[\s\S]*?\n\}/)].join('\n');
  return vm.runInContext(code + '\n;({levelForScore,MAX_LEVEL,MAX_SCORE:typeof MAX_SCORE==="number"?MAX_SCORE:0,ceilings:typeof SCORE_CEILINGS==="object"?SCORE_CEILINGS:null})', vm.createContext({ Math }));
}

async function suite({ gameHtml, workerMod, workerSrc, quiet = false, parts = null }) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const say = (t) => { if (!quiet) console.log(t); };
  const on = (p) => !parts || parts.includes(p);
  try {
    /* ================= M1 the rule ================= */
    if (on('1')) {
      say('== M1 the rule: game, server and test helper agree, level 1 to 99 ==');
      const P = pageRule(gameHtml), Wr = workerRule(workerSrc);
      let bad = [], edges = 0;
      for (const d of DIFFS) for (let lv = 1; lv <= 100; lv++) {
        const t = lv <= 99 ? ruleScoreAt(lv, d) : Math.round((45000 + 91 * 50000) * MULT[d]);
        for (const sc of [t - 1, t, t + 1]) { if (sc < 0) continue; edges++;
          const a = P.levelForScore(sc, d), b = Wr.levelForScore(sc, d), c = ruleLevelFor(sc, d);
          if (a !== b || b !== c) bad.push(d + ' ' + sc + ': ' + a + '/' + b + '/' + c); }
      }
      ck('M1 the game, the server and the test helper give the same level at every threshold edge (score - 1, score, score + 1), level 1 to 99 (and "100"), every difficulty', bad.length === 0, bad.slice(0, 3).join('; ') || edges + ' scores');
      const ok9 = DIFFS.every((d) => [2, 3, 4, 5, 6, 7, 8, 9].every((lv) => P.levelScoreAt(lv, d) === Math.round([2500, 6000, 10000, 15000, 21000, 28000, 36000, 45000][lv - 2] * MULT[d])));
      const okM = DIFFS.every((d) => { for (let n = 10; n <= 99; n++) if (P.levelScoreAt(n, d) !== Math.round((45000 + (n - 9) * 50000) * MULT[d])) return false; return true; });
      ck('M1 levels 1-9 are unchanged; level n (10-99) is at (45,000 + (n - 9) x 50,000) x the difficulty multiplier', ok9 && okM);
      ck('M1 the owner\'s numbers: Hard 52,249 -> 9, 52,250 -> 10; Medium 95,000 -> 10; Hard 257,614 -> 17; Hard 300,000 -> 19',
        P.levelForScore(52249, 'hard') === 9 && P.levelForScore(52250, 'hard') === 10 && P.levelForScore(95000, 'medium') === 10 && P.levelForScore(257614, 'hard') === 17 && P.levelForScore(300000, 'hard') === 19,
        [P.levelForScore(52250, 'hard'), P.levelForScore(95000, 'medium'), P.levelForScore(257614, 'hard'), P.levelForScore(300000, 'hard')].join(','));
      ck('M1 never above 99 (the game and the server), whatever the score', DIFFS.every((d) => P.levelForScore(1e9, d) === 99 && Wr.levelForScore(1e9, d) === 99) && Wr.MAX_LEVEL === 99);
    }
    /* ================= M2 the caps ================= */
    if (on('2')) {
      say('== M2 the caps: points stop at the level-99 score; the server allows it plus one level ==');
      const P = pageRule(gameHtml), Wr = workerRule(workerSrc);
      const want99 = { easy: 6817500, medium: 4545000, hard: 2499750 }, want100 = { easy: 6892500, medium: 4595000, hard: 2527250 };
      ck('M2 the game stops points at the difficulty\'s level-99 score: Easy 6,817,500, Medium 4,545,000, Hard 2,499,750', !!P.caps && DIFFS.every((d) => P.caps[d] === want99[d] && P.caps[d] === P.levelScoreAt(99, d)), JSON.stringify(P.caps));
      ck('M2 the server ceiling is the level-99 score plus one level, per difficulty: Easy 6,892,500, Medium 4,595,000, Hard 2,527,250; MAX_SCORE allows the highest', !!Wr.ceilings && DIFFS.every((d) => Wr.ceilings[d] === want100[d]) && Wr.MAX_SCORE >= want100.easy, JSON.stringify(Wr.ceilings) + ' max ' + Wr.MAX_SCORE);
      const caps = {};
      for (const d of DIFFS) {
        const { store } = makeStore({ fluxPlayerId: 'p-cap', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxDifficulty: d });
        const g = boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store, standalone: false });
        const run = (c) => vm.runInContext(c, g.ctx);
        g.ctx.newGame(); run('difficulty="' + d + '"; score=300001; capScore();'); const s1 = run('score'), t1 = run('JSON.stringify(texts.map(function(t){return t.s;}))');
        run('score=9999999; capScore();'); caps[d] = [s1, run('score'), JSON.parse(t1).includes('MAX SCORE'), JSON.parse(run('JSON.stringify(texts.map(function(t){return t.s;}))')).includes('MAX SCORE')];
      }
      ck('M2 in play: 300,001 is no longer capped (no MAX SCORE); the MAX SCORE notice comes only at the new cap', DIFFS.every((d) => caps[d][0] === 300001 && caps[d][1] === want99[d] && !caps[d][2] && caps[d][3]), JSON.stringify(caps));
    }
    /* ================= M3 the server ================= */
    if (on('3') && workerMod) {
      say('== M3 the server: levels to 99, the new ceilings, every other check kept ==');
      const w = workerMod.default, env = makeEnv(workerMod.LeaderboardDO);
      ck('M3 Hard 300,000 is accepted at level 19 (its level) and at 18 (one-level tolerance, kept); 17 is refused',
        (await submit(w, env, { score: 300000, level: 19, difficulty: 'hard' })) === 200 && (await submit(w, env, { score: 300000, level: 18, difficulty: 'hard' })) === 200 && (await submit(w, env, { score: 300000, level: 17, difficulty: 'hard' })) === 422);
      ck('M3 the owner\'s run: Hard 257,614 at level 17 is accepted', (await submit(w, env, { score: 257614, level: 17, difficulty: 'hard' })) === 200);
      const at = [];
      for (const [d, c] of [['hard', 2527250], ['medium', 4595000], ['easy', 6892500]]) at.push(await submit(w, env, { score: c, level: 99, difficulty: d }), await submit(w, env, { score: c + 1, level: 99, difficulty: d }));
      ck('M3 each difficulty\'s ceiling is accepted at level 99, one point more is refused', at[0] === 200 && at[1] >= 400 && at[2] === 200 && at[3] >= 400 && at[4] === 200 && at[5] >= 400, at.join(','));
      ck('M3 a level two off its score is still refused (Hard 300,000 at 17, Medium 95,000 at 12, a huge score at level 1)',
        (await submit(w, env, { score: 95000, level: 12, difficulty: 'medium' })) === 422 && (await submit(w, env, { score: 2000000, level: 1, difficulty: 'hard' })) === 422);
      ck('M3 a level above 99 is refused (400); a level 99 claim on a small score is refused (422)', (await submit(w, env, { score: 2499750, level: 100, difficulty: 'hard' })) === 400 && (await submit(w, env, { score: 60000, level: 99, difficulty: 'hard' })) === 422);
      ck('M3 stats, restores and imports keep levels up to 99 (the same MAX_LEVEL); nothing else caps a level at 9', /out\.lvl = lvl >= 1 && lvl <= MAX_LEVEL \? lvl : 1;/.test(workerSrc) && /if \(level < 1 \|\| level > MAX_LEVEL\) level = 1;/.test(workerSrc) && !/Math\.min\(9,|level\s*>\s*9\b|lvl\s*<=\s*9\b/.test(workerSrc));
    }
    /* ================= M4 / M5 play unchanged; the celebration ================= */
    if (on('4') && MAIN_HTML) {
      say('== M4 play unchanged past level 9 (seeded, main vs this build, every frame) ==');
      const fakeEl = () => { const cls = new Set(); return { textContent: '', innerHTML: '', style: {}, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, v) => { if (v === undefined ? !cls.has(c) : v) cls.add(c); else cls.delete(c); } }, _cls: cls }; };
      const play = (html, seed, plan) => {
        const realRandom = Math.random; let s = seed; Math.random = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
        try {
          const { store } = makeStore({ fluxPlayerId: 'p-m4', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxDifficulty: 'hard', fluxRunsPlayed: '9', fluxLite: '0' });
          const g = boot(scriptsOf(html), { origin: ORIGIN, path: '/play/', store, standalone: false });
          for (const id of ['level', 'levelLabel', 'levelBox', 'levelProgress']) g.els[id] = fakeEl();
          const run = (c) => vm.runInContext(c, g.ctx);
          g.ctx.newGame(); run('difficulty="hard"; level=9; speedLevel=9; paddle.w=paddleWidthFor(9); setPaddle(paddle.x); speedStep=lastStep(); speedShown=speedStep; applyCelestialBackground(9); score=' + plan.start + '; combo=8;');   // as late in a long run: level 9, speed at its last step, the level 9 background
          const states = [], seen = []; let ts = 1000;
          for (let fr = 0; fr < plan.frames; fr++) {
            if (plan.chains.includes(fr)) run('(function(){ const n=coloursInPlay(); let c=ball.color; for(let k=0;k<10;k++){ targets.push({x:ball.x,y:ball.y,r:20,color:c,spin:0,vx:0,vy:0,phase:0,age:1,danger:k%3===2}); c=(c+1)%n; } })()');
            if (plan.bump && plan.bump[0] === fr) run('score+=' + plan.bump[1] + ';');
            ts += 16; run('misses=0; if(ball) setPaddle(ball.x+Math.sin(' + fr + ')*20);'); g.ctx.loop(ts);
            states.push(run('JSON.stringify([score,combo,level,speedLevel,speedStep,Math.round(paddle.x*1000),paddle.w,Math.round(ball.x*1000),Math.round(ball.y*1000),Math.round(ball.vx*1000),Math.round(ball.vy*1000),ball.color,playing,paused,pendingLevel,speedCountdown>0,targets.length,targets.map(function(t){ return [Math.round(t.x),Math.round(t.y),t.color]; })])'));
            seen.push(run('JSON.stringify({m:typeof milestoneLevel==="number"?milestoneLevel:0, box:typeof milestoneBox==="number"?milestoneBox:0, label:document.getElementById("levelLabel").textContent, num:String(document.getElementById("level").textContent), amber:document.getElementById("levelBox")._cls.has("speedUp"), bar:String(document.getElementById("levelProgress").style.width||""), banner:levelBanner>0 ? levelBannerLayout().t1 || "" : "", parts:particles.length, theme:celestialIndex, playing:playing, paused:paused, pending:pendingLevel})'));
          }
          return { states, seen: seen.map((x) => JSON.parse(x)), run };
        } finally { Math.random = realRandom; }
      };
      const plans = [{ name: 'Hard, from 52,000: level 10 passed in the middle of a 10-orb chain', start: 52000, frames: 240, chains: [5, 120] },
        { name: 'Hard, from 52,100, two chains, then +27,000 at frame 300: levels 10 and 11', start: 52100, frames: 420, chains: [5, 200], bump: [300, 27000] }];
      for (const [i, plan] of plans.entries()) {
        const m = play(MAIN_HTML, 777 + i, plan), n = play(gameHtml, 777 + i, plan);
        const diff = m.states.findIndex((v, k) => v !== n.states[k]);
        const reached = n.seen[n.seen.length - 1].m, crossedAt = n.seen.findIndex((x) => x.m >= 10);
        ck('M4 ' + plan.name + ': score, combo, game level (9), speed, launcher, ball and every orb equal main on every frame',
          diff === -1 && crossedAt > 0 && JSON.parse(n.states[n.states.length - 1])[2] === 9 && (i === 0 ? reached === 10 : reached === 11),
          diff === -1 ? 'milestone ' + reached + ' (first at frame ' + crossedAt + ')' : 'frame ' + diff + ': ' + m.states[diff].slice(0, 90) + ' vs ' + n.states[diff].slice(0, 90));
        if (i === 0) {
          const k = crossedAt, c = n.seen[k], later = n.seen[Math.min(n.seen.length - 1, k + 160)];
          const chainFrames = n.seen.slice(k, k + 12);
          say('== M5 the celebration (this build, the frames around level 10) ==');
          ck('M5 at level 10: banner "LEVEL 10", the LEVEL box reads LEVEL UP in amber with the number 10 (never a countdown)', c.banner === 'LEVEL 10' && c.label === 'LEVEL UP' && c.amber && c.num === '10', JSON.stringify(c));
          ck('M5 ~2 s later the box reads LEVEL again, still 10', later.label === 'LEVEL' && !later.amber && later.num === '10', JSON.stringify(later));
          ck('M5 it never stops play: playing on every frame, no pause, no level countdown, no SPEED UP (and play equals main, M4)', n.seen.every((x) => x.playing && !x.paused && !x.pending));
          ck('M5 the background stays on the level 9 theme (solar core)', n.seen.every((x) => x.theme === 8));
          ck('M5 the progress bar points to the next milestone (not stuck at 100%): just past level 10 it is near 0%', /^[0-9.]+%$/.test(c.bar) && parseFloat(c.bar) < 10 && parseFloat(n.seen[k - 1].bar) > 90, n.seen[k - 1].bar + ' -> ' + c.bar);
          ck('M5 the effects stay within the per-frame caps (#94): no frame adds more than 160 particles', chainFrames.every((x, j) => j === 0 || x.parts - chainFrames[j - 1].parts <= 160));
        }
      }
      ck('M5 the celebration: level-up sound, short haptic, a burst with the effects\' own random numbers (never the game\'s), a popup; no startLevelUp, no speed step, no background change',
        /function celebrateMilestone\(m\)\{\n levelBanner=3\.2; milestoneBox=2\.2;\n playLevelUp\(\); haptic\(80\);\n juiceBurst\(W\/2,135,'#62eaff',38\);[^\n]*\n popup\(W\/2,155,'LEVEL '\+m,'#62eaff'\);\n updateHud\(\);\n\}/.test(gameHtml) &&
        !/function celebrateMilestone\(m\)\{[^}]*(startLevelUp|applySpeedStep|applyCelestialBackground|speedLevel|level\+\+)/.test(gameHtml));
    }
    /* ================= M6 shown everywhere ================= */
    if (on('6')) {
      say('== M6 menu, saved data, uploads ==');
      const run0 = { score: 257614, level: 9, difficulty: 'hard', playerId: 'p-m6', at: 1 };
      const init = { fluxSeason: '1', fluxPlayerId: 'p-m6', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxDifficulty: 'hard', fluxRunsPlayed: '30',
        fluxBest_hard: '257614', fluxBestLevel_hard: '9', fluxBestRun_hard: JSON.stringify(run0) };
      const { store, mem } = makeStore(init); const bodies = [];
      const g = boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store, standalone: false, fetchImpl: (u, o) => { if (String(u).includes('submit-score')) bodies.push(JSON.parse(o.body)); return Promise.resolve(new Response('{"ok":true,"isNewBest":false,"public":true,"rank":3}', { status: 200, headers: { 'Content-Type': 'application/json' } })); } });
      const run = (c) => vm.runInContext(c, g.ctx);
      g.els.menuLevel = { textContent: '' }; run('difficulty="hard"; refreshMenu();');
      ck('M6 menu BEST LEVEL: an existing Hard best of 257,614 shows 17 at once', String(g.els.menuLevel.textContent) === '17', String(g.els.menuLevel.textContent));
      ck('M6 saved data is not rewritten (the saved best still says level 9; BEST LEVEL key still 9)', mem.fluxBestLevel_hard === '9' && JSON.parse(mem.fluxBestRun_hard).level === 9 && JSON.parse(mem.fluxBestRun_hard).score === 257614);
      run('submitScore()'); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      ck('M6 that best, uploaded, carries the level its score reaches (17), as the server works it out', bodies.length >= 1 && bodies[bodies.length - 1].score === 257614 && bodies[bodies.length - 1].level === 17, JSON.stringify(bodies.map((b) => [b.score, b.level])));
      const { store: s2, mem: m2 } = makeStore({ fluxSeason: '1', fluxPlayerId: 'p-m6b', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxDifficulty: 'hard' });
      const g2 = boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store: s2, standalone: false });
      vm.runInContext('difficulty="hard"; recordBestRun(80000, levelForScore(80000,"hard"));', g2.ctx);
      ck('M6 a new best saves the level its score reaches (Hard 80,000 -> 11)', JSON.parse(m2.fluxBestRun_hard || '{}').level === 11 && m2.fluxBestLevel_hard === '11', m2.fluxBestRun_hard);
      const { store: s3, mem: m3 } = makeStore({ fluxSeason: '1', fluxPlayerId: 'p-m6c', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxDifficulty: 'hard', fluxBest_hard: '80000', fluxBestLevel_hard: '11', fluxBestRun_hard: JSON.stringify({ score: 80000, level: 11, difficulty: 'hard', playerId: 'p-m6c', at: 1 }) });
      boot(scriptsOf(gameHtml), { origin: ORIGIN, path: '/play/', store: s3, standalone: false });
      ck('M6 a saved milestone level is kept at the next start (never cut back to 9)', JSON.parse(m3.fluxBestRun_hard).level === 11 && m3.fluxBestLevel_hard === '11', m3.fluxBestRun_hard);
      ck('M6 the HUD shows the level shown (milestone or game level) and the run\'s end stats report it', /document\.getElementById\('level'\)\.textContent=shownLevel\(\);/.test(gameHtml) && /lvl:shownLevel\(\),diff:difficulty\},fluxGameOverInfo\(\)\)/.test(gameHtml));
    }
  } catch (e) { ck('suite ran without an exception', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  return { F, failed };
}

const realMod = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);
const res = await suite({ gameHtml: GAME_HTML, workerMod: realMod, workerSrc: WORKER_SRC });
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
async function control(label, expect, parts, { game = (s) => s, worker = (s) => s }) {
  const g2 = game(GAME_HTML), w2 = worker(WORKER_SRC);
  if (g2 === GAME_HTML && w2 === WORKER_SRC) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  let mod = realMod, tmp = null;
  if (w2 !== WORKER_SRC) { tmp = path.join(__dirname, '.nc-mlv-' + Math.random().toString(16).slice(2) + '.mjs'); fs.writeFileSync(tmp, w2); mod = await import(pathToFileURL(tmp).href); }
  try {
    const r = await suite({ gameHtml: g2, workerMod: mod, workerSrc: w2, quiet: true, parts });
    const hit = r.failed.filter((f) => f.startsWith(expect));
    console.log((hit.length ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (hit[0] || 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
    if (!hit.length) NC++;
  } finally { if (tmp) try { fs.unlinkSync(tmp); } catch (e) {} }
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('the game still stops at level 9', 'M1', ['1'], { game: rep('while(lv<LEVEL_MAX && sc>=levelScoreAt(lv+1,d)) lv++;', 'while(lv<9 && sc>=levelScoreAt(lv+1,d)) lv++;') });
await control('the server a different step (55,000)', 'M1', ['1'], { worker: rep('LEVEL_MILESTONE_STEP = 50000;', 'LEVEL_MILESTONE_STEP = 55000;') });
await control('the server still refuses levels above 9', 'M3', ['3'], { worker: rep('const MAX_LEVEL = 99;', 'const MAX_LEVEL = 9;') });
await control('the old 455,000 ceiling', 'M3', ['3'], { worker: rep("  if (score > (SCORE_CEILINGS[difficulty] || SCORE_CEILINGS.medium)) {", '  if (score > 455000) {') });
await control('a ceiling with no margin (the level-99 score)', 'M2', ['2'], { worker: rep('const SCORE_CEILINGS = { easy: 6_892_500, medium: 4_595_000, hard: 2_527_250 };', 'const SCORE_CEILINGS = { easy: 6_817_500, medium: 4_545_000, hard: 2_499_750 };') });
await control('MAX_SCORE left at 5,000,000', 'M2', ['2'], { worker: rep('const MAX_SCORE = 6_892_500;', 'const MAX_SCORE = 5_000_000;') });
await control('the level tolerance dropped (only the exact level)', 'M3', ['3'], { worker: rep('const LEVEL_TOLERANCE = 1;', 'const LEVEL_TOLERANCE = 0;') });
await control('the run cap left at 300,000', 'M2', ['2'], { game: rep('const RUN_SCORE_CAPS={easy:6817500,medium:4545000,hard:2499750};', 'const RUN_SCORE_CAPS={easy:300000,medium:300000,hard:300000};') });
await control('a milestone brings a real level-up (countdown, speed step, ramp)', 'M4', ['4'], { game: rep(' if(pendingLevel || fluxCountdown>0 || speedCountdown>0 || level>=9) return;', ' if(pendingLevel || fluxCountdown>0 || speedCountdown>0 || level>=99) return;') });
await control('the celebration burst uses the game\'s random numbers', 'M4', ['4'], { game: rep(" juiceBurst(W/2,135,'#62eaff',38);   // own random numbers", " burst(W/2,135,'#62eaff',38);   // own random numbers") });
await control('the LEVEL UP box never goes back to LEVEL', 'M5', ['4'], { game: rep(' if(milestoneBox>0){ milestoneBox-=dt; if(milestoneBox<=0){ milestoneBox=0; updateHud(); } }', '') });
await control('the progress bar stuck at 100% past level 9', 'M5', ['4'], { game: rep('const pct=cur>=LEVEL_MAX?100:', 'const pct=cur>=9?100:') });
await control('a milestone moves the background off the level 9 theme', 'M5', ['4'], { game: rep(' levelBanner=3.2; milestoneBox=2.2;\n', ' levelBanner=3.2; milestoneBox=2.2; celestialIndex=7;\n') });
await control('the menu shows the saved level (9), not the best score\'s', 'M6', ['6'], { game: rep("textContent=Math.max(+localStorage['fluxBestLevel_'+difficulty]||1,levelForScore(+localStorage['fluxBest_'+difficulty]||0,difficulty));", "textContent=+localStorage['fluxBestLevel_'+difficulty]||1;") });
await control('saved bests rewritten to the new rule at start-up', 'M6', ['6'], { game: rep("const lv=playLevelForScore(r.score,r.difficulty||d); if(r.level!==lv && !(r.level>LEVEL_PLAY_MAX && r.level===levelForScore(r.score,r.difficulty||d))){", "const lv=levelForScore(r.score,r.difficulty||d); if(r.level!==lv){") });
await control('an upload sends the saved level instead of the score\'s', 'M6', ['6'], { game: rep("level:(typeof levelForScore==='function' && Number.isFinite(item.score)) ? levelForScore(item.score,item.difficulty||'medium') : item.level,", 'level:item.level,') });
await control('saved milestone levels cut back to 9 at start-up', 'M6', ['6'], { game: rep(" && !(r.level>LEVEL_PLAY_MAX && r.level===levelForScore(r.score,r.difficulty||d))){", '){') });
const total = res.F + NC;
console.log('\n' + (total ? 'MILESTONE LEVELS FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'MILESTONE LEVELS PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
