// RC2.8.1 CORRECTIONS — D-29 prototype-name IDs, D-31 verify-session delivery,
// D-33 tag consistency, D-34 reconciliation pagination, plus the client's
// pending-delivery message. Written FIRST and run against RC2.8, where each
// defect test must FAIL. Real worker.js and real game page; Stripe/KV stand-ins.
import worker, { LeaderboardDO } from "./FLUX-Sparta/worker.js";
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
import { boot, makeStore } from "./harness.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
/* ---------------- fake Durable Object runtime ---------------- */

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(kOrObj, v) {
    if (typeof kOrObj === "object") {
      for (const [k, val] of Object.entries(kOrObj)) this.map.set(k, structuredClone(val));
    } else this.map.set(kOrObj, structuredClone(v));
  }
}

class FakeState {
  constructor() { this.storage = new FakeStorage(); }
  async blockConcurrencyWhile(fn) { return fn(); }
}

// A real DO processes one request at a time. Emulate that with a queue,
// otherwise the test would be easier than reality.
function makeNamespace() {
  const instances = new Map();
  let chain = Promise.resolve();
  return {
    idFromName(name) { return name; },
    get(id) {
      if (!instances.has(id)) instances.set(id, new LeaderboardDO(new FakeState()));
      const obj = instances.get(id);
      return {
        fetch(url, init) {
          const run = () => obj.fetch(new Request(url, init));
          const result = chain.then(run, run);
          chain = result.then(() => {}, () => {});
          return result;
        },
      };
    },
    _instances: instances,
  };
}

function makeEnv(extra = {}) {
  return {
    LEADERBOARD_DO: makeNamespace(),
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_fake",
    STRIPE_PRICE_TOXIC: "price_toxic",
    STRIPE_PRICE_COSMIC: "price_cosmic",
    STRIPE_PRICE_SOLAR: "price_solar",
    SITE_URL: "https://flux-sparta-3.example.dev",
    // AUDIT A-4: the shipped store is closed on the server. These tests cover
    // the checkout flow players get once it reopens (post-T-9), so they run
    // with the store open. test-audit-fixes.mjs proves the closed behaviour.
    STORE_OPEN: "true",
    ...extra,
  };
}

async function signStripe(payload, secret, timestamp) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}


const ORIGIN="https://flux-sparta-3.example.dev", ADMIN={"x-admin-token":"correct-horse-battery"};
function kv(failPut=false){ const m=new Map(); return { map:m, failPut,
  async get(k){ return m.has(k)?m.get(k):null; }, async put(k,v){ if(this.failPut) throw new Error("kv down"); m.set(k,String(v)); },
  async delete(k){ m.delete(k); }, async list({prefix=""}={}){ return { keys:[...m.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})) }; } }; }
function env2(extra={}){ return makeEnv({ ADMIN_TOKEN:"correct-horse-battery", LEADERBOARD: kv(), ...extra }); }
async function call(env,p,{method="GET",body,headers={},raw}={}){
  const r=new Request(ORIGIN+p,{method,headers:{...(body||raw?{"Content-Type":"application/json"}:{}),...headers},body: raw!==undefined?raw:(body?JSON.stringify(body):undefined)});
  const res=await worker.fetch(r,env,{}); let data=null; try{data=await res.json();}catch(e){}
  return { status:res.status, data, raw:JSON.stringify(data) };
}
const inst=(env)=>[...env.LEADERBOARD_DO._instances.values()][0];
const submit=(env,id,name,score,d="medium",c="US",level=9)=>   // D-41: the real game tops out at level 9
call(env,"/api/submit-score",{method:"POST",body:{playerId:id,name,score,level,difficulty:d,country:c}});
const section=async(title,fn)=>{ console.log("\n== "+title+" =="); try{ await fn(); }catch(e){ ck("section completed without crashing",false,String(e).slice(0,100)); } };
async function webhook(env,session){ const payload=JSON.stringify({id:"evt_"+Math.random(),type:"checkout.session.completed",data:{object:session}});
  return call(env,"/api/stripe-webhook",{method:"POST",raw:payload,headers:{"stripe-signature":await signStripe(payload,"whsec_fake",Math.floor(Date.now()/1000))}}); }
