/**
 * FLUX worker — v4
 *
 * Changes from v3:
 *  - Leaderboard moved from KV to a single Durable Object ("global").
 *    Fixes lost updates under concurrency and eventual-consistency lag
 *    between devices.
 *  - Purchases recorded server-side (entitlements), so a paid skin
 *    survives cache clears and follows the player across devices.
 *  - Stripe webhook with real signature verification, so a purchase is
 *    recorded even if the buyer closes the tab before redirect.
 *  - Player's chosen country is honored; cf.country is the fallback.
 *  - Per-difficulty leaderboards.
 *  - Score plausibility check + per-player submit cooldown.
 */

const MAX_NAME_LEN = 16;
const MAX_SCORE = 5_000_000;
// D-41 (RC2.8.5): the game has 9 levels (play/index.html: level<9). Levels
// above 9 are refused. (RC2.8.7: the per-level score ceiling this cap fed is
// replaced by the D-51 score-to-level rule below; MAX_SCORE still applies.)
const MAX_LEVEL = 9;
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const VALID_SKUS = new Set(["toxic", "cosmic", "solar"]);

// D-51 (RC2.8.7): levels are reached by SCORE (D-50). A submission's level
// must be the level its score reaches on that difficulty, give or take one
// (a run can end during the 5-second SPEED UP countdown). This replaces the
// per-level score ceiling (score <= level * 50,000 + 5,000). MUST stay
// identical to LEVEL_SCORE_THRESHOLDS / LEVEL_SCORE_MULT in play/index.html.
const LEVEL_SCORE_THRESHOLDS = [2500, 6000, 10000, 15000, 21000, 28000, 36000, 45000];   // Medium, levels 2..9
const LEVEL_SCORE_MULT = { easy: 0.75, medium: 1, hard: 1.35 };
const LEVEL_TOLERANCE = 1;
function levelForScore(score, difficulty) {
  const m = LEVEL_SCORE_MULT[difficulty] || 1;
  let lv = 1;
  for (const t of LEVEL_SCORE_THRESHOLDS) { if (score >= Math.round(t * m)) lv++; else break; }
  return Math.min(MAX_LEVEL, lv);
}

// Minimum gap between two accepted submissions from one playerId.
const SUBMIT_COOLDOWN_MS = 10_000;

const ISO2 = /^[A-Z]{2}$/;
// Restrictive on purpose: keeps "__proto__" and friends out of the record maps.
const PLAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const validPlayerId = (v) => PLAYER_ID.test(String(v || "")) && !UNSAFE_KEYS.has(String(v));

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(reconcilePayments(env).catch((e) => console.error("reconcile:", e && e.message)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/api/")) {
        if (request.method === "OPTIONS") return preflight();

        if (path === "/api/leaderboard" && request.method === "GET") {
          return withCors(await forwardToDO(request, env, "/leaderboard" + url.search));
        }
        if (path === "/api/submit-score" && request.method === "POST") {
          return withCors(await submitScore(request, env));
        }
        if (path === "/api/geo" && request.method === "GET") {
          const cc = (request.cf && request.cf.country) || "";
          return withCors(json({ country: ISO2.test(cc) ? cc : null }));
        }
        if (path === "/api/entitlements" && request.method === "GET") {
          return withCors(await getEntitlements(request, env));
        }
        if (path === "/api/restore-check" && request.method === "POST") {
          return withCors(await restoreCheck(request, env));   // D-35
        }
        if (path === "/api/create-checkout-session" && request.method === "POST") {
          return withCors(await createCheckout(request, env));
        }
        if (path === "/api/verify-session" && request.method === "GET") {
          return withCors(await verifySession(request, env));
        }
        if (request.method === "POST" && path.startsWith("/api/admin/")) {
          const admin = {
            "/api/admin/find-player":       () => adminFind(request, env),
            "/api/admin/remove-score":      () => adminPidAction(request, env, "/admin-remove-score"),
            "/api/admin/restrict":          () => adminPidAction(request, env, "/admin-restrict", (b) => ({ reason: b.reason })),
            "/api/admin/unrestrict":        () => adminPidAction(request, env, "/admin-unrestrict"),
            "/api/admin/privacy-delete":    () => adminPidAction(request, env, "/admin-privacy-delete", (b) => ({ removePurchases: !!b.removePurchases })),
            "/api/admin/name-ban":          () => adminNameBan(request, env, true),
            "/api/admin/name-unban":        () => adminNameBan(request, env, false),
            "/api/admin/exceptions":        () => adminExceptions(request, env),
            "/api/admin/dismiss-flag":      () => adminDismissFlag(request, env),
            "/api/admin/resolve-delivery":  () => adminResolveDelivery(request, env),
            "/api/admin/purchases":         () => adminPurchases(request, env),
            "/api/admin/purchase-revoke":   () => adminPurchaseChange(request, env, false),
            "/api/admin/purchase-grant":    () => adminPurchaseChange(request, env, true),
            "/api/admin/issue-restore-code": () => adminIssueRestore(request, env),   // D-37
          }[path];
          if (admin) return withCors(await admin());
        }
        if (path === "/api/admin/import-kv" && request.method === "POST") {
          return withCors(await importFromKV(request, env));
        }
        if (path === "/api/stripe-webhook" && request.method === "POST") {
          // No CORS: Stripe calls this server-to-server.
          return stripeWebhook(request, env);
        }
        return withCors(json({ error: "Not found" }, 404));
      }

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("Unhandled:", err && err.stack ? err.stack : err);
      return withCors(json({ error: "Server error" }, 500));
    }
  },
};

/* ------------------------------------------------------------------ */
/* Durable Object plumbing                                             */
/* ------------------------------------------------------------------ */

function leaderboardStub(env) {
  if (!env.LEADERBOARD_DO) return null;
  const id = env.LEADERBOARD_DO.idFromName("global");
  return env.LEADERBOARD_DO.get(id);
}

async function forwardToDO(request, env, path, init) {
  const stub = leaderboardStub(env);
  if (!stub) {
    return json({ error: "Leaderboard storage is not configured (missing LEADERBOARD_DO binding)" }, 500);
  }
  return stub.fetch("https://do.internal" + path, init);
}

/* ------------------------------------------------------------------ */
/* Score submission                                                    */
/* ------------------------------------------------------------------ */

async function submitScore(request, env) {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "Invalid request body" }, 400);

  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!validPlayerId(playerId)) {
    return json({ error: "Missing or invalid playerId" }, 400);
  }

  const name = cleanName(body.name);   // A-3

  const score = Number.isFinite(body.score) ? Math.floor(body.score) : NaN;
  const level = Number.isFinite(body.level) ? Math.floor(body.level) : 1;
  const difficulty = VALID_DIFFICULTIES.has(body.difficulty) ? body.difficulty : "medium";

  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
    return json({ error: "Invalid score" }, 400);
  }
  if (!Number.isFinite(level) || level < 1 || level > MAX_LEVEL) {
    return json({ error: "Invalid level" }, 400);
  }
  if (Math.abs(level - levelForScore(score, difficulty)) > LEVEL_TOLERANCE) {   // D-51
    return json({ error: "Score is not plausible for that level" }, 422);
  }

  // Player's pick wins; cf.country is the fallback for "OTHER"/unset.
  const detected = (request.cf && request.cf.country) || "XX";
  const chosen = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
  const country = ISO2.test(chosen) ? chosen : (ISO2.test(detected) ? detected : "XX");

  return forwardToDO(request, env, "/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId, name, score, level, difficulty, country, detected }),
  });
}

async function getEntitlements(request, env) {
  const playerId = new URL(request.url).searchParams.get("playerId") || "";
  if (!validPlayerId(playerId)) return json({ error: "Missing or invalid playerId" }, 400);
  return forwardToDO(request, env, "/entitlements?playerId=" + encodeURIComponent(playerId));
}

