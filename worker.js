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
const MAX_LEVEL = 999;
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const VALID_SKUS = new Set(["toxic", "cosmic", "solar"]);

// Highest believable score for a given level. Tune once you know the
// real ceiling of a legitimate run.
const SCORE_PER_LEVEL = 50_000;
const SCORE_BASE_ALLOWANCE = 5_000;

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
        if (path === "/api/create-checkout-session" && request.method === "POST") {
          return withCors(await createCheckout(request, env));
        }
        if (path === "/api/verify-session" && request.method === "GET") {
          return withCors(await verifySession(request, env));
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

  let name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) name = "PILOT";
  name = name.slice(0, MAX_NAME_LEN).toUpperCase();

  const score = Number.isFinite(body.score) ? Math.floor(body.score) : NaN;
  const level = Number.isFinite(body.level) ? Math.floor(body.level) : 1;
  const difficulty = VALID_DIFFICULTIES.has(body.difficulty) ? body.difficulty : "medium";

  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
    return json({ error: "Invalid score" }, 400);
  }
  if (!Number.isFinite(level) || level < 1 || level > MAX_LEVEL) {
    return json({ error: "Invalid level" }, 400);
  }
  if (score > level * SCORE_PER_LEVEL + SCORE_BASE_ALLOWANCE) {
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

async function grantEntitlement(env, playerId, sku, sessionId) {
  if (!validPlayerId(playerId) || !VALID_SKUS.has(sku)) return false;
  const stub = leaderboardStub(env);
  if (!stub) return false;
  const resp = await stub.fetch("https://do.internal/grant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId, sku, sessionId: sessionId || null }),
  });
  return resp.ok;
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
  const body = await readJsonObject(request);
  if (!body) return json({ error: "Invalid request body" }, 400);

  const sku = typeof body.sku === "string" ? body.sku : "";
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";

  const priceMap = {
    toxic: env.STRIPE_PRICE_TOXIC,
    cosmic: env.STRIPE_PRICE_COSMIC,
    solar: env.STRIPE_PRICE_SOLAR,
  };
  const price = priceMap[sku];
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

  // Record it here too, so the unlock works even if the webhook is slow
  // or was never configured. Granting is idempotent.
  if (paid && sku && playerId) {
    await grantEntitlement(env, playerId, sku, data.id || sessionId);
  }

  return json({ paid, sku, playerId });
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
      if (sku && playerId) {
        await grantEntitlement(env, playerId, sku, session.id);
      }
    }
  }

  // Always 200 on a validly signed event, or Stripe keeps retrying.
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

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Durable Object                                                      */
/* ------------------------------------------------------------------ */

export class LeaderboardDO {
  constructor(state) {
    this.state = state;
    this.ready = false;
  }

