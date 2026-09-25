// RC2.8 — WORKER DEFECTS D-22, D-25, D-26, D-27, D-28 and the new moderation
// and purchase tools. Written FIRST and run against RC2.7, where each defect
// test must FAIL. Runs the REAL worker.js; Stripe and KV are local stand-ins.
import worker, { LeaderboardDO } from "./FLUX-Sparta/worker.js";
import { levelFor } from './level-rule.mjs';   // RC2.8.7: D-51 fixture levels
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


const ORIGIN = "https://flux-sparta-3.example.dev";
const ADMIN = { "x-admin-token": "correct-horse-battery" };
function kv() { const m = new Map(); return { map:m,
  async get(k){ return m.has(k) ? m.get(k) : null; }, async put(k,v){ m.set(k,String(v)); },
  async delete(k){ m.delete(k); }, async list({prefix=""}={}){ return { keys:[...m.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})), list_complete:true }; } }; }
function env2(extra={}) { return makeEnv({ ADMIN_TOKEN:"correct-horse-battery", LEADERBOARD: kv(), ...extra }); }
async function call(env, p, { method="GET", body, headers={}, raw } = {}) {
  const r = new Request(ORIGIN + p, { method, headers: { ...(body||raw ? {"Content-Type":"application/json"} : {}), ...headers },
    body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined) });
  const res = await worker.fetch(r, env, {});
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, raw: JSON.stringify(data) };
}
const P = (n) => "aaaaaaaa-bbbb-4ccc-8ddd-" + String(n).padStart(12, "0");
const submit = (env, id, name, score, difficulty="medium", country="US", level=levelFor(score, difficulty)) =>   // D-51: the level this score reaches
  call(env, "/api/submit-score", { method:"POST", body:{ playerId:id, name, score, level, difficulty, country } });
const inst = (env) => [...env.LEADERBOARD_DO._instances.values()][0];
async function tick(){ await new Promise(r=>setTimeout(r,5)); }

