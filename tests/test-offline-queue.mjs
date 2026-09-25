// Offline submission queue: every case the spec lists.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Paths are resolved relative to THIS file, so the suite runs from wherever the
// ZIP is extracted. No absolute or environment-specific paths.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPARTA = path.join(__dirname, 'FLUX-Sparta', 'public');
const src=fs.readFileSync(path.join(SPARTA,'play','index.html'),'utf8');
const grab=n=>{const i=src.indexOf((n.startsWith('async')?'':'function ')+n.replace('async ','')+'(');
  let d=0,j=src.indexOf('{',i);for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1);}}};
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};

let store={};
globalThis.localStorage=new Proxy(store,{get:(t,k)=>k==='removeItem'?(x=>{delete t[x]}):t[k],set:(t,k,v)=>{t[k]=String(v);return true}});
let difficulty='medium', playerId='p1', callsign='SPARTA', country='PH';
let netMode='ok', calls=0;
Object.defineProperty(globalThis,'navigator',{value:{onLine:true},writable:true,configurable:true});
globalThis.fetch=async()=>{ calls++;
  if(netMode==='offline') throw new Error('offline');
  if(netMode==='500') return {ok:false,status:500};
  if(netMode==='429') return {ok:false,status:429};
  if(netMode==='422') return {ok:false,status:422};
  return {ok:true,status:200}; };
globalThis.bestRun=()=>({score:120000,level:3,difficulty:'medium'});
const SUBMIT_QUEUE_KEY='fluxPendingSubmits', SUBMIT_MAX_ATTEMPTS=8, SUBMIT_QUEUE_MAX=20;
globalThis.SUBMIT_QUEUE_KEY=SUBMIT_QUEUE_KEY; globalThis.SUBMIT_MAX_ATTEMPTS=SUBMIT_MAX_ATTEMPTS; globalThis.SUBMIT_QUEUE_MAX=SUBMIT_QUEUE_MAX;
globalThis.difficulty=difficulty; globalThis.playerId=playerId; globalThis.callsign=callsign; globalThis.country=country;
// RC2.8 queue (D-24): backoff table, cooldown wait and processor state.
Object.assign(globalThis,{SUBMIT_BACKOFF_MS:[5000,15000,45000,120000,300000,600000],SUBMIT_COOLDOWN_WAIT_MS:11000,
  _flushing:null,_retryTimer:null,_flushAgain:false,lastUploadResult:null,document:{getElementById:()=>null}});
for(const f of ['loadQueue','saveQueue','buildSubmission','enqueueSubmission','dequeueSubmission','recordSubmitFailure','clearSubmitFailure','submitScore','updateUploadStatus','scheduleFlush'])
  eval(grab(f).replace('function '+f+'(', 'globalThis.'+f+'=function('));
// grab() finds 'function X(' — for async fns the slice starts at 'function',
// dropping the async keyword. Re-attach it.
eval('globalThis.postSubmission = async ' + grab('postSubmission').replace('function postSubmission(','function('));
eval('globalThis.flushSubmitQueue = async ' + grab('flushSubmitQueue').replace('function flushSubmitQueue(','function('));

console.log('-- offline: run is queued, not discarded --');
netMode='offline'; navigator.onLine=false;
submitScore(); await new Promise(r=>setTimeout(r,5));
let q=loadQueue();
ck('run queued while offline', q.length===1, 'len='+q.length);
ck('queued item is a WHOLE run record', q[0].score===120000 && q[0].level===3 && q[0].difficulty==='medium' && q[0].playerId==='p1');
ck('no network call attempted while offline', calls===0, 'calls='+calls);

console.log('\n-- duplicate protection --');
submitScore(); submitScore(); await new Promise(r=>setTimeout(r,5));
ck('same run not queued twice', loadQueue().length===1, 'len='+loadQueue().length);

console.log('\n-- reconnect: successful retry clears the queue --');
netMode='ok'; navigator.onLine=true;
await flushSubmitQueue();
ck('queue drained on reconnect', loadQueue().length===0);
ck('exactly one submit call', calls===1, 'calls='+calls);
ck('failure record cleared', !store.fluxLastSubmitError);

console.log('\n-- temporary failures keep it queued (5xx / 429) --');
calls=0; netMode='500'; submitScore(); await new Promise(r=>setTimeout(r,5));
ck('500 keeps item queued', loadQueue().length===1);
ck('attempts incremented', loadQueue()[0].attempts===1, 'a='+loadQueue()[0].attempts);
netMode='429'; await flushSubmitQueue();
ck('429 also temporary', loadQueue().length===1 && loadQueue()[0].attempts===2);

console.log('\n-- permanent rejection (422) is dropped, not retried forever --');
netMode='422'; await flushSubmitQueue();
ck('422 removes the item', loadQueue().length===0);
ck('recorded as rejected', JSON.parse(store.fluxLastSubmitError).reason==='rejected');

// D-24 (RC2.8), INVERTED. The intent here was "no infinite retry" -- never
// hammer a failing server. RC2.7 achieved that by DELETING the queued best
// after 8 failures, which was the defect. RC2.8 keeps the best and instead
// SPACES retries out, growing to a 10-minute cap.
console.log('\n-- no hammering: retries are spaced out, the best is kept --');
store.fluxPendingSubmits=JSON.stringify([{id:'x',playerId:'p1',name:'N',score:1,level:1,difficulty:'medium',attempts:20}]);
const _realST=globalThis.setTimeout; const waits=[];
globalThis.setTimeout=(fn,ms)=>{ if(ms>=1000){ waits.push(ms); return 0; } return _realST(fn,ms); };
netMode='500'; await flushSubmitQueue();
globalThis.setTimeout=_realST;
ck('best kept after many temporary failures', loadQueue().length===1, 'len='+loadQueue().length);
ck('recorded as queued, never gave_up', JSON.parse(store.fluxLastSubmitError).reason==='queued');
ck('next retry is spaced, within the 10-minute cap', waits.length===1 && waits[0]>=5000 && waits[0]<=600000, waits.join(','));

console.log('\n-- corrupt queue storage does not crash --');
store.fluxPendingSubmits='{not json';
let threw=false; try{ await flushSubmitQueue(); }catch(e){ threw=true; }
ck('no throw on corrupt queue', !threw);
ck('recovers to empty', loadQueue().length===0);

console.log('\n-- queue is bounded --');
const many=[]; for(let i=0;i<40;i++) many.push({id:'i'+i,score:i,level:1,difficulty:'medium',attempts:0});
saveQueue(many);
ck('capped at 20', loadQueue().length===20, 'len='+loadQueue().length);

console.log('\n-- D-09 interaction: never reassembled from independent bests --');
const item=buildSubmission();
ck('score+level come from bestRun() together', item.score===120000 && item.level===3);
ck('carries difficulty and identity', item.difficulty==='medium' && item.playerId==='p1');
ck('has a stable dedupe id', item.id==='p1:medium:120000:3', item.id);

console.log('\n'+'='.repeat(50));
console.log(F? '  '+F+' FAILED' : '  ALL OFFLINE-QUEUE TESTS PASSED');
console.log('='.repeat(50));
process.exit(F?1:0);
