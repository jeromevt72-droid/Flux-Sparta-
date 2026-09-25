// Service-worker tests. RC2.2 models the REAL iOS cold-launch condition that
// RC2.1's suite missed: app terminated, no network, launched from the Home
// Screen icon at the installed start_url.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPARTA = path.join(__dirname, 'FLUX-Sparta', 'public');
const src = fs.readFileSync(path.join(SPARTA,'sw.js'),'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(SPARTA,'manifest.webmanifest'),'utf8'));

let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
const ORIGIN='https://flux-sparta-3.test';

function makeEnv(netHandler){
  const store=new Map();
  const norm=u=>String(u).split('#')[0];
  const cacheAPI={
    async open(n){ if(!store.has(n)) store.set(n,new Map()); const m=store.get(n);
      return {
        async addAll(list){ for(const u of list){ const r=await netHandler(new Req(u)); if(!(r&&r.status===200)) throw new Error('addAll '+u); m.set(norm(u),r); } },
        async put(u,r){ m.set(norm(typeof u==='string'?u:u.url), r); },
        async match(u,o){ const k=norm(typeof u==='string'?u:u.url);
          if(m.has(k)) return m.get(k);
          if(o&&o.ignoreSearch){ const base=k.split('?')[0];
            for(const [kk,v] of m) if(kk.split('?')[0]===base) return v; }
          return undefined; }
      }; },
    async keys(){ return [...store.keys()]; },
    async delete(n){ return store.delete(n); },
    async match(u,o){ for(const n of store.keys()){ const c=await cacheAPI.open(n); const h=await c.match(u,o); if(h) return h; } return undefined; }
  };
  class Req{ constructor(url,mode='same-origin',method='GET'){ this.url=String(url); this.mode=mode; this.method=method; } }
  const L={};
  const loc={origin:ORIGIN, href:ORIGIN+'/sw.js', toString(){return this.href;}};
  const self_={ location:loc,
    addEventListener:(t,f)=>{(L[t]=L[t]||[]).push(f);},
    clients:{claimed:false, claim(){self_.clients.claimed=true;return Promise.resolve();}},
    skipWaiting(){self_.skipped=true;}, skipped:false };
  class Resp{ static redirect(url,status){ const r=new Resp('',{status:status||302}); r.redirectTo=String(url); return r; }
    constructor(body,init){ this.body=body; this.status=(init&&init.status)||200; this.type='basic'; }
    clone(){ const r=new Resp(this.body,{status:this.status}); r.type=this.type; return r; } }
  new Function('self','caches','fetch','URL','Response', src)(self_,cacheAPI,netHandler,URL,Resp);
  return {self_,L,store,cacheAPI,Req,Resp};
}
const R=(status,body='SHELL')=>({status,type:'basic',body,clone(){return R(status,body)}});

console.log('-- manifest: explicit start_url and scope (the RC2.1 gap) --');
ck('start_url is the site root, where the Gateway lives', manifest.start_url==='/', manifest.start_url);
ck('scope declared', manifest.scope==='/', String(manifest.scope));
ck('id declared', manifest.id==='/', String(manifest.id));

console.log('\n-- install: absolute keys + synthetic shell key --');
let e=makeEnv(async()=>R(200));
let w=[]; await e.L.install[0]({waitUntil:p=>w.push(p)}); await Promise.all(w);
const c=[...e.store.get('flux-sparta-v4').keys()].sort();
ck('cache version bumped to v4 (paths moved)', e.store.has('flux-sparta-v4'));
ck('8 keys stored (7 assets + shell key)', c.length===8, String(c.length));
ck('game root /play/ cached', c.includes(ORIGIN+'/play/'));
ck('Gateway root "/" is NOT cached as the game', !c.includes(ORIGIN+'/'));
ck('/play/index.html cached', c.includes(ORIGIN+'/play/index.html'));
ck('synthetic shell key cached', c.includes(ORIGIN+'/__flux_shell'));
ck('all keys absolute', c.every(k=>k.startsWith('http')));

console.log('\n-- activate: v1 removed, unrelated preserved --');
let e2=makeEnv(async()=>R(200));
e2.store.set('flux-sparta-v1',new Map([[ORIGIN+'/index.html',R(200)]]));
e2.store.set('flux-sparta-v2',new Map([[ORIGIN+'/index.html',R(200)]]));
e2.store.set('flux-sparta-v3',new Map([[ORIGIN+'/index.html',R(200)]]));
e2.store.set('other-app',new Map([['x',R(200)]]));
let w2=[]; await e2.L.install[0]({waitUntil:p=>w2.push(p)}); await Promise.all(w2);
let w3=[]; await e2.L.activate[0]({waitUntil:p=>w3.push(p)}); await Promise.all(w3);
ck('v1 deleted', !e2.store.has('flux-sparta-v1'));
ck('v2 deleted (the real deployed-build upgrade path)', !e2.store.has('flux-sparta-v2'));
ck('v3 deleted (the deployed-build upgrade path, keyed to old paths)', !e2.store.has('flux-sparta-v3'));
ck('v4 kept', e2.store.has('flux-sparta-v4'));
ck('unrelated cache preserved', e2.store.has('other-app'));
ck('clients claimed', e2.self_.clients.claimed);

console.log('\n== THE REAL FAILURE: COLD OFFLINE LAUNCH ==');
let online=true;
let e3=makeEnv(async()=>{ if(!online) throw new Error('offline'); return R(200,'SHELL'); });
let w4=[]; await e3.L.install[0]({waitUntil:p=>w4.push(p)}); await Promise.all(w4);
let w5=[]; await e3.L.activate[0]({waitUntil:p=>w5.push(p)}); await Promise.all(w5);
online=false;   // Airplane Mode ON, app terminated, cold launch

async function nav(url){
  let out=null;
  e3.L.fetch[0]({request:new e3.Req(url,'navigate'),respondWith:p=>{out=p}});
  return out ? await out : null;
}
for(const [label,url] of [
  ['game /play/index.html',           ORIGIN+'/play/index.html'],
  ['game root /play/',                ORIGIN+'/play/'],
  ['game with query',                 ORIGIN+'/play/index.html?utm=homescreen'],
  ['game root with query',            ORIGIN+'/play/?source=pwa'],
  ['game without trailing slash',     ORIGIN+'/play'],
]){
  const r=await nav(url);
  ck('cold offline: '+label, !!r && r.status===200, r?('status '+r.status):'NO RESPONSE');
}
// ROOT MOVE: the installed app now starts at "/" -- the Gateway. A cold offline
// launch therefore requests the GATEWAY first. It must hand the player to the
// cached game at /play/ -- never an error page, never the Gateway (which needs
// the network). This is the path D-02A now actually takes on a device.
for (const [label, u] of [['start_url "/"', ORIGIN+'/'], ['/index.html', ORIGIN+'/index.html'],
                          ['retired /welcome/', ORIGIN+'/welcome/'], ['any other page', ORIGIN+'/privacy.html']]) {
  const r = await nav(u);
  ck('cold offline: '+label+' redirects to the game', !!r && r.status===302 && r.redirectTo===ORIGIN+'/play/',
     r ? r.status+' -> '+r.redirectTo : 'NO RESPONSE');
}
const followed = await nav(ORIGIN+'/play/');
ck('cold offline: following it serves the cached game shell', !!followed && followed.status===200 && followed.body==='SHELL',
   followed ? followed.status+' '+followed.body : 'none');

// ONE-APP AUDIT: online, visiting the Gateway must NOT overwrite the game
// shell. RC2.5.5's worker stored EVERY navigation as the game, which would
// have replaced the offline game with Gateway HTML.
{
  // sw.js install calls fetch(SHELL_URL) with a plain string, not a Request.
  const eg = makeEnv(async (r)=> { const pth = new URL(typeof r==='string' ? r : r.url).pathname;
    return R(200, (pth==='/' || pth==='/index.html') ? 'GATEWAY-HTML' : 'SHELL'); });
  let w1=[]; await eg.L.install[0]({waitUntil:p=>w1.push(p)}); await Promise.all(w1);
  let out=null; eg.L.fetch[0]({request:new eg.Req(ORIGIN+'/','navigate'),respondWith:p=>{out=p}});
  const served = await out;
  await new Promise(r=>setTimeout(r,10));
  const c = eg.store.get('flux-sparta-v4');
  ck('online Gateway visit is served normally', served && served.body==='GATEWAY-HTML');
  ck('online Gateway visit does NOT overwrite the game shell',
     c.get(ORIGIN+'/play/index.html').body==='SHELL' && c.get(ORIGIN+'/play/').body==='SHELL' && c.get(ORIGIN+'/__flux_shell').body==='SHELL'
       && !c.has(ORIGIN+'/'),
     [c.get(ORIGIN+'/play/index.html')?.body, c.get(ORIGIN+'/play/')?.body, c.has(ORIGIN+'/') ? 'ROOT-CACHED' : 'root-not-cached'].join(','));
  let out2=null; eg.L.fetch[0]({request:new eg.Req(ORIGIN+'/play/','navigate'),respondWith:p=>{out2=p}});
  await out2; await new Promise(r=>setTimeout(r,10));
  ck('a GAME navigation still refreshes the shell', c.get(ORIGIN+'/play/index.html').body==='SHELL');
}
const r5=await nav(ORIGIN+'/play/index.html');
ck('never resolves undefined', r5!==undefined && r5!==null);

console.log('\n-- terminal fallback: even a wiped cache returns a Response --');
let e4=makeEnv(async()=>{ throw new Error('offline'); });
let out=null;
e4.L.fetch[0]({request:new e4.Req(ORIGIN+'/play/','navigate'),respondWith:p=>{out=p}});
const r6=await out;
ck('returns a real Response, not undefined', !!r6, r6?('status '+r6.status):'UNDEFINED');
ck('it is an explicit 503, not a browser error page', r6 && r6.status===503);

console.log('\n-- /api/* still never intercepted --');
let touched=null;
e3.L.fetch[0]({request:new e3.Req(ORIGIN+'/api/leaderboard','navigate'),respondWith:p=>{touched=p}});
ck('API navigation not intercepted', touched===null);
touched=null;
e3.L.fetch[0]({request:new e3.Req(ORIGIN+'/api/submit-score','same-origin','POST'),respondWith:p=>{touched=p}});
ck('API POST not intercepted', touched===null);

console.log('\n-- Version A -> Version B --');
let ver='vA'; online=true;
let e5=makeEnv(async()=>R(200,ver));
let w6=[]; await e5.L.install[0]({waitUntil:p=>w6.push(p)}); await Promise.all(w6);
ck('A cached', e5.store.get('flux-sparta-v4').get(ORIGIN+'/play/index.html').body==='vA');
ver='vB';
let o2=null; e5.L.fetch[0]({request:new e5.Req(ORIGIN+'/play/index.html','navigate'),respondWith:p=>{o2=p}});
ck('online serves B', (await o2).body==='vB');
await new Promise(r=>setTimeout(r,5));
const m=e5.store.get('flux-sparta-v4');
ck('all three shell keys refreshed to B',
   m.get(ORIGIN+'/play/index.html').body==='vB' && m.get(ORIGIN+'/play/').body==='vB' && m.get(ORIGIN+'/__flux_shell').body==='vB');

console.log('\n-- readiness handshake (OFFLINE READY must be earned) --');
let replies=[];
const msgSrc={postMessage:m=>replies.push(m)};
e3.L.message[0]({data:{type:'GET_READY'},source:msgSrc});
await new Promise(r=>setTimeout(r,10));
ck('reports ready when fully cached', replies[0] && replies[0].ready===true, JSON.stringify(replies[0]));
replies=[];
let e6=makeEnv(async()=>R(200));   // never installed
e6.L.message[0]({data:{type:'GET_READY'},source:msgSrc});
await new Promise(r=>setTimeout(r,10));
ck('reports NOT ready when cache is empty', replies[0] && replies[0].ready===false, JSON.stringify(replies[0]));

console.log('\n-- messages --');
e3.L.message[0]({data:{type:'SKIP_WAITING'}});
ck('skipWaiting honoured', e3.self_.skipped===true);
let threw=false;
[null,undefined,'s',{},[],{type:'x'}].forEach(d=>{try{e3.L.message[0]({data:d});}catch(x){threw=true;}});
ck('malformed messages safe', !threw);

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL SERVICE-WORKER TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