/* D-35 (RC2.8.2): RESTORE CHECK. The game asks this before it switches the
   device to a restored pilot, so a mistyped or unknown code changes nothing.
   It answers only for the exact secret playerId it is given -- the same value
   /api/entitlements and /api/submit-score already accept -- and returns only
   what that pilot's own device already shows: name, tag, country, bests and
   owned skins. POST, so the secret is not written into URLs or access logs,
   and never cached. */
async function restoreCheck(request, env) {
  const body = await readJsonObject(request);
  const playerId = body && typeof body.playerId === "string" ? body.playerId : "";
  if (!validPlayerId(playerId)) return json({ error: "Missing or invalid playerId" }, 400, { "Cache-Control": "no-store" });
  const resp = await forwardToDO(request, env, "/restore-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  });
  const headers = new Headers(resp.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(resp.body, { status: resp.status, headers });
}

async function grantEntitlement(env, playerId, sku, sessionId) {
  if (!validPlayerId(playerId) || !VALID_SKUS.has(sku)) return false;
  const stub = leaderboardStub(env);
  if (!stub) return false;
  try {
    const resp = await stub.fetch("https://do.internal/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, sku, sessionId: sessionId || null }),
    });
    return resp.ok;
  } catch (e) {
    return false;          // D-26: a thrown storage error is a failed grant, reported to the caller
  }
}

/* ------------------------------------------------------------------ */
/* One-off KV -> Durable Object import                                 */
/* ------------------------------------------------------------------ */

const IMPORT_BATCH = 200;

/**
 * Migrates the old KV leaderboard into the Durable Object.
 *
 * Safe to run more than once: records are merged by best score and the
 * country totals are recomputed from scratch afterwards, so a second run
 * cannot double-count.
 *
 * POST /api/admin/import-kv          -> imports
 * POST /api/admin/import-kv?dryRun=1 -> reports what it would do
 *
 * Requires header: x-admin-token: <ADMIN_TOKEN secret>
 */
async function importFromKV(request, env) {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN is not configured" }, 500);
  }
  const supplied = request.headers.get("x-admin-token") || "";
  if (!timingSafeEqual(supplied, env.ADMIN_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!env.LEADERBOARD) {
    return json({ error: "Old KV namespace (LEADERBOARD) is not bound — nothing to import from" }, 400);
  }
  if (!leaderboardStub(env)) {
    return json({ error: "LEADERBOARD_DO binding missing" }, 500);
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const stats = { scanned: 0, valid: 0, skipped: 0, imported: 0, merged: 0, source: "player-keys", dryRun };
  const skippedExamples = [];

  let batch = [];
  let cursor = undefined;
  let guard = 0;

  // Primary source: the individual player:<id> records.
  do {
    const page = await env.LEADERBOARD.list({ prefix: "player:", cursor, limit: 1000 });
    for (const key of page.keys) {
      stats.scanned++;
      let rec;
      try {
        const raw = await env.LEADERBOARD.get(key.name);
        rec = raw ? JSON.parse(raw) : null;
      } catch {
        rec = null;
      }
      const clean = normaliseImported(rec, key.name);
      if (!clean) {
        stats.skipped++;
        if (skippedExamples.length < 5) skippedExamples.push(key.name);
        continue;
      }
      stats.valid++;
      batch.push(clean);
      if (batch.length >= IMPORT_BATCH && !dryRun) {
        const r = await sendImportBatch(env, batch);
        stats.imported += r.imported;
        stats.merged += r.merged;
        batch = [];
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && ++guard < 100);

  // Fallback: if there were no player: keys, salvage what meta:top holds.
  if (stats.scanned === 0) {
    stats.source = "meta:top";
    try {
      const raw = await env.LEADERBOARD.get("meta:top");
      const top = raw ? JSON.parse(raw) : [];
      for (const entry of Array.isArray(top) ? top : []) {
        stats.scanned++;
        const clean = normaliseImported(entry, "player:" + (entry && entry.playerId));
        if (!clean) {
          stats.skipped++;
          continue;
        }
        stats.valid++;
        batch.push(clean);
      }
    } catch {
      /* nothing usable */
    }
  }

  if (batch.length && !dryRun) {
    const r = await sendImportBatch(env, batch);
    stats.imported += r.imported;
    stats.merged += r.merged;
  }

  if (dryRun) {
    return json({ ...stats, skippedExamples, note: "Dry run — nothing was written." });
  }

  // Rebuild country totals from the player map. This is what makes a
  // repeat run safe.
  const stub = leaderboardStub(env);
  const recomputed = await (await stub.fetch("https://do.internal/recompute", { method: "POST" })).json();

  return json({ ...stats, skippedExamples, countries: recomputed.countries, players: recomputed.players });
}

function normaliseImported(rec, keyName) {
  if (!rec || typeof rec !== "object") return null;

  let playerId = typeof rec.playerId === "string" ? rec.playerId.trim() : "";
  if (!playerId && typeof keyName === "string" && keyName.startsWith("player:")) {
    playerId = keyName.slice("player:".length).trim();
  }
  if (!validPlayerId(playerId)) return null;

  const score = Number.isFinite(rec.score) ? Math.floor(rec.score) : NaN;
  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) return null;

  let level = Number.isFinite(rec.level) ? Math.floor(rec.level) : 1;
  if (level < 1 || level > MAX_LEVEL) level = 1;

  let name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) name = "PILOT";
  name = name.slice(0, MAX_NAME_LEN).toUpperCase();

  const difficulty = VALID_DIFFICULTIES.has(rec.difficulty) ? rec.difficulty : "medium";

  const country = typeof rec.country === "string" && ISO2.test(rec.country.trim().toUpperCase())
    ? rec.country.trim().toUpperCase()
    : "XX";

  const updatedAt = Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;

  return { playerId, name, score, level, difficulty, country, updatedAt };
}

async function sendImportBatch(env, records) {
  const stub = leaderboardStub(env);
  const resp = await stub.fetch("https://do.internal/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records }),
  });
  if (!resp.ok) return { imported: 0, merged: 0 };
  return resp.json();
}

/* ------------------------------------------------------------------ */
/* Stripe                                                              */
/* ------------------------------------------------------------------ */

async function createCheckout(request, env) {
  /* A-4: the store was closed only inside the app. Anyone sending this request
     directly could still create a checkout -- and with Sandbox's public test
     card, get a skin free that would carry over after going live. The store is
     now closed on the server too, by the STORE_OPEN variable in wrangler.jsonc.
     verify-session and the webhook are untouched, so any checkout already
     started still resolves correctly. */
  if (String(env.STORE_OPEN || "").toLowerCase() !== "true") {
    return json({ error: "The FLUX store is coming soon.", code: "STORE_CLOSED" }, 403);
  }
  const body = await readJsonObject(request);
  if (!body) return json({ error: "Invalid request body" }, 400);

  const sku = typeof body.sku === "string" ? body.sku : "";
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";

  const priceMap = {
    toxic: env.STRIPE_PRICE_TOXIC,
    cosmic: env.STRIPE_PRICE_COSMIC,
    solar: env.STRIPE_PRICE_SOLAR,
  };
  const price = Object.prototype.hasOwnProperty.call(priceMap, sku) ? priceMap[sku] : undefined;   // D-29
  if (!sku || !price) return json({ error: "Unknown or missing sku" }, 400);
  if (!validPlayerId(playerId)) {
    return json({ error: "Missing or invalid playerId — required so the purchase can be restored later" }, 400);
  }
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Server is not configured with a Stripe key yet" }, 500);
  }

  const siteUrl = env.SITE_URL || new URL(request.url).origin;
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("line_items[0][price]", price);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", `${siteUrl}/?session_id={CHECKOUT_SESSION_ID}&sku=${encodeURIComponent(sku)}`);
  params.append("cancel_url", `${siteUrl}/?checkout=cancelled`);
  params.append("metadata[sku]", sku);
  params.append("metadata[playerId]", playerId);
  params.append("client_reference_id", playerId);

  /* -------------------------------------------------------------------------
     T-9 — MODE / ENVIRONMENT CONSISTENCY CHECK

     A Price ID does not encode whether it is live or test, so a test price
     configured against a live secret key (or the reverse) produces a Checkout
     Session that looks fine here and then behaves badly on Stripe's hosted
     page. We retrieve the Price first and compare its livemode against the
     mode implied by the secret key, and fail explicitly instead of handing
     back an ambiguous purchase experience.

     No secret is ever logged or returned -- only the boolean mode.
     ------------------------------------------------------------------------- */
  const keyIsLive = /^sk_live_/.test(env.STRIPE_SECRET_KEY);
  const keyIsTest = /^sk_test_/.test(env.STRIPE_SECRET_KEY);
  if (!keyIsLive && !keyIsTest) {
    return json({ error: "Stripe key is not a recognised secret key", code: "stripe_key_malformed" }, 500);
  }
  const priceResp = await fetch(
    `https://api.stripe.com/v1/prices/${encodeURIComponent(price)}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  const priceData = await priceResp.json();
  if (!priceResp.ok) {
    return json({
      error: "This skin's price is not reachable in the configured Stripe account.",
      code: "price_not_found",
      sku,
      stripeMessage: (priceData.error && priceData.error.message) || null,
      keyMode: keyIsLive ? "live" : "test",
    }, 502);
  }
  /* Only assert a mismatch when Stripe actually told us the mode. An absent
     livemode is unknown, not proven inconsistent, and must not block a sale. */
  if (typeof priceData.livemode === "boolean" && priceData.livemode !== keyIsLive) {
    return json({
      error: "Stripe configuration mismatch: the price and the API key are in different modes.",
      code: "stripe_mode_mismatch",
      sku,
      keyMode: keyIsLive ? "live" : "test",
      priceMode: priceData.livemode ? "live" : "test",
    }, 500);
  }
  if (priceData.active === false) {
    return json({ error: "This skin's price is not active in Stripe.", code: "price_inactive", sku }, 502);
  }

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) {
    return json({
      error: (data.error && data.error.message) || "Stripe rejected the request",
      code: "session_create_failed",
      sku,
      keyMode: keyIsLive ? "live" : "test",
    }, 502);
  }
  if (!data.url) {
    return json({ error: "Stripe returned no checkout URL", code: "session_no_url", sku }, 502);
  }
  /* Safe diagnostics: session id and mode only. Useful for correlating a
     stalled hosted page with a real session; contains nothing secret. */
  return json({
    url: data.url,
    sessionId: data.id || null,
    mode: keyIsLive ? "live" : "test",
    sku,
  });
}

/* D-31 (RC2.8.1): payment confirmation and entitlement delivery are separate
   states. RC2.8 ignored the grant result here, so a paid session returned
   200 { paid: true } even when the skin was never saved. Now:
   - Stripe says paid + skin saved          -> 200 paid:true  delivered:true
   - Stripe says paid + save failed/threw   -> a durable delivery exception is
     recorded FIRST, then 200 paid:true delivered:false pendingDelivery:true
     (the webhook retry and reconciliation will finish the job)
   - ...and the exception cannot be stored  -> 503, retryable
   - not paid (unpaid, open, expired)       -> paid:false delivered:false
   Ownership is never granted from URL parameters: the session is fetched from
   Stripe with the secret key, and the player must match on the client. */
async function verifySession(request, env) {
  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (!sessionId) return json({ error: "Missing session_id" }, 400);
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Server is not configured with a Stripe key yet" }, 500);
  }

  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  const data = await resp.json();
  if (!resp.ok) {
    return json({ error: (data.error && data.error.message) || "Stripe rejected the request" }, 502);
  }

  const paid = data.payment_status === "paid";
  const sku = (data.metadata && data.metadata.sku) || null;
  const playerId = (data.metadata && data.metadata.playerId) || data.client_reference_id || null;

  if (!paid) return json({ paid: false, delivered: false, pendingDelivery: false, sku, playerId });

  if (!sku || !playerId) {
    const recorded = await recordDeliveryException(env, data, "missing ownership binding");
    if (!recorded) return json({ error: "Temporarily unable to record the payment; retry" }, 503, { "Retry-After": "30" });
    return json({ paid: true, delivered: false, pendingDelivery: true, sku, playerId });
  }

  const delivered = await grantEntitlement(env, playerId, sku, data.id || sessionId);
  if (delivered) {
    await clearDeliveryException(env, data.id || sessionId);
    return json({ paid: true, delivered: true, pendingDelivery: false, sku, playerId });
  }
  const recorded = await recordDeliveryException(env, data, "delivery failed; will retry");
  if (!recorded) return json({ error: "Temporarily unable to record the payment; retry" }, 503, { "Retry-After": "30" });
  return json({ paid: true, delivered: false, pendingDelivery: true, sku, playerId });
}

async function stripeWebhook(request, env) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: "Webhook secret not configured" }, 500);

  const signature = request.headers.get("stripe-signature") || "";
  const payload = await request.text();

  const ok = await verifyStripeSignature(payload, signature, secret);
  if (!ok) return json({ error: "Invalid signature" }, 400);

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!event || typeof event !== "object") return json({ error: "Invalid JSON" }, 400);

  if (event.type === "checkout.session.completed") {
    const session = (event.data && event.data.object) || {};
    if (session.payment_status === "paid") {
      const sku = (session.metadata && session.metadata.sku) || null;
      const playerId = (session.metadata && session.metadata.playerId) || session.client_reference_id || null;
      /* D-26: RC2.7 replied 200 "received" whether or not the skin was saved,
         so Stripe never retried a failed delivery. Now:
         - saved                        -> 200
         - not saved (error or refusal) -> 500, and Stripe retries automatically
         - no player attached           -> recorded as an exception in KV (a
           separate store); 200 only once that record exists, else 500      */
      if (sku && playerId) {
        const ok = await grantEntitlement(env, playerId, sku, session.id);
        if (!ok) return json({ error: "Delivery failed; retry" }, 500);
        await clearDeliveryException(env, session.id);      // resolved: stop showing it
      } else {
        const recorded = await recordDeliveryException(env, session, "missing ownership binding");
        if (!recorded) return json({ error: "Could not record the exception; retry" }, 500);
      }
    }
  }

  return json({ received: true });
}

async function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  if (!header) return false;

  let timestamp = null;
  const provided = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") provided.push(v);
  }
  if (!timestamp || provided.length === 0) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`)
  );
  const expected = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return provided.some((p) => timingSafeEqual(p, expected));
}

