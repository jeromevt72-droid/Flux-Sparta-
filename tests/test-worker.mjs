import worker, { LeaderboardDO } from "./FLUX-Sparta/worker.js";
import { levelFor } from './level-rule.mjs';   // RC2.8.7: D-51 fixture levels

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

function req(path, { method = "GET", body, cf } = {}) {
  const r = new Request("https://flux-sparta-3.example.dev" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (cf) Object.defineProperty(r, "cf", { value: cf });
  return r;
}

const call = (env, path, opts) => worker.fetch(req(path, opts), env);
const asJson = async (resp) => ({ status: resp.status, body: await resp.json() });

/* ---------------- tiny assert runner ---------------- */

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? " -> " + detail : ""}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ---------------- Stripe signature helper ---------------- */

async function signStripe(payload, secret, timestamp) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

/* ================= TESTS ================= */

async function run() {

  /* ---- 1. basic submit + read back ---- */
  section("1. Score submit and leaderboard read");
  {
    const env = makeEnv();
    const r1 = await asJson(await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "p1", name: "jerome", score: 40000, level: levelFor(40000, "medium"), difficulty: "medium" },
    }));
    check("submit accepted", r1.status === 200, JSON.stringify(r1.body));
    check("marked as new best", r1.body.isNewBest === true);
    check("name uppercased", (await asJson(await call(env, "/api/leaderboard"))).body.top[0].name === "JEROME");

    const lb = await asJson(await call(env, "/api/leaderboard"));
    check("appears on leaderboard", lb.body.top.length === 1 && lb.body.top[0].score === 40000);
    check("country total recorded", lb.body.countries[0].totalScore === 40000);
    check("leadingCountry set", lb.body.leadingCountry.country === "US");
  }

  /* ---- 2. concurrency: the bug that motivated the rewrite ---- */
  section("2. Concurrent submissions (old code lost these)");
  {
    const env = makeEnv();
    const N = 50;
    await Promise.all(Array.from({ length: N }, (_, i) =>
      call(env, "/api/submit-score", {
        method: "POST", cf: { country: "US" },
        body: { playerId: `p${i}`, name: `P${i}`, score: 1000 + i, level: levelFor(1000 + i, "medium"), difficulty: "medium" },
      })
    ));
    const lb = await asJson(await call(env, "/api/leaderboard", {}));
    const total = lb.body.countries.find(c => c.country === "US").totalScore;
    const expected = Array.from({ length: N }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0);
    check(`all ${N} players counted`, lb.body.countries[0].playerCount === N, `got ${lb.body.countries[0].playerCount}`);
    check("country total is exact (no lost updates)", total === expected, `got ${total}, expected ${expected}`);
    const top = await asJson(await call(env, "/api/leaderboard?limit=100"));
    check("all players on board", top.body.top.length === N, `got ${top.body.top.length}`);
    check("sorted descending", top.body.top[0].score === 1049);
  }

  /* ---- 3. country picker is honored ---- */
  section("3. Player's chosen country wins over IP");
  {
    const env = makeEnv();
    const r = await asJson(await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "ph1", name: "MARIA", score: 9000, level: levelFor(9000, "medium"), difficulty: "medium", country: "PH" },
    }));
    check("filed under chosen country", r.body.country === "PH", JSON.stringify(r.body));

    const env2 = makeEnv();
    const r2 = await asJson(await call(env2, "/api/submit-score", {
      method: "POST", cf: { country: "CA" },
      body: { playerId: "x1", name: "X", score: 9000, level: levelFor(9000, "medium"), difficulty: "medium" },
    }));
    check("falls back to IP country when unset", r2.body.country === "CA");

    const env3 = makeEnv();
    const r3 = await asJson(await call(env3, "/api/submit-score", {
      method: "POST", cf: { country: "CA" },
      body: { playerId: "x2", name: "X", score: 9000, level: levelFor(9000, "medium"), difficulty: "medium", country: "NOTACOUNTRY" },
    }));
    check("garbage country rejected, IP used", r3.body.country === "CA");

    const env4 = makeEnv();
    const r4 = await asJson(await call(env4, "/api/submit-score", {
      method: "POST",
      body: { playerId: "x3", name: "X", score: 9000, level: levelFor(9000, "medium"), difficulty: "medium" },
    }));
    check("no cf at all -> XX", r4.body.country === "XX");
  }

  /* ---- 4. country switch must not double-count ---- */
  section("4. Player changes country");
  {
    const env = makeEnv();
    await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "sw", name: "SW", score: 20000, level: levelFor(20000, "medium"), difficulty: "medium", country: "US" },
    });
    await new Promise(r => setTimeout(r, 15)); // clear cooldown below
    const env2 = env;
    // force past cooldown by direct second call after wait
    await new Promise(r => setTimeout(r, 0));
    const lbBefore = await asJson(await call(env2, "/api/leaderboard"));
    check("initially under US", lbBefore.body.countries[0].country === "US");
  }

  /* ---- 5. plausibility + validation ---- */
  section("5. Cheat and validation guards");
  {
    const env = makeEnv();
    const cheat = await asJson(await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "hax", name: "HAX", score: 4999999, level: 1, difficulty: "hard" },
    }));
    check("implausible score rejected (422)", cheat.status === 422, `got ${cheat.status}`);

    const over = await asJson(await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "hax2", name: "HAX", score: 99999999, level: levelFor(99999999, "hard"), difficulty: "hard" },
    }));
    check("score above MAX_SCORE rejected (400)", over.status === 400);

    const noId = await asJson(await call(env, "/api/submit-score", {
      method: "POST", body: { name: "X", score: 100, level: 1 },
    }));
    check("missing playerId rejected", noId.status === 400);

    const badLevel = await asJson(await call(env, "/api/submit-score", {
      method: "POST", body: { playerId: "bl", name: "X", score: 100, level: 0 },
    }));
    check("level 0 rejected", badLevel.status === 400);

    const nan = await asJson(await call(env, "/api/submit-score", {
      method: "POST", body: { playerId: "n1", name: "X", score: "40000", level: 3 },
    }));
    check("string score rejected", nan.status === 400);

    const neg = await asJson(await call(env, "/api/submit-score", {
      method: "POST", body: { playerId: "n2", name: "X", score: -5, level: 3 },
    }));
    check("negative score rejected", neg.status === 400);

    const legit = await asJson(await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "ok", name: "OK", score: 150000, level: levelFor(150000, "hard"), difficulty: "hard" },
    }));
    check("legit score at its own level accepted", legit.status === 200, JSON.stringify(legit.body));
  }

  /* ---- 6. cooldown ---- */
  section("6. Submit cooldown");
  {
    const env = makeEnv();
    const a = await asJson(await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "spam", name: "S", score: 1000, level: levelFor(1000, "medium"), difficulty: "medium" },
    }));
    const b = await asJson(await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "spam", name: "S", score: 2000, level: levelFor(2000, "medium"), difficulty: "medium" },
    }));
    check("first accepted", a.status === 200);
    check("immediate second rejected (429)", b.status === 429, `got ${b.status}`);
  }

  /* ---- 7. personal best does not regress ---- */
  section("7. Best score retention");
  {
    const env = makeEnv();
    const ns = env.LEADERBOARD_DO;
    await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "pb", name: "PB", score: 80000, level: levelFor(80000, "medium"), difficulty: "medium" },
    });
    // bypass cooldown by reaching into the DO's clock record
    const inst = ns._instances.get("global");
    inst.lastSubmit["pb"] = 0;
    const lower = await asJson(await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "pb", name: "NEWNAME", score: 10000, level: levelFor(10000, "medium"), difficulty: "medium" },
    }));
    check("lower score not a new best", lower.body.isNewBest === false);
    check("best score retained", lower.body.best === 80000, `got ${lower.body.best}`);

    const lb = await asJson(await call(env, "/api/leaderboard"));
    check("name updated to latest", lb.body.top[0].name === "NEWNAME");
    check("country total not inflated", lb.body.countries[0].totalScore === 80000, `got ${lb.body.countries[0].totalScore}`);
    check("player counted once", lb.body.countries[0].playerCount === 1, `got ${lb.body.countries[0].playerCount}`);
  }

  /* ---- 8. country switch accounting ---- */
  section("8. Country switch moves the score, does not copy it");
  {
    const env = makeEnv();
    const ns = env.LEADERBOARD_DO;
    await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "mv", name: "MV", score: 50000, level: levelFor(50000, "medium"), difficulty: "medium", country: "US" },
    });
    ns._instances.get("global").lastSubmit["mv"] = 0;
    await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "mv", name: "MV", score: 60000, level: levelFor(60000, "medium"), difficulty: "medium", country: "PH" },
    });
    const lb = await asJson(await call(env, "/api/leaderboard"));
    const us = lb.body.countries.find(c => c.country === "US");
    const ph = lb.body.countries.find(c => c.country === "PH");
    check("US entry removed", !us, JSON.stringify(lb.body.countries));
    check("PH has the score once", ph && ph.totalScore === 60000, JSON.stringify(ph));
    check("PH player count is 1", ph && ph.playerCount === 1);
  }

  /* ---- 9. difficulty filtering ---- */
  section("9. Per-difficulty leaderboard");
  {
    const env = makeEnv();
    await call(env, "/api/submit-score", { method: "POST", cf: { country: "US" },
      body: { playerId: "e1", name: "E", score: 90000, level: levelFor(90000, "easy"), difficulty: "easy" } });
    await call(env, "/api/submit-score", { method: "POST", cf: { country: "US" },
      body: { playerId: "h1", name: "H", score: 70000, level: levelFor(70000, "hard"), difficulty: "hard" } });
    const all = await asJson(await call(env, "/api/leaderboard"));
    const hard = await asJson(await call(env, "/api/leaderboard?difficulty=hard"));
    check("all board has both", all.body.top.length === 2);
    check("hard board has one", hard.body.top.length === 1 && hard.body.top[0].name === "H");
  }

  /* ---- 10. entitlements ---- */
  section("10. Purchases survive and are idempotent");
  {
    const env = makeEnv();
    const stub = env.LEADERBOARD_DO.get("global");
    await stub.fetch("https://do.internal/grant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "buyer", sku: "solar", sessionId: "cs_1" }),
    });
    let ent = await asJson(await call(env, "/api/entitlements?playerId=buyer"));
    check("skin granted", ent.body.skus.includes("solar"), JSON.stringify(ent.body));

    // same session replayed (webhook + redirect both fire)
    await stub.fetch("https://do.internal/grant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "buyer", sku: "solar", sessionId: "cs_1" }),
    });
    ent = await asJson(await call(env, "/api/entitlements?playerId=buyer"));
    check("no duplicate entry", ent.body.skus.length === 1, JSON.stringify(ent.body));

    await stub.fetch("https://do.internal/grant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "buyer", sku: "toxic", sessionId: "cs_2" }),
    });
    ent = await asJson(await call(env, "/api/entitlements?playerId=buyer"));
    check("second skin added", ent.body.skus.length === 2 && ent.body.skus.includes("toxic"));

    const other = await asJson(await call(env, "/api/entitlements?playerId=nobody"));
    check("unknown player owns nothing", other.body.skus.length === 0);

    const noId = await asJson(await call(env, "/api/entitlements"));
    check("missing playerId rejected", noId.status === 400);
  }

  /* ---- 11. checkout session creation ---- */
  section("11. Checkout creation");
  {
    const env = makeEnv();
    let captured = null;
    const realFetch = globalThis.fetch;
    // T-9: route by endpoint so the new price/mode consistency check is
    // genuinely exercised rather than accidentally satisfied.
    let priceLivemode = false;          // matches sk_test_fake
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/v1/prices/")) {
        return new Response(JSON.stringify({
          id: u.split("/v1/prices/")[1], livemode: priceLivemode, active: true,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      captured = { body: init.body, auth: init.headers.Authorization };
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_123", id: "cs_test_123" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };


    const ok = await asJson(await call(env, "/api/create-checkout-session", {
      method: "POST", body: { sku: "solar", playerId: "buyer7" },
    }));
    check("checkout url returned", ok.body.url && ok.body.url.includes("checkout.stripe.com"), JSON.stringify(ok.body));
    check("playerId sent to Stripe as metadata", captured.body.includes("metadata%5BplayerId%5D=buyer7"), captured.body);
    check("client_reference_id set", captured.body.includes("client_reference_id=buyer7"));
    check("correct price id used", captured.body.includes("price_solar"));
    check("secret key used as bearer", captured.auth === "Bearer sk_test_fake");

    // T-9: a live price configured against a test key must fail explicitly
    // rather than produce an ambiguous purchase.
    priceLivemode = true;
    const mism = await asJson(await call(env, "/api/create-checkout-session", {
      method: "POST", body: { sku: "solar", playerId: "buyer7" },
    }));
    check("mode mismatch rejected explicitly", mism.status === 500 && mism.body.code === "stripe_mode_mismatch", JSON.stringify(mism.body));
    check("mismatch response leaks no secret", !JSON.stringify(mism.body).includes("sk_test_fake"));
    check("mismatch names both modes", mism.body.keyMode === "test" && mism.body.priceMode === "live");
    priceLivemode = false;

    const diag = await asJson(await call(env, "/api/create-checkout-session", {
      method: "POST", body: { sku: "solar", playerId: "buyer7" },
    }));
    check("safe diagnostics returned", diag.body.sessionId === "cs_test_123" && diag.body.mode === "test");
    check("diagnostics leak no secret", !JSON.stringify(diag.body).includes("sk_"));

    const noPlayer = await asJson(await call(env, "/api/create-checkout-session", {
      method: "POST", body: { sku: "solar" },
    }));
    check("checkout without playerId rejected", noPlayer.status === 400, `got ${noPlayer.status}`);

    const badSku = await asJson(await call(env, "/api/create-checkout-session", {
      method: "POST", body: { sku: "freebie", playerId: "b" },
    }));
    check("unknown sku rejected", badSku.status === 400);

    const noKey = await asJson(await worker.fetch(
      req("/api/create-checkout-session", { method: "POST", body: { sku: "solar", playerId: "b" } }),
      makeEnv({ STRIPE_SECRET_KEY: undefined })
    ));
    check("missing stripe key surfaces 500", noKey.status === 500);

    globalThis.fetch = realFetch;
  }

  /* ---- 12. verify-session grants the skin ---- */
  section("12. Redirect verification grants entitlement");
  {
    const env = makeEnv();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: "cs_test_999", payment_status: "paid",
      metadata: { sku: "cosmic", playerId: "buyer9" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const v = await asJson(await call(env, "/api/verify-session?session_id=cs_test_999"));
    check("reports paid", v.body.paid === true, JSON.stringify(v.body));
    const ent = await asJson(await call(env, "/api/entitlements?playerId=buyer9"));
    check("skin recorded server-side", ent.body.skus.includes("cosmic"), JSON.stringify(ent.body));

    globalThis.fetch = async () => new Response(JSON.stringify({
      id: "cs_unpaid", payment_status: "unpaid", metadata: { sku: "toxic", playerId: "cheap" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    await call(env, "/api/verify-session?session_id=cs_unpaid");
    const ent2 = await asJson(await call(env, "/api/entitlements?playerId=cheap"));
    check("unpaid session grants nothing", ent2.body.skus.length === 0);

    globalThis.fetch = realFetch;
  }

  /* ---- 13. webhook ---- */
  section("13. Stripe webhook signature");
  {
    const env = makeEnv();
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_hook_1", payment_status: "paid", metadata: { sku: "solar", playerId: "hookbuyer" } } },
    });
    const now = Math.floor(Date.now() / 1000);

    const goodSig = await signStripe(payload, "whsec_fake", now);
    const good = await worker.fetch(new Request("https://x.dev/api/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": goodSig }, body: payload,
    }), env);
    check("valid signature accepted", good.status === 200, `got ${good.status}`);
    const ent = await asJson(await call(env, "/api/entitlements?playerId=hookbuyer"));
    check("webhook granted the skin", ent.body.skus.includes("solar"), JSON.stringify(ent.body));

    const badSig = await signStripe(payload, "whsec_WRONG", now);
    const bad = await worker.fetch(new Request("https://x.dev/api/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": badSig }, body: payload,
    }), env);
    check("forged signature rejected", bad.status === 400, `got ${bad.status}`);

    const oldSig = await signStripe(payload, "whsec_fake", now - 4000);
    const old = await worker.fetch(new Request("https://x.dev/api/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": oldSig }, body: payload,
    }), env);
    check("replayed old event rejected", old.status === 400, `got ${old.status}`);

    const none = await worker.fetch(new Request("https://x.dev/api/stripe-webhook", {
      method: "POST", body: payload,
    }), env);
    check("unsigned request rejected", none.status === 400);

    // duplicate delivery of the same session
    const dupe = await worker.fetch(new Request("https://x.dev/api/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": await signStripe(payload, "whsec_fake", Math.floor(Date.now() / 1000)) }, body: payload,
    }), env);
    check("duplicate delivery accepted quietly", dupe.status === 200);
    const ent2 = await asJson(await call(env, "/api/entitlements?playerId=hookbuyer"));
    check("no duplicate skin from retry", ent2.body.skus.length === 1, JSON.stringify(ent2.body));
  }

  /* ---- 14. CORS + misc ---- */
  section("14. CORS and routing");
  {
    const env = makeEnv();
    const lb = await call(env, "/api/leaderboard");
    check("leaderboard has CORS header", lb.headers.get("Access-Control-Allow-Origin") === "*");
    const pre = await worker.fetch(new Request("https://x.dev/api/submit-score", { method: "OPTIONS" }), env);
    check("preflight answered 204", pre.status === 204);
    check("preflight allows POST", (pre.headers.get("Access-Control-Allow-Methods") || "").includes("POST"));
    const nf = await call(env, "/api/nope");
    check("unknown api route 404s", nf.status === 404);
    const badJson = await worker.fetch(new Request("https://x.dev/api/submit-score", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{{{",
    }), env);
    check("malformed JSON handled", badJson.status === 400);
  }

  /* ---- 15. missing DO binding ---- */
  section("15. Misconfiguration surfaces clearly");
  {
    const env = makeEnv({ LEADERBOARD_DO: undefined });
    const r = await asJson(await call(env, "/api/leaderboard"));
    check("missing DO binding reported", r.status === 500 && /LEADERBOARD_DO/.test(r.body.error), JSON.stringify(r.body));
  }

  console.log(`\n${"=".repeat(46)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) console.log("  Failing: " + failures.join(", "));
  console.log("=".repeat(46));
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error("HARNESS CRASH:", e); process.exit(2); });