function stripeMock(sessions){ const orig=globalThis.fetch; const seen=[];
  globalThis.fetch=async(u,init)=>{ const s=String(u); if(!s.includes("api.stripe.com")) return orig(u,init); seen.push(s);
    const one=s.match(/checkout\/sessions\/([A-Za-z0-9_]+)(\?|$)/);
    if(one){ const f=sessions.find(x=>x.id===one[1]); return new Response(JSON.stringify(f||{error:{message:"No such session"}}),{status:f?200:404}); }
    const u2=new URL(s); const after=u2.searchParams.get("starting_after"); const lim=+u2.searchParams.get("limit")||10;
    let list=sessions; if(u2.searchParams.get("status")) list=list.filter(x=>x.status===u2.searchParams.get("status"));
    const start=after? list.findIndex(x=>x.id===after)+1 : 0; const page=list.slice(start,start+lim);
    return new Response(JSON.stringify({ data:page, has_more: start+lim<list.length }),{status:200}); };
  return { restore:()=>{globalThis.fetch=orig;}, seen }; }

const PROTO=["__proto__","proto","constructor","prototype","toString","valueOf","hasOwnProperty","isPrototypeOf","propertyIsEnumerable","toLocaleString"];

await section("D-29: prototype-name player IDs never crash the server", async()=>{
  for (const id of PROTO) {
    const env=env2();
    const r=await submit(env,id,"PROTOTEST",1234);
    ck(id+": submit is 200 or a controlled 4xx, never 5xx", r.status<500, r.status+" "+r.raw.slice(0,60));
    if (r.status===200) {
      ck(id+": treated as a NEW player (no inherited record)", r.data.isNewBest===true && r.data.best===1234, r.raw.slice(0,80));
      const lb=await call(env,"/api/leaderboard");
      ck(id+": appears exactly once with the right score", lb.data.top.filter(x=>x.name==="PROTOTEST"&&x.score===1234).length===1);
    }
    const e=await call(env,"/api/entitlements?playerId="+encodeURIComponent(id));
    ck(id+": entitlements lookup is not 5xx and owns nothing", e.status<500 && (!e.data.skus || (Array.isArray(e.data.skus) && e.data.skus.length===0)), e.status+" "+e.raw.slice(0,60));
  }
  ck("Object.prototype was never polluted", ({}).polluted===undefined && Object.getPrototypeOf({})===Object.prototype && typeof ({}).toString==="function");
});

await section("D-29: every server map is safe from inherited keys", async()=>{
  const env=env2();
  await submit(env,"valueOf","ALPHA",500); await submit(env,"real-player-01","BRAVO",400);
  const d=inst(env);
  for (const k of ["players","lastSubmit","entitlements","seenSessions","restricted","nameBans","countries"])
    ck("map '"+k+"' has no inherited Object properties", d[k] && !("toString" in d[k]) && !("hasOwnProperty" in d[k]), typeof d[k]);
  const f=await call(env,"/api/admin/find-player",{method:"POST",body:{query:"ALPHA"},headers:ADMIN});
  const pid=f.data?.matches?.[0]?.pid;
  const rs=await call(env,"/api/admin/restrict",{method:"POST",body:{pid,reason:"t"},headers:ADMIN});
  ck("restricting a prototype-named player works", rs.status===200 && !(await call(env,"/api/leaderboard")).data.top.some(x=>x.name==="ALPHA"));
  for (const n of ["toString","__proto__","constructor","hasOwnProperty"]) {
    const b=await call(env,"/api/admin/name-ban",{method:"POST",body:{name:n},headers:ADMIN});
    ck("banning the name '"+n+"' is safe", b.status<500, b.status+" "+b.raw.slice(0,60));
  }
  ck("BRAVO unaffected by bans on prototype names", (await call(env,"/api/leaderboard")).data.top.some(x=>x.name==="BRAVO"));
  const imp=await (await inst(env).fetch(new Request("https://do.internal/import",{method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({records:[{playerId:"toString",name:"IMP1",country:"US",score:700,level:3,difficulty:"medium"},
                                   {playerId:"__proto__",name:"IMP2",country:"US",score:600,level:3,difficulty:"medium",polluted:true}]})}))).json();
  ck("import with prototype-named IDs does not crash", imp.ok===true, JSON.stringify(imp));
  ck("import never pollutes any prototype", ({}).polluted===undefined && Object.getPrototypeOf(inst(env).players)===null);
});