/* ===========================================================================
   AUDIT FIXES (Sep 21, 2026)
   =========================================================================== */

/* A-1: the public leaderboard must never reveal a playerId. A playerId is the
   ONLY proof of who a player is (there is no password), so exposing it let
   anyone become any listed player. The leaderboard now carries a one-way hash
   instead. playerIds are random UUIDs, so the hash cannot be reversed; a player
   recognises their own row by hashing their own id the same way. */
async function pidHash(playerId) {
  const data = new TextEncoder().encode("flux-pid:" + String(playerId));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* A-3: FLUX IDs were accepted with ANY characters. Display was always escaped
   (no code could run), but slurs, impersonation ("ADMIN") and invisible or
   direction-reversing characters could reach a worldwide leaderboard.
   Letters and numbers from any language are kept -- FLUX is global -- plus
   space . - _ ; everything else is removed. A blocked name is shown as PILOT
   rather than rejected, so the player's score still counts. */
// Blocked only as the ENTIRE name (brands, and words that are fine inside names).
const RESERVED_EXACT = new Set([
  "ADMIN", "ADMINISTRATOR", "MOD", "MODERATOR", "OFFICIAL", "SUPPORT", "STAFF",
  "SYSTEM", "DEVELOPER", "OWNER", "FLUXTEAM", "FLUX TEAM", "FLUX OFFICIAL",
  "FLUX ADMIN", "FLUX SUPPORT", "FLUX STAFF", "STRIPE", "APPLE", "GOOGLE", "ANTHROPIC",
]);
// Blocked as a word in a short name ("FLUX STAFF"), since they signal authority.
const RESERVED_WORDS = new Set(["ADMIN", "ADMINISTRATOR", "MODERATOR", "OFFICIAL", "STAFF", "DEVELOPER", "OWNER"]);
// Matched ANYWHERE after look-alike substitution and removing spaces. Only terms
// with no common innocent substring belong here.
const BLOCKED_ANYWHERE = [
  "NIGGER", "NIGGA", "FAGGOT", "TRANNY", "WETBACK", "RAGHEAD",
  "FUCK", "CUNT", "BITCH", "WHORE", "SLUT", "SHIT", "HITLER", "KKK", "PORN",
  "MOLEST", "PEDOPHILE", "JIZZ", "DILDO",
];
// Matched only as WHOLE WORDS, because they occur inside innocent words:
// GRAPE, THERAPIST, PAKISTAN, SPICY, RACCOON, ANALYST, DOCUMENT, COCKPIT,
// DICKENS, PEDOMETER, NAZIR, RETARDANT, PUSSYCAT ...
const BLOCKED_WORDS = new Set([
  "ASS", "FAG", "HOE", "TIT", "TITS", "SEX", "NIG", "JAP", "SPIC", "COON", "PAKI",
  "ANAL", "CUM", "DICK", "COCK", "RAPE", "RAPIST", "GOOK", "KIKE", "NUDE", "NAZI",
  "PEDO", "PUSSY", "RETARD", "RETARDED", "CHINK", "BEANER", "PENIS", "VAGINA",
]);

function deLeet(s) {
  return s.replace(/0/g, "O").replace(/1/g, "I").replace(/3/g, "E").replace(/4/g, "A")
    .replace(/5/g, "S").replace(/7/g, "T").replace(/8/g, "B").replace(/@/g, "A")
    .replace(/\$/g, "S").replace(/!/g, "I");
}
function isBlockedName(name) {
  const upper = String(name).toUpperCase().trim();
  if (RESERVED_EXACT.has(upper)) return true;
  const squeezed = deLeet(upper).replace(/[^A-Z]/g, "");
  if (BLOCKED_ANYWHERE.some((w) => squeezed.includes(w))) return true;
  const words = deLeet(upper).split(/[^A-Z]+/).filter(Boolean);
  if (words.some((w) => BLOCKED_WORDS.has(w))) return true;
  if (words.length <= 2 && words.some((w) => RESERVED_WORDS.has(w))) return true;
  return false;
}
function cleanName(raw) {
  let s = typeof raw === "string" ? raw : "";
  try { s = s.normalize("NFKC"); } catch (e) {}
  s = s.replace(/\p{C}/gu, "");                 // control, zero-width, bidi overrides
  s = s.replace(/[^\p{L}\p{N} ._-]/gu, "");     // letters/numbers (any script) + space . - _
  s = s.replace(/\s+/g, " ").trim().toUpperCase().slice(0, MAX_NAME_LEN).trim();
  if (!s || isBlockedName(s)) return "PILOT";
  return s;
}

/* A-2: the Privacy Policy promises to remove an entry within 30 days of a
   request, and abusive names must be removable -- but the leaderboard lives in
   a Durable Object that the Cloudflare dashboard cannot edit. These admin
   actions, guarded by the ADMIN_TOKEN secret, make both possible from the
   /admin.html page. They work by the leaderboard hash, so even the admin page
   never sees a playerId. */
function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN is not configured" }, 500);
  const supplied = request.headers.get("x-admin-token") || "";
  if (!timingSafeEqual(supplied, env.ADMIN_TOKEN)) return json({ error: "Unauthorized" }, 401);
  return null;
}
const PID_RE = /^[0-9a-f]{16}$/;
async function adminDO(request, env, doPath, payload) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  return forwardToDO(request, env, doPath, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
}
async function adminBody(request) { return (await readJsonObject(request)) || {}; }
async function adminPidAction(request, env, doPath, extra = (b) => ({})) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const b = await adminBody(request);
  if (!(typeof b.pid === "string" && PID_RE.test(b.pid))) return json({ error: "Invalid entry" }, 400);
  return adminDO(request, env, doPath, { pid: b.pid, ...extra(b) });
}
async function adminFind(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const b = await adminBody(request);
  const q = String(b.query || b.name || "").trim();
  if (!q) return json({ error: "Enter a FLUX ID or tag to search for" }, 400);
  return adminDO(request, env, "/admin-find", { q });
}
/* D-37 (RC2.8.3): ISSUE RESTORE CODE. Lets the owner hand a player back their
   pilot. Safeguards:
     - admin password (requireAdmin), like every admin action;
     - a written reason is REQUIRED -- how the player's ownership was checked;
     - the issue is written to a permanent log (time, tag, name, reason) BEFORE
       the code is returned; if the log cannot be saved, no code is issued;
     - the log never contains the code or the playerId;
     - the response is never cached, and the admin page shows it once. */
