// RC2.8.2 -- D-35 PILOT RESTORE CODE.
// Runs the REAL worker.js (stand-in Durable Object storage) and the REAL game
// page (harness vm). Written against RC2.8.1 first, where the restore tests
// must FAIL (no endpoint, no restore functions). Ends with negative controls:
// each re-inserts one defect and REQUIRES this suite's checks to catch it.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','play','index.html'),'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','worker.js'),'utf8');
const ORIGIN='https://flux-sparta-3.jeromevt72.workers.dev';
const scriptsOf = (html)=>[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);

/* ---------------- fake Durable Object runtime (as in test-rc28-worker) ---------------- */
function makeRuntime(LeaderboardDO){
  class FakeStorage { constructor(){ this.map=new Map(); }
    async get(k){ return this.map.has(k)?structuredClone(this.map.get(k)):undefined; }
    async put(a,v){ if(typeof a==='object'){ for(const [k,val] of Object.entries(a)) this.map.set(k,structuredClone(val)); } else this.map.set(a,structuredClone(v)); } }
  class FakeState { constructor(){ this.storage=new FakeStorage(); } async blockConcurrencyWhile(fn){ return fn(); } }
  const instances=new Map(); let chain=Promise.resolve();
  return { idFromName:(n)=>n, _instances:instances,
    get(id){ if(!instances.has(id)) instances.set(id,new LeaderboardDO(new FakeState())); const obj=instances.get(id);
      return { fetch(url,init){ const run=()=>obj.fetch(new Request(url,init)); const r=chain.then(run,run); chain=r.then(()=>{},()=>{}); return r; } }; } };
}
function makeEnv(LeaderboardDO){
  return { LEADERBOARD_DO: makeRuntime(LeaderboardDO), ADMIN_TOKEN:'correct-horse-battery', STORE_OPEN:'false',
    STRIPE_SECRET_KEY:'sk_test_fake', STRIPE_WEBHOOK_SECRET:'whsec_fake', SITE_URL:ORIGIN,
    STRIPE_PRICE_TOXIC:'p1', STRIPE_PRICE_COSMIC:'p2', STRIPE_PRICE_SOLAR:'p3' };
}
const realNow=Date.now; let skew=0; Date.now=()=>realNow()+skew;
async function call(worker, env, p, { method='GET', body, headers={} }={}){
  const init={ method, headers:{ 'Content-Type':'application/json', ...headers } };
  if(body!==undefined) init.body = typeof body==='string' ? body : JSON.stringify(body);
  const res = await worker.fetch(new Request(ORIGIN+p, init), env);
  let data=null; const text=await res.text(); try{ data=JSON.parse(text); }catch(e){}
  return { status:res.status, data, text, headers:res.headers };
}
async function submit(worker, env, playerId, name, score, level, difficulty, country='US'){
  skew += 20000;                                   // step past the 10 s cooldown
  return call(worker, env, '/api/submit-score', { method:'POST', body:{ playerId, name, score, level, difficulty, country } });
}
async function pidHash(id){
  const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode('flux-pid:'+id));
  return [...new Uint8Array(buf)].slice(0,8).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function snapshot(env){
  const out={}; for(const [k,obj] of env.LEADERBOARD_DO._instances) out[k]=JSON.stringify([...obj.state.storage.map.entries()]); return JSON.stringify(out);
}
/* game fetch routed into the real worker */
function fetchVia(worker, env){
  return (u,o={})=>worker.fetch(new Request(new URL(String(u), ORIGIN).href, { method:o.method||'GET', headers:o.headers||{}, body:o.body }), env);
}
const tick=()=>new Promise(r=>setTimeout(r,20));
const run=(g,code)=>vm.runInContext(code,g.ctx);