  async load() {
    if (this.ready) return;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.ready) return;
      this.players = (await this.state.storage.get("players")) || {};
      this.countries = (await this.state.storage.get("countries")) || {};
      this.entitlements = (await this.state.storage.get("entitlements")) || {};
      this.seenSessions = (await this.state.storage.get("seenSessions")) || {};
      this.lastSubmit = (await this.state.storage.get("lastSubmit")) || {};
      this.ready = true;
    });
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);

    if (url.pathname === "/leaderboard") return this.handleLeaderboard(url);
    if (url.pathname === "/submit") return this.handleSubmit(request);
    if (url.pathname === "/entitlements") return this.handleEntitlements(url);
    if (url.pathname === "/grant") return this.handleGrant(request);
    if (url.pathname === "/import") return this.handleImport(request);
    if (url.pathname === "/recompute") return this.handleRecompute();
    return json({ error: "Not found" }, 404);
  }

  handleLeaderboard(url) {
    const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
    const difficulty = VALID_DIFFICULTIES.has(url.searchParams.get("difficulty"))
      ? url.searchParams.get("difficulty")
      : null;

    let records = Object.values(this.players);
    if (difficulty) records = records.filter((r) => r.difficulty === difficulty);
    records.sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);

    const top = records.slice(0, limit).map((r) => ({
      playerId: r.playerId,
      name: r.name,
      country: r.country,
      score: r.score,
      level: r.level,
      difficulty: r.difficulty,
    }));

    const countries = Object.values(this.countries).sort((a, b) => b.totalScore - a.totalScore);

    return json({
      top,
      countries,
      leadingCountry: countries[0] || null,
      difficulty: difficulty || "all",
    });
  }

  async handleSubmit(request) {
    const body = await request.json();
    const { playerId, name, score, level, difficulty, country } = body;

    const now = Date.now();
    const last = this.lastSubmit[playerId] || 0;
    if (now - last < SUBMIT_COOLDOWN_MS) {
      return json({ error: "Slow down — too many submissions" }, 429);
    }
    this.lastSubmit[playerId] = now;

    const prev = this.players[playerId] || null;
    const isNewBest = !prev || score > prev.score;

    const record = {
      playerId,
      name,                       // name always refreshes to the current one
      country,                    // country always refreshes to the current pick
      score: isNewBest ? score : prev.score,
      level: isNewBest ? level : prev.level,
      difficulty: isNewBest ? difficulty : prev.difficulty,
      updatedAt: now,
    };
    this.players[playerId] = record;

    this.applyCountryDelta(prev, record);

    await this.state.storage.put({
      players: this.players,
      countries: this.countries,
      lastSubmit: this.lastSubmit,
    });

    const ranked = Object.values(this.players).sort((a, b) => b.score - a.score);
    const rank = ranked.findIndex((r) => r.playerId === playerId) + 1;

    return json({ ok: true, isNewBest, best: record.score, country, rank });
  }

  applyCountryDelta(prev, record) {
    // Remove the player's previous contribution, wherever it was filed.
    if (prev) {
      const old = this.countries[prev.country];
      if (old) {
        old.totalScore -= prev.score;
        old.playerCount = Math.max(0, old.playerCount - 1);
        if (old.playerCount === 0 || old.totalScore <= 0) delete this.countries[prev.country];
      }
    }

    if (!this.countries[record.country]) {
      this.countries[record.country] = {
        country: record.country,
        totalScore: 0,
        playerCount: 0,
        topScore: 0,
        topName: "",
      };
    }
    const c = this.countries[record.country];
    c.totalScore += record.score;
    c.playerCount += 1;
    if (record.score >= c.topScore) {
      c.topScore = record.score;
      c.topName = record.name;
    }
  }

  async handleImport(request) {
    const { records } = await request.json();
    let imported = 0;
    let merged = 0;

    for (const rec of Array.isArray(records) ? records : []) {
      const existing = this.players[rec.playerId];
      if (!existing) {
        this.players[rec.playerId] = { ...rec };
        imported++;
      } else if (rec.score > existing.score) {
        // Keep whichever run was actually better.
        this.players[rec.playerId] = { ...rec };
        merged++;
      } else {
        merged++;
      }
    }

    await this.state.storage.put({ players: this.players });
    return json({ ok: true, imported, merged });
  }

  async handleRecompute() {
    const totals = {};
    for (const r of Object.values(this.players)) {
      const cc = ISO2.test(String(r.country || "")) ? r.country : "XX";
      if (!totals[cc]) {
        totals[cc] = { country: cc, totalScore: 0, playerCount: 0, topScore: 0, topName: "" };
      }
      const c = totals[cc];
      c.totalScore += r.score;
      c.playerCount += 1;
      if (r.score >= c.topScore) {
        c.topScore = r.score;
        c.topName = r.name;
      }
    }
    this.countries = totals;
    await this.state.storage.put({ countries: this.countries });
    return json({
      ok: true,
      players: Object.keys(this.players).length,
      countries: Object.keys(this.countries).length,
    });
  }

  handleEntitlements(url) {
    const playerId = url.searchParams.get("playerId") || "";
    const skus = this.entitlements[playerId] || [];
    return json({ playerId, skus });
  }

  async handleGrant(request) {
    const { playerId, sku, sessionId } = await request.json();

    // Idempotent: the webhook and the redirect both call this.
    if (sessionId && this.seenSessions[sessionId]) {
      return json({ ok: true, duplicate: true, skus: this.entitlements[playerId] || [] });
    }

    const owned = new Set(this.entitlements[playerId] || []);
    owned.add(sku);
    this.entitlements[playerId] = [...owned];
    if (sessionId) this.seenSessions[sessionId] = Date.now();

    await this.state.storage.put({
      entitlements: this.entitlements,
      seenSessions: this.seenSessions,
    });

    return json({ ok: true, skus: this.entitlements[playerId] });
  }
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