const RESTORE_REASON_MIN = 3;
const RESTORE_REASON_MAX = 200;
async function adminIssueRestore(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const b = await adminBody(request);
  if (!(typeof b.pid === "string" && PID_RE.test(b.pid))) return json({ error: "Invalid entry" }, 400, { "Cache-Control": "no-store" });
  const reason = typeof b.reason === "string" ? b.reason.replace(/\s+/g, " ").trim() : "";
  if (reason.length < RESTORE_REASON_MIN) return json({ error: "Write how you verified this player (kept on record)." }, 400, { "Cache-Control": "no-store" });
  const resp = await adminDO(request, env, "/admin-issue-restore", { pid: b.pid, reason: reason.slice(0, RESTORE_REASON_MAX) });
  const headers = new Headers(resp.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(resp.body, { status: resp.status, headers });
}
/* Same format and checksum as makeRestoreCode() in public/play/index.html. */
async function restoreCodeFor(playerId) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("flux-restore:" + playerId));
  const check = [...new Uint8Array(buf)].slice(0, 2).map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  return "FX1-" + playerId + "-" + check;
}

async function adminNameBan(request, env, on) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const b = await adminBody(request);
  return adminDO(request, env, on ? "/admin-name-ban" : "/admin-name-unban", { name: String(b.name || "") });
}
/* Exceptions = informational flags (DO) + unresolved payment deliveries (KV). */
async function adminExceptions(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const resp = await forwardToDO(request, env, "/admin-overview", { method: "POST" });
  const overview = await resp.json();
  overview.delivery = await listDeliveryExceptions(env);
  return json(overview);
}
async function adminDismissFlag(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const b = await adminBody(request);
  return adminDO(request, env, "/admin-dismiss-flag", { id: String(b.id || "") });
}
async function adminResolveDelivery(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const b = await adminBody(request);
  if (!env.LEADERBOARD || !b.session) return json({ error: "Nothing to resolve" }, 400);
  await env.LEADERBOARD.delete(DELIVERY_PREFIX + String(b.session));
  return json({ ok: true });
}

/* D-27: purchases, found WITHOUT a leaderboard entry. Buyers rarely know their
   Checkout Session ID, so lookup uses what they do have: the email address on
   their Stripe receipt, or a payment reference (pi_...) from the Stripe
   dashboard. Results never include the playerId; only its public tag. Email
   addresses are used for the lookup only and are never logged or stored. */
