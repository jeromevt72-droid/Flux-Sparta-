// Simulated player (test helper, not a suite): the model used by the Easy/Medium
// scoring PRs (#26, #30) and TIME SPEED. It follows the ball with a delay
// (react, in frames) and a random aim error (aim, px, new every 0.5 s), moves
// the launcher at most px per frame, plays a 4th+ run (no first-run hints),
// takes the one free revive, and stops at game over or after 30 minutes.
// playRuns() returns one record per seeded run; runParallel() spreads the
// runs of several (difficulty, player) rows over worker threads.
import vm from 'vm';
import os from 'os';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { boot, makeStore } from './harness.mjs';

export const PLAYERS = { 'new beginner': [12, 18, 15], casual: [9, 14, 20], steady: [6, 9, 28] };
export function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

export function playRuns({ html, diff, player, seeds, from = 1, runsPlayed = '5' }) {
  const [react, aim, px] = PLAYERS[player] || player;
  const scripts = scriptsOf(html), out = [], realRandom = Math.random;
  try {
    for (let seed = from; seed < from + seeds; seed++) {
      Math.random = seeded(seed);
      const { store } = makeStore({ fluxPlayerId: 'sim-' + seed, fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1', fluxRunsPlayed: runsPlayed, fluxDifficulty: diff });
      const g = boot(scripts, { origin: 'https://x.test', path: '/play/', store });
      g.ctx.newGame();
      const r = vm.runInContext(`var __h=[],__e=0,__t=0,__q=${seed * 7 + 1},__sc=0,__f=0,__lv3=-1,__st=[],__ps=(typeof speedStep!=='undefined')?speedStep:0;
        function __r(){__q=(__q*1103515245+12345)%2147483648;return __q/2147483648;} function __g(){let u=0,v=0;while(!u)u=__r();while(!v)v=__r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
        var __rev=false; playing=true; paused=false;
        for(let i=0;i<108000;i++){ if(!playing&&!paused)break; if(paused&&__rev&&!playing)break; __h.push(ball.x); if(__h.length>${react})__h.shift(); __t-=1/60; if(__t<=0){__e=__g()*${aim};__t=.5;}
          paddle.x+=Math.max(-${px},Math.min(${px},__h[0]+__e-paddle.x)); setPaddle(paddle.x); update(1/60); __f++; __sc=Math.max(__sc,score);
          if(__lv3<0 && level>=3) __lv3=__f/60;
          if(typeof speedStep!=='undefined' && speedStep!==__ps){ __st.push([__f/60, typeof runClock!=='undefined'?runClock:0]); __ps=speedStep; }
          if(paused&&!__rev&&document.getElementById('reviveWatchBtn')){__rev=true;const b=document.getElementById('reviveWatchBtn'); if(b.onclick)b.onclick();} }
        JSON.stringify({ seed:${seed}, score:__sc, sec:__f/60, level:level, lv3:__lv3, steps:__st })`, g.ctx);
      out.push(JSON.parse(r));
    }
  } finally { Math.random = realRandom; }
  return out;
}

// rows: [{ diff, player, seeds }] -> Promise of [{ diff, player, runs:[...] }], each row split over threads.
export async function runParallel(html, rows, threads = Math.max(1, Math.min(4, (os.availableParallelism ? os.availableParallelism() : os.cpus().length)))) {
  const jobs = [];
  for (const row of rows) {
    const per = Math.ceil(row.seeds / threads);
    for (let from = 1; from <= row.seeds; from += per) jobs.push({ row, from, seeds: Math.min(per, row.seeds - from + 1) });
  }
  const results = new Array(jobs.length); let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++, j = jobs[i];
      results[i] = await new Promise((ok, fail) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { html, diff: j.row.diff, player: j.row.player, seeds: j.seeds, from: j.from, runsPlayed: j.row.runsPlayed || '5' } });
        w.once('message', ok); w.once('error', fail); w.once('exit', (c) => { if (c) fail(new Error('sim worker exit ' + c)); });
      });
    }
  };
  await Promise.all(Array.from({ length: threads }, worker));
  return rows.map((row) => ({ diff: row.diff, player: row.player, runs: jobs.map((j, i) => (j.row === row ? results[i] : [])).flat() }));
}

if (!isMainThread && workerData && workerData.html) parentPort.postMessage(playRuns(workerData));
