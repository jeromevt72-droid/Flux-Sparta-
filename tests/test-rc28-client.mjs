// RC2.8 — GAME DEFECTS D-23 (updates interrupting runs) and D-24 (queued
// scores destroyed), plus honest score display. Written FIRST and run against
// RC2.7, where each defect test must FAIL. Boots the REAL game page.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME = [...fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','play','index.html'),'utf8')
  .matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const ORIGIN='https://flux-sparta-3.jeromevt72.workers.dev';
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
const tick=()=>new Promise(r=>setTimeout(r,15));
const run=(g,code)=>vm.runInContext(code,g.ctx);

// ---- D-23: an update may only activate when no run is in progress --------
async function offerUpdate(setup){
  const { store } = makeStore({ fluxProfileComplete:'1', fluxCallsign:'TITAN' });
  const g = boot(GAME, { origin:ORIGIN, path:'/play/', store });
  const posted=[];
  g.win.navigator.serviceWorker.register = () => Promise.resolve({
    waiting:{ postMessage:(m)=>posted.push(m.type) }, installing:null, addEventListener(){} });
  const timers=[]; g.win.setTimeout=(fn,ms)=>{ timers.push({fn,ms}); return timers.length; };
  setup(g);
  g.fire('load'); await tick();
  return { g, posted, timers };
}
console.log('== D-23: waiting updates never interrupt a run ==');
for (const [label, setup] of [
  ['paused run',            g=>{ g.ctx.newGame(); g.ctx.setPaused(true); }],
  ['level transition hold', g=>{ g.ctx.newGame(); run(g,'playing=false; paused=false; levelHold=.85;'); }],
  ['revive screen',         g=>{ g.ctx.newGame(); run(g,'paused=true;'); }],
  ['active play',           g=>{ g.ctx.newGame(); }],
]) {
  try {
    const { posted } = await offerUpdate(setup);
    ck('no update applied during a '+label, !posted.includes('SKIP_WAITING'), posted.join(','));
  } catch(e){ ck(label+' test ran', false, String(e).slice(0,80)); }
}
try {
  const { posted, timers, g } = await offerUpdate(g=>{ g.ctx.newGame(); g.ctx.setPaused(true); });
  run(g,'playing=false; paused=false;'); g.ctx.endGame();
  for (const t of timers.splice(0)) t.fn();
  ck('the update applies once the run has ended', posted.includes('SKIP_WAITING'), posted.join(','));
} catch(e){ ck('post-run update test ran', false, String(e).slice(0,80)); }
try {
  const { posted } = await offerUpdate(()=>{});
  ck('an update applies immediately at the menu (no run)', posted.includes('SKIP_WAITING'), posted.join(','));
} catch(e){ ck('menu update test ran', false, String(e).slice(0,80)); }

// ---- D-24: temporary failures never destroy an unsent personal best -----
function queueGame(responder){
  const { store, mem } = makeStore({ fluxProfileComplete:'1', fluxCallsign:'TITAN', fluxDifficulty:'medium' });
  const calls=[];
  const fetchImpl=(u,o)=>{ const url=String(u);
    if(!url.includes('/api/submit-score')) return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({skus:[]}),headers:{get:()=>null}});
    calls.push(JSON.parse(o.body)); return Promise.resolve(responder(calls.length)); };
  const g = boot(GAME, { origin:ORIGIN, path:'/play/', store, fetchImpl, uuid:()=>'player-q' });
  const timers=[]; g.win.setTimeout=(fn,ms)=>{ timers.push({fn,ms}); return timers.length; };
  return { g, mem, calls, timers };
}
const R=(status,headers={},body={})=>({ ok:status<400, status, headers:{ get:(k)=>headers[k]??headers[k.toLowerCase()]??null }, json:()=>Promise.resolve(body) });
const queueOf=(mem)=>JSON.parse(mem.fluxPendingSubmits||'[]');

