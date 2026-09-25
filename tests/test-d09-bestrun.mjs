// Extract bestRun/recordBestRun from the built file and run the spec's 8 cases.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Paths are resolved relative to THIS file, so the suite runs from wherever the
// ZIP is extracted. No absolute or environment-specific paths.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPARTA = path.join(__dirname, 'FLUX-Sparta', 'public');
let bestRun, recordBestRun;
const src = fs.readFileSync(path.join(SPARTA,'play','index.html'),'utf8');
const grab = n => { const i=src.indexOf('function '+n+'('); let d=0,j=src.indexOf('{',i);
  for(let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} } };
let store={};
global.localStorage=new Proxy(store,{get:(t,k)=>k==='removeItem'?(x=>{delete t[x]}):t[k],set:(t,k,v)=>{t[k]=String(v);return true}});
let difficulty='medium', playerId='p-abc';
globalThis.bestRunKey=function(){return 'fluxBestRun_'+difficulty};
eval(grab('bestRun').replace('function bestRun()','bestRun=function()'));
eval(grab('recordBestRun').replace('function recordBestRun(','recordBestRun=function('));
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':'')); if(!c)F++;};

console.log('-- 1. old-storage migration (legacy score, mismatched level) --');
store={}; global.localStorage=new Proxy(store,{get:(t,k)=>k==='removeItem'?(x=>{delete t[x]}):t[k],set:(t,k,v)=>{t[k]=String(v);return true}});
store['fluxBest_medium']='250000'; store['fluxBestLevel_medium']='2';
let r=bestRun();
ck('legacy score preserved', r.score===250000, 'score='+r.score);
ck('level raised so server accepts it', r.score <= r.level*50000+5000, 'level='+r.level);
ck('flagged as migrated', r.migrated===true);
ck('migration persisted', !!store['fluxBestRun_medium']);

console.log('\n-- 2. valid pair on a new best --');
r=recordBestRun(300000,7);
ck('new best stored', r.score===300000 && r.level===7);
ck('pair is self-consistent', r.score <= r.level*50000+5000);
ck('legacy keys kept in sync (rollback safe)', store['fluxBest_medium']==='300000');

console.log('\n-- 3. lower subsequent score --');
const before=JSON.stringify(bestRun());
r=recordBestRun(1000,1);
ck('best unchanged', r.score===300000, 'score='+r.score);
ck('record untouched', JSON.stringify(bestRun())===before);

console.log('\n-- 4. higher subsequent score --');
r=recordBestRun(400000,9);
ck('best replaced atomically', r.score===400000 && r.level===9);

console.log('\n-- 5. the ORIGINAL D-09 bug: could old code pair mismatched values? --');
const oldPair={score:+store['fluxBest_medium'], level:+store['fluxBestLevel_medium']};
console.log('     legacy keys now:', JSON.stringify(oldPair));
const nw=bestRun();
ck('new path always self-consistent', nw.score <= nw.level*50000+5000, 'score='+nw.score+' level='+nw.level);

console.log('\n-- 6. corrupted record falls back, does not throw --');
store['fluxBestRun_medium']='{not json';
let threw=false; try{ r=bestRun(); }catch(e){ threw=true; }
ck('no throw on corrupt JSON', !threw);
ck('recovered from legacy keys', r.score===400000, 'score='+r.score);

console.log('\n-- 7. fresh install, nothing stored --');
store={}; global.localStorage=new Proxy(store,{get:(t,k)=>k==='removeItem'?(x=>{delete t[x]}):t[k],set:(t,k,v)=>{t[k]=String(v);return true}});
r=bestRun();
ck('score 0', r.score===0);
ck('level >= 1', r.level>=1, 'level='+r.level);
ck('nothing written for an empty best', !store['fluxBestRun_medium']);

console.log('\n-- 8. difficulty isolation --');
recordBestRun(100000,3);
difficulty='hard';
r=bestRun();
ck('hard starts clean', r.score===0, 'score='+r.score);
difficulty='medium';
ck('medium retained', bestRun().score===100000);

console.log('\n'+'='.repeat(46));
console.log(F? '  '+F+' FAILED' : '  ALL D-09 BEHAVIOURAL TESTS PASSED');
console.log('='.repeat(46));
process.exit(F?1:0);