async function stripeGet(env, pathAndQuery) {
  const resp = await fetch("https://api.stripe.com/v1/" + pathAndQuery, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((data.error && data.error.message) || "Stripe rejected the request");
  return data;
}
async function ownsSku(env, playerId, sku) {
  const stub = leaderboardStub(env);
  const r = await stub.fetch("https://do.internal/entitlements?playerId=" + encodeURIComponent(playerId));
  const d = await r.json();
  return (d.skus || []).includes(sku);
}
async function adminPurchases(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Stripe is not configured" }, 500);
  const b = await adminBody(request);
  const email = typeof b.email === "string" ? b.email.trim() : "";
  const ref = typeof b.reference === "string" ? b.reference.trim() : "";
  let query;
  if (/^pi_[A-Za-z0-9]+$/.test(ref)) query = "payment_intent=" + encodeURIComponent(ref);
  else if (/^cs_[A-Za-z0-9_]+$/.test(ref)) query = null;
  else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) query = "customer_details[email]=" + encodeURIComponent(email);
  else return json({ error: "Enter the buyer's email address or a payment reference (pi_...)" }, 400);
  try {
    const list = query ? (await stripeGet(env, "checkout/sessions?limit=20&" + query)).data || []
                       : [await stripeGet(env, "checkout/sessions/" + encodeURIComponent(ref))];
    const purchases = [];
    for (const sesh of list) {
      const sku = (sesh.metadata && sesh.metadata.sku) || null;
      const playerId = (sesh.metadata && sesh.metadata.playerId) || sesh.client_reference_id || null;
      const pid = playerId ? await pidHash(playerId) : null;
      purchases.push({
        session: sesh.id, sku, paid: sesh.payment_status === "paid",
        created: sesh.created || null, amount: sesh.amount_total || null, currency: sesh.currency || null,
        tag: pid ? tagFromPid(pid, 7) : null,
        delivered: playerId && sku ? await ownsSku(env, playerId, sku) : false,
        deliverable: !!(playerId && sku),
      });
    }
    return json({ ok: true, purchases });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}
async function adminPurchaseChange(request, env, grant) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Stripe is not configured" }, 500);
  const b = await adminBody(request);
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(b.session || ""))) return json({ error: "Invalid purchase" }, 400);
  let sesh;
  try { sesh = await stripeGet(env, "checkout/sessions/" + encodeURIComponent(b.session)); }
  catch (e) { return json({ error: e.message }, 502); }
  const sku = (sesh.metadata && sesh.metadata.sku) || null;
  const playerId = (sesh.metadata && sesh.metadata.playerId) || sesh.client_reference_id || null;
  if (!sku || !playerId) return json({ error: "That payment has no player attached — handle it in the Stripe dashboard" }, 409);
  if (grant && sesh.payment_status !== "paid") return json({ error: "That payment is not marked paid" }, 409);
  const stub = leaderboardStub(env);
  const r = await stub.fetch("https://do.internal/" + (grant ? "grant" : "revoke"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(grant ? { playerId, sku, sessionId: sesh.id, force: true } : { playerId, sku }),
  });
  if (!r.ok) return json({ error: "Could not update the purchase record" }, 500);
  if (grant) await env.LEADERBOARD?.delete(DELIVERY_PREFIX + sesh.id);
  return json({ ok: true, sku, granted: grant });
}

/* D-26: payment delivery exceptions live in KV -- a DIFFERENT store from the
   Durable Object that holds purchases -- so a failure there cannot also erase
   the record that it failed. */
const DELIVERY_PREFIX = "exception:delivery:";
async function recordDeliveryException(env, session, reason) {
  if (!env.LEADERBOARD) return false;
  try {
    await env.LEADERBOARD.put(DELIVERY_PREFIX + session.id, JSON.stringify({
      session: session.id, reason, at: Date.now(),
      paid: session.payment_status === "paid",
      sku: (session.metadata && session.metadata.sku) || null,
      amount: session.amount_total || null, currency: session.currency || null,
    }));
    return true;
  } catch (e) { return false; }
}
async function clearDeliveryException(env, sessionId) {
  if (!env.LEADERBOARD || !sessionId) return;
  try { await env.LEADERBOARD.delete(DELIVERY_PREFIX + sessionId); } catch (e) {}
}
async function listDeliveryExceptions(env) {
  if (!env.LEADERBOARD) return [];
  const out = [];
  const page = await env.LEADERBOARD.list({ prefix: DELIVERY_PREFIX });
  for (const k of page.keys || []) {
    try { out.push(JSON.parse(await env.LEADERBOARD.get(k.name))); } catch (e) {}
  }
  return out.sort((a, b) => b.at - a.at);
}

/* Automatic reconciliation (cron, every 30 minutes): every paid checkout from
   the last 72 hours is checked against the purchase records and delivered if
   missing. Independent of the webhook and of the write that may have failed.
   A purchase the admin deliberately revoked stays revoked (its session is
   already recorded as handled). */
/* D-34 (RC2.8.1): reconciliation follows Stripe's pagination. RC2.8 read one
   page of 100 and stopped, so busy periods could leave purchases unchecked.
   WINDOW: completed checkouts created in the last 72 hours, checked every 30
   minutes -- so every payment is re-checked about 144 times before it ages out.
   Older payments are NOT covered automatically; the admin purchase lookup
   handles those. Idempotent: owned skins are skipped, grants are keyed by
   session, and a skin the admin revoked stays revoked (its session is already
   recorded as handled). Failures are recorded and the run continues. */
