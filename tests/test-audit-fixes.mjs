// AUDIT FIXES A-1..A-4 — runs the REAL worker.js end to end, and the REAL game
// page for the "your row" hash, and checks the two implementations agree.
import worker, { LeaderboardDO } from "./FLUX-Sparta/worker.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
    ...extra,
  };
}


const ORIGIN = "https://flux-sparta-3.example.dev";
async function call(env, p, { method="GET", body, headers={}, cf } = {}) {
  const r = new Request(ORIGIN + p, { method, headers: { ...(body ? {"Content-Type":"application/json"} : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  if (cf) Object.defineProperty(r, "cf", { value: cf });
  const res = await worker.fetch(r, env, {});
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, raw: JSON.stringify(data) };
}
const PID_A = "11111111-aaaa-4bbb-8ccc-000000000001";
const PID_B = "22222222-aaaa-4bbb-8ccc-000000000002";
async function submit(env, playerId, name, score, country="US") {
  return call(env, "/api/submit-score", { method:"POST", body:{ playerId, name, score, level: 5, difficulty:"medium", country } });
}

console.log("== A-1: the public leaderboard never reveals a playerId ==");
{
  const env = makeEnv();
  await submit(env, PID_A, "TITAN", 4000, "PH");
  await submit(env, PID_B, "NOVA", 3000, "US");
  const lb = await call(env, "/api/leaderboard?limit=25");
  ck("leaderboard answers", lb.status===200 && lb.data.top.length===2);
  ck("no playerId field on any row", lb.data.top.every(r=>!("playerId" in r)));
  ck("no playerId appears ANYWHERE in the response", !lb.raw.includes(PID_A) && !lb.raw.includes(PID_B));
  ck("every row carries a 16-hex hash instead", lb.data.top.every(r=>/^[0-9a-f]{16}$/.test(r.pid)));
  ck("hashes are distinct per player", lb.data.top[0].pid !== lb.data.top[1].pid);

  // The REAL game computes its own hash; it must equal the worker's.
  const GAME=[...fs.readFileSync(path.join(__dirname,"FLUX-Sparta","public","play","index.html"),"utf8").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  const { store, mem } = makeStore({ fluxPlayerId: PID_A, fluxCallsign:"TITAN", fluxProfileComplete:"1" });
  const g = boot(GAME, { origin: ORIGIN, path:"/play/", store });
  const mine = await g.ctx.myPidHash();
  const titanRow = lb.data.top.find(r=>r.name==="TITAN");
  ck("game's own hash == worker's hash for the same player (real code, both sides)", mine && mine===titanRow.pid, mine+" vs "+titanRow.pid);
  ck("game's hash does NOT match another player's row", mine !== lb.data.top.find(r=>r.name==="NOVA").pid);
  ck("game still uses its real playerId", mem.fluxPlayerId===PID_A);
}

console.log("\n== A-3: FLUX IDs are cleaned and filtered on the server ==");
{
  const env = makeEnv();
  const cases = [
    ["<img src=x onerror=alert(1)>", n => !/[<>=()]/.test(n), "markup characters stripped"],
    ["ADMIN", n => n==="PILOT", "impersonating ADMIN is blocked"],
    ["flux staff", n => n==="PILOT", "impersonating FLUX STAFF is blocked"],
    ["f.u.c.k", n => n==="PILOT", "dotted profanity is caught"],
    ["SH1T HEAD", n => n==="PILOT", "look-alike digits are caught"],
    ["T\u200BI\u200BT\u202EAN", n => n==="TITAN", "invisible and direction-reversing characters removed"],
    ["jos\u00e9", n => n==="JOS\u00c9", "accented letters kept"],
    ["\u5c71\u7530", n => n==="\u5c71\u7530", "non-Latin names kept (global game)"],
    ["   ", n => n==="PILOT", "empty name becomes PILOT"],
    ["abcdefghijklmnopqrstuvwxyz", n => n.length===16, "length capped at 16"],
  ];
  let i=0;
  for (const [input, okFn, label] of cases) {
    const pid = "33333333-aaaa-4bbb-8ccc-" + String(100000000000 + (i++)).slice(-12);
    await submit(env, pid, input, 1000 + i);
    const lb = await call(env, "/api/leaderboard?limit=100");
    const row = lb.data.top.find(r => r.score === 1000 + i);
    ck(label, row && okFn(row.name), row && row.name);
  }
  // Innocent names that a careless filter would block.
  const innocent = ["GRAPE","THERAPIST","PAKISTAN","SPICY","RACCOON","ANALYST","DOCUMENT","COCKPIT",
                    "DICKENS","PEDOMETER","CLASS","TITAN","DEV PATEL","NAZIR","ASSASSIN","SCRAPER","CUMBERLAND"];
  const blocked=[];
  for (const nm of innocent) {
    const pid = "44444444-aaaa-4bbb-8ccc-" + String(200000000000 + (i++)).slice(-12);
    await submit(env, pid, nm, 2000 + i);
    const lb = await call(env, "/api/leaderboard?limit=100");
    const row = lb.data.top.find(r => r.score === 2000 + i);
    if (!row || row.name !== nm) blocked.push(nm + "->" + (row && row.name));
  }
  ck("innocent names are NOT blocked ("+innocent.length+" checked)", blocked.length===0, blocked.join(", "));
  ck("a blocked name still records the score (shown as PILOT)", (await call(env,"/api/leaderboard?limit=100")).data.top.some(r=>r.name==="PILOT" && r.score>1000));
}

console.log("\n== A-3: entries stored BEFORE the filter are cleaned on the way out ==");
{
  const env = makeEnv();
  await submit(env, PID_A, "LEGIT", 500);
  // Legacy data arrives from STORAGE (RC2.7 single-score shape), then loads.
  const inst = [...env.LEADERBOARD_DO._instances.values()][0];
  const stored = (await inst.state.storage.get("players")) || {};
  stored[PID_B] = { playerId: PID_B, name: "<B>FUCK</B>", country:"US", score: 9999, level: 5, difficulty:"medium" };
  await inst.state.storage.put("players", stored);
  inst.ready = false; await inst.load();
  const lb = await call(env, "/api/leaderboard?limit=25");
  const row = lb.data.top[0];
  ck("a legacy abusive name is not served as stored", row.name==="PILOT", row.name);
}

console.log("\n== A-2: admin actions -- locked without the password ==");
{
  const env = makeEnv({ ADMIN_TOKEN: "correct-horse-battery" });
  await submit(env, PID_A, "TITAN", 4000, "PH");
  const none = await call(env, "/api/admin/find-player", { method:"POST", body:{ name:"TITAN" } });
  ck("no password -> 401", none.status===401);
  const wrong = await call(env, "/api/admin/find-player", { method:"POST", body:{ name:"TITAN" }, headers:{ "x-admin-token":"nope" } });
  ck("wrong password -> 401", wrong.status===401);
  const rm = await call(env, "/api/admin/remove-score", { method:"POST", body:{ pid:"0123456789abcdef" }, headers:{ "x-admin-token":"nope" } });
  ck("remove with wrong password -> 401", rm.status===401);
  const unset = await call(makeEnv(), "/api/admin/find-player", { method:"POST", body:{ name:"X" }, headers:{ "x-admin-token":"" } });
  ck("no ADMIN_TOKEN configured -> refuses (500), never open", unset.status===500);
  const lb = await call(env, "/api/leaderboard");
  ck("nothing was removed by the failed attempts", lb.data.top.length===1);
}

console.log("\n== A-2: admin actions -- find and remove, keeping the privacy promise ==");
{
  const env = makeEnv({ ADMIN_TOKEN: "correct-horse-battery" });
  const H = { "x-admin-token":"correct-horse-battery" };
  await submit(env, PID_A, "TITAN", 4000, "PH");
  await submit(env, PID_B, "NOVA", 3000, "PH");
  // Give TITAN a purchase record.
  const inst = [...env.LEADERBOARD_DO._instances.values()][0];
  await inst.load(); inst.entitlements[PID_A] = ["solar"];
  const found = await call(env, "/api/admin/find-player", { method:"POST", body:{ name:"tit" }, headers:H });
  ck("find by partial FLUX ID works", found.status===200 && found.data.matches.length===1 && found.data.matches[0].name==="TITAN");
  ck("find never returns a playerId", !found.raw.includes(PID_A) && !("playerId" in found.data.matches[0]));
  const before = (await call(env, "/api/leaderboard")).data.countries.find(c=>c.country==="PH");
  ck("before: PH has 2 players, 7000 points", before.playerCount===2 && before.totalScore===7000);

  const bad = await call(env, "/api/admin/remove-score", { method:"POST", body:{ pid:"not-a-hash" }, headers:H });
  ck("malformed entry id -> 400", bad.status===400);
  const ghost = await call(env, "/api/admin/remove-score", { method:"POST", body:{ pid:"0123456789abcdef" }, headers:H });
  ck("unknown entry -> 404", ghost.status===404);

  const out = await call(env, "/api/admin/remove-score", { method:"POST", body:{ pid: found.data.matches[0].pid }, headers:H });
  ck("remove succeeds", out.status===200 && out.data.removed.name==="TITAN");
  const after = await call(env, "/api/leaderboard");
  ck("TITAN is gone from the leaderboard", !after.data.top.some(r=>r.name==="TITAN"));
  ck("NOVA is untouched", after.data.top.some(r=>r.name==="NOVA" && r.score===3000));
  const ph = after.data.countries.find(c=>c.country==="PH");
  ck("country totals rebuilt: PH now 1 player, 3000 points", ph.playerCount===1 && ph.totalScore===3000, JSON.stringify(ph));
  const ent = await call(env, "/api/entitlements?playerId="+PID_A);
  ck("purchases KEPT by default (skins not taken away)", ent.data.skus.includes("solar"));

  // RC2.8: purchase deletion is a PRIVACY action, separate from Remove score.
  // RC2.8 keeps the submit cooldown after Remove score (RC2.7 reset it, so a
  // removed score could be re-posted instantly). Let the cooldown pass first.
  inst.lastSubmit = {};
  await submit(env, PID_A, "TITAN", 4100, "PH");
  const f2 = await call(env, "/api/admin/find-player", { method:"POST", body:{ name:"TITAN" }, headers:H });
  const o2 = await call(env, "/api/admin/privacy-delete", { method:"POST", body:{ pid: f2.data.matches[0].pid, removePurchases:true }, headers:H });
  ck("remove with purchases reports them", o2.data.purchasesRemoved===1);
  const ent2 = await call(env, "/api/entitlements?playerId="+PID_A);
  ck("purchase records deleted when asked", ent2.data.skus.length===0);
}

console.log("\n== A-4: the store is closed on the SERVER ==");
{
  const origFetch = globalThis.fetch; let stripeCalls=0;
  globalThis.fetch = async (u, init) => { if (String(u).includes("api.stripe.com")) { stripeCalls++; return new Response(JSON.stringify({ id:"cs_test_x", url:"https://checkout.stripe.com/c/pay/cs_test_x" }), { status:200 }); } return origFetch(u, init); };
  try {
    for (const [label, val] of [["unset", undefined], ['"false"', "false"], ['"FALSE"', "FALSE"], ["junk", "yes"]]) {
      const env = makeEnv(val === undefined ? {} : { STORE_OPEN: val });
      const r = await call(env, "/api/create-checkout-session", { method:"POST", body:{ sku:"solar", playerId: PID_A } });
      ck("STORE_OPEN "+label+" -> 403 STORE_CLOSED", r.status===403 && r.data.code==="STORE_CLOSED", r.status+" "+(r.data&&r.data.code));
    }
    ck("no request reached Stripe while closed", stripeCalls===0, String(stripeCalls));
    const open = await call(makeEnv({ STORE_OPEN:"true" }), "/api/create-checkout-session", { method:"POST", body:{ sku:"solar", playerId: PID_A } });
    ck('STORE_OPEN "true" -> checkout proceeds (post-T-9 behaviour)', open.status===200 && !!open.data.url, open.status);
  } finally { globalThis.fetch = origFetch; }
  const w = fs.readFileSync(path.join(__dirname,"FLUX-Sparta","wrangler.jsonc"),"utf8");
  ck('shipped wrangler.jsonc has STORE_OPEN "false"', /"STORE_OPEN":\s*"false"/.test(w));
}

console.log("\n== admin page is safe on its own ==");
{
  const a = fs.readFileSync(path.join(__dirname,"FLUX-Sparta","public","admin.html"),"utf8");
  const js = [...a.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join("\n");
  ck("noindex", /<meta name="robots" content="noindex,nofollow">/.test(a));
  ck("no manifest (not part of the app)", !/<link rel="manifest"/.test(a));
  ck("no service worker registration", !/serviceWorker/.test(js));
  ck("never touches player storage", !/localStorage|sessionStorage|indexedDB/.test(js));
  ck("never writes data with innerHTML", !/innerHTML/.test(js));
  ck("password field is type=password", /id="token" type="password"/.test(a));
}

console.log("\n"+"=".repeat(56));
console.log(F ? "  "+F+" FAILED" : "  ALL AUDIT-FIX TESTS PASSED");
console.log("=".repeat(56));
process.exit(F?1:0);
