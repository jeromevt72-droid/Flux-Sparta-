// RC2.8.3 -- D-36 (restore code moved into EDIT; game-over Mode label) and
// D-37 (admin ISSUE RESTORE CODE with safeguards). Real worker.js, real game
// page, real admin page script. Written against RC2.8.2 first: must FAIL there.
// Ends with negative controls that re-insert each defect and require a catch.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','play','index.html'),'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','admin.html'),'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','worker.js'),'utf8');
const ORIGIN='https://flux-sparta-3.jeromevt72.workers.dev';
const TOKEN='correct-horse-battery';
const scriptsOf=(html)=>[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const realNow=Date.now; let skew=0; Date.now=()=>realNow()+skew;

function makeRuntime(LeaderboardDO, failPutKey){
  class FakeStorage { constructor(){ this.map=new Map(); this.failKey=null; }
    async get(k){ return this.map.has(k)?structuredClone(this.map.get(k)):undefined; }
    async put(a,v){ const o=typeof a==='object'?a:{[a]:v}; if(this.failKey && this.failKey in o) throw new Error('storage down');
      for(const [k,val] of Object.entries(o)) this.map.set(k,structuredClone(val)); } }
  class FakeState { constructor(){ this.storage=new FakeStorage(); } async blockConcurrencyWhile(fn){ return fn(); } }
  const instances=new Map(); let chain=Promise.resolve();
  return { idFromName:(n)=>n, _instances:instances,
    get(id){ if(!instances.has(id)) instances.set(id,new LeaderboardDO(new FakeState())); const obj=instances.get(id);
      return { _obj:obj, fetch(url,init){ const run=()=>obj.fetch(new Request(url,init)); const r=chain.then(run,run); chain=r.then(()=>{},()=>{}); return r; } }; } };
}
const makeEnv=(DO)=>({ LEADERBOARD_DO:makeRuntime(DO), ADMIN_TOKEN:TOKEN, STORE_OPEN:'false', SITE_URL:ORIGIN,
  STRIPE_SECRET_KEY:'sk_test_fake', STRIPE_WEBHOOK_SECRET:'whsec_fake', STRIPE_PRICE_TOXIC:'p1', STRIPE_PRICE_COSMIC:'p2', STRIPE_PRICE_SOLAR:'p3' });
async function call(worker, env, p, { method='POST', body, token }={}){
  const headers={ 'Content-Type':'application/json' }; if(token!==undefined) headers['x-admin-token']=token;
  const res=await worker.fetch(new Request(ORIGIN+p,{ method, headers, body: body===undefined?undefined:(typeof body==='string'?body:JSON.stringify(body)) }), env);
  const text=await res.text(); let data=null; try{ data=JSON.parse(text); }catch(e){}
  return { status:res.status, data, text, headers:res.headers };
}
async function pidHash(id){ const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode('flux-pid:'+id));
  return [...new Uint8Array(buf)].slice(0,8).map(b=>b.toString(16).padStart(2,'0')).join(''); }
const tick=()=>new Promise(r=>setTimeout(r,20));