await section("D-31: verify-session separates payment from delivery", async()=>{
  const P="bbbbbbbb-cccc-4ddd-8eee-000000000001";
  const sessions=[
    {id:"cs_ok",payment_status:"paid",status:"complete",metadata:{sku:"solar",playerId:P}},
    {id:"cs_fail",payment_status:"paid",status:"complete",metadata:{sku:"cosmic",playerId:P}},
    {id:"cs_throw",payment_status:"paid",status:"complete",metadata:{sku:"toxic",playerId:P}},
    {id:"cs_kvdown",payment_status:"paid",status:"complete",metadata:{sku:"toxic",playerId:P}},
    {id:"cs_unpaid",payment_status:"unpaid",status:"open",metadata:{sku:"solar",playerId:"bbbbbbbb-cccc-4ddd-8eee-000000000009"}},
    {id:"cs_expired",payment_status:"unpaid",status:"expired",metadata:{sku:"solar",playerId:"bbbbbbbb-cccc-4ddd-8eee-000000000009"}},
  ];
  const m=stripeMock(sessions);
  try {
    const env=env2(); await call(env,"/api/leaderboard");
    const ok=await call(env,"/api/verify-session?session_id=cs_ok");
    ck("paid + saved -> paid:true delivered:true", ok.status===200 && ok.data.paid===true && ok.data.delivered===true && ok.data.pendingDelivery===false, ok.raw);
    const d=inst(env); const origGrant=d.handleGrant.bind(d);
    d.handleGrant=async()=>new Response(JSON.stringify({error:"boom"}),{status:500});
    const bad=await call(env,"/api/verify-session?session_id=cs_fail");
    ck("paid + grant refused -> delivered:false, pendingDelivery:true", bad.status===200 && bad.data.paid===true && bad.data.delivered===false && bad.data.pendingDelivery===true, bad.raw);
    ck("...and a durable delivery exception was recorded first", [...env.LEADERBOARD.map.keys()].some(k=>k.includes("cs_fail")));
    d.handleGrant=origGrant;
    const st=d.state.storage; const origPut=st.put.bind(st); let boom=true;
    st.put=async(...a)=>{ if(boom){boom=false; throw new Error("storage down");} return origPut(...a); };
    const thr=await call(env,"/api/verify-session?session_id=cs_throw");
    ck("paid + thrown storage error -> pendingDelivery, never 'delivered'", thr.status===200 && thr.data.delivered===false && thr.data.pendingDelivery===true, thr.status+" "+thr.raw);
    env.LEADERBOARD.failPut=true; d.handleGrant=async()=>new Response("{}",{status:500});
    const kvd=await call(env,"/api/verify-session?session_id=cs_kvdown");
    ck("grant fails AND exception cannot be stored -> retryable non-2xx", kvd.status>=500, kvd.status+" "+kvd.raw);
    env.LEADERBOARD.failPut=false; d.handleGrant=origGrant;
    const wh=await webhook(env,sessions[1]);
    const own=(await call(env,"/api/entitlements?playerId="+P)).data.skus;
    ck("a later webhook retry delivers the failed purchase", wh.status===200 && own.includes("cosmic"), JSON.stringify(own));
    const ex=await call(env,"/api/admin/exceptions",{method:"POST",body:{},headers:ADMIN});
    ck("...and the exception clears itself once delivered", !(ex.data.delivery||[]).some(e=>e.session==="cs_fail"));
    const w=[]; await worker.scheduled({},env,{waitUntil:p=>w.push(p)}); await Promise.all(w);
    ck("scheduled reconciliation delivers the thrown-storage purchase", (await call(env,"/api/entitlements?playerId="+P)).data.skus.includes("toxic"));
    await call(env,"/api/verify-session?session_id=cs_ok"); await webhook(env,sessions[0]);
    ck("duplicate verify + webhook -> exactly one delivery", (await call(env,"/api/entitlements?playerId="+P)).data.skus.filter(s=>s==="solar").length===1);
    const un=await call(env,"/api/verify-session?session_id=cs_unpaid"), exp=await call(env,"/api/verify-session?session_id=cs_expired");
    ck("unpaid and expired sessions never unlock", un.data.paid===false && un.data.delivered===false && exp.data.paid===false &&
       (await call(env,"/api/entitlements?playerId=bbbbbbbb-cccc-4ddd-8eee-000000000009")).data.skus.length===0);
  } finally { m.restore(); }
});