console.log("== D-22: each difficulty keeps its own best ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "TITAN", 3000, "easy");
  inst(env).lastSubmit = {};                              // skip the 10s cooldown between runs
  await submit(env, P(1), "TITAN", 2000, "hard");
  const hard = await call(env, "/api/leaderboard?difficulty=hard");
  const easy = await call(env, "/api/leaderboard?difficulty=easy");
  ck("Hard board keeps the player's Hard 2,000", hard.data.top.some(r=>r.name==="TITAN" && r.score===2000), hard.raw.slice(0,120));
  ck("Easy board keeps the player's Easy 3,000", easy.data.top.some(r=>r.name==="TITAN" && r.score===3000));
  const all = await call(env, "/api/leaderboard");
  ck("overall board lists the player ONCE, at their single best", all.data.top.filter(r=>r.name==="TITAN").length===1 && all.data.top.find(r=>r.name==="TITAN")?.score===3000);
  const us = all.data.countries.find(c=>c.country==="US");
  ck("country counts the single best (3,000), not the sum (5,000)", us && us.totalScore===3000 && us.playerCount===1, JSON.stringify(us));
  inst(env).lastSubmit = {};
  await submit(env, P(1), "TITAN", 1500, "hard");       // lower -> must not overwrite
  const hard2 = await call(env, "/api/leaderboard?difficulty=hard");
  ck("a lower run never overwrites a difficulty best", hard2.data.top.find(r=>r.name==="TITAN")?.score===2000);
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== D-25: country leaders stay correct when a leader moves ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "BIGSHOT", 455000, "medium", "US", 9);
  await submit(env, P(2), "ALPHA", 2000, "medium", "US");
  await submit(env, P(3), "BRAVO", 1500, "medium", "US");
  inst(env).lastSubmit = {};
  await submit(env, P(1), "BIGSHOT", 10, "medium", "PH"); // moves country (best stays 455,000)
  const lb = await call(env, "/api/leaderboard");
  const us = lb.data.countries.find(c=>c.country==="US"), ph = lb.data.countries.find(c=>c.country==="PH");
  ck("former country total = remaining players (3,500 from 2)", us?.totalScore===3500 && us.playerCount===2, JSON.stringify(us));
  ck("former country's leader is no longer the departed player", us?.topName==="ALPHA" && us.topScore===2000, us?.topName+" "+us?.topScore);
  ck("new country carries the mover", ph && ph.topName==="BIGSHOT" && ph.playerCount===1);
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== D-28 / moderation: restriction excludes a player everywhere ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "CHEATER", 455000, "medium", "US", 9);
  await submit(env, P(2), "HONEST", 2000, "medium", "US");
  const f = await call(env, "/api/admin/find-player", { method:"POST", body:{ query:"CHEATER" }, headers:ADMIN });
  const pid = f.data && f.data.matches && f.data.matches[0] && f.data.matches[0].pid;
  const r = await call(env, "/api/admin/restrict", { method:"POST", body:{ pid, reason:"fake score" }, headers:ADMIN });
  ck("restrict succeeds", r.status===200, r.raw);
  const lb = await call(env, "/api/leaderboard");
  ck("restricted player gone from the leaderboard", !lb.data.top.some(x=>x.name==="CHEATER"));
  const us = lb.data.countries.find(c=>c.country==="US");
  ck("restricted player excluded from country totals and leader", us?.totalScore===2000 && us?.topName==="HONEST", JSON.stringify(us));
  inst(env).lastSubmit = {};
  const again = await submit(env, P(1), "CHEATER", 455000, "medium", "US", 9);
  ck("a restricted player can still submit (plays locally, no error)", again.status===200);
  ck("...but is given NO public rank (none fabricated)", again.data && again.data.rank===null && again.data.public===false, again.raw);
  const lb2 = await call(env, "/api/leaderboard");
  ck("...and still does not appear publicly", !lb2.data.top.some(x=>x.name==="CHEATER"));
  await call(env, "/api/admin/unrestrict", { method:"POST", body:{ pid }, headers:ADMIN });
  const lb3 = await call(env, "/api/leaderboard");
  ck("unrestrict restores the player's standing", lb3.data.top[0]?.name==="CHEATER");
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== Remove score: keeps identity and purchases; restriction stops returns ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "FAKER", 400000, "medium", "US", 9);
  inst(env).entitlements[P(1)] = ["solar"];
  const f = await call(env, "/api/admin/find-player", { method:"POST", body:{ query:"FAKER" }, headers:ADMIN });
  const pid = f.data?.matches?.[0]?.pid;
  const rm = await call(env, "/api/admin/remove-score", { method:"POST", body:{ pid }, headers:ADMIN });
  ck("remove-score succeeds", rm.status===200, rm.raw);
  const ent = await call(env, "/api/entitlements?playerId="+P(1));
  ck("purchases are NOT touched by remove-score", ent.data.skus.includes("solar"));
  ck("remove-score does NOT reset the submit cooldown", inst(env).lastSubmit[P(1)] > 0);
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== Public tags: longer than 4 hex, stable, collision-checked ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "TITAN", 3000); await submit(env, P(2), "TITAN", 2000);
  const lb = await call(env, "/api/leaderboard");
  const tags = lb.data.top.map(r=>r.tag);
  ck("every row has a tag of 6+ characters", tags.every(t=>typeof t==="string" && /^[0-9A-Z]{6,}$/.test(t)), tags.join(","));
  ck("two TITANs have different tags", tags[0] !== tags[1]);
  const lb2 = await call(env, "/api/leaderboard");
  ck("tags are stable between reads", lb2.data.top.map(r=>r.tag).join()===tags.join());
  ck("no tag or row reveals a playerId", !lb.raw.includes(P(1)) && !lb.raw.includes(P(2)));
  const me = await submit(env, P(3), "NOVA", 9);
  ck("submit response tells the player their own tag", me.data && /^[0-9A-Z]{6,}$/.test(me.data.tag||""), me.raw);
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== Name bans: display replaced, personal best preserved ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "SMUGGLER", 3000);
  const b = await call(env, "/api/admin/name-ban", { method:"POST", body:{ name:"smuggler" }, headers:ADMIN });
  ck("name-ban succeeds", b.status===200, b.raw);
  const lb = await call(env, "/api/leaderboard");
  const row = lb.data.top[0] || {};
  ck("banned name is shown as PILOT", row.name==="PILOT" && row.score===3000, JSON.stringify(row));
  ck("the stored best is not destroyed", inst(env).players[P(1)] && JSON.stringify(inst(env).players[P(1)]).includes("3000"));
  await call(env, "/api/admin/name-unban", { method:"POST", body:{ name:"SMUGGLER" }, headers:ADMIN });
  ck("unban restores the name", (await call(env, "/api/leaderboard")).data.top[0]?.name==="SMUGGLER");
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== Unusual submissions are flagged -- never auto-punished ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "STEADY", 3000);
  await submit(env, P(2), "ROCKET", 450000, "medium", "US", 9);
  const ex = await call(env, "/api/admin/exceptions", { method:"POST", body:{}, headers:ADMIN });
  ck("the outlier is flagged for optional review", ex.status===200 && (ex.data.flags||[]).some(f=>f.name==="ROCKET"), ex.raw.slice(0,160));
  const lb = await call(env, "/api/leaderboard");
  ck("...but NOT hidden or punished automatically", lb.data.top[0]?.name==="ROCKET");
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== D-26: a paid event that cannot be fulfilled is NOT acknowledged ==");
async function webhook(env, session) {
  const payload = JSON.stringify({ id:"evt_"+Math.random(), type:"checkout.session.completed", data:{ object: session } });
  const t = Math.floor(Date.now()/1000);
  return call(env, "/api/stripe-webhook", { method:"POST", raw: payload, headers:{ "stripe-signature": await signStripe(payload, "whsec_fake", t) } });
}
const paid = (id, extra={}) => ({ id, payment_status:"paid", metadata:{ sku:"solar", playerId:P(1) }, client_reference_id:P(1), ...extra });
await (async () => { try {
  // Internal grant fails (non-OK response).
  const env = env2();
  await call(env, "/api/leaderboard");                   // create the DO
  const d = inst(env); const orig = d.handleGrant.bind(d);
  d.handleGrant = async () => new Response(JSON.stringify({ error:"boom" }), { status:500 });
  const r = await webhook(env, paid("cs_fail_1"));
  ck("failed internal grant -> retryable non-2xx", r.status>=500, r.status+" "+r.raw);
  d.handleGrant = orig;
  const r2 = await webhook(env, paid("cs_fail_1"));
  ck("Stripe's retry then delivers", r2.status===200 && (await call(env,"/api/entitlements?playerId="+P(1))).data.skus.includes("solar"));
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();
await (async () => { try {
  // Storage throws DURING the grant: the retry must not be mistaken for a duplicate.
  const env = env2();
  await call(env, "/api/leaderboard");
  const d = inst(env); const st = d.state.storage; const origPut = st.put.bind(st); let boom = true;
  st.put = async (...a) => { if (boom) { boom = false; throw new Error("storage unavailable"); } return origPut(...a); };
  const r = await webhook(env, paid("cs_throw_1"));
  ck("thrown storage error -> retryable non-2xx", r.status>=500, r.status+" "+r.raw);
  const r2 = await webhook(env, paid("cs_throw_1"));
  const ent = await call(env, "/api/entitlements?playerId="+P(1));
  ck("retry after a failed write is NOT treated as a duplicate -- skin delivered", r2.status===200 && ent.data.skus.includes("solar"), JSON.stringify(ent.data));
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();
await (async () => { try {
  // Missing ownership binding: cannot be fulfilled by retrying; must be recorded.
  const env = env2();
  const r = await webhook(env, { id:"cs_nometa", payment_status:"paid", metadata:{} });
  const stored = [...env.LEADERBOARD.map.keys()].some(k=>k.includes("cs_nometa"));
  ck("paid event with no ownership binding is recorded as an exception", stored);
  ck("...and acknowledged only because it was durably recorded", r.status===200);
  const ex = await call(env, "/api/admin/exceptions", { method:"POST", body:{}, headers:ADMIN });
  ck("...and appears in the admin exceptions", (ex.data && ex.data.delivery || []).some(e=>e.session==="cs_nometa"));
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();
await (async () => { try {
  // Duplicate events never double-deliver.
  const env = env2();
  await webhook(env, paid("cs_dup")); await webhook(env, paid("cs_dup"));
  const ent = await call(env, "/api/entitlements?playerId="+P(1));
  ck("duplicate event -> exactly one delivery", ent.data.skus.filter(s=>s==="solar").length===1);
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== D-27: purchases found and removed WITHOUT a leaderboard entry ==");
await (async () => { try {
  const origFetch = globalThis.fetch;
  const sessions = [{ id:"cs_buyer_1", payment_status:"paid", created: 1758000000, amount_total: 299, currency:"usd",
                      customer_details:{ email:"buyer@example.com" }, payment_intent:"pi_123", metadata:{ sku:"solar", playerId:P(9) } }];
  let lastUrl = "";
  globalThis.fetch = async (u, init) => { const s=String(u); lastUrl=s;
    // Like real Stripe: /checkout/sessions/<id> returns ONE session object;
    // /checkout/sessions?... returns a list.
    const one = s.match(/checkout\/sessions\/(cs_[A-Za-z0-9_]+)/);
    if (one) { const f = sessions.find(x=>x.id===one[1]); return new Response(JSON.stringify(f || { error:{ message:"No such session" } }), { status: f?200:404 }); }
    if (s.includes("api.stripe.com/v1/checkout/sessions")) return new Response(JSON.stringify({ data: sessions, has_more:false }), { status:200 });
    return origFetch(u, init); };
  try {
    const env = env2();
    await call(env, "/api/leaderboard");
    inst(env).entitlements[P(9)] = ["solar"];               // buyer never submitted a score
    const look = await call(env, "/api/admin/purchases", { method:"POST", body:{ email:"buyer@example.com" }, headers:ADMIN });
    ck("lookup by the buyer's email finds the purchase", look.status===200 && (look.data.purchases||[]).length===1, look.raw.slice(0,160));
    ck("lookup never returns the playerId", !look.raw.includes(P(9)));
    ck("lookup shows it was delivered", look.data?.purchases?.[0]?.delivered===true);
    const byPi = await call(env, "/api/admin/purchases", { method:"POST", body:{ reference:"pi_123" }, headers:ADMIN });
    ck("lookup by a payment reference (pi_...) works too", byPi.status===200 && /payment_intent=pi_123/.test(lastUrl), lastUrl);
    const rv = await call(env, "/api/admin/purchase-revoke", { method:"POST", body:{ session:"cs_buyer_1" }, headers:ADMIN });
    ck("revoke works with no leaderboard entry", rv.status===200 && !(await call(env,"/api/entitlements?playerId="+P(9))).data.skus.includes("solar"), rv.raw);
    const rg = await call(env, "/api/admin/purchase-grant", { method:"POST", body:{ session:"cs_buyer_1" }, headers:ADMIN });
    ck("re-deliver works", rg.status===200 && (await call(env,"/api/entitlements?playerId="+P(9))).data.skus.includes("solar"));
    const locked = await call(env, "/api/admin/purchases", { method:"POST", body:{ email:"buyer@example.com" } });
    ck("purchase lookup requires the admin password", locked.status===401);
  } finally { globalThis.fetch = origFetch; }
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== Privacy deletion is separate, and works without a leaderboard entry ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "LEAVER", 3000);
  const f = await call(env, "/api/admin/find-player", { method:"POST", body:{ query:"LEAVER" }, headers:ADMIN });
  const pid = f.data?.matches?.[0]?.pid;
  inst(env).entitlements[P(1)] = ["toxic"];
  const pd = await call(env, "/api/admin/privacy-delete", { method:"POST", body:{ pid, removePurchases:false }, headers:ADMIN });
  ck("privacy deletion removes the entry", pd.status===200 && !(await call(env,"/api/leaderboard")).data.top.some(r=>r.name==="LEAVER"));
  ck("privacy deletion keeps purchases unless asked", (await call(env,"/api/entitlements?playerId="+P(1))).data.skus.includes("toxic"));
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== Delayed events and automatic reconciliation ==");
await (async () => { try {
  const origFetch = globalThis.fetch;
  const now = Math.floor(Date.now()/1000);
  const sessions = [
    { id:"cs_recon_missing", payment_status:"paid", status:"complete", created: now-600, metadata:{ sku:"cosmic", playerId:P(7) } },
    { id:"cs_recon_nometa",  payment_status:"paid", status:"complete", created: now-600, metadata:{} },
    { id:"cs_recon_unpaid",  payment_status:"unpaid", status:"complete", created: now-600, metadata:{ sku:"toxic", playerId:P(7) } },
  ];
  globalThis.fetch = async (u, init) => { const s=String(u);
    const one = s.match(/checkout\/sessions\/(cs_[A-Za-z0-9_]+)/);
    if (one) { const f = sessions.find(x=>x.id===one[1]) || { id:one[1], payment_status:"paid", metadata:{ sku:"solar", playerId:P(8) } };
               return new Response(JSON.stringify(f), { status:200 }); }
    if (s.includes("api.stripe.com/v1/checkout/sessions")) return new Response(JSON.stringify({ data: sessions }), { status:200 });
    return origFetch(u, init); };
  try {
    // Delayed webhook: the player's return already delivered via verify-session.
    const env = env2();
    await call(env, "/api/verify-session?session_id=cs_late");
    const late = await webhook(env, { id:"cs_late", payment_status:"paid", metadata:{ sku:"solar", playerId:P(8) } });
    const ent = await call(env, "/api/entitlements?playerId="+P(8));
    ck("a delayed webhook after the return is accepted", late.status===200);
    ck("...and delivers exactly once", ent.data.skus.filter(x=>x==="solar").length===1);

    // Reconciliation, run by the 30-minute cron.
    const env3 = env2();
    const waits=[]; await worker.scheduled({}, env3, { waitUntil:(p)=>waits.push(p) }); await Promise.all(waits);
    const owned = await call(env3, "/api/entitlements?playerId="+P(7));
    ck("reconciliation delivers a paid-but-undelivered purchase", owned.data.skus.includes("cosmic"), JSON.stringify(owned.data));
    ck("reconciliation never delivers an UNPAID checkout", !owned.data.skus.includes("toxic"));
    const ex = await call(env3, "/api/admin/exceptions", { method:"POST", body:{}, headers:ADMIN });
    ck("a paid checkout with no player becomes an admin exception", (ex.data.delivery||[]).some(e=>e.session==="cs_recon_nometa"));
    const exBefore = [...env3.LEADERBOARD.map.keys()].length;
    const w2=[]; await worker.scheduled({}, env3, { waitUntil:(p)=>w2.push(p) }); await Promise.all(w2);
    ck("re-running reconciliation adds no duplicate exceptions", [...env3.LEADERBOARD.map.keys()].length===exBefore);

    // A purchase the admin revoked stays revoked.
    const rv = await call(env3, "/api/admin/purchase-revoke", { method:"POST", body:{ session:"cs_recon_missing" }, headers:ADMIN });
    const w3=[]; await worker.scheduled({}, env3, { waitUntil:(p)=>w3.push(p) }); await Promise.all(w3);
    ck("reconciliation respects an admin revocation", rv.status===200 && !(await call(env3,"/api/entitlements?playerId="+P(7))).data.skus.includes("cosmic"));

    const res = await call(env3, "/api/admin/resolve-delivery", { method:"POST", body:{ session:"cs_recon_nometa" }, headers:ADMIN });
    ck("an exception can be marked resolved", res.status===200 && !(await call(env3,"/api/admin/exceptions",{method:"POST",body:{},headers:ADMIN})).data.delivery.some(e=>e.session==="cs_recon_nometa"));
  } finally { globalThis.fetch = origFetch; }
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n== Tag collisions: same name + same short tag -> both lengthened ==");
await (async () => { try {
  const env = env2();
  await submit(env, P(1), "TITAN", 3000); await submit(env, P(2), "TITAN", 2000); await submit(env, P(3), "NOVA", 1000);
  const d = inst(env);
  // Force a collision: two hashes identical for the first 35 bits (7 tag chars).
  const forced = { [P(1)]: "abcdef0123456789", [P(2)]: "abcdef0120000000", [P(3)]: "ffffffffffffffff" };
  d.pid = async (id) => forced[id];
  // RC2.8.1 caches hashes and the resolved tag map (D-33). A real player's
  // hash never changes; this test FORCES a change after players exist, so it
  // must clear those caches, exactly as a genuinely new identity would start.
  d.pidCache = new Map(); d.tagCache = null;
  const lb = await call(env, "/api/leaderboard");
  const t = lb.data.top.filter(r=>r.name==="TITAN").map(r=>r.tag);
  ck("colliding short tags are detected and lengthened", t.length===2 && t.every(x=>x.length===12), t.join(","));
  ck("lengthened tags differ", t[0]!==t[1]);
  ck("non-colliding players keep the short tag", lb.data.top.find(r=>r.name==="NOVA").tag.length===7);
} catch (e) { ck("section completed without crashing", false, String(e).slice(0,90)); } })();

console.log("\n"+"=".repeat(56));
console.log(F ? "  "+F+" FAILED" : "  ALL RC2.8 WORKER TESTS PASSED");
console.log("=".repeat(56));
process.exit(F?1:0);