const RECONCILE_WINDOW_SEC = 72 * 3600;
const RECONCILE_MAX_PAGES = 50;          // 5,000 sessions per run; a safety stop, not a window
async function reconcilePayments(env) {
  if (!env.STRIPE_SECRET_KEY) return { skipped: true };
  const since = Math.floor(Date.now() / 1000) - RECONCILE_WINDOW_SEC;
  let delivered = 0, exceptions = 0, checked = 0, pages = 0, after = null;
  const seen = new Set();
  do {
    const q = "checkout/sessions?limit=100&status=complete&created[gte]=" + since + (after ? "&starting_after=" + encodeURIComponent(after) : "");
    const page = await stripeGet(env, q);
    const list = page.data || [];
    pages++;
    for (const sesh of list) {
      if (!sesh || seen.has(sesh.id)) continue;               // duplicates across pages
      seen.add(sesh.id); checked++;
      if (sesh.payment_status !== "paid") continue;          // unpaid, expired, cancelled: never
      const sku = (sesh.metadata && sesh.metadata.sku) || null;
      const playerId = (sesh.metadata && sesh.metadata.playerId) || sesh.client_reference_id || null;
      if (!sku || !playerId) {
        if (!(await env.LEADERBOARD?.get(DELIVERY_PREFIX + sesh.id))) { await recordDeliveryException(env, sesh, "missing ownership binding"); exceptions++; }
        continue;
      }
      try {
        if (await ownsSku(env, playerId, sku)) { await clearDeliveryException(env, sesh.id); continue; }
        const ok = await grantEntitlement(env, playerId, sku, sesh.id);
        if (ok) { delivered++; await clearDeliveryException(env, sesh.id); }
        else { await recordDeliveryException(env, sesh, "delivery failed; will retry"); exceptions++; }
      } catch (e) {
        await recordDeliveryException(env, sesh, "delivery failed; will retry"); exceptions++;
      }
    }
    after = page.has_more && list.length ? list[list.length - 1].id : null;
  } while (after && pages < RECONCILE_MAX_PAGES);
  return { checked, delivered, exceptions, pages, windowHours: RECONCILE_WINDOW_SEC / 3600 };
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Durable Object                                                      */
/* ------------------------------------------------------------------ */

/* D-29 (RC2.8.1): PROTOTYPE-SAFE MAPS.
   Player IDs, session IDs and names are untrusted strings. Used as keys in
   ordinary objects, names like "toString", "valueOf" or "hasOwnProperty"
   resolved to INHERITED functions and were mistaken for stored records -- the
   server crashed with 500. Every server map is now a prototype-free object
   (Object.create(null)): no inherited keys, and "__proto__" is an ordinary own
   key rather than a prototype setter. No blocklist of special names involved. */
function NP(o) {
  const n = Object.create(null);
  if (o) for (const k of Object.keys(o)) n[k] = o[k];
  return n;
}
function setKey(o, k, v) { const n = NP(o); n[k] = v; return n; }
function dropKey(o, k) { const n = NP(o); delete n[k]; return n; }
function ownGet(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }

export class LeaderboardDO {
  /* RC2.8 DATA MODEL
     players[playerId] = { playerId, name, country, updatedAt,
                           bests: { easy?, medium?, hard? : {score, level, updatedAt} } }
     D-22: RC2.7 kept ONE best per player and then filtered it by difficulty, so
     a higher Easy score hid the player's Hard score entirely. Each difficulty now
     keeps its own best. Legacy single-score records convert as they load.
     restricted[pidHash] = {at, reason}      moderation, keyed by the public hash
     nameBans[normalisedName] = {at}         exact-name bans, display only
     flags[]                                  unusual submissions, informational */
  constructor(state) {
    this.state = state;
    this.ready = false;
    this.pidCache = new Map();
  }

  async load() {
    if (this.ready) return;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.ready) return;
      const raw = (await this.state.storage.get("players")) || {};
      this.players = Object.create(null);                       // D-29
      for (const id of Object.keys(raw)) this.players[id] = normaliseRecord(raw[id], id);
      this.countries = NP(await this.state.storage.get("countries"));
      this.entitlements = NP(await this.state.storage.get("entitlements"));
      this.seenSessions = NP(await this.state.storage.get("seenSessions"));
      this.lastSubmit = NP(await this.state.storage.get("lastSubmit"));
      this.restricted = NP(await this.state.storage.get("restricted"));
      this.nameBans = NP(await this.state.storage.get("nameBans"));
      this.tagCache = null;
      this.flags = (await this.state.storage.get("flags")) || [];
      const rl = await this.state.storage.get("restoreLog");
      this.restoreLog = Array.isArray(rl) ? rl : [];
      this.ready = true;
    });
  }

  async pid(playerId) {
    if (!this.pidCache.has(playerId)) this.pidCache.set(playerId, await pidHash(playerId));
    return this.pidCache.get(playerId);
  }
  async isRestricted(playerId) { return !!ownGet(this.restricted, await this.pid(playerId)); }
  displayName(r) {
    const n = cleanName(r.name);
    return ownGet(this.nameBans, normaliseForBan(r.name)) ? "PILOT" : n;
  }
  async findPlayerIdByPid(pid) {
    for (const id of new Set([...Object.keys(this.players), ...Object.keys(this.entitlements)])) {
      if ((await this.pid(id)) === pid) return id;
    }
    return null;
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const route = {
      "/leaderboard": () => this.handleLeaderboard(url),
      "/submit": () => this.handleSubmit(request),
      "/entitlements": () => this.handleEntitlements(url),
      "/restore-check": () => this.handleRestoreCheck(request),
      "/grant": () => this.handleGrant(request),
      "/revoke": () => this.handleRevoke(request),
      "/import": () => this.handleImport(request),
      "/recompute": () => this.handleRecompute(),
      "/admin-find": () => this.handleAdminFind(request),
      "/admin-remove-score": () => this.handleAdminRemoveScore(request),
      "/admin-restrict": () => this.handleAdminRestrict(request, true),
      "/admin-unrestrict": () => this.handleAdminRestrict(request, false),
      "/admin-privacy-delete": () => this.handleAdminPrivacyDelete(request),
      "/admin-name-ban": () => this.handleAdminNameBan(request, true),
      "/admin-name-unban": () => this.handleAdminNameBan(request, false),
      "/admin-overview": () => this.handleAdminOverview(),
      "/admin-dismiss-flag": () => this.handleAdminDismissFlag(request),
      "/admin-issue-restore": () => this.handleAdminIssueRestore(request),
    }[url.pathname];
    return route ? route() : json({ error: "Not found" }, 404);
  }

  /* Public rows for one board. No difficulty = each player's single best. */
  async publicRows(difficulty) {
    const rows = [];
    for (const r of Object.values(this.players)) {
      if (await this.isRestricted(r.playerId)) continue;       // moderation exclusion
      const b = difficulty ? r.bests[difficulty] : bestOf(r);
      if (!b) continue;
      rows.push({ r, score: b.score, level: b.level, difficulty: difficulty || b.difficulty, updatedAt: b.updatedAt || r.updatedAt || 0 });
    }
    rows.sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);
    return rows;
  }

  /* D-33 (RC2.8.1): public tags resolved over the COMPLETE player set.
     RC2.8 checked collisions only among the rows in one response, so a
     same-name player outside the top 25 could make a tag short in one view and
     long in another. The tag map is now computed once over every player
     (restricted included, so restricting someone never changes another
     player's tag) and cached until players or name bans change. Every view --
     leaderboard, World Grid, country leaders, submit response, admin -- reads
     this one map. 7 characters normally; 12 where two players share a displayed
     name and a short tag. */
  async tagMap() {
    if (this.tagCache) return this.tagCache;
    const groups = new Map();
    const pids = [];
    for (const r of Object.values(this.players)) {
      const pid = await this.pid(r.playerId);
      pids.push(pid);
      const key = this.displayName(r) + "#" + tagFromPid(pid, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pid);
    }
    const map = new Map();
    for (const list of groups.values()) {
      for (const pid of list) map.set(pid, tagFromPid(pid, list.length > 1 ? 12 : 7));
    }
    this.tagCache = map;
    return map;
  }
  async tagFor(playerId) {
    const pid = await this.pid(playerId);
    return (await this.tagMap()).get(pid) || tagFromPid(pid, 7);
  }
  async tagRows(items) {
    const out = [];
    for (const it of items) out.push({ it, pid: await this.pid(it.r.playerId), tag: await this.tagFor(it.r.playerId) });
    return out;
  }
  invalidateTags() { this.tagCache = null; }

  async handleLeaderboard(url) {
    const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
    const difficulty = VALID_DIFFICULTIES.has(url.searchParams.get("difficulty")) ? url.searchParams.get("difficulty") : null;
    const rows = (await this.publicRows(difficulty)).slice(0, limit);
    const tagged = await this.tagRows(rows);
    const top = tagged.map((o) => ({
      pid: o.pid,                                  // A-1: a hash, never the playerId
      tag: o.tag,
      name: this.displayName(o.it.r),
      country: o.it.r.country,
      score: o.it.score,
      level: o.it.level,
      difficulty: o.it.difficulty,
    }));
    // The leader's tag comes from the SAME live tag map as every other view,
    // resolved now -- never a copy stored earlier. leaderId never leaves the server.
    const countries = [];
    for (const { leaderId, leaderPid, topTag, ...c } of Object.values(this.countries)) {
      countries.push({ ...c, topTag: leaderId ? await this.tagFor(leaderId) : "" });
    }
    countries.sort((a, b) => b.totalScore - a.totalScore);
    return json({ top, countries, leadingCountry: countries[0] || null, difficulty });
  }

  /* D-25: country figures are rebuilt from the player records every time
     something changes, so totals, counts, top scores and displayed leaders can
     never drift apart. RC2.7 subtracted a departing player's score but kept
     their name and top score as the country's leader. Each player counts once,
     at their single best public score; restricted players are excluded. */
  async recomputeCountries() {
    const totals = Object.create(null);   // D-29
    const leaders = Object.create(null);
    for (const x of await this.publicRows(null)) {
      const cc = ISO2.test(String(x.r.country || "")) ? x.r.country : "XX";
      const c = totals[cc] || (totals[cc] = { country: cc, totalScore: 0, playerCount: 0, topScore: 0, topName: "", leaderId: "" });
      c.totalScore += x.score;
      c.playerCount += 1;
      if (!leaders[cc] || x.score > leaders[cc].score) leaders[cc] = x;
    }
    for (const [cc, x] of Object.entries(leaders)) {
        totals[cc].topScore = x.score;
      totals[cc].topName = this.displayName(x.r);
      totals[cc].leaderId = x.r.playerId;           // internal only: stripped from every response
    }
    await this.state.storage.put({ countries: totals });
    this.countries = totals;
  }

  async handleSubmit(request) {
    const body = await request.json();
    const { playerId, name, score, level, difficulty, country } = body;

    const now = Date.now();
    const last = ownGet(this.lastSubmit, playerId) || 0;
    if (now - last < SUBMIT_COOLDOWN_MS) {
      return json({ error: "Slow down — too many submissions", retryAfterSec: Math.ceil((SUBMIT_COOLDOWN_MS - (now - last)) / 1000) }, 429,
                  { "Retry-After": String(Math.ceil((SUBMIT_COOLDOWN_MS - (now - last)) / 1000)) });
    }

    const prev = ownGet(this.players, playerId) || null;
    const prevBest = prev && ownGet(prev.bests, difficulty) ? prev.bests[difficulty].score : 0;
    const isNewBest = score > prevBest;
    const record = {
      playerId,
      name,                              // name and country always refresh
      country,
      updatedAt: now,
      bests: NP(prev ? prev.bests : null),
    };
    if (isNewBest) record.bests[difficulty] = { score, level, updatedAt: now };

    // Informational only: flag the unusual for optional review. Never hides or
    // punishes anyone automatically.
    const flag = await this.maybeFlag(playerId, name, difficulty, score, prevBest, now);

    // Durable first: memory changes only after the write succeeds.
    const nextPlayers = setKey(this.players, playerId, record);
    const nextLast = setKey(this.lastSubmit, playerId, now);
    const nextFlags = flag ? pruneFlags([...this.flags.filter((f) => f.id !== flag.id), flag], now) : this.flags;
    await this.state.storage.put({ players: nextPlayers, lastSubmit: nextLast, flags: nextFlags });
    this.players = nextPlayers; this.lastSubmit = nextLast; this.flags = nextFlags;
    this.invalidateTags();

    await this.recomputeCountries();

    const pid = await this.pid(playerId);
    const restricted = !!ownGet(this.restricted, pid);
    let rank = null;
    if (!restricted) {
      const rows = await this.publicRows(difficulty);
      rank = rows.findIndex((x) => x.r.playerId === playerId) + 1 || null;
    }
    const [o] = await this.tagRows([{ r: record }]);
    return json({
      ok: true, isNewBest, best: record.bests[difficulty] ? record.bests[difficulty].score : score,
      country, difficulty,
      public: !restricted,       // honest: no public rank is invented for a restricted player
      rank,
      tag: o.tag,
    });
  }

  async maybeFlag(playerId, name, difficulty, score, prevBest, now) {
    let boardTop = 0;
    for (const x of await this.publicRows(difficulty)) { if (x.r.playerId !== playerId) { boardTop = x.score; break; } }
    let reason = null;
    if (score >= FLAG_ABSOLUTE) reason = "exceptionally high score";
    else if (score >= FLAG_MIN_SCORE && boardTop > 0 && score > boardTop * FLAG_JUMP_FACTOR) reason = "far above the current #1";
    else if (score >= FLAG_MIN_SCORE && prevBest > 0 && score > prevBest * FLAG_PERSONAL_JUMP) reason = "sudden jump over this player's own best";
    if (!reason) return null;
    const pid = await this.pid(playerId);
    return { id: pid + ":" + difficulty, pid, name: cleanName(name), difficulty, score, prevBest, boardTop, reason, at: now };
  }

  /* D-35: see restoreCheck(). Known = has a score record or owns a skin.
     Nothing is written. */
  async handleRestoreCheck(request) {
    let body = null;
    try { body = await request.json(); } catch (e) {}
    const playerId = body && typeof body.playerId === "string" ? body.playerId : "";
    if (!validPlayerId(playerId)) return json({ error: "Missing or invalid playerId" }, 400);
    const rec = ownGet(this.players, playerId);
    const owned = ownGet(this.entitlements, playerId);
    const skus = Array.isArray(owned) ? owned.filter((s) => VALID_SKUS.has(s)) : [];
    if (!rec && !skus.length) return json({ found: false });
    const bests = {};
    if (rec) {
      for (const d of VALID_DIFFICULTIES) {
        const b = ownGet(rec.bests, d);
        if (b && Number.isFinite(b.score)) bests[d] = { score: b.score, level: Number.isFinite(b.level) ? b.level : 1 };
      }
    }
    return json({
      found: true,
      name: rec ? cleanName(rec.name) : "",
      tag: await this.tagFor(playerId),
      country: rec && ISO2.test(String(rec.country || "")) ? rec.country : "",
      bests,
      skus,
    });
  }

  handleEntitlements(url) {
    const playerId = url.searchParams.get("playerId") || "";
    const skus = ownGet(this.entitlements, playerId) || [];
    return json({ playerId, skus });
  }

  /* D-26: durable first. RC2.7 marked a session "seen" in memory BEFORE the
     storage write. If the write threw, Stripe's retry was waved through as a
     duplicate and the skin was never delivered. Memory now changes only after
     the write succeeds; a failed write leaves nothing behind. */
  async handleGrant(request) {
    const { playerId, sku, sessionId, force } = await request.json();
    if (!force && sessionId && ownGet(this.seenSessions, sessionId)) {
      return json({ ok: true, duplicate: true, skus: ownGet(this.entitlements, playerId) || [] });
    }
    const owned = new Set(ownGet(this.entitlements, playerId) || []);
    owned.add(sku);
    const nextEnt = setKey(this.entitlements, playerId, [...owned]);
    const nextSeen = sessionId ? setKey(this.seenSessions, sessionId, Date.now()) : this.seenSessions;
    await this.state.storage.put({ entitlements: nextEnt, seenSessions: nextSeen });
    this.entitlements = nextEnt; this.seenSessions = nextSeen;
    return json({ ok: true, skus: this.entitlements[playerId] });
  }

  async handleRevoke(request) {
    const { playerId, sku } = await request.json();
    const owned = (ownGet(this.entitlements, playerId) || []).filter((s) => s !== sku);
    const nextEnt = NP(this.entitlements);
    if (owned.length) nextEnt[playerId] = owned; else delete nextEnt[playerId];
    await this.state.storage.put({ entitlements: nextEnt });
    this.entitlements = nextEnt;
    return json({ ok: true, skus: owned });
  }

  async handleImport(request) {
    const { records } = await request.json();
    let imported = 0;
    let merged = 0;
    const next = NP(this.players);
    for (const rec of Array.isArray(records) ? records : []) {
      if (!rec || typeof rec.playerId !== "string" || !validPlayerId(rec.playerId)) continue;
      const incoming = normaliseRecord(rec, rec.playerId);
      const existing = ownGet(next, rec.playerId);
      if (!existing) { next[rec.playerId] = incoming; imported++; continue; }
      // Keep whichever run was better, per difficulty.
      const bests = NP(existing.bests);
      for (const [d, b] of Object.entries(incoming.bests)) {
        if (!bests[d] || b.score > bests[d].score) bests[d] = b;
      }
      next[rec.playerId] = { ...existing, bests };
      merged++;
    }
    await this.state.storage.put({ players: next });
    this.players = next;
    this.invalidateTags();
    return json({ ok: true, imported, merged });
  }

  async handleRecompute() {
    await this.recomputeCountries();
    return json({ ok: true, players: Object.keys(this.players).length, countries: Object.keys(this.countries).length });
  }

  /* ------------------------------ admin ------------------------------ */

  async adminView(r) {
    const pid = await this.pid(r.playerId);
    const [o] = await this.tagRows([{ r }]);
    return {
      pid, tag: o.tag, name: cleanName(r.name), shownAs: this.displayName(r), country: r.country,
      bests: r.bests, restricted: !!ownGet(this.restricted, pid), restriction: ownGet(this.restricted, pid) || null,
      updatedAt: r.updatedAt || null,
    };
  }

  async handleAdminFind(request) {
    const { q } = await request.json();
    const raw = String(q || "").toUpperCase().trim();
    // D-38: "NAME #TAG" -- the way the game shows a pilot -- must match that
    // pilot. Plain "NAME", "TAG" or "#TAG" work as before.
    const both = /^(.+?)\s*#\s*([0-9A-Z]+)$/.exec(raw);
    const query = raw.replace(/^#/, "").trim();
    const matches = [];
    for (const r of Object.values(this.players)) {
      const v = await this.adminView(r);
      const hit = both
        ? (v.name.includes(both[1].trim()) && (v.tag.startsWith(both[2]) || tagFromPid(v.pid, 12).startsWith(both[2])))
        : (v.name.includes(query) || v.tag.startsWith(query) || tagFromPid(v.pid, 12).startsWith(query));
      if (hit) matches.push(v);
    }
    matches.sort((a, b) => (bestOf({ bests: b.bests }) || { score: 0 }).score - (bestOf({ bests: a.bests }) || { score: 0 }).score);
    return json({ ok: true, matches: matches.slice(0, 25) });
  }

  /* Remove score: public scores only. Identity lives on the player's device and
     purchases are untouched. The cooldown is kept, so the same scores cannot be
     re-posted instantly. Removal alone does not prevent resubmission --
     restriction is the tool for repeated abuse. */
  async handleAdminRemoveScore(request) {
    const { pid } = await request.json();
    const id = await this.findPlayerIdByPid(pid);
    if (!id || !ownGet(this.players, id)) return json({ error: "Entry not found" }, 404);
    const removed = this.players[id];
    const next = dropKey(this.players, id);
    const nextFlags = this.flags.filter((f) => f.pid !== pid);
    await this.state.storage.put({ players: next, flags: nextFlags });
    this.players = next; this.flags = nextFlags;
    this.invalidateTags();
    await this.recomputeCountries();
    return json({ ok: true, removed: { name: cleanName(removed.name), country: removed.country } });
  }

  async handleAdminRestrict(request, on) {
    const { pid, reason } = await request.json();
    const next = NP(this.restricted);
    if (on) next[pid] = { at: Date.now(), reason: String(reason || "").slice(0, 120) };
    else delete next[pid];
    await this.state.storage.put({ restricted: next });
    this.restricted = next;
    await this.recomputeCountries();
    return json({ ok: true, restricted: on });
  }

  /* Privacy deletion: the player's scores, name, cooldown and flags are erased,
     and purchase records too if asked. A restriction record (public hash, date,
     reason) is kept while the restriction is in force, as the Privacy Policy
     states -- without it, a restriction could not be enforced. Works for
     purchase-only players with no leaderboard entry. */
  async handleAdminPrivacyDelete(request) {
    const { pid, removePurchases } = await request.json();
    const id = await this.findPlayerIdByPid(pid);
    if (!id) return json({ error: "No records found for that entry" }, 404);
    const nextPlayers = dropKey(this.players, id);
    const nextLast = dropKey(this.lastSubmit, id);
    const nextFlags = this.flags.filter((f) => f.pid !== pid);
    const nextEnt = NP(this.entitlements);
    let purchasesRemoved = 0;
    if (removePurchases && ownGet(nextEnt, id)) { purchasesRemoved = nextEnt[id].length; delete nextEnt[id]; }
    // D-37: the restore log keeps the date and tag of each issue, but the name
    // and the written reason (which may mention an email) are erased too.
    const nextLog = this.restoreLog.map((e) => (e.pid === pid ? { at: e.at, pid: e.pid, tag: e.tag, name: "", reason: "(erased on privacy request)" } : e));
    await this.state.storage.put({ players: nextPlayers, lastSubmit: nextLast, flags: nextFlags, entitlements: nextEnt, restoreLog: nextLog });
    this.players = nextPlayers; this.lastSubmit = nextLast; this.flags = nextFlags; this.entitlements = nextEnt; this.restoreLog = nextLog;
    this.invalidateTags();
    await this.recomputeCountries();
    return json({ ok: true, purchasesRemoved, restrictionKept: !!ownGet(this.restricted, pid) });
  }

  async handleAdminNameBan(request, on) {
    const { name } = await request.json();
    const key = normaliseForBan(name);
    if (!key) return json({ error: "Enter a name" }, 400);
    const next = NP(this.nameBans);
    if (on) next[key] = { at: Date.now() }; else delete next[key];
    await this.state.storage.put({ nameBans: next });
    this.nameBans = next;
    this.invalidateTags();
    await this.recomputeCountries();
    return json({ ok: true, name: key, banned: on });
  }

  async handleAdminOverview() {
    const now = Date.now();
    return json({
      ok: true,
      flags: pruneFlags(this.flags, now).sort((a, b) => b.at - a.at),
      nameBans: Object.keys(this.nameBans).sort(),
      restrictedCount: Object.keys(this.restricted).length,
      restoreLog: this.restoreLog.slice(-RESTORE_LOG_SHOWN).reverse(),   // D-37
    });
  }

  /* D-37: log first, durably; only then return the code. */
  async handleAdminIssueRestore(request) {
    const { pid, reason } = await request.json();
    const id = await this.findPlayerIdByPid(pid);
    if (!id) return json({ error: "Entry not found" }, 404);
    const rec = ownGet(this.players, id);
    const tag = await this.tagFor(id);
    const name = rec ? cleanName(rec.name) : "";
    const entry = { at: Date.now(), pid, tag, name, reason: String(reason || "").slice(0, RESTORE_REASON_MAX) };
    const next = [...this.restoreLog, entry].slice(-RESTORE_LOG_MAX);
    try { await this.state.storage.put({ restoreLog: next }); }
    catch (e) { return json({ error: "Could not record this in the log, so no code was issued. Try again." }, 503); }
    this.restoreLog = next;
    return json({ ok: true, code: await restoreCodeFor(id), tag, name });
  }

  async handleAdminDismissFlag(request) {
    const { id } = await request.json();
    const next = this.flags.filter((f) => f.id !== id);
    await this.state.storage.put({ flags: next });
    this.flags = next;
    return json({ ok: true });
  }
}

