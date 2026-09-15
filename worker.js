const MAX_NAME_LEN = 16;
const MAX_SCORE = 5_000_000;
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/leaderboard" && request.method === "GET") {
        return leaderboard(request, env);
      }
      if (url.pathname === "/api/submit-score" && request.method === "POST") {
        return submitScore(request, env);
      }
      if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
        return createCheckout(request, env);
      }
      if (url.pathname === "/api/verify-session" && request.method === "GET") {
        return verifySession(request, env);
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      // TEMPORARY DEBUG: expose the real error message in the response so it
      // shows up directly in the game's error popup. Revert this once the
      // checkout issue is diagnosed — never ship detailed error text to
      // players in the final build.
      return json({ error: "DEBUG: " + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};

async function leaderboard(request, env) {
  if (!env.LEADERBOARD) return json({ error: "Leaderboard storage is not configured yet (missing LEADERBOARD KV binding)" }, 500);
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const [topRaw, countriesRaw] = await Promise.all([
    env.LEADERBOARD.get("meta:top"),
    env.LEADERBOARD.get("meta:countries"),
  ]);
  const top = topRaw ? JSON.parse(topRaw) : [];
  const countriesMap = countriesRaw ? JSON.parse(countriesRaw) : {};
  const countries = Object.values(countriesMap).sort((a, b) => b.totalScore - a.totalScore);
  return json({ top: top.slice(0, limit), countries, leadingCountry: countries[0] || null }, 200, { "Cache-Control": "max-age=15" });
}

async function submitScore(request, env) {
  if (!env.LEADERBOARD) return json({ error: "Leaderboard storage is not configured yet (missing LEADERBOARD KV binding)" }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  let name = typeof body.name === "string" ? body.name.trim() : "";
  const score = Number.isFinite(body.score) ? Math.floor(body.score) : NaN;
  const difficulty = VALID_DIFFICULTIES.has(body.difficulty) ? body.difficulty : "medium";
  const level = Number.isFinite(body.level) ? Math.floor(body.level) : 1;
  if (!playerId || playerId.length > 64) return json({ error: "Missing or invalid playerId" }, 400);
  if (!name) name = "PILOT";
  name = name.slice(0, MAX_NAME_LEN).toUpperCase();
  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) return json({ error: "Invalid score" }, 400);

  const country = (request.cf && request.cf.country) || "XX";
  const now = Date.now();
  const playerKey = `player:${playerId}`;
  const prevRaw = await env.LEADERBOARD.get(playerKey);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  const isNewBest = !prev || score > prev.score;
  const record = {
    playerId,
    name,
    country,
    score: isNewBest ? score : prev.score,
    difficulty: isNewBest ? difficulty : prev.difficulty,
    level: isNewBest ? level : prev.level,
    updatedAt: now,
  };
  await env.LEADERBOARD.put(playerKey, JSON.stringify(record));
  await updateTopCache(env, record);
  await updateCountryTotals(env, prev, record);
  return json({ ok: true, isNewBest, best: record.score, country });
}

async function updateTopCache(env, record) {
  const raw = await env.LEADERBOARD.get("meta:top");
  let top = raw ? JSON.parse(raw) : [];
  top = top.filter((r) => r.playerId !== record.playerId);
  top.push({ playerId: record.playerId, name: record.name, country: record.country, score: record.score });
  top.sort((a, b) => b.score - a.score);
  await env.LEADERBOARD.put("meta:top", JSON.stringify(top.slice(0, 100)));
}

async function updateCountryTotals(env, prev, record) {
  const raw = await env.LEADERBOARD.get("meta:countries");
  const totals = raw ? JSON.parse(raw) : {};
  if (prev) {
    const oldC = totals[prev.country];
    if (oldC) {
      oldC.totalScore -= prev.score;
      oldC.playerCount = Math.max(0, oldC.playerCount - 1);
      if (oldC.playerCount === 0) delete totals[prev.country];
    }
  }
  if (!totals[record.country]) totals[record.country] = { country: record.country, totalScore: 0, playerCount: 0, topScore: 0, topName: "" };
  const c = totals[record.country];
  c.totalScore += record.score;
  c.playerCount += 1;
  if (record.score >= c.topScore) { c.topScore = record.score; c.topName = record.name; }
  await env.LEADERBOARD.put("meta:countries", JSON.stringify(totals));
}

async function createCheckout(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const sku = body && body.sku;
  const priceMap = { toxic: env.STRIPE_PRICE_TOXIC, cosmic: env.STRIPE_PRICE_COSMIC };
  const price = priceMap[sku];
  if (!sku || !price) return json({ error: "Unknown or missing sku" }, 400);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Server is not configured with a Stripe key yet" }, 500);
  const siteUrl = env.SITE_URL || new URL(request.url).origin;
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("line_items[0][price]", price);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", `${siteUrl}/?session_id={CHECKOUT_SESSION_ID}&sku=${encodeURIComponent(sku)}`);
  params.append("cancel_url", `${siteUrl}/?checkout=cancelled`);
  params.append("metadata[sku]", sku);
  const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await stripeResp.json();
  if (!stripeResp.ok) return json({ error: ((data.error && data.error.message) || "Stripe rejected the request") + (data.error && data.error.param ? (" [param: " + data.error.param + "]") : "") }, 500);
  return json({ url: data.url });
}

async function verifySession(request, env) {
  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (!sessionId) return json({ error: "Missing session_id" }, 400);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Server is not configured with a Stripe key yet" }, 500);
  const stripeResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await stripeResp.json();
  if (!stripeResp.ok) return json({ error: ((data.error && data.error.message) || "Stripe rejected the request") + (data.error && data.error.param ? (" [param: " + data.error.param + "]") : "") }, 500);
  return json({ paid: data.payment_status === "paid", sku: (data.metadata && data.metadata.sku) || null });
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extraHeaders } });
}