await section("D-33: public tags are consistent across every view", async()=>{
  const env=env2();
  for (let i=0;i<130;i++) await submit(env,"cccccccc-dddd-4eee-8fff-"+String(i).padStart(12,"0"),"FILL"+i,100000-i*10);
  const A="cccccccc-dddd-4eee-8fff-900000000001", B="cccccccc-dddd-4eee-8fff-900000000002";
  await submit(env,A,"TITAN",200000,"medium","PH"); await submit(env,B,"TITAN",50,"medium","PH");   // B ranks ~132nd
  const d=inst(env); const realPid=d.pid.bind(d);
  const forced={[A]:"abcdef0123456789",[B]:"abcdef0120000000"};
  d.pid=async(id)=>forced[id]||realPid(id); d.pidCache=new Map(); d.tagCache=null;
  const t25=(await call(env,"/api/leaderboard?limit=25")).data.top.find(r=>r.name==="TITAN").tag;
  const t100=(await call(env,"/api/leaderboard?limit=100")).data.top.find(r=>r.name==="TITAN").tag;
  ck("collision with a player OUTSIDE the top 25 is detected", t25.length===12, t25);
  ck("...and outside the top 100", t100.length===12, t100);
  ck("top-25 and top-100 views show the same tag", t25===t100);
  const lbAll=await call(env,"/api/leaderboard?limit=100");
  const ph=lbAll.data.countries.find(c=>c.country==="PH");
  ck("country leader shows the same tag", ph.topTag===t25, ph.topTag+" vs "+t25);
  const f=await call(env,"/api/admin/find-player",{method:"POST",body:{query:"TITAN"},headers:ADMIN});
  const adminTag=f.data.matches.find(x=>x.bests.medium.score===200000).tag;
  ck("admin page shows the same tag", adminTag===t25, adminTag);
  d.lastSubmit=Object.create(null);
  const me=await submit(env,A,"TITAN",200001,"medium","PH");
  ck("the player's own submit response shows the same tag", me.data.tag===t25, me.data.tag);
  d.lastSubmit=Object.create(null); await submit(env,B,"TITAN",300000,"medium","PH");   // B overtakes A
  const after=(await call(env,"/api/leaderboard?limit=25")).data.top.filter(r=>r.name==="TITAN").map(r=>r.tag);
  ck("tags unchanged when rankings change", after.includes(t25) && after.length===2 && after.every(x=>x.length===12), after.join(","));
});