/* Records: legacy single-score -> per-difficulty bests. */
function normaliseRecord(r, id) {
  if (r && r.bests && typeof r.bests === "object") return { ...r, bests: NP(r.bests), playerId: r.playerId || id };
  const d = VALID_DIFFICULTIES.has(r && r.difficulty) ? r.difficulty : "medium";
  const bests = Object.create(null);
  if (r && Number.isFinite(r.score)) bests[d] = { score: r.score, level: r.level || 1, updatedAt: r.updatedAt || 0 };
  return { playerId: (r && r.playerId) || id, name: r && r.name, country: r && r.country, updatedAt: (r && r.updatedAt) || 0, bests };
}
function bestOf(r) {
  let best = null;
  for (const [d, b] of Object.entries((r && r.bests) || {})) {
    if (b && (!best || b.score > best.score)) best = { ...b, difficulty: d };
  }
  return best;
}
/* Crockford base32 from the hex leaderboard hash (no I, L, O, U). */
function tagFromPid(pidHex, len) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = "";
  for (const ch of String(pidHex)) bits += parseInt(ch, 16).toString(2).padStart(4, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length && out.length < len; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
/* Name bans compare the cleaned form, ignoring spacing and look-alike digits. */
function normaliseForBan(raw) {
  let s = typeof raw === "string" ? raw : "";
  try { s = s.normalize("NFKC"); } catch (e) {}
  s = s.replace(/\p{C}/gu, "").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, MAX_NAME_LEN).trim();
  return s;
}
const FLAG_ABSOLUTE = 1_000_000;
const FLAG_MIN_SCORE = 20_000;
const FLAG_JUMP_FACTOR = 3;
const FLAG_PERSONAL_JUMP = 10;
const FLAG_RETENTION_MS = 90 * 24 * 3600 * 1000;   // flags auto-expire after 90 days
const FLAG_MAX = 200;
const RESTORE_LOG_MAX = 500;    // D-37: kept, not time-pruned; newest 500
const RESTORE_LOG_SHOWN = 25;
function pruneFlags(flags, now) {
  return flags.filter((f) => now - f.at < FLAG_RETENTION_MS).slice(-FLAG_MAX);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function readJsonObject(request) {
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw || "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
};

function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

function withCors(resp) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