/* ============================== THE SUITE ============================== */
async function suite({ gameHtml, workerMod, quiet=false }){
  let F=0; const failed=[];
  const ck=(l,c,x='')=>{ if(!quiet) console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':'')); if(!c){ F++; failed.push(l); } };
  const GAME=scriptsOf(gameHtml);
  const worker=workerMod.default, LeaderboardDO=workerMod.LeaderboardDO;
  const bootGame=(init={}, opts={})=>{ const { store, mem } = makeStore(init);
    const g=boot(GAME,{ origin:ORIGIN, path:'/play/', store, uuid:opts.uuid||(()=>'fresh-'+Math.random().toString(16).slice(2)), fetchImpl:opts.fetchImpl });
    return { g, mem, store }; };

  /* ---------------- server ---------------- */
  if(!quiet) console.log('== server: /api/restore-check ==');
  try {
    const env=makeEnv(LeaderboardDO);
    let r=await call(worker,env,'/api/restore-check',{ method:'POST', body:{ playerId:'never-seen-1234' } });
    ck('S1 unknown pilot -> found:false', r.status===200 && r.data && r.data.found===false, r.text.slice(0,80));
    ck('S1 response is never cached', (r.headers.get('cache-control')||'').includes('no-store'));
    for (const bad of ['', 'a'.repeat(65), '__proto__', 'constructor', 'prototype', 'has space', 'semi;colon', 'x/y']) {
      r=await call(worker,env,'/api/restore-check',{ method:'POST', body:{ playerId:bad } });
      ck('S2 invalid id rejected: '+JSON.stringify(bad).slice(0,20), r.status===400);
    }
    for (const body of ['not json', '[]', 'null', '{"playerId":42}', '{}']) {
      r=await call(worker,env,'/api/restore-check',{ method:'POST', body });
      ck('S2 malformed body -> 400, no crash: '+body, r.status===400);
    }
    for (const proto of ['toString','valueOf','hasOwnProperty','isPrototypeOf','propertyIsEnumerable','toLocaleString','__defineGetter__','__lookupGetter__']) {
      r=await call(worker,env,'/api/restore-check',{ method:'POST', body:{ playerId:proto } });
      ck('S2 prototype name is just an unknown pilot: '+proto, r.status===200 && r.data && r.data.found===false, r.text.slice(0,60));
    }
    r=await call(worker,env,'/api/restore-check?playerId=never-seen-1234');
    ck('S2 GET is not accepted (secret stays out of URLs)', r.status===404);

    const A='a1b2c3d4-0000-4000-8000-00000000000a';
    await submit(worker,env,A,'Titan',4315,2,'hard','US');
    await submit(worker,env,A,'Titan',900,1,'easy','US');
    const before=snapshot(env);
    r=await call(worker,env,'/api/restore-check',{ method:'POST', body:{ playerId:A } });
    const lb=await call(worker,env,'/api/leaderboard?limit=25');
    const row=lb.data.top.find(x=>x.name==='TITAN');
    ck('S3 known pilot -> found:true', r.data && r.data.found===true, r.text.slice(0,120));
    ck('S3 name, country returned', r.data.name==='TITAN' && r.data.country==='US');
    ck('S3 tag identical to the leaderboard tag', row && r.data.tag===row.tag, (row&&row.tag)+' vs '+r.data.tag);
    ck('S3 bests per difficulty', r.data.bests.hard.score===4315 && r.data.bests.hard.level===2 && r.data.bests.easy.score===900 && !r.data.bests.medium);
    ck('S3 response never echoes a playerId', !r.text.includes(A) && !('playerId' in r.data));
    ck('S3 restore-check writes nothing', snapshot(env)===before);

    const B='b1b2c3d4-0000-4000-8000-00000000000b';
    const stub=env.LEADERBOARD_DO.get('global');
    await stub.fetch('https://do.internal/grant',{ method:'POST', body:JSON.stringify({ playerId:B, sku:'toxic', sessionId:'cs_1' }) });
    r=await call(worker,env,'/api/restore-check',{ method:'POST', body:{ playerId:B } });
    ck('S4 pilot with a skin but no score -> found, skus', r.data.found===true && JSON.stringify(r.data.skus)==='["toxic"]' && r.data.name==='');

    const pidA=await pidHash(A);
    await call(worker,env,'/api/admin/restrict',{ method:'POST', headers:{'x-admin-token':'correct-horse-battery'}, body:{ pid:pidA, reason:'test' } });
    r=await call(worker,env,'/api/restore-check',{ method:'POST', body:{ playerId:A } });
    ck('S6 restricted pilot still restorable (restriction follows the pilot)', r.data.found===true);
    const lb2=await call(worker,env,'/api/leaderboard?limit=25');
    ck('S6 ...and stays off the public board', !lb2.data.top.some(x=>x.pid===pidA));

    await call(worker,env,'/api/admin/privacy-delete',{ method:'POST', headers:{'x-admin-token':'correct-horse-battery'}, body:{ pid:pidA } });
    r=await call(worker,env,'/api/restore-check',{ method:'POST', body:{ playerId:A } });
    ck('S7 privacy-deleted pilot is no longer restorable', r.data && r.data.found===false, r.text.slice(0,80));
  } catch(e){ ck('server section ran', false, String(e.stack||e).slice(0,160)); }

  /* ---------------- codes ---------------- */
  if(!quiet) console.log('== codes: FX1-<id>-<check> ==');
  try {
    const { g } = bootGame({ fluxPlayerId:'c0ffee00-1111-4222-8333-444455556666', fluxProfileComplete:'1', fluxCallsign:'TITAN' });
    const id='c0ffee00-1111-4222-8333-444455556666';
    const code=await g.ctx.makeRestoreCode(id);
    ck('C1 code format', /^FX1-c0ffee00-1111-4222-8333-444455556666-[0-9A-F]{4}$/.test(code), code);
    const p=async s=>await g.ctx.parseRestoreCode(s);
    ck('C1 round trip', (await p(code)).playerId===id);
    ck('C1 surrounding spaces/newlines', (await p('  \n'+code+'\n ')).playerId===id);
    ck('C1 quotes from a message', (await p('\u201C'+code+'\u201D')).playerId===id);
    ck('C1 zero-width characters', (await p(code.slice(0,10)+'\u200B'+code.slice(10))).playerId===id);
    ck('C1 typographic dashes', (await p(code.replace(/-/g,'\u2013'))).playerId===id);
    ck('C1 line break in the middle', (await p(code.slice(0,20)+'\n'+code.slice(20))).playerId===id);
    ck('C1 retyped in capitals -> original lower-case id', (await p(code.toUpperCase())).playerId===id);
    ck('C1 lower-case prefix/check accepted', (await p(code.toLowerCase())).playerId===id);
    ck('C1 legacy p-style id round trip', (await p(await g.ctx.makeRestoreCode('pmf3k2x9a1b2c3d4'))).playerId==='pmf3k2x9a1b2c3d4');
    ck('C1 truncated code refused', !(await p(code.slice(0,-3))).ok && !(await p(code.slice(0,30))).ok);
    ck('C1 empty / junk refused', !(await p('')).ok && !(await p('hello')).ok && !(await p(null)).ok && !(await p('FX1--ABCD')).ok);
    // every single-character substitution in the id part: none may be accepted as a DIFFERENT pilot
    const alphabet='0123456789abcdef-xyzABC'; let accepted=0, tried=0;
    const idStart=4, idEnd=4+id.length;
    for(let i=idStart;i<idEnd;i++) for(const ch of alphabet){ if(ch===code[i]) continue;
      const mut=code.slice(0,i)+ch+code.slice(i+1); tried++;
      const r=await p(mut); if(r.ok && r.playerId!==id && r.playerId.toLowerCase()!==id) accepted++; }
    ck('C1 single-character typos never restore another pilot ('+tried+' tried)', accepted===0, 'accepted '+accepted);
    const reserved=await g.ctx.restoreChecksum('__proto__');
    ck('C2 reserved id refused even with a valid checksum', !(await p('FX1-__proto__-'+reserved)).ok);
    ck('C2 makeRestoreCode refuses invalid ids', (await g.ctx.makeRestoreCode('bad id'))===null && (await g.ctx.makeRestoreCode('constructor'))===null);
  } catch(e){ ck('code section ran', false, String(e.stack||e).slice(0,160)); }

  /* ---------------- plan ---------------- */
  if(!quiet) console.log('== plan: every key a restore changes ==');
  try {
    const OLD='old-pilot-0001';
    const { g, mem } = bootGame({ fluxPlayerId:OLD, fluxProfileComplete:'1', fluxCallsign:'FLUX', fluxCountry:'PH', fluxPublicTag:'3CA7WGN',
      fluxSkin:'cosmic', fluxBackground:'solar', fluxBest_easy:'99999', fluxBestLevel_easy:'3', fluxBestRun_easy:JSON.stringify({score:99999,level:3,difficulty:'easy',playerId:OLD,at:1}),
      fluxBest_medium:'5000', fluxEntitlementsV1:JSON.stringify({v:1,source:'server',playerId:OLD,skus:['cosmic'],verifiedAt:1}), fluxOwned_cosmic:'1',
      fluxDifficulty:'hard', fluxGatewayCountry:'PH', fluxPendingSubmits:JSON.stringify([{id:'q1',playerId:OLD,score:1,level:1}]) });
    const NEW='new-pilot-0002';
    const plan=g.ctx.buildRestorePlan({ name:'titan', tag:'VNXB79C', country:'US', bests:{ easy:{score:500,level:1}, hard:{score:4878,level:2} }, skus:['solar'] }, NEW);
    ck('C3 player id', plan.fluxPlayerId===NEW);
    ck('C3 name upper-cased, profile complete', plan.fluxCallsign==='TITAN' && plan.fluxProfileComplete==='1');
    ck('C3 country and tag', plan.fluxCountry==='US' && plan.fluxPublicTag==='VNXB79C');
    ck('C3 bests replaced by the restored pilot\'s (lower easy best wins)', plan.fluxBest_easy==='500' && JSON.parse(plan.fluxBestRun_easy).playerId===NEW && JSON.parse(plan.fluxBestRun_easy).score===500);
    ck('C3 difficulty with no server best is cleared', plan.fluxBest_medium===null && plan.fluxBestRun_medium===null && plan.fluxBestLevel_medium===null);
    ck('C3 hard best written', plan.fluxBest_hard==='4878' && plan.fluxBestLevel_hard==='2');
    ck('C3 verified skin cache and legacy keys dropped', plan.fluxEntitlementsV1===null && plan.fluxOwned_cosmic===null);
    ck('C3 unowned paid skin reset, owned paid background kept', plan.fluxSkin==='aurora' && !('fluxBackground' in plan));
    ck('C3 settings, gateway flag and unsent runs untouched', !('fluxDifficulty' in plan) && !('fluxGatewayCountry' in plan) && !('fluxPendingSubmits' in plan));
    const p2=g.ctx.buildRestorePlan({ name:'', tag:'<img>', country:'ZZ', bests:{ easy:{score:NaN,level:1}, medium:{score:-5}, hard:'x' }, skus:'toxic' }, NEW);
    ck('C3 no server name -> player is asked for one', p2.fluxCallsign===null && p2.fluxProfileComplete===null);
    ck('C3 hostile tag/country/bests ignored', p2.fluxPublicTag===null && !('fluxCountry' in p2) && p2.fluxBest_easy===null && p2.fluxBest_medium===null && p2.fluxBest_hard===null);
    ck('C3 plan has no prototype keys', Object.getPrototypeOf(plan)===null || !('__proto__' in Object.keys(plan)));
  } catch(e){ ck('plan section ran', false, String(e.stack||e).slice(0,160)); }

  /* ---------------- apply + journal ---------------- */
  if(!quiet) console.log('== apply: all or nothing ==');
  try {
    const init={ fluxPlayerId:'old-1', fluxProfileComplete:'1', fluxCallsign:'OLDIE', fluxBest_easy:'7777', fluxPublicTag:'AAAAAAA' };
    let WRITES=0;
    {
      const { g, mem } = bootGame(init);
      const plan=g.ctx.buildRestorePlan({ name:'TITAN', tag:'VNXB79C', country:'US', bests:{ easy:{score:10,level:1} }, skus:[] }, 'new-1');
      let n=0; const { store:cs, mem:cm } = makeStore(init);
      const counting=new Proxy(cs,{ get:(t,k)=> k==='setItem' ? (a,b)=>{ n++; return t.setItem(a,b); } : t[k], set:(t,k,v)=>{ t[k]=v; return true; }, has:(t,k)=> k in t });
      const gc=boot(GAME,{ origin:ORIGIN, path:'/play/', store:counting }); n=0;
      gc.ctx.applyRestorePlan(gc.ctx.buildRestorePlan({ name:'TITAN', tag:'VNXB79C', country:'US', bests:{ easy:{score:10,level:1} }, skus:[] }, 'new-1'));
      WRITES=n;
      const ok=g.ctx.applyRestorePlan(plan);
      ck('C4 apply succeeds ('+WRITES+' writes; every one is failure-tested below)', ok===true && WRITES>=5);
      ck('C4 device holds exactly the new pilot', mem.fluxPlayerId==='new-1' && mem.fluxCallsign==='TITAN' && mem.fluxBest_easy==='10' && mem.fluxPublicTag==='VNXB79C');
      ck('C4 journal removed', !('fluxRestoreJournal' in mem));
    }
    for (let failAt=1; failAt<=WRITES; failAt++) {
      const { store:base, mem } = makeStore(init);
      const ctl={ n:0, failAt:0 };
      const store=new Proxy(base,{ get:(t,k)=> k==='setItem' ? (a,b)=>{ ctl.n++; if(ctl.n===ctl.failAt) throw new Error('QuotaExceededError'); return t.setItem(a,b); } : t[k],
        set:(t,k,v)=>{ t[k]=v; return true; }, deleteProperty:(t,k)=>{ delete t[k]; return true; }, has:(t,k)=> k in t });
      const g=boot(GAME,{ origin:ORIGIN, path:'/play/', store });
      const beforeState=JSON.stringify(Object.entries(mem).sort());
      const plan=g.ctx.buildRestorePlan({ name:'TITAN', tag:'VNXB79C', country:'US', bests:{ easy:{score:10,level:1} }, skus:[] }, 'new-1');
      ctl.n=0; ctl.failAt=failAt;
      const ok=g.ctx.applyRestorePlan(plan);
      const n=ctl.n; ctl.failAt=0;
      ck('C5 storage failure on write #'+failAt+' -> refused, device unchanged', ok===false && JSON.stringify(Object.entries(mem).sort())===beforeState, n+' writes');
    }
  } catch(e){ ck('apply section ran', false, String(e.stack||e).slice(0,160)); }

  if(!quiet) console.log('== crash mid-restore: next launch finishes it ==');
  try {
    // Build a journal exactly as applyRestorePlan writes it, apply only HALF, then relaunch.
    const init={ fluxPlayerId:'old-2', fluxProfileComplete:'1', fluxCallsign:'OLDIE', fluxBest_easy:'99999', fluxBestRun_easy:JSON.stringify({score:99999,level:3,difficulty:'easy',playerId:'old-2',at:1}) };
    const { g } = bootGame(init);
    const plan=g.ctx.buildRestorePlan({ name:'TITAN', tag:'VNXB79C', country:'US', bests:{ easy:{score:10,level:1} }, skus:[] }, 'new-2');
    const before={}; for(const k of Object.keys(plan)) before[k]= k in init ? init[k] : null;
    const crashed={ ...init, fluxRestoreJournal:JSON.stringify({ v:1, after:plan, before }) };
    const keys=Object.keys(plan); for(const k of keys.slice(0, Math.floor(keys.length/2))){ if(plan[k]===null) delete crashed[k]; else crashed[k]=plan[k]; }
    // second variant: the crash happened before fluxPlayerId itself was written
    const crashed2={ ...init, fluxRestoreJournal:JSON.stringify({ v:1, after:plan, before }) };
    for(const k of keys.slice(Math.floor(keys.length/2))){ if(plan[k]===null) delete crashed2[k]; else crashed2[k]=plan[k]; }
    const { g:g5, mem:m5 } = bootGame(crashed2);
    const sub5=run(g5,"difficulty='easy'; buildSubmission()");
    ck('C7 crash before the id was written: relaunch completes it', run(g5,'playerId')==='new-2' && m5.fluxCallsign==='TITAN' && sub5 && sub5.playerId==='new-2' && sub5.score===10, run(g5,'playerId')+' '+(sub5&&sub5.score));
    const { g:g2, mem:m2 } = bootGame(crashed);
    ck('C7 relaunch completes the restore', run(g2,'playerId')==='new-2' && m2.fluxCallsign==='TITAN' && m2.fluxBest_easy==='10');
    ck('C7 journal cleared after replay', !('fluxRestoreJournal' in m2));
    const sub=run(g2,"difficulty='easy'; buildSubmission()");
    ck('C7 no old best uploaded under the restored pilot', sub && sub.playerId==='new-2' && sub.score===10, sub && (sub.playerId+' '+sub.score));
    const { g:g3, mem:m3 } = bootGame({ ...init, fluxRestoreJournal:'{not json' });
    ck('C7 corrupt journal -> old pilot intact, journal removed', run(g3,'playerId')==='old-2' && m3.fluxBest_easy==='99999' && !('fluxRestoreJournal' in m3));
    const { g:g4 } = bootGame({ ...init, fluxRestoreJournal:JSON.stringify({ v:2, after:{ fluxPlayerId:'x' } }) });
    ck('C7 unknown journal version ignored', run(g4,'playerId')==='old-2');
  } catch(e){ ck('crash section ran', false, String(e.stack||e).slice(0,160)); }

  if(!quiet) console.log('== refusals ==');
  try {
    const { g, mem } = bootGame({ fluxPlayerId:'old-3', fluxProfileComplete:'1', fluxCallsign:'OLDIE' });
    ck('C9 at the menu -> allowed', g.ctx.restoreBlockedReason()===null);
    run(g,'playing=true'); ck('C9 during a run -> refused', !!g.ctx.restoreBlockedReason()); run(g,'playing=false');
    run(g,'purchaseInFlight=true'); ck('C9 purchase in flight -> refused', !!g.ctx.restoreBlockedReason()); run(g,'purchaseInFlight=false');
    mem.fluxPendingCheckout=JSON.stringify({ sessionId:'cs_x', sku:'toxic', playerId:'old-3', at:realNow() });
    ck('C9 unfinished checkout for this pilot -> refused', !!g.ctx.restoreBlockedReason());
    mem.fluxPendingCheckout=JSON.stringify({ sessionId:'cs_y', sku:'toxic', playerId:'someone-else', at:realNow() });
    ck('C9 another pilot\'s stale checkout does not block', g.ctx.restoreBlockedReason()===null);
  } catch(e){ ck('refusal section ran', false, String(e.stack||e).slice(0,160)); }

  /* ---------------- end to end: iPhone Safari pilot -> old Home Screen icon ---------------- */
  if(!quiet) console.log('== end to end with the real worker ==');
  try {
    const env=makeEnv(LeaderboardDO); const f=fetchVia(worker,env);
    const SAFARI='5afa0000-aaaa-4bbb-8ccc-dddddddddddd';
    await submit(worker,env,SAFARI,'TITAN',4878,2,'hard','US');
    await env.LEADERBOARD_DO.get('global').fetch('https://do.internal/grant',{ method:'POST', body:JSON.stringify({ playerId:SAFARI, sku:'solar', sessionId:'cs_e2e' }) });
    // the old icon: empty storage, asks for a FLUX ID, has minted its own id
    const { g:icon, mem:im } = bootGame({ fluxEntitlementsV1:JSON.stringify({v:1,source:'server',playerId:'icon-own',skus:['cosmic'],verifiedAt:1}) }, { uuid:()=>'icon-own', fetchImpl:f });
    // RC2.8.5 (D-43): an empty icon now starts as a new auto-named pilot (PILOT-XXXX)
    ck('E0 old icon starts as a new pilot (the reported bug)', /^PILOT-[A-Z2-9]{4}$/.test(run(icon,'callsign')) && run(icon,'playerId')==='icon-own');
    const { g:safari } = bootGame({ fluxPlayerId:SAFARI, fluxProfileComplete:'1', fluxCallsign:'TITAN' }, { fetchImpl:f });
    const code=await safari.ctx.makeRestoreCode(SAFARI);
    const parsed=await icon.ctx.parseRestoreCode('\n'+code+' ');
    const chk=await icon.ctx.checkRestoreOnServer(parsed.playerId);
    ck('E1 icon finds the Safari pilot on the server', chk.kind==='found' && chk.info.name==='TITAN');
    ck('E1 apply', icon.ctx.applyRestorePlan(icon.ctx.buildRestorePlan(chk.info, parsed.playerId))===true);
    const { g:after, mem:am } = bootGame({ ...im }, { fetchImpl:f });      // location.reload()
    ck('E2 relaunched icon IS the Safari pilot', run(after,'playerId')===SAFARI && run(after,'callsign')==='TITAN' && run(after,'profileComplete')===true);
    ck('E2 ...and is no longer marked as an auto name', am.fluxAutoName===undefined);
    const lb=await call(worker,env,'/api/leaderboard?limit=25');
    const mine=await after.ctx.myPidHash();
    ck('E2 leaderboard highlights the restored pilot', lb.data.top.some(x=>x.pid===mine && x.name==='TITAN'));
    ck('E2 tag shown matches the board', am.fluxPublicTag===lb.data.top.find(x=>x.pid===mine).tag);
    ck('E3 old verified-skin cache for icon-own not carried over (offline)', !after.ctx.ownsSkin('cosmic'));
    await after.ctx.syncEntitlements();
    ck('E3 restored pilot\'s skin comes back from the server', after.ctx.ownsSkin('solar')===true && !after.ctx.ownsSkin('cosmic'));
    const sub=run(after,"difficulty='hard'; buildSubmission()");
    ck('E4 next upload is the restored pilot\'s own best', sub.playerId===SAFARI && sub.score===4878);
    const again=await after.ctx.parseRestoreCode(code);
    ck('E5 same code again -> recognised as this pilot', again.playerId===run(after,'playerId'));
    const unknown=await after.ctx.checkRestoreOnServer('zzzz-not-a-pilot');
    ck('E6 unknown code -> notfound, nothing changed', unknown.kind==='notfound' && am.fluxPlayerId===SAFARI);
    const down=bootGame({ fluxPlayerId:'x1' }, { fetchImpl:()=>Promise.reject(new Error('offline')) });
    ck('E7 network failure reported, not treated as unknown', (await down.g.ctx.checkRestoreOnServer(SAFARI)).kind==='network');
    const err=bootGame({ fluxPlayerId:'x2' }, { fetchImpl:()=>Promise.resolve(new Response('oops',{status:500})) });
    ck('E7 server error reported, not treated as unknown', (await err.g.ctx.checkRestoreOnServer(SAFARI)).kind==='error');
    const html=bootGame({ fluxPlayerId:'x3' }, { fetchImpl:()=>Promise.resolve(new Response('<html>',{status:200})) });
    ck('E7 non-JSON reply (captive portal) reported as error', (await html.g.ctx.checkRestoreOnServer(SAFARI)).kind==='error');
  } catch(e){ ck('end-to-end section ran', false, String(e.stack||e).slice(0,200)); }

  /* ---------------- page wiring ---------------- */
  if(!quiet) console.log('== page wiring ==');
  try {
    const { g } = bootGame({ fluxPlayerId:'w1' });
    // RC2.8.3 (D-36): the menu button was removed on purpose; the code now lives
    // behind EDIT through the same link. test-d36-d37.mjs covers that change.
    ck('W1 name-screen link wired', typeof g.els.restoreLink.onclick==='function');
    ck('W2 link sits directly after the name editor (CSS hides it with the editor)', /<\/select><\/div><button type="button" class="linkBtn restoreLink" id="restoreLink">/.test(gameHtml) && gameHtml.includes('#profileEditor.hidden+.restoreLink{display:none}'));
    const jPos=gameHtml.indexOf("localStorage.getItem('fluxRestoreJournal')"), idPos=gameHtml.indexOf('const playerId=localStorage.fluxPlayerId');
    ck('W3 journal replay runs before the game reads its identity', jPos>0 && idPos>0 && jPos<idPos);
    ck('W4 store still closed', gameHtml.includes('const STORE_OPEN = false;'));
    ck('W5 no load errors', g.errors.length===0, g.errors.join('|'));
  } catch(e){ ck('wiring section ran', false, String(e.stack||e).slice(0,160)); }

  return { F, failed };
}

/* ============================== RUN ============================== */
const real = await import(pathToFileURL(path.join(__dirname,'FLUX-Sparta','worker.js')).href);
const main = await suite({ gameHtml:GAME_HTML, workerMod:real });

console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC=0;
async function control(label, { game=(s)=>s, workerSrc=(s)=>s, expect }){
  const g2=game(GAME_HTML), w2=workerSrc(WORKER_SRC);
  if(g2===GAME_HTML && w2===WORKER_SRC){ console.log('  FAIL  control did not apply: '+label); NC++; return; }
  const tmp=path.join(__dirname,'.nc-worker-'+Math.random().toString(16).slice(2)+'.mjs');
  fs.writeFileSync(tmp,w2);
  try {
    const mod=await import(pathToFileURL(tmp).href);
    const r=await suite({ gameHtml:g2, workerMod:mod, quiet:true });
    const hit=r.failed.filter(f=>f.startsWith(expect));
    const caught=hit.length>0;
    console.log((caught?'  PASS  ':'  FAIL  ')+'caught: '+label+'  ['+(caught?hit[0]:'expected '+expect+'; failed: '+(r.failed.join(' | ')||'none'))+']');
    if(!caught) NC++;
  } finally { try{ fs.unlinkSync(tmp); }catch(e){} }
}
const rep=(a,b)=>(s)=>{ if(!s.includes(a)) return s; return s.replace(a,b); };
await control('server says every code is a pilot', { expect:'S1', workerSrc:rep('if (!rec && !skus.length) return json({ found: false });','') });
await control('server echoes the secret playerId', { expect:'S3 response never echoes', workerSrc:rep('      found: true,\n','      found: true, playerId,\n') });
await control('checksum not enforced', { expect:'C1 single-character typos', game:rep("if(restoreIdOk(id) && (await restoreChecksum(id))===want)","if(restoreIdOk(id))") });
await control('old pilot\'s bests kept after restore', { expect:'C3 difficulty with no server best', game:rep("after['fluxBest_'+d]=null; after['fluxBestLevel_'+d]=null; after['fluxBestRun_'+d]=null;","") });
await control('journal replay removed', { expect:'C7', game:rep("try{ put(j.after); }","try{ }") });
await control('no rollback on storage failure', { expect:'C5', game:rep("try{ put(before); }catch(e2){}","") });
await control('restore allowed during a run', { expect:'C9 during a run', game:rep("if(playing) return 'Finish your run first, then restore from the menu.';","") });
await control('restore allowed during a purchase', { expect:'C9 purchase in flight', game:rep("if(purchaseInFlight || pending)","if(false)") });
await control('network failure treated as unknown pilot', { expect:'E7 network failure', game:rep("}catch(e){ return {kind:'network'}; }","}catch(e){ return {kind:'notfound'}; }") });
await control('verified skin cache kept', { expect:'C3 verified skin cache', game:rep("after[ENT_CACHE_KEY]=null;","") });
await control('capitals not normalised', { expect:'C1 retyped in capitals', game:rep("if(m[1].toLowerCase()!==m[1]) tries.push(m[1].toLowerCase());","") });
await control('journal replay placed after identity is read', { expect:'C7 crash before the id', game:(s)=>{ const a=s.indexOf('/* D-35 (RC2.8.2) RESTORE JOURNAL REPLAY'); const b=s.indexOf("})();\n",a)+6; if(a<0) return s; const block=s.slice(a,b); const t=s.slice(0,a)+s.slice(b); return t.replace('const playerId=localStorage.fluxPlayerId;','const playerId=localStorage.fluxPlayerId;\n'+block); } });

const total=main.F+NC;
console.log('\n'+(total? ('D-35 FAILED: '+main.F+' check(s), '+NC+' uncaught control(s)') : 'D-35 PASSED: all checks and all negative controls'));
process.exit(total?1:0);