console.log('\n== D-24: queued scores survive temporary failures ==');
for (const [label, resp] of [['HTTP 429', ()=>R(429)], ['server error 503', ()=>R(503)], ['network failure', null]]) {
  try {
    const { g, mem } = queueGame(n=> resp ? resp() : Promise.reject(new TypeError('network down')));
    if (!resp) g.win.fetch = (u)=> String(u).includes('/api/submit-score') ? Promise.reject(new TypeError('offline')) : Promise.resolve(R(200));
    g.ctx.recordBestRun(4200, 3); await g.ctx.submitScore();
    for (let i=0;i<12;i++){ await g.ctx.flushSubmitQueue(); }
    const q=queueOf(mem);
    ck(label+' x12: the personal best is still queued', q.some(x=>x.score===4200), JSON.stringify(q).slice(0,90));
  } catch(e){ ck(label+' test ran', false, String(e).slice(0,80)); }
}
try {
  const { g, timers } = queueGame(()=>R(429,{'Retry-After':'30'}));
  g.ctx.recordBestRun(4200, 3); await g.ctx.submitScore();
  const retry = timers.map(t=>t.ms).filter(ms=>typeof ms==='number');
  ck('a retry is SCHEDULED after a temporary failure', retry.length>0, retry.join(','));
  ck('Retry-After is respected (>= 30s)', retry.some(ms=>ms>=30000), retry.join(','));
} catch(e){ ck('retry scheduling test ran', false, String(e).slice(0,80)); }
try {
  const { g, timers } = queueGame(()=>R(429));
  g.ctx.recordBestRun(4200, 3); await g.ctx.submitScore();
  const retry = timers.map(t=>t.ms).filter(ms=>typeof ms==='number');
  ck('without Retry-After, the server cooldown (10s) is still respected', retry.some(ms=>ms>=10000), retry.join(','));
} catch(e){ ck('cooldown test ran', false, String(e).slice(0,80)); }
try {
  let release; const gate=new Promise(r=>release=r);
  const { g, calls } = queueGame(()=>gate.then(()=>R(200,{},{ok:true,rank:2,public:true,tag:'K7Q2MX8'})));
  g.ctx.recordBestRun(4200, 3); g.ctx.enqueueSubmission(g.ctx.buildSubmission());
  const a=g.ctx.flushSubmitQueue(), b=g.ctx.flushSubmitQueue(), c=g.ctx.flushSubmitQueue();
  await tick(); const inFlight=calls.length; release(); await Promise.all([a,b,c]);
  ck('only ONE queue processor runs at a time', inFlight===1, 'in flight: '+inFlight);
} catch(e){ ck('single-processor test ran', false, String(e).slice(0,80)); }
try {
  // A run ends (new score queued) while an earlier upload is still in flight.
  let release; const gate=new Promise(r=>release=r); let n=0;
  const { g, mem, calls, timers } = queueGame(()=>{ n++; return n===1 ? gate.then(()=>R(200,{},{ok:true,public:true,rank:1,tag:'K7Q2MX8'})) : R(200,{},{ok:true,public:true,rank:1,tag:'K7Q2MX8'}); });
  g.ctx.recordBestRun(4200, 3); const first = g.ctx.submitScore();
  await tick();                                            // first upload now in flight
  g.ctx.enqueueSubmission({ id:'player-q:hard:900:1', playerId:'player-q', name:'TITAN', score:900, level:1, difficulty:'hard', at:Date.now(), attempts:0 });
  const second = g.ctx.flushSubmitQueue();                 // arrives mid-run
  release(); await first; await second;
  ck('work arriving mid-run is sent in the same run, not left for a timer',
     calls.some(b=>b.difficulty==='hard') && queueOf(mem).length===0 && timers.length===0,
     'sent: '+calls.map(b=>b.difficulty).join(',')+' | queued: '+queueOf(mem).length+' | timers: '+timers.length);
} catch(e){ ck('mid-run test ran', false, String(e).slice(0,80)); }
try {
  const { g, mem } = queueGame(()=>R(503));
  for (const [sc,lv] of [[1000,1],[2600,2],[1800,2]]) { g.ctx.recordBestRun(sc, lv); await g.ctx.submitScore(); }
  const q=queueOf(mem).filter(x=>x.difficulty==='medium');
  ck('the queue keeps only the BEST unsent record per difficulty', q.length===1 && q[0].score===2600, JSON.stringify(q.map(x=>x.score)));
} catch(e){ ck('best-per-difficulty test ran', false, String(e).slice(0,80)); }

console.log('\n== Honest, automatic score display ==');
try {
  const { g } = queueGame(()=>R(503));
  g.ctx.recordBestRun(4200, 3); await g.ctx.submitScore();
  ck('"PENDING UPLOAD" shown while a best is waiting', /PENDING UPLOAD/.test(g.els.uploadStatus?.textContent||''), g.els.uploadStatus?.textContent);
  g.win.fetch = (u)=>Promise.resolve(R(200,{},{ok:true,rank:5,public:true,tag:'K7Q2MX8'}));
  await g.ctx.flushSubmitQueue();
  ck('the label clears once uploaded', !/PENDING/.test(g.els.uploadStatus?.textContent||''), g.els.uploadStatus?.textContent);
} catch(e){ ck('pending label test ran', false, String(e).slice(0,80)); }
try {
  const { g, mem } = queueGame(()=>R(200,{},{ok:true,rank:4,public:true,tag:'K7Q2MX8'}));
  g.ctx.recordBestRun(4200, 3); await g.ctx.submitScore();
  ck('the player learns their public tag from the server', mem.fluxPublicTag==='K7Q2MX8', mem.fluxPublicTag);
  ck('menu shows the FLUX ID with its tag', /#K7Q2MX8/.test(g.els.profileTag?.textContent||''), g.els.profileTag?.textContent);
} catch(e){ ck('tag display test ran', false, String(e).slice(0,80)); }
try {
  const { g } = queueGame(()=>R(200,{},{ok:true,rank:null,public:false,tag:'K7Q2MX8'}));
  g.ctx.recordBestRun(4200, 3); await g.ctx.submitScore();
  const t=(g.els.uploadStatus?.textContent||'');
  ck('no rank is shown when the player has no public rank', !/#\d|RANK/.test(t), t);
  ck('...and nothing claims it is pending when it is not', !/PENDING/.test(t), t);
} catch(e){ ck('no-rank display test ran', false, String(e).slice(0,80)); }

console.log('\n'+'='.repeat(56));
console.log(F ? '  '+F+' FAILED' : '  ALL RC2.8 CLIENT TESTS PASSED');
console.log('='.repeat(56));
process.exit(F?1:0);
