import fs from 'fs';
const src=fs.readFileSync(new URL('./FLUX-Sparta/public/play/index.html', import.meta.url),'utf8');
// Strip comments FIRST: prose that quotes code must never be mistaken for
// code. (This bit me immediately — a comment documenting the removed override
// was found as if it were a real definition.)
const code=[...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n;\n')
  .replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
// Pull the LAST definition of each fn — i.e. the runtime binding.
function grabLast(n){
  const i=Math.max(code.lastIndexOf('function '+n+'('), code.lastIndexOf(n+' = function'), code.lastIndexOf(n+'=function'));
  let d=0,j=code.indexOf('{',i);
  for(let k=j;k<code.length;k++){ if(code[k]==='{')d++; else if(code[k]==='}'){d--; if(!d) return code.slice(i,k+1);} }
}
const store={};
globalThis.localStorage=new Proxy(store,{get:(t,k)=>k==='removeItem'?(x=>{delete t[x]}):t[k],set:(t,k,v)=>{t[k]=String(v);return true}});
Object.defineProperty(globalThis,'navigator',{value:{onLine:true},writable:true,configurable:true});
let difficulty='medium', playerId='p1', callsign='SPARTA', country='PH', best=0, level=1;
Object.assign(globalThis,{difficulty,playerId,callsign,country,best,level,
  SUBMIT_QUEUE_KEY:'fluxPendingSubmits',SUBMIT_MAX_ATTEMPTS:Infinity,SUBMIT_QUEUE_MAX:20,
  // RC2.8 queue (D-24): backoff table, cooldown wait and processor state.
  SUBMIT_BACKOFF_MS:[5000,15000,45000,120000,300000,600000],SUBMIT_COOLDOWN_WAIT_MS:11000,
  _flushing:null,_retryTimer:null,_flushAgain:false,lastUploadResult:null,document:{getElementById:()=>null}});
globalThis.bestRunKey=()=>'fluxBestRun_'+difficulty;
for(const f of ['bestRun','recordBestRun','loadQueue','saveQueue','buildSubmission','enqueueSubmission','dequeueSubmission','recordSubmitFailure','clearSubmitFailure','submitScore','updateUploadStatus','scheduleFlush'])
  eval('globalThis.'+f+' = '+grabLast(f).replace('function '+f+'(','function ('));
eval('globalThis.postSubmission = async '+grabLast('postSubmission').replace('function postSubmission(','function ('));
eval('globalThis.flushSubmitQueue = async '+grabLast('flushSubmitQueue').replace('function flushSubmitQueue(','function ('));
let mode='ok', calls=0, bodies=[];
globalThis.fetch=async(u,o)=>{calls++; bodies.push(JSON.parse(o.body));
  if(mode==='offline') throw new Error('offline');
  if(mode==='500') return {ok:false,status:500};
  if(mode==='429') return {ok:false,status:429};
  if(mode==='422') return {ok:false,status:422};
  return {ok:true,status:200};};

console.log('-- 1..5 run completes offline, queued, app usable --');
recordBestRun(184000,4);
mode='offline'; navigator.onLine=false;
submitScore(); await new Promise(r=>setTimeout(r,5));
ck('run queued, not lost', loadQueue().length===1);
ck('no network attempt while offline', calls===0, 'calls='+calls);
const q=loadQueue()[0];
ck('queued record is whole-run', q.score===184000 && q.level===4 && q.difficulty==='medium' && q.playerId==='p1');
ck('carries FLUX ID and country', q.name==='SPARTA' && q.country==='PH');

console.log('\n-- 6..10 reconnect, flush once, no duplicate --');
mode='ok'; navigator.onLine=true;
await flushSubmitQueue();
ck('queue drained', loadQueue().length===0);
ck('server called exactly once', calls===1, 'calls='+calls);
ck('submitted pair matches the run', bodies[0].score===184000 && bodies[0].level===4);
await flushSubmitQueue();
ck('re-flush sends nothing (no duplicate)', calls===1, 'calls='+calls);

console.log('\n-- relaunch with a pending queue --');
store.fluxPendingSubmits=JSON.stringify([{id:'x',playerId:'p1',name:'S',score:5,level:1,difficulty:'medium',attempts:0}]);
calls=0; await flushSubmitQueue();
ck('pending item submitted after relaunch', calls===1 && loadQueue().length===0);

console.log('\n-- failure matrix --');
mode='500'; recordBestRun(200000,5); submitScore(); await new Promise(r=>setTimeout(r,5));
ck('500 stays queued', loadQueue().length===1);
mode='ok'; await flushSubmitQueue();
ck('500 then success drains', loadQueue().length===0);
mode='429'; recordBestRun(210000,5); submitScore(); await new Promise(r=>setTimeout(r,5));
ck('429 stays queued', loadQueue().length===1);
mode='ok'; await flushSubmitQueue(); ck('429 then success drains', loadQueue().length===0);
mode='422'; recordBestRun(220000,5); submitScore(); await new Promise(r=>setTimeout(r,5));
ck('422 permanently rejected, not retried', loadQueue().length===0);
ck('422 recorded as rejected', JSON.parse(store.fluxLastSubmitError).reason==='rejected');
// D-24 (RC2.8), INVERTED: this check used to assert "retry cap enforced" --
// that a queued personal best is DELETED after 8 temporary failures. That was
// the defect itself, recorded as correct behaviour, which is why no suite ever
// caught it. Temporary failures must never delete an unsent best.
store.fluxPendingSubmits=JSON.stringify([{id:'y',playerId:'p1',name:'S',score:1,level:1,difficulty:'medium',attempts:7}]);
mode='500'; await flushSubmitQueue();
ck('a best is NEVER deleted by temporary failures (D-24)', loadQueue().length===1 && loadQueue()[0].attempts===8 && JSON.parse(store.fluxLastSubmitError).reason==='queued');
saveQueue(Array.from({length:40},(_,i)=>({id:'i'+i,score:i,level:1,difficulty:'medium',attempts:0})));
ck('queue cap 20', loadQueue().length===20);
console.log('\n'+'='.repeat(50));
console.log(F? '  '+F+' FAILED' : '  ALL OFFLINE RUNTIME-PATH TESTS PASSED');
console.log('='.repeat(50));
process.exit(F?1:0);