async function suite({ gameHtml, adminHtml, workerMod, quiet=false }){
  let F=0; const failed=[];
  const ck=(l,c,x='')=>{ if(!quiet) console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':'')); if(!c){ F++; failed.push(l); } };
  const GAME=scriptsOf(gameHtml); const worker=workerMod.default, DO=workerMod.LeaderboardDO;
  const bootGame=(init={})=>{ const { store, mem }=makeStore(init); const g=boot(GAME,{ origin:ORIGIN, path:'/play/', store }); return { g, mem }; };

  /* ---------------- D-36: restore code inside EDIT ---------------- */
  if(!quiet) console.log('== D-36: restore code lives inside EDIT ==');
  try {
    ck('M1 no restore button in the main menu', !gameHtml.includes('id="restoreBtn"'));
    ck('M1 menu row back to the two original buttons', /id="skinsBtn">[^<]*<\/button><\/div>/.test(gameHtml));
    const fresh=bootGame({});
    ck('M2 new pilot: link offers to enter a code', fresh.g.els.restoreLink.textContent==='HAVE A RESTORE CODE?', fresh.g.els.restoreLink.textContent);
    const named=bootGame({ fluxPlayerId:'p-1', fluxProfileComplete:'1', fluxCallsign:'TITAN' });
    ck('M2 existing pilot: link shows RESTORE CODE', /RESTORE CODE$/.test(named.g.els.restoreLink.textContent) && !/HAVE/.test(named.g.els.restoreLink.textContent), named.g.els.restoreLink.textContent);
    let opened='';
    named.g.ctx.openRestoreCode=()=>{ opened='code'; }; named.g.ctx.openRestoreEntry=()=>{ opened='entry'; };
    named.g.els.restoreLink.onclick(); ck('M3 existing pilot: tapping it shows the pilot\'s code', opened==='code', opened);
    fresh.g.ctx.openRestoreCode=()=>{ opened='code'; }; fresh.g.ctx.openRestoreEntry=()=>{ opened='entry'; };
    opened=''; fresh.g.els.restoreLink.onclick(); ck('M3 new pilot: tapping it opens code entry', opened==='entry', opened);
    ck('M4 EDIT still opens the editor (original handler kept)', typeof named.g.els.editProfile.onclick==='function');
    let threw=false; try{ named.g.els.editProfile.onclick({}); }catch(e){ threw=true; }
    ck('M4 EDIT runs without errors and keeps the restore link', !threw && /RESTORE CODE/.test(named.g.els.restoreLink.textContent));
    ck('M5 link still sits directly after the name editor', /<\/select><\/div><button type="button" class="linkBtn restoreLink" id="restoreLink">/.test(gameHtml) && gameHtml.includes('#profileEditor.hidden+.restoreLink{display:none}'));
    ck('M6 wording points at EDIT', gameHtml.includes('Save your restore code (EDIT'));
    ck('M7 no load errors', named.g.errors.length===0 && fresh.g.errors.length===0, named.g.errors.join('|'));
  } catch(e){ ck('D-36 menu section ran', false, String(e.stack||e).slice(0,200)); }

  if(!quiet) console.log('== D-36: game-over Mode label ==');
  try {
    for (const d of ['easy','medium','hard']) {
      const { g } = bootGame({ fluxPlayerId:'p-2', fluxProfileComplete:'1', fluxCallsign:'TITAN', fluxDifficulty:d });
      const timers=[]; g.win.setTimeout=(fn)=>{ timers.push(fn); return timers.length; };
      g.win.document.getElementById('finalMode').textContent='MEDIUM';   // the page's static default
      g.ctx.newGame(); vm.runInContext('score=1234; level=2;', g.ctx); g.ctx.endGame();
      for (let i=0;i<5 && timers.length;i++) timers.splice(0).forEach(fn=>{ try{ fn(); }catch(e){} });
      ck('L1 game over after a '+d+' run says Mode: '+d.toUpperCase(), g.els.finalMode.textContent===d.toUpperCase(), g.els.finalMode.textContent);
    }
  } catch(e){ ck('D-36 label section ran', false, String(e.stack||e).slice(0,200)); }

  /* ---------------- D-37: admin issue restore code ---------------- */
  if(!quiet) console.log('== D-37: ISSUE RESTORE CODE safeguards ==');
  try {
    const env=makeEnv(DO); const stub=env.LEADERBOARD_DO.get('global');
    const ID='a1a1a1a1-0000-4000-8000-000000000001';
    skew+=20000; await call(worker,env,'/api/submit-score',{ body:{ playerId:ID, name:'Titan', score:21742, level:2, difficulty:'hard', country:'US' } });
    const pid=await pidHash(ID);
    const P='/api/admin/issue-restore-code';
    let r=await call(worker,env,P,{ body:{ pid, reason:'receipt matched' } });
    ck('A1 no admin password -> refused', r.status===401 && !r.text.includes('FX1-'));
    r=await call(worker,env,P,{ token:'wrong', body:{ pid, reason:'receipt matched' } });
    ck('A1 wrong admin password -> refused', r.status===401 && !r.text.includes('FX1-'));
    for (const reason of [undefined,'','  ','ab',42,{x:1}]) {
      r=await call(worker,env,P,{ token:TOKEN, body:{ pid, reason } });
      ck('A2 reason required: '+JSON.stringify(reason), r.status===400 && !r.text.includes('FX1-'));
    }
    for (const bad of ['', 'xyz', ID, '__proto__', 'A'.repeat(16)]) {
      r=await call(worker,env,P,{ token:TOKEN, body:{ pid:bad, reason:'receipt matched' } });
      ck('A3 invalid entry refused: '+String(bad).slice(0,12), r.status===400 && !r.text.includes('FX1-'));
    }
    r=await call(worker,env,P,{ token:TOKEN, body:{ pid:'0123456789abcdef', reason:'receipt matched' } });
    ck('A3 unknown entry -> 404, nothing logged', r.status===404 && (stub._obj.restoreLog||[]).length===0);
    for (const body of ['not json','[]','null']) {
      r=await call(worker,env,P,{ token:TOKEN, body });
      ck('A3 malformed body -> 400, no crash: '+body, r.status===400);
    }
    r=await call(worker,env,P,{ token:TOKEN, body:{ pid, reason:'  Stripe receipt\n matched  ' } });
    ck('A4 issued', r.status===200 && typeof r.data.code==='string' && r.data.tag && r.data.name==='TITAN', r.text.slice(0,80));
    ck('A4 never cached', (r.headers.get('cache-control')||'').includes('no-store'));
    const code=r.data.code;
    const { g }=bootGame({ fluxPlayerId:'someone-else' });
    const parsed=await g.ctx.parseRestoreCode(code);
    ck('A5 the issued code is accepted by the game and is exactly this pilot', parsed.ok && parsed.playerId===ID);
    ck('A5 same code the pilot\'s own device shows', code===(await g.ctx.makeRestoreCode(ID)));
    const rc=await call(worker,env,'/api/restore-check',{ body:{ playerId:parsed.playerId } });
    ck('A5 restore-check finds it (full restore works)', rc.data && rc.data.found===true && rc.data.tag===r.data.tag);
    const ov=await call(worker,env,'/api/admin/exceptions',{ token:TOKEN, body:{} });
    const log=ov.data.restoreLog||[];
    ck('A6 issue is logged: time, tag, name, reason', log.length===1 && log[0].tag===r.data.tag && log[0].name==='TITAN' && log[0].reason==='Stripe receipt matched' && log[0].at>0, JSON.stringify(log).slice(0,120));
    ck('A6 the log never contains the code or the playerId', !ov.text.includes(ID) && !ov.text.includes('FX1-'));
    const unauth=await call(worker,env,'/api/admin/exceptions',{ body:{} });
    ck('A6 the log itself needs the admin password', unauth.status===401 && !unauth.text.includes('TITAN'));
    // durable-first: if the log can't be written, no code
    stub._obj.state.storage.failKey='restoreLog';
    r=await call(worker,env,P,{ token:TOKEN, body:{ pid, reason:'second issue' } });
    stub._obj.state.storage.failKey=null;
    ck('A7 log write fails -> no code issued', r.status===503 && !r.text.includes('FX1-') && !r.text.includes(ID), r.status+' '+r.text.slice(0,60));
    ck('A7 ...and the in-memory log is unchanged', stub._obj.restoreLog.length===1);
    // pilot with a skin and no score
    const B='b2b2b2b2-0000-4000-8000-000000000002';
    await stub.fetch('https://do.internal/grant',{ method:'POST', body:JSON.stringify({ playerId:B, sku:'solar', sessionId:'cs_b' }) });
    r=await call(worker,env,P,{ token:TOKEN, body:{ pid:await pidHash(B), reason:'receipt pi_123 matched' } });
    ck('A8 pilot with purchases but no score can be issued a code', r.status===200 && (await g.ctx.parseRestoreCode(r.data.code)).playerId===B);
    // privacy deletion scrubs the log
    await call(worker,env,'/api/admin/privacy-delete',{ token:TOKEN, body:{ pid } });
    const ov2=await call(worker,env,'/api/admin/exceptions',{ token:TOKEN, body:{} });
    const e2=(ov2.data.restoreLog||[]).find(x=>x.tag===log[0].tag);
    ck('A9 privacy deletion erases name and reason from the log', e2 && e2.name==='' && /erased/.test(e2.reason) && !ov2.text.includes('Stripe receipt matched'), JSON.stringify(e2));
    ck('A9 ...and the log survives a restart (stored, not memory-only)', (await stub._obj.state.storage.get('restoreLog')).length===2);
    // cap
    for (let i=0;i<510;i++) stub._obj.restoreLog.push({ at:i, pid:'x', tag:'T', name:'N', reason:'r' });
    r=await call(worker,env,P,{ token:TOKEN, body:{ pid:await pidHash(B), reason:'cap test' } });
    ck('A10 log is capped at 500 entries, newest kept', stub._obj.restoreLog.length===500 && stub._obj.restoreLog[499].reason==='cap test');
  } catch(e){ ck('D-37 server section ran', false, String(e.stack||e).slice(0,200)); }

  if(!quiet) console.log('== D-37: admin page ==');
  try {
    const A=scriptsOf(adminHtml).join('\n');
    ck('P1 button present and calls the endpoint', A.includes("btn('ISSUE RESTORE CODE'") && A.includes("call('issue-restore-code'"));
    ck('P2 asks how the player was verified, refuses an empty answer', A.includes('How did you verify them?') && A.includes("reason.trim().length < 3"));
    ck('P3 code shown once: button removed after issuing, HIDE offered, nothing stored', A.includes('b.remove();') && A.includes("btn('HIDE'") && !/localStorage|sessionStorage/.test(A.slice(A.indexOf('ISSUE RESTORE CODE'), A.indexOf('async function find()'))));
    ck('P4 log shown under Check Exceptions', A.includes('renderRestoreLog(d.restoreLog'));
    const ok=(()=>{ try{ new vm.Script(A); return true; }catch(e){ return false; } })();
    ck('P5 admin script parses', ok);
  } catch(e){ ck('admin page section ran', false, String(e.stack||e).slice(0,200)); }

  return { F, failed };
}

const real=await import(pathToFileURL(path.join(__dirname,'FLUX-Sparta','worker.js')).href);
const main=await suite({ gameHtml:GAME_HTML, adminHtml:ADMIN_HTML, workerMod:real });

console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC=0;
async function control(label,{ expect, game=(s)=>s, admin=(s)=>s, workerSrc=(s)=>s }){
  const g2=game(GAME_HTML), a2=admin(ADMIN_HTML), w2=workerSrc(WORKER_SRC);
  if(g2===GAME_HTML && a2===ADMIN_HTML && w2===WORKER_SRC){ console.log('  FAIL  control did not apply: '+label); NC++; return; }
  const tmp=path.join(__dirname,'.nc37-'+Math.random().toString(16).slice(2)+'.mjs'); fs.writeFileSync(tmp,w2);
  try { const mod=await import(pathToFileURL(tmp).href); const r=await suite({ gameHtml:g2, adminHtml:a2, workerMod:mod, quiet:true });
    const hit=r.failed.filter(f=>f.startsWith(expect)); const caught=hit.length>0;
    console.log((caught?'  PASS  ':'  FAIL  ')+'caught: '+label+'  ['+(caught?hit[0]:'expected '+expect+'; failed: '+(r.failed.join(' | ')||'none'))+']');
    if(!caught) NC++; } finally { try{ fs.unlinkSync(tmp); }catch(e){} }
}
const rep=(a,b)=>(s)=>s.includes(a)?s.replace(a,b):s;
await control('Mode label never set at game over',{ expect:'L1', game:rep("   document.getElementById('finalMode').textContent=String(difficulty).toUpperCase();","") });
await control('restore button back in the main menu',{ expect:'M1', game:rep('id="skinsBtn">\u2726 THEMES & SKINS</button>','id="skinsBtn">\u2726 THEMES & SKINS</button><button class="linkBtn" id="restoreBtn">RESTORE CODE</button>') });
await control('existing pilot sent to code entry',{ expect:'M3', game:rep("if(restoreHasPilot()) openRestoreCode(); else openRestoreEntry();","openRestoreEntry();") });
await control('EDIT handler replaced instead of chained',{ expect:'M4', game:rep("if(typeof prev==='function') prev.call(this,e); ","throw new Error('lost'); ") });
// The password is checked twice (the endpoint AND the shared admin gateway), so
// this control removes both layers; removing either one alone stays safe.
await control('no admin password check (both layers)',{ expect:'A1', workerSrc:(s)=>s.replace("async function adminIssueRestore(request, env) {\n  const denied = requireAdmin(request, env); if (denied) return denied;","async function adminIssueRestore(request, env) {").replace("async function adminDO(request, env, doPath, payload) {\n  const denied = requireAdmin(request, env); if (denied) return denied;","async function adminDO(request, env, doPath, payload) {") });
await control('reason not required',{ expect:'A2', workerSrc:rep("if (reason.length < RESTORE_REASON_MIN)","if (false)") });
await control('code returned before the log is saved',{ expect:'A7', workerSrc:rep("    catch (e) { return json({ error: \"Could not record this in the log, so no code was issued. Try again.\" }, 503); }","    catch (e) { }") });
await control('log leaks the code',{ expect:'A6', workerSrc:rep("const entry = { at: Date.now(), pid, tag, name,","const entry = { at: Date.now(), pid, tag, name, code: await restoreCodeFor(id),") });
await control('server checksum differs from the game',{ expect:'A5', workerSrc:rep('encode("flux-restore:" + playerId)','encode("flux-restore-v2:" + playerId)') });
await control('privacy deletion leaves the log untouched',{ expect:'A9', workerSrc:rep("const nextLog = this.restoreLog.map((e) => (e.pid === pid ?","const nextLog = this.restoreLog.map((e) => (false ?") });
await control('response cacheable',{ expect:'A4 never cached', workerSrc:(s)=>{ const i=s.indexOf('async function adminIssueRestore'); const j=s.indexOf('headers.set("Cache-Control", "no-store");',i); return i<0||j<0?s:s.slice(0,j)+s.slice(j+'headers.set("Cache-Control", "no-store");'.length); } });
await control('admin page never asks for a reason',{ expect:'P2', admin:rep("if (reason.trim().length < 3) { say('Write how you verified this player.', 'err'); return; }","") });

const total=main.F+NC;
console.log('\n'+(total?('D-36/D-37 FAILED: '+main.F+' check(s), '+NC+' uncaught control(s)'):'D-36/D-37 PASSED: all checks and all negative controls'));
process.exit(total?1:0);