await section("D-34: reconciliation follows Stripe pagination", async()=>{
  const now=Math.floor(Date.now()/1000); const sessions=[];
  for (let i=0;i<250;i++) sessions.push({id:"cs_pg_"+String(i).padStart(3,"0"),payment_status:"paid",status:"complete",created:now-600-i,
    metadata:{sku:["toxic","cosmic","solar"][i%3],playerId:"dddddddd-eeee-4fff-8aaa-"+String(i).padStart(12,"0")}});
  sessions.push({id:"cs_pg_unpaid",payment_status:"unpaid",status:"complete",created:now-600,metadata:{sku:"solar",playerId:"dddddddd-eeee-4fff-8aaa-999999999999"}});
  sessions.push({id:"cs_pg_expired",payment_status:"unpaid",status:"expired",created:now-600,metadata:{sku:"solar",playerId:"dddddddd-eeee-4fff-8aaa-999999999998"}});
  const m=stripeMock(sessions);
  try {
    const env=env2(); await call(env,"/api/leaderboard");
    const d=inst(env); const origGrant=d.handleGrant.bind(d);
    const failId="dddddddd-eeee-4fff-8aaa-000000000200";
    d.handleGrant=async(req)=>{ const b=await req.clone().json(); if(b.playerId===failId) return new Response("{}",{status:500}); return origGrant(req); };
    const w=[]; await worker.scheduled({},env,{waitUntil:p=>w.push(p)}); await Promise.all(w);
    let delivered=0; for (let i=0;i<250;i++){ const id="dddddddd-eeee-4fff-8aaa-"+String(i).padStart(12,"0");
      if((await call(env,"/api/entitlements?playerId="+id)).data.skus.length) delivered++; }
    ck("all pages checked: 249 of 250 delivered (1 forced failure)", delivered===249, "delivered "+delivered);
    ck("more than one Stripe page was requested", m.seen.filter(u=>u.includes("starting_after=")).length>=2, m.seen.length+" requests");
    const ex=await call(env,"/api/admin/exceptions",{method:"POST",body:{},headers:ADMIN});
    ck("the partial failure is recorded for the admin", (ex.data.delivery||[]).some(e=>e.session==="cs_pg_200"));
    ck("unpaid and expired never delivered", (await call(env,"/api/entitlements?playerId=dddddddd-eeee-4fff-8aaa-999999999999")).data.skus.length===0 &&
       (await call(env,"/api/entitlements?playerId=dddddddd-eeee-4fff-8aaa-999999999998")).data.skus.length===0);
    d.handleGrant=origGrant;
    const w2=[]; await worker.scheduled({},env,{waitUntil:p=>w2.push(p)}); await Promise.all(w2);
    ck("a re-run delivers the earlier failure", (await call(env,"/api/entitlements?playerId="+failId)).data.skus.length===1);
    const ex2=await call(env,"/api/admin/exceptions",{method:"POST",body:{},headers:ADMIN});
    ck("...and clears its exception", !(ex2.data.delivery||[]).some(e=>e.session==="cs_pg_200"));
    const dup=(await call(env,"/api/entitlements?playerId=dddddddd-eeee-4fff-8aaa-000000000000")).data.skus;
    ck("repeated reconciliation never duplicates", dup.length===1, JSON.stringify(dup));
  } finally { m.restore(); }
});

await section("Client: a clear pending-delivery message", async()=>{
  const GAME=[...fs.readFileSync(path.join(__dirname,"FLUX-Sparta","public","play","index.html"),"utf8").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  let mode="pending";
  const fetchImpl=(u)=>{ const url=String(u);
    const J=(b)=>Promise.resolve({ok:true,status:200,headers:{get:()=>null},json:()=>Promise.resolve(b)});
    if(url.includes("/api/verify-session")) return J(mode==="pending" ? {paid:true,delivered:false,pendingDelivery:true,sku:"solar",playerId:"buyer-9"}
                                                                  : {paid:true,delivered:true,pendingDelivery:false,sku:"solar",playerId:"buyer-9"});
    if(url.includes("/api/entitlements")) return J({skus: mode==="pending"?[]:["solar"]});
    return J({}); };
  const { store, mem } = makeStore({ fluxProfileComplete:"1", fluxCallsign:"TITAN" });
  const g=boot(GAME,{origin:"https://x.test",path:"/play/",store,fetchImpl,uuid:()=>"buyer-9"});
  await new Promise(r=>setTimeout(r,20));
  const shown=[]; g.ctx.showInfo=(t,b)=>shown.push(t+" | "+b);
  mem.fluxPendingCheckout=JSON.stringify({sessionId:"cs_p1",sku:"solar",playerId:"buyer-9",at:Date.now()});
  g.fire("pageshow"); await new Promise(r=>setTimeout(r,30));
  ck("payment ok but delivery pending -> a clear pending-delivery message", shown.some(s=>/PAYMENT RECEIVED/.test(s) && /deliver/i.test(s)), shown.join(" / "));
  ck("...never 'PURCHASE COMPLETE'", !shown.some(s=>/PURCHASE COMPLETE/.test(s)));
  ck("...the skin is NOT shown as owned", g.ctx.ownsSkin("solar")===false);
  ck("...and the pending record is kept for an automatic re-check", !!mem.fluxPendingCheckout);
  mode="done"; shown.length=0; g.fire("pageshow"); await new Promise(r=>setTimeout(r,30));
  ck("once delivered, the next return completes normally", shown.some(s=>/PURCHASE COMPLETE/.test(s)) && g.ctx.ownsSkin("solar")===true, shown.join(" / "));
});

console.log("\n"+"=".repeat(56));
console.log(F ? "  "+F+" FAILED" : "  ALL RC2.8.1 TESTS PASSED");
console.log("=".repeat(56));
process.exit(F?1:0);
