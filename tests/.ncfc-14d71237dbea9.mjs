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
const LEVEL_SCORE_MULT = { easy: 1.5, medium: 1, hard: 0.55 };   // FULL POINTS: every difficulty pays the same points; the multipliers set the level pace
/* DIFFICULTY WEIGHT (owner): the per-difficulty boards show real points. Where
   difficulties are compared -- the ALL board and the country totals -- each
   best counts at its difficulty's weight (Hard most, Easy least), worked out
   here when ranking, from the stored real points (stored scores are never
   rewritten). A player's ALL-board score is their best weighted score across
   difficulties; a country's total adds each player's once. MUST stay
   identical to DIFF_WEIGHT in play/index.html. */
const DIFF_WEIGHT = { easy: 0.09, medium: 0.21, hard: 1 };
function weightedScore(score, difficulty) { return Math.round((Number(score) || 0) * (DIFF_WEIGHT[difficulty] || 1)); }
const LEVEL_TOLERANCE = 1;
// RC2.8.7: a hard ceiling kept IN ADDITION to D-51. The level rule alone lets
// any score through once level 9 is claimed; nothing above the RC2.8.5
// maximum (9 * 50,000 + 5,000) is accepted.
const SCORE_CEILING = 455_000;
function levelForScore(score, difficulty) {
  const m = LEVEL_SCORE_MULT[difficulty] || 1;
  let lv = 1;
  for (const t of LEVEL_SCORE_THRESHOLDS) { if (score >= Math.round(t * m)) lv++; else break; }
  return Math.min(MAX_LEVEL, lv);
}

/* SEASON 1 (owner): the Easy (x0.4) and Medium (x0.85) point rates changed, so
   old bests could never be beaten. Once, the first time the leaderboard Durable
   Object loads with this code, every player's bests are copied into an archive
   in the DO ("archive:season0" + chunks, shown on the admin page) and then
   cleared, so every board starts empty. The stored "season" key makes it run
   exactly once (see LeaderboardDO.startSeason). Scores must say which season
   the page was built for: a page older than Season 1 (an open tab, a queued
   upload) is refused with 409, so it cannot put old-rate scores back. */
const SEASON = 1;
const SEASON_ARCHIVE_KEY = "archive:season0";        // meta; chunks are archive:season0:<n>
const SEASON_ARCHIVE_CHUNK_BYTES = 64 * 1024;       // well under the 128 KiB DO value limit
const SEASON_ARCHIVE_PUT_KEYS = 100;                // a DO put takes at most 128 keys

// Minimum gap between two accepted submissions from one playerId.
const SUBMIT_COOLDOWN_MS = 10_000;

/* RATE LIMITS + REPLAY PROTECTION (no Cloudflare setup needed).
   Rate limits: fixed one-minute windows counted in the MEMORY of the Durable
   Object that serves the route ("global" for scores, restore checks and admin;
   "analytics" for stats). Nothing is written to storage: a counter lives at most
   one window and is swept away, and an evicted object simply starts at zero.
   Two kinds of key, each a one-way code, never a raw value:
     i:<route>:<hash of CF-Connecting-IP + the UTC day>   per network address
     p:<route>:<the route's existing one-way player code>  per pilot
   The raw IP address is hashed in the Worker and never leaves it.
   Numbers (per minute): a whole class behind one school Wi-Fi (30 pilots) ends
   at most ~30 runs a minute and flushes stats ~1-2 times a minute each, so
   the per-address limits leave 2x headroom. A pilot can only get a score
   ACCEPTED every 10 s (SUBMIT_COOLDOWN_MS, unchanged); the per-pilot limits
   only stop loops. A refused score is never lost: the game keeps it queued and
   retries after Retry-After. If the limiter itself fails, requests pass (fail
   open): protection never costs a legitimate score. */
const RL_WINDOW_MS = 60_000;
const RL_MAX_KEYS = 50_000;               // memory bound per object; oldest counters go first
const RATE_LIMITS = {
  submit:  { ip: 60,  player: 30 },
  events:  { ip: 120, player: 20 },
  restore: { ip: 30,  player: 20 },
  admin:   { ip: 30 },
};
/* Replay protection. Each finished run's upload carries a random run id
   (runId), reused on every retry of that same upload. The leaderboard keeps the
   last RUN_IDS_MAX accepted run ids per pilot (at most RUN_IDS_MAX_AGE_MS old)
   under "runs:<pilot's public hash>", compactly, and answers a repeat with the
   same success reply without changing anything. RUN_ID_REQUIRED = false: pages
   from before run ids still upload under the existing rules (season, level
   rule, 10 s cooldown, rate limits). Set it to true in a later release, once
   those pages have been replaced; they then get 409, which they already treat
   as "drop quietly". */
const RUN_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const RUN_ID_KEEP_CHARS = 24;
const RUN_IDS_MAX = 200;
const RUN_IDS_MAX_AGE_MS = 7 * 86_400_000;
const RUN_ID_REQUIRED = false;
const BATCH_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const AN_BATCH_IDS_MAX = 32;              // per pilot, kept in the pilot's own stats record

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
    ctx.waitUntil(analyticsDO(env, "/an-purge", { method: "POST" }).catch(() => {}));   // STATS: raw events older than 90 days -> totals only
    // BACKUPS: the first run of each UTC day takes the daily leaderboard backup; later runs that day do nothing.
    if (env.LEADERBOARD_DO) ctx.waitUntil(backupDO(env, "/daily", { method: "POST" })
      .then(async (r) => { if (!r.ok) console.error("backup: daily failed:", (await r.text()).slice(0, 300)); })
      .catch((e) => console.error("backup: daily failed:", e && e.message)));
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
        if (path === "/api/events" && request.method === "POST") {
          return withCors(await ingestEvents(request, env));   // STATS (in-house, anonymous)
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
          // ORDER: (1) the per-address admin rate limit (30 a minute, before any
          // password is looked at; its 429 lasts at most 60 s and is never counted
          // as a failed login, so it cannot turn into a lockout); (2) FLUX COMMAND:
          // login/logout have their own checks; every other admin route passes the
          // gate (lockout + session), then requireAdmin in each admin function.
          const limited = await adminRateLimit(request, env);
          if (limited) return adminOut(limited);
          if (path === "/api/admin/login") return adminOut(await commandLogin(request, env));
          if (path === "/api/admin/logout") return adminOut(await commandLogout(request, env));
          const gated = await commandGate(request, env);
          if (gated) return adminOut(gated);
          const admin = {
            "/api/admin/find-player":       () => adminFind(request, env),
            "/api/admin/remove-score":      () => adminPidAction(request, env, "/admin-remove-score"),
            "/api/admin/restrict":          () => adminPidAction(request, env, "/admin-restrict", (b) => ({ reason: b.reason })),
            "/api/admin/unrestrict":        () => adminPidAction(request, env, "/admin-unrestrict"),
            "/api/admin/privacy-delete":    () => adminPrivacyDelete(request, env),   // BACKUPS: also erases the pilot from every backup
            "/api/admin/name-ban":          () => adminNameBan(request, env, true),
            "/api/admin/name-unban":        () => adminNameBan(request, env, false),
            "/api/admin/exceptions":        () => adminExceptions(request, env),
            "/api/admin/dismiss-flag":      () => adminDismissFlag(request, env),
            "/api/admin/resolve-delivery":  () => adminResolveDelivery(request, env),
            "/api/admin/purchases":         () => adminPurchases(request, env),
            "/api/admin/purchase-revoke":   () => adminPurchaseChange(request, env, false),
            "/api/admin/purchase-grant":    () => adminPurchaseChange(request, env, true),
            "/api/admin/issue-restore-code": () => adminIssueRestore(request, env),   // D-37
            "/api/admin/analytics":          () => adminAnalytics(request, env),     // STATS dashboard data
            "/api/admin/season-archive":     () => adminDO(request, env, "/admin-season-archive", {}),   // SEASON 1: archived Season 0 scores, read-only
            "/api/admin/backups":            () => adminBackup(request, env, "/list"),        // BACKUPS: list + last status
            "/api/admin/backup-now":         () => adminBackup(request, env, "/snapshot"),    // BACKUPS: manual backup
            "/api/admin/backup-dry-run":     () => adminBackup(request, env, "/dry-run"),     // BACKUPS: what a restore would change; writes nothing
            "/api/admin/backup-restore":     () => adminBackup(request, env, "/restore"),     // BACKUPS: real restore, typed confirmation only
            "/api/admin/backup-download":    () => adminBackup(request, env, "/export"),      // BACKUPS: the snapshot as a JSON file
            "/api/admin/backup-import":      () => adminBackup(request, env, "/import"),      // BACKUPS: a downloaded file back in, as a snapshot
            "/api/admin/session":            () => adminSession(request, env),       // FLUX COMMAND: "am I still logged in?"
            "/api/admin/summary":            () => adminSummary(request, env),       // FLUX COMMAND: owner summary, one request
          }[path];
          if (admin) return adminOut(await admin());
          if (path === "/api/admin/import-kv") return adminOut(await importFromKV(request, env));
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

/* RATE LIMITS (see RATE_LIMITS). The network address is reduced to a one-way
   code here, in the Worker; only the code reaches the Durable Object. */
async function ipCode(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) return null;                  // Cloudflare always sets it; absent only in local tools
  const day = Math.floor(Date.now() / 86_400_000);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("flux-rl:" + day + ":" + ip));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function rateLimit(env, instance, route, request, playerCode) {
  try {
    if (!env.LEADERBOARD_DO) return null;
    const lim = RATE_LIMITS[route], keys = [], ip = await ipCode(request);
    if (ip && lim.ip) keys.push({ k: "i:" + route + ":" + ip, max: lim.ip });
    if (playerCode && lim.player) keys.push({ k: "p:" + route + ":" + playerCode, max: lim.player });
    if (!keys.length) return null;
    const r = await env.LEADERBOARD_DO.get(env.LEADERBOARD_DO.idFromName(instance)).fetch("https://do.internal/rl", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) });
    const d = r.ok ? await r.json() : null;
    if (!d || !d.limited) return null;
    const sec = Math.max(1, Math.min(60, Math.ceil(Number(d.retryAfterSec) || 60)));
    return json({ error: "Too many requests — please wait a moment", retryAfterSec: sec, rateLimited: true }, 429, { "Retry-After": String(sec) });
  } catch (e) { return null; }           // fail open: the limiter never costs a legitimate request
}
function adminRateLimit(request, env) { return rateLimit(env, "global", "admin", request, null); }

/* ------------------------------------------------------------------ */
/* STATS: in-house, anonymous gameplay counts (children may play)       */
/* ------------------------------------------------------------------ */
/* No third party, no advertising ID, no personal information. The game
   sends a few events (app opened, first run, run finished, level-up,
   share tapped) with its random pilot ID; the server keeps only a one-way
   code made from it (a different code from the leaderboard's, so the two
   cannot be matched), the pilot's country (never a precise location) and
   the "src" tag of the link they first came from. Everything is counted
   into daily / monthly totals and retention-by-start-date totals as it
   arrives. Raw events are kept 90 days, then only the totals remain. It
   runs in its own Durable Object instance ("analytics"), so the
   leaderboard is never slowed down, and the game never waits for it.
   GAMEPLAY: at the end of a run the game also sends, for each speed step of
   the ball it reached, one "play" event: difficulty, step, seconds played at
   that step, orb hits, wrong-colour hits and balls lost. They are added into
   day totals keyed only by difficulty and step ("p:<difficulty>:<step>"),
   never by country or source; numbers are clamped, the difficulty must be
   one of the three, the step is capped at AN_MAX_STEP. */
const AN_EVENTS = new Set(["open", "first_run", "run_end", "level_up", "share", "play"]);
const AN_MAX_STEP = 8;
function anInt(v, lo, hi) { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }
const AN_SRC = /^[a-z0-9_-]{1,24}$/;
const AN_KEEP_DAYS = 90;
const AN_MAX_BATCH = 40;
function analyticsDO(env, path, init) {
  if (!env.LEADERBOARD_DO) return Promise.resolve(json({ error: "not configured" }, 500));
  return env.LEADERBOARD_DO.get(env.LEADERBOARD_DO.idFromName("analytics")).fetch("https://do.internal" + path, init);
}
async function analyticsCode(playerId) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("flux-stats:" + String(playerId)));
  return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function cleanSrc(v) { const s = String(v || "").trim().toLowerCase(); return AN_SRC.test(s) ? s : "direct"; }
function cleanEvent(e) {
  if (!e || typeof e !== "object" || !AN_EVENTS.has(e.e)) return null;
  const out = { e: e.e };
  if (e.e === "open") out.home = e.home === true;
  if (e.e === "run_end" || e.e === "level_up") {
    const lvl = Math.floor(Number(e.lvl)); out.lvl = lvl >= 1 && lvl <= MAX_LEVEL ? lvl : 1;
    out.diff = VALID_DIFFICULTIES.has(e.diff) ? e.diff : "medium";
  }
  if (e.e === "run_end") { const sec = Math.floor(Number(e.sec)); out.sec = sec >= 0 && sec <= 7200 ? sec : 0; }
  if (e.e === "play") {   // GAMEPLAY: one run's time at one speed step
    if (!VALID_DIFFICULTIES.has(e.diff)) return null;
    out.diff = e.diff; out.st = anInt(e.st, 0, AN_MAX_STEP); out.sec = anInt(e.sec, 0, 7200);
    out.hit = anInt(e.hit, 0, 5000); out.wrong = anInt(e.wrong, 0, 5000); out.lost = anInt(e.lost, 0, 4);
  }
  return out;
}
async function ingestEvents(request, env) {
  try {
    const body = await readJsonObject(request);
    if (!body) return json({ ok: false }, 400);
    const playerId = typeof body.pid === "string" ? body.pid.trim() : "";
    if (!validPlayerId(playerId)) return json({ ok: false }, 400);
    const events = (Array.isArray(body.events) ? body.events : []).slice(0, AN_MAX_BATCH).map(cleanEvent).filter(Boolean);
    if (!events.length) return json({ ok: true, n: 0 });
    const h = await analyticsCode(playerId);
    const limited = await rateLimit(env, "analytics", "events", request, h);
    if (limited) return limited;
    const bid = typeof body.bid === "string" && BATCH_ID_RE.test(body.bid) ? body.bid : "";   // older pages send none
    const c = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
    const cf = (request.cf && request.cf.country) || "";
    const country = ISO2.test(c) ? c : (ISO2.test(cf) ? cf : "XX");   // country only, never a precise location
    const r = await analyticsDO(env, "/an-ingest", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ h, bid, src: cleanSrc(body.src), country, events }) });
    return json({ ok: r.ok }, r.ok ? 200 : 500);
  } catch (e) { return json({ ok: false }, 500); }
}
async function adminAnalytics(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const b = (await readJsonObject(request)) || {};
  return analyticsDO(env, "/an-report?" + new URLSearchParams({ from: String(b.from || ""), to: String(b.to || "") }));
}
const AN_DAY_MS = 86400000;
const anDayStr = (d) => new Date(d * AN_DAY_MS).toISOString().slice(0, 10);
const anDayNum = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? Math.floor(Date.parse(s + "T00:00:00Z") / AN_DAY_MS) : NaN);
const anMonth = (d) => anDayStr(d).slice(0, 7);
function anAdd(bucket, groups, field, n) { for (const g of groups) { const o = bucket[g] || (bucket[g] = {}); o[field] = (o[field] || 0) + n; } }

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

  const limited = await rateLimit(env, "global", "submit", request, await pidHash(playerId));
  if (limited) return limited;

  const name = presetOrOwn(cleanName(body.name), playerId);   // A-3 + PRESET NAMES: only allowed names are ever stored

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
  if (score > SCORE_CEILING) {
    return json({ error: "Score is above the maximum" }, 422);
  }

  // SEASON 1: a page (or a queued upload) from before Season 1 carries no
  // season. Its score is at the old point rates, so it is refused -- 409, which
  // older pages already treat as a permanent refusal and drop from their queue.
  if (!(Number.isFinite(body.season) && body.season >= SEASON)) {
    return json({ error: "A new season has started. Reload FLUX to play Season " + SEASON + ".", season: SEASON, staleSeason: true }, 409);
  }
  // REPLAY PROTECTION: the run id travels to the leaderboard beside the score
  // record (in the internal URL) and is kept apart from the player record.
  const runId = typeof body.runId === "string" && RUN_ID_RE.test(body.runId) ? body.runId : "";
  if (!runId && RUN_ID_REQUIRED) {
    return json({ error: "Reload FLUX to keep uploading scores.", season: SEASON, staleSeason: true }, 409);
  }

  // Player's pick wins; cf.country is the fallback for "OTHER"/unset.
  const detected = (request.cf && request.cf.country) || "XX";
  const chosen = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
  const country = ISO2.test(chosen) ? chosen : (ISO2.test(detected) ? detected : "XX");

  return forwardToDO(request, env, "/submit" + (runId ? "?run=" + encodeURIComponent(runId) : ""), {
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
  const limited = await rateLimit(env, "global", "restore", request, await pidHash(playerId));
  if (limited) { limited.headers.set("Cache-Control", "no-store"); return limited; }
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
 * Requires header: x-admin-token: <ADMIN_TOKEN secret> (or a FLUX COMMAND login session)
 */
async function importFromKV(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;   // FLUX COMMAND: the header or a login session
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
/* PILOT NAMES (child privacy). A new pilot starts with a preset name built from
   these friendly word lists, e.g. "SWIFT COMET 42", so a child can play without
   giving any personal information. In EDIT a pilot may type a name, but only one
   word that follows the typed-name rules below. The same lists and rules are in
   worker.js and play/index.html (a test keeps them identical). A name that breaks
   the rules becomes the pilot's own preset, derived from its random player
   identifier. Numbers skip 14, 18, 69 and 88. */
const NAME_ADJ = ['SWIFT','BRAVE','BRIGHT','CALM','CLEVER','COSMIC','EAGER','FAST','GENTLE','GOLDEN','HAPPY','JOLLY','KIND','LUCKY','MIGHTY','NOBLE','QUICK','QUIET','RAPID','SHINY','SILVER','SMART','SOLAR','SPEEDY','STARRY','SUNNY','SUPER','TURBO','VIVID','WISE','ZIPPY','BOLD'];
const NAME_NOUN = ['COMET','ROCKET','STAR','NOVA','ORBIT','PLANET','MOON','METEOR','GALAXY','NEBULA','RANGER','FALCON','EAGLE','TIGER','PANDA','OTTER','FOX','OWL','LYNX','HAWK','DRAGON','SPARK','BOLT','FLASH','WAVE','RIVER','CLOUD','MAPLE','CEDAR','PEBBLE','BADGER','ROBIN'];
const NAME_NUMS = []; for (let i = 10; i <= 99; i++) if (i !== 14 && i !== 18 && i !== 69 && i !== 88) NAME_NUMS.push(i);
function isPresetName(s) {
  const m = /^([A-Z]+) ([A-Z]+) (\d\d)$/.exec(typeof s === 'string' ? s : '');
  return !!m && NAME_ADJ.indexOf(m[1]) >= 0 && NAME_NOUN.indexOf(m[2]) >= 0 && NAME_NUMS.indexOf(+m[3]) >= 0;
}
function presetNameFrom(n) {
  n = n >>> 0;
  const a = n % NAME_ADJ.length; n = Math.floor(n / NAME_ADJ.length);
  const b = n % NAME_NOUN.length; n = Math.floor(n / NAME_NOUN.length);
  return NAME_ADJ[a] + ' ' + NAME_NOUN[b] + ' ' + NAME_NUMS[n % NAME_NUMS.length];
}
function presetNameForId(id) {   // FNV-1a of the player identifier: the same pilot always gets the same preset
  let h = 2166136261; const s = String(id || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return presetNameFrom(h);
}
// Typed names (EDIT only, owner rule): one word, letters A-Z and numbers 0-9, up to 12
// characters, and nothing that looks like an email, a phone number or a web link. On the
// server the rude-word filter (cleanName) still applies on top of this.
const TYPED_NAME_MAX = 12;
const CONTACT_LIKE = /HTTP|WWW|DOTCOM|DOTNET|DOTORG|GMAIL|YAHOO|HOTMAIL|OUTLOOK|ICLOUD|PROTONMAIL/;
function typedNameProblem(s) {
  s = typeof s === 'string' ? s : '';
  if (!/^[A-Z0-9]+$/.test(s) || s.length > TYPED_NAME_MAX) return 'One word, letters and numbers only, up to 12.';
  if ((s.match(/[0-9]/g) || []).length >= 7) return 'A name can\'t look like a phone number.';
  if (CONTACT_LIKE.test(s)) return 'A name can\'t look like an email or a web link.';
  return '';
}
function isAllowedName(s) { return isPresetName(s) || typedNameProblem(s) === ''; }
// A public name is a preset or a typed name that follows the rules; anything else (typed
// before the rules, or sent by a modified client) becomes the pilot's own preset.
function presetOrOwn(name, playerId) { return isAllowedName(name) ? name : presetNameForId(playerId); }

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
  if (COMMAND_AUTHED.has(request)) return null;   // FLUX COMMAND: a valid login session, checked by commandGate
  const supplied = request.headers.get("x-admin-token") || "";
  if (!timingSafeEqual(supplied, env.ADMIN_TOKEN)) return json({ error: "Unauthorized" }, 401);
  return null;
}
/* ------------------------------------------------------------------ */
/* FLUX COMMAND: admin login session, lockout, owner summary           */
/* ------------------------------------------------------------------ */
/* The admin page (installable as the "FLUX COMMAND" Home Screen app) used to
   send the password with every request. It now logs in once:
   POST /api/admin/login checks the password (constant time) and returns a
   random session token (256 bits from crypto.getRandomValues) in a cookie that
   is HttpOnly (page scripts cannot read it), Secure, SameSite=Strict (never sent
   from another site) and Path=/api/admin (never sent anywhere else). Only the
   token's SHA-256 is stored, in its own Durable Object instance ("admin-auth"),
   so a copy of that storage cannot be replayed as a login.
   EXPIRY: 30 minutes without an admin request (idle) and 12 hours after login
   at most (absolute) -- an evening of admin work without logging in again, but
   a lost phone or a shared laptop is not an open door for long.
   CSRF: SameSite=Strict, plus every cookie request must carry X-FLUX-Admin: 1,
   a header another site cannot add without a CORS preflight, which this API
   never allows for that header.
   The x-admin-token header still works (owner tools, the import script, the
   tests). It is a custom header already, so it needs no X-FLUX-Admin, but its
   wrong guesses count towards the same lockout.
   LOCKOUT: 5 wrong passwords from one client within 15 minutes lock that client
   for 15 minutes (429 + Retry-After). A client is a SHA-256 of CF-Connecting-IP
   mixed with the secret; the raw IP is never stored.
   GLOBAL SAFETY: 50 wrong passwords from all clients within 15 minutes switch
   on a 15-minute safety mode in which ONE wrong password locks a client. Other
   people's guesses never lock the owner out: a client that has not failed can
   still log in, and sessions already logged in keep working.
   RECOVERY: wait 15 minutes; or change ADMIN_TOKEN in the Cloudflare dashboard
   (Workers & Pages > flux-sparta-3 > Settings > Variables and Secrets). Every
   session and lock is tied to a fingerprint of the current secret, so a new
   secret ends all sessions and clears all locks at once. The failed-login log
   (time and a short client code; never a password or an IP) is kept. */
const COMMAND_COOKIE = "flux_admin";
const COMMAND_IDLE_MS = 30 * 60 * 1000;
const COMMAND_MAX_MS = 12 * 3600 * 1000;
const COMMAND_LOCK_MS = 15 * 60 * 1000;          // lockout window AND lock length
const COMMAND_CLIENT_FAILS = 5;
const COMMAND_GLOBAL_FAILS = 50;
const COMMAND_MAX_SESSIONS = 20;
const COMMAND_ALERTS_KEPT = 200;
const COMMAND_AUTHED = new WeakMap();            // request -> session info, set only by commandGate
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function commandDO(env, path, body) {
  const stub = env.LEADERBOARD_DO.get(env.LEADERBOARD_DO.idFromName("admin-auth"));
  const r = await stub.fetch("https://do.internal" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json().catch(() => null)) || { ok: false, error: "auth unavailable" };
}
async function commandIds(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return {
    fp: (await sha256Hex("flux-command-fp:" + env.ADMIN_TOKEN)).slice(0, 16),
    client: (await sha256Hex("flux-command-client:" + env.ADMIN_TOKEN + ":" + ip)).slice(0, 32),   // never the raw IP
  };
}
function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function newCommandToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);                     // 256 bits
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function commandCookie(token, maxAgeSec) {
  return COMMAND_COOKIE + "=" + token + "; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAgeSec;
}
const commandCsrfOk = (request) => request.headers.get("X-FLUX-Admin") === "1";
function commandLocked(r) {
  const sec = Math.max(1, Math.ceil(Number(r.retryAfter) || COMMAND_LOCK_MS / 1000)), min = Math.ceil(sec / 60);
  return json({ error: "Too many wrong passwords. Locked for " + min + " min.", locked: true, retryAfter: sec, minutes: min },
    429, { "Retry-After": String(sec) });
}
const commandUnavailable = () => json({ error: "Login is unavailable right now. Try again in a minute." }, 503);

async function commandLogin(request, env) {
  if (!commandCsrfOk(request)) return json({ error: "Missing X-FLUX-Admin header" }, 403);
  if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN is not configured" }, 500);
  if (!env.LEADERBOARD_DO) return json({ error: "Login storage is not configured (missing LEADERBOARD_DO binding)" }, 500);
  const b = (await readJsonObject(request)) || {};
  const password = typeof b.password === "string" ? b.password.slice(0, 512) : "";
  const ok = password !== "" && timingSafeEqual(password, env.ADMIN_TOKEN);
  const { fp, client } = await commandIds(request, env);
  const token = ok ? newCommandToken() : "";
  const r = await commandDO(env, "/auth-attempt", { fp, client, ok, hash: ok ? await sha256Hex(token) : "" });
  if (r.locked) return commandLocked(r);
  if (r.error) return commandUnavailable();
  if (!r.ok) return json({ error: "Wrong password.", attemptsLeft: r.attemptsLeft }, 401);
  return json({ ok: true, idleMinutes: COMMAND_IDLE_MS / 60000, expiresAt: r.expiresAt, maxAt: r.maxAt }, 200,
    { "Set-Cookie": commandCookie(token, COMMAND_MAX_MS / 1000) });
}
async function commandLogout(request, env) {
  if (!commandCsrfOk(request)) return json({ error: "Missing X-FLUX-Admin header" }, 403);
  const tok = readCookie(request, COMMAND_COOKIE);
  if (tok && env.ADMIN_TOKEN && env.LEADERBOARD_DO) {
    const { fp } = await commandIds(request, env);
    await commandDO(env, "/auth-logout", { fp, hash: await sha256Hex(tok) });
  }
  return json({ ok: true }, 200, { "Set-Cookie": commandCookie("", 0) });
}
/* Runs before every other /api/admin/* route. It never lets a request through
   on its own: requireAdmin, in each admin function, still decides. It only
   (a) counts x-admin-token guesses towards the lockout and refuses locked
   clients, and (b) turns a valid session cookie into COMMAND_AUTHED. */
async function commandGate(request, env) {
  if (!env.ADMIN_TOKEN || !env.LEADERBOARD_DO) return null;   // requireAdmin answers
  const supplied = request.headers.get("x-admin-token");
  const tok = readCookie(request, COMMAND_COOKIE);
  if (!supplied && !tok) return null;                            // requireAdmin answers 401
  const { fp, client } = await commandIds(request, env);
  if (supplied) {
    const r = await commandDO(env, "/auth-attempt", { fp, client, ok: timingSafeEqual(supplied, env.ADMIN_TOKEN) });
    if (r.locked) return commandLocked(r);
    if (r.error) return commandUnavailable();
    if (!r.ok) return json({ error: "Unauthorized", attemptsLeft: r.attemptsLeft }, 401);
    return null;
  }
  if (!commandCsrfOk(request)) return json({ error: "Missing X-FLUX-Admin header" }, 403);
  const r = await commandDO(env, "/auth-check", { fp, hash: await sha256Hex(tok) });
  if (r.error) return commandUnavailable();
  if (!r.ok) return json({ error: "Session expired. Log in again.", expired: true }, 401, { "Set-Cookie": commandCookie("", 0) });
  COMMAND_AUTHED.set(request, { expiresAt: r.expiresAt, maxAt: r.maxAt });
  return null;
}
async function adminSession(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const s = COMMAND_AUTHED.get(request);
  return json({ ok: true, via: s ? "session" : "token", idleMinutes: COMMAND_IDLE_MS / 60000, expiresAt: s ? s.expiresAt : null, maxAt: s ? s.maxAt : null });
}
/* The owner's first screen, in one request, from data the server already has:
   today's PLAYER STATS totals (UTC day), the exceptions count (same sources as
   CHECK EXCEPTIONS), purchases delivered today (purchase records; amounts live
   in Stripe) and the failed-login log. Each part is optional: one failing
   source shows as "unavailable" instead of failing the whole summary. */
async function adminSummary(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const safe = (p) => Promise.resolve(p).then((v) => v, () => null);
  const body = (p) => safe(Promise.resolve(p).then((r) => (r && r.ok ? r.json() : null)));
  const [rep, lb, delivery, sec, bk] = await Promise.all([
    body(analyticsDO(env, "/an-report?today=1")),
    body(forwardToDO(request, env, "/admin-summary", { method: "POST" })),
    safe(listDeliveryExceptions(env)),
    env.LEADERBOARD_DO ? safe(commandIds(request, env).then(({ fp }) => commandDO(env, "/auth-report", { fp }))) : null,
    env.LEADERBOARD_DO ? body(backupDO(env, "/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })) : null,
  ]);
  const bst = (bk && bk.status) || {}, bErr = bst.lastError && (!bst.lastOk || bst.lastError.at > bst.lastOk.at) ? bst.lastError : null;
  const day = rep && (rep.days || []).find((d) => d.date === rep.today);
  const g = (day && day.groups && day.groups.all) || {};
  const players = rep ? {
    date: rep.today, active: g.active || 0, newPlayers: g.new || 0, runs: g.runs || 0,
    avgRunSec: g.runs ? Math.round((g.sec || 0) / g.runs) : null, shareRate: g.runs ? (g.shares || 0) / g.runs : null,
    homeOpens: g.home || 0, opens: g.opens || 0,
  } : null;
  const flags = lb ? lb.flags : null, del = Array.isArray(delivery) ? delivery.length : null;
  return json({
    ok: true, at: Date.now(), players,
    exceptions: flags === null && del === null ? null : { flags, delivery: del, total: (flags || 0) + (del || 0) },
    purchases: lb ? { today: lb.purchasesToday, restrictedCount: lb.restrictedCount } : null,
    security: sec && sec.ok ? { failed24h: sec.failed24h, lastFailedAt: sec.lastFailedAt, lockedClients: sec.lockedClients,
      safetyUntil: sec.safetyUntil, recent: sec.recent, sessions: sec.sessions } : null,
    // BACKUPS: the same status the BACKUPS section shows (last good daily backup, stale, latest failure).
    backup: bk && bk.ok ? { ok: !!bk.lastDaily && !bk.stale && !bErr, stale: !!bk.stale,
      lastDailyAt: bk.lastDaily ? bk.lastDaily.createdAt : null, count: (bk.snapshots || []).length,
      lastError: bErr ? { at: bErr.at, error: String(bErr.error || "").slice(0, 200) } : null } : null,
  });
}
/* Every admin response: CORS as before, never cached anywhere. */
function adminOut(resp) {
  const r = withCors(resp);
  r.headers.set("Cache-Control", "no-store");
  return r;
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
/* A privacy deletion erases the pilot from the live leaderboard AND from every
   stored backup (BACKUPS), so a restore can never bring them back and no copy on
   the server outlives the request. */
async function adminPrivacyDelete(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const b = await adminBody(request);
  if (!(typeof b.pid === "string" && PID_RE.test(b.pid))) return json({ error: "Invalid entry" }, 400);
  const payload = { pid: b.pid, removePurchases: !!b.removePurchases };
  const live = await adminDO(request, env, "/admin-privacy-delete", payload);
  if (!env.LEADERBOARD_DO) return live;
  let backups;
  try {
    const r = await backupDO(env, "/purge-player", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    backups = await r.json();
    if (!r.ok) backups = { ok: false, error: backups.error || "backup clean-up failed" };
  } catch (e) { backups = { ok: false, error: "backup clean-up failed: " + (e && e.message) }; }
  const out = await live.json().catch(() => ({}));
  if (live.status === 404 && backups.ok && backups.changed > 0) return json({ ok: true, liveFound: false, purchasesRemoved: 0, restrictionKept: false, backups });
  return json({ ...out, backups }, live.status);
}
/* BACKUPS: every backup route needs the admin password, like every admin action. */
async function adminBackup(request, env, doPath) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  if (!env.LEADERBOARD_DO) return json({ error: "Backups are not set up on this server (no LEADERBOARD_DO binding)." }, 500);
  const b = await adminBody(request);
  const resp = await backupDO(env, doPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const headers = new Headers(resp.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(resp.body, { status: resp.status, headers });
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

/* Constant time: no early exit, not even on a length mismatch (FLUX COMMAND).
   The loop always runs over the longer string, so the time depends only on the
   length the caller sent -- never on how many characters of the secret match. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);   // past the end: NaN | 0 = 0
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
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
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
      if (!(await this.state.storage.get("nameRulesV1"))) await this.migrateNames();   // PILOT NAMES, once
      // DIFFICULTY WEIGHT: country totals stored under other weights (or none) are rebuilt once from the real points.
      if ((await this.state.storage.get("countriesWeights")) !== JSON.stringify(DIFF_WEIGHT)) await this.recomputeCountries();
      if (!((await this.state.storage.get("season")) >= SEASON)) await this.startSeason();   // SEASON 1, once
      this.ready = true;
    });
  }

  /* PILOT NAMES (owner, before launch): once, erase the old text of every stored name
     that breaks the name rules. It becomes the pilot's own preset -- in the player
     record and in any review note -- so the old text is gone from storage. */
  async migrateNames() {
    const switched = Object.create(null);
    for (const id of Object.keys(this.players)) {
      const r = this.players[id]; const n = presetOrOwn(cleanName(r.name), id);
      if (n !== r.name) { r.name = n; switched[await pidHash(id)] = n; }
    }
    this.flags = this.flags.map((f) => (f && ownGet(switched, f.pid) ? { ...f, name: switched[f.pid] } : f));
    await this.state.storage.put({ players: this.players, flags: this.flags, nameRulesV1: 1 });
  }

  /* SEASON 1 (see SEASON). Runs inside load()'s blockConcurrencyWhile, so no
     request is served while it runs, and only when the stored "season" is below
     SEASON -- so a second load, a restart or a concurrent request never archives
     or clears again (Season 1 scores are safe). Order, so a failure part-way
     never loses a score:
       1. the archive chunks are written (a retry rewrites the same chunks, from
          the same untouched bests);
       2. ONE put writes the cleared players, empty country figures, the archive
          summary and season = SEASON together -- all or nothing;
       3. memory follows, tags are invalidated, countries are recomputed.
     Only "bests" change. Names, countries, restrictions, name bans, skins and
     purchases, restore log, analytics and cooldowns are not touched. */
  async startSeason() {
    const players = [];
    for (const id of Object.keys(this.players)) {
      const r = this.players[id], bests = Object.create(null);
      for (const d of Object.keys(r.bests || {})) {
        const b = r.bests[d];
        if (b && Number.isFinite(b.score)) bests[d] = { score: b.score, level: b.level, updatedAt: b.updatedAt || 0 };
      }
      if (Object.keys(bests).length) players.push({ playerId: r.playerId || id, name: r.name, country: r.country, bests });
    }
    const chunks = [];
    let cur = [], size = 2;
    for (const p of players) {
      const n = new TextEncoder().encode(JSON.stringify(p)).length + 1;
      if (cur.length && size + n > SEASON_ARCHIVE_CHUNK_BYTES) { chunks.push(cur); cur = []; size = 2; }
      cur.push(p); size += n;
    }
    if (cur.length) chunks.push(cur);
    for (let i = 0; i < chunks.length; i += SEASON_ARCHIVE_PUT_KEYS) {
      const puts = {};
      chunks.slice(i, i + SEASON_ARCHIVE_PUT_KEYS).forEach((c, j) => { puts[SEASON_ARCHIVE_KEY + ":" + (i + j)] = c; });
      await this.state.storage.put(puts);
    }
    const scores = players.reduce((n, p) => n + Object.keys(p.bests).length, 0);
    const meta = { season: 0, archivedAt: Date.now(), players: players.length, scores, chunks: chunks.length };
    const cleared = Object.create(null);
    for (const id of Object.keys(this.players)) cleared[id] = Object.assign(Object.create(null), this.players[id], { bests: Object.create(null) });
    await this.state.storage.put({ players: cleared, countries: {}, [SEASON_ARCHIVE_KEY]: meta, season: SEASON });
    this.players = cleared;
    this.invalidateTags();
    await this.recomputeCountries();
  }

  /* The archived Season 0 scores, for the admin page (read-only). One row per
     player and difficulty, highest first. Like every admin view, a public hash,
     never a playerId. */
  async readSeasonArchive() {
    const meta = await this.state.storage.get(SEASON_ARCHIVE_KEY);
    const players = [];
    for (let i = 0; meta && i < meta.chunks; i++) {
      const c = await this.state.storage.get(SEASON_ARCHIVE_KEY + ":" + i);
      if (Array.isArray(c)) players.push(...c);
    }
    return { meta: meta || null, players };
  }
  async handleAdminSeasonArchive() {
    const { meta, players } = await this.readSeasonArchive();
    const rows = [];
    for (const p of players) {
      const pid = await this.pid(p.playerId), tag = await this.tagFor(p.playerId);
      for (const d of Object.keys(p.bests || {})) {
        const b = p.bests[d];
        rows.push({ difficulty: d, pid, tag, name: cleanName(p.name), country: p.country || "", score: b.score, level: b.level, updatedAt: b.updatedAt || 0 });
      }
    }
    rows.sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);
    return json({ ok: true, season: 0, archivedAt: meta ? meta.archivedAt : null, players: meta ? meta.players : 0, count: rows.length, rows });
  }
  /* A privacy deletion also erases the pilot from the Season 0 archive. */
  async eraseFromSeasonArchive(playerId) {
    const meta = await this.state.storage.get(SEASON_ARCHIVE_KEY);
    if (!meta) return;
    const puts = {};
    let removed = 0, lostScores = 0;
    for (let i = 0; i < meta.chunks; i++) {
      const k = SEASON_ARCHIVE_KEY + ":" + i, c = await this.state.storage.get(k);
      if (!Array.isArray(c)) continue;
      const kept = c.filter((p) => p.playerId !== playerId);
      if (kept.length === c.length) continue;
      for (const p of c) if (p.playerId === playerId) { removed++; lostScores += Object.keys(p.bests || {}).length; }
      puts[k] = kept;
    }
    if (!removed) return;
    puts[SEASON_ARCHIVE_KEY] = { ...meta, players: Math.max(0, meta.players - removed), scores: Math.max(0, (meta.scores || 0) - lostScores) };
    await this.state.storage.put(puts);
  }

  async pid(playerId) {
    if (!this.pidCache.has(playerId)) this.pidCache.set(playerId, await pidHash(playerId));
    return this.pidCache.get(playerId);
  }
  async isRestricted(playerId) { return !!ownGet(this.restricted, await this.pid(playerId)); }
  displayName(r) {
    const n = presetOrOwn(cleanName(r.name), r.playerId);   // PRESET NAMES: a name that breaks the rules is shown as the pilot's preset
    return ownGet(this.nameBans, normaliseForBan(r.name)) || ownGet(this.nameBans, normaliseForBan(n)) ? "PILOT" : n;
  }
  async findPlayerIdByPid(pid) {
    for (const id of new Set([...Object.keys(this.players), ...Object.keys(this.entitlements)])) {
      if ((await this.pid(id)) === pid) return id;
    }
    return null;
  }

  async fetch(request) {
    const url0 = new URL(request.url);
    if (url0.pathname === "/rl") return this.handleRateLimit(request);                 // memory only, any instance
    if (url0.pathname.startsWith("/an-")) return this.handleAnalytics(request, url0);   // STATS instance: never loads the leaderboard
    if (url0.pathname.startsWith("/auth-")) return this.handleCommandAuth(request, url0);   // FLUX COMMAND instance: never loads the leaderboard
    if (url0.pathname.startsWith("/bk/")) return this.handleBackups(request, url0);    // BACKUPS instance: never loads the leaderboard
    // BACKUPS: the "backups" instance never serves leaderboard routes.
    if (this.role === undefined) this.role = (await this.state.storage.get(BACKUP_ROLE_KEY)) || "";
    if (this.role) return json({ error: "Not found" }, 404);
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
      "/admin-season-archive": () => this.handleAdminSeasonArchive(),
      "/admin-summary": () => this.handleAdminSummary(),
      "/backup-dump": () => this.handleBackupDump(),            // BACKUPS (internal: the worker never forwards these)
      "/backup-restore": () => this.handleBackupRestore(request),
    }[url.pathname];
    return route ? route() : json({ error: "Not found" }, 404);
  }

  /* FLUX COMMAND (see the note at COMMAND_COOKIE). Its own instance
     ("admin-auth"), ONE storage key, one request at a time, in order:
       s: sessions   sha256(token) -> { c: created, l: last used }
       k: clients    sha256(secret + IP) -> { f: [failure times in the window], u: locked until }
       g: global     { f: [failure times in the window], u: safety mode until }
       a: failed-login log [{ at, c: 6-character client code, lock, g }] -- no passwords, no IPs
       fp: fingerprint of the secret these belong to (a new secret starts afresh; the log is kept) */
  handleCommandAuth(request, url) {
    const run = async () => {
      try {
        const b = (await request.json()) || {};
        const now = this.nowMs ? this.nowMs() : Date.now();
        const st = await this.cmdLoad(String(b.fp || ""));
        cmdPrune(st, now);
        let out;
        if (url.pathname === "/auth-attempt") out = cmdAttempt(st, b, now);
        else if (url.pathname === "/auth-check") out = cmdCheck(st, b, now);
        else if (url.pathname === "/auth-logout") { if (CMD_HASH.test(b.hash || "") && st.s[b.hash]) { delete st.s[b.hash]; st.dirty = 1; } out = { ok: true }; }
        else if (url.pathname === "/auth-report") out = cmdReport(st, now);
        else return json({ error: "Not found" }, 404);
        if (st.dirty) { delete st.dirty; await this.state.storage.put("cmd:auth", st); }
        return json(out);
      } catch (e) { console.error("command auth:", e && e.message); return json({ ok: false, error: "auth failed" }, 500); }
    };
    const p = (this.cmdChain || Promise.resolve()).then(run, run);
    this.cmdChain = p.then(() => {}, () => {});
    return p;
  }
  async cmdLoad(fp) {
    const saved = await this.state.storage.get("cmd:auth");
    if (saved && typeof saved === "object" && saved.fp === fp) return saved;
    return { fp, s: {}, k: {}, g: { f: [], u: 0 }, a: (saved && Array.isArray(saved.a)) ? saved.a : [], dirty: 1 };
  }

  /* RATE LIMITS (see RATE_LIMITS): fixed one-minute windows in memory only.
     Counters older than the current window are swept; the map never holds more
     than RL_MAX_KEYS counters. All keys of one request are checked first and
     counted only if none is over its limit. */
  rateCheck(keys, now) {
    const rl = this.rl || (this.rl = new Map());
    const w = Math.floor(now / RL_WINDOW_MS) * RL_WINDOW_MS;
    if (this.rlSweptWindow !== w) {
      for (const [k, e] of rl) if (e.w !== w) rl.delete(k);
      this.rlSweptWindow = w;
    }
    for (const { k, max } of keys) {
      const e = rl.get(k);
      if (e && e.w === w && e.n >= max) return { limited: true, retryAfterSec: Math.max(1, Math.ceil((w + RL_WINDOW_MS - now) / 1000)) };
    }
    for (const { k } of keys) {
      const e = rl.get(k);
      if (e && e.w === w) e.n++;
      else { rl.delete(k); rl.set(k, { w, n: 1 }); }
    }
    while (rl.size > RL_MAX_KEYS) rl.delete(rl.keys().next().value);
    return { limited: false };
  }
  async handleRateLimit(request) {
    let b = null; try { b = await request.json(); } catch (e) {}
    const keys = (b && Array.isArray(b.keys) ? b.keys : []).slice(0, 4)
      .filter((x) => x && typeof x.k === "string" && x.k.length <= 80 && Number.isFinite(x.max) && x.max > 0);
    return json(this.rateCheck(keys, Date.now()));
  }

  /* REPLAY PROTECTION (see RUN_ID_RE). One compact string per pilot:
     "<runId 24 chars>.<accepted at, base-36 seconds>.<1|0 new best><e|m|h>,..."
     newest last, at most RUN_IDS_MAX entries, none older than RUN_IDS_MAX_AGE_MS. */
  async readRuns(pid, now) {
    const raw = await this.state.storage.get("runs:" + pid);
    const cut = Math.floor((now - RUN_IDS_MAX_AGE_MS) / 1000);
    return (typeof raw === "string" && raw ? raw.split(",") : []).filter((e) => parseInt(e.split(".")[1], 36) >= cut);
  }

  /* BACKUPS (see BackupStore). Runs only on the "backups" instance: the worker
     marks its calls with a header, and an instance holding leaderboard data
     ("players" / "season") refuses, so backup code can never write into the
     leaderboard's own storage. The first call marks the instance as the backup
     store; from then on it refuses every leaderboard route. */
  async handleBackups(request, url) {
    if (request.headers.get(BACKUP_INSTANCE_HEADER) !== "backups") return json({ error: "Not found" }, 404);
    if (!this.bk) {
      const st = this.state.storage;
      if ((await st.get("players")) !== undefined || (await st.get("season")) !== undefined) return json({ error: "Backups never run on the leaderboard instance." }, 409);
      if ((await st.get(BACKUP_ROLE_KEY)) !== "backups") await st.put(BACKUP_ROLE_KEY, "backups");
      this.role = "backups";
      this.bk = new BackupStore(this.state, this.env);
    }
    return this.bk.fetch(request, url.pathname.slice(3));
  }

  /* STATS (see the note at AN_EVENTS). One request at a time, in order. */
  handleAnalytics(request, url) {
    const run = async () => {
      try {
        if (url.pathname === "/an-ingest" && request.method === "POST") return await this.anIngest(await request.json());
        if (url.pathname === "/an-report") return await this.anReport(url);
        if (url.pathname === "/an-purge") return await this.anPurge();
        return json({ error: "Not found" }, 404);
      } catch (e) { return json({ error: "stats failed" }, 500); }
    };
    const p = (this.anChain || Promise.resolve()).then(run, run);
    this.anChain = p.then(() => {}, () => {});
    return p;
  }
  anToday() { return Math.floor((this.nowMs ? this.nowMs() : Date.now()) / AN_DAY_MS); }
  async anIngest(b) {
    const st = this.state.storage, today = this.anToday(), month = anMonth(today);
    const h = String(b.h || ""); if (!/^[0-9a-f]{16}$/.test(h)) return json({ ok: false }, 400);
    const events = (Array.isArray(b.events) ? b.events : []).slice(0, AN_MAX_BATCH);
    const country = ISO2.test(b.country || "") ? b.country : "XX";
    // The pilot's own record: first day, first src (where they came from), last active day/month, retention marks.
    let p = await st.get("an:p:" + h), isNew = false;
    if (!p) { p = { f: today, s: cleanSrc(b.src), l: -1, m: "", r: 0, k: 0, kd: today }; isNew = true; }
    if (p.kd !== today) { p.kd = today; p.k = 0; }
    // REPLAY PROTECTION: a batch id this pilot already sent is counted once.
    const bid = typeof b.bid === "string" && BATCH_ID_RE.test(b.bid) ? b.bid : "";
    if (bid && Array.isArray(p.b) && p.b.includes(bid)) return json({ ok: true, duplicate: true });
    if (p.k >= 500) return json({ ok: true, capped: true });   // a flood from one pilot is ignored for the day
    if (bid) p.b = (Array.isArray(p.b) ? p.b : []).concat([bid]).slice(-AN_BATCH_IDS_MAX);
    p.k += events.length;
    const groups = ["all", "c:" + country, "s:" + p.s];
    const day = (await st.get("an:day:" + today)) || {};
    const puts = {};
    if (isNew) anAdd(day, groups, "new", 1);
    if (p.l !== today) {
      anAdd(day, groups, "active", 1); p.l = today;
      const age = today - p.f, bit = { 1: 1, 7: 2, 30: 4 }[age];
      if (bit && !(p.r & bit)) {   // came back on day 1 / 7 / 30 after their start date
        p.r |= bit;
        const ret = (await st.get("an:ret:" + p.f)) || {};
        anAdd(ret, ["all", "c:" + (p.c || country), "s:" + p.s], "d" + age, 1);
        puts["an:ret:" + p.f] = ret;
      }
    }
    if (isNew) { p.c = country; const ret = puts["an:ret:" + p.f] || (await st.get("an:ret:" + p.f)) || {}; anAdd(ret, groups, "n", 1); puts["an:ret:" + p.f] = ret; }
    if (p.m !== month) {
      p.m = month;
      const mon = (await st.get("an:mon:" + month)) || {};
      anAdd(mon, groups, "active", 1); puts["an:mon:" + month] = mon;
    }
    for (const e of events) {
      if (e.e === "open") { anAdd(day, groups, "opens", 1); if (e.home) anAdd(day, groups, "home", 1); }
      else if (e.e === "first_run") anAdd(day, groups, "first", 1);
      else if (e.e === "level_up") anAdd(day, groups, "levelups", 1);
      else if (e.e === "share") anAdd(day, groups, "shares", 1);
      else if (e.e === "run_end") { anAdd(day, groups, "runs", 1); anAdd(day, groups, "sec", e.sec || 0); anAdd(day, groups, "lvl", e.lvl || 1); }
      else if (e.e === "play") {   // GAMEPLAY: by difficulty and speed step only
        const pg = ["p:" + e.diff + ":" + e.st];
        anAdd(day, pg, "runs", 1); anAdd(day, pg, "sec", e.sec); anAdd(day, pg, "hit", e.hit); anAdd(day, pg, "wrong", e.wrong); anAdd(day, pg, "lost", e.lost);
      }
    }
    // Raw events for 90 days, in small chunks.
    const n = (await st.get("an:evn:" + today)) || 0, ck = "an:ev:" + today + ":" + Math.max(0, n - 1);
    let chunk = n ? ((await st.get(ck)) || []) : [];
    const rows = events.map((e) => Object.assign({ h, c: country, s: p.s }, e));
    if (!n || chunk.length + rows.length > 400) { chunk = rows; puts["an:ev:" + today + ":" + n] = chunk; puts["an:evn:" + today] = n + 1; }
    else { chunk = chunk.concat(rows); puts[ck] = chunk; }
    const days = (await st.get("an:days")) || [];
    if (days[days.length - 1] !== today) { days.push(today); puts["an:days"] = days; }
    puts["an:day:" + today] = day; puts["an:p:" + h] = p;
    await st.put(puts);
    return json({ ok: true });
  }
  async anPurge() {
    const st = this.state.storage, cut = this.anToday() - AN_KEEP_DAYS;
    const days = (await st.get("an:days")) || [], keep = [], gone = [];
    for (const d of days) (d < cut ? gone : keep).push(d);
    for (const d of gone) {
      const n = (await st.get("an:evn:" + d)) || 0, keys = ["an:evn:" + d];
      for (let i = 0; i < n; i++) keys.push("an:ev:" + d + ":" + i);
      if (st.delete) await st.delete(keys); else for (const k of keys) await st.put(k, null);
    }
    if (gone.length) await st.put("an:days", keep);
    return json({ ok: true, purgedDays: gone.length });
  }
  async anReport(url) {
    const st = this.state.storage, today = this.anToday();
    let to = anDayNum(url.searchParams.get("to")), from = anDayNum(url.searchParams.get("from"));
    if (!Number.isFinite(to)) to = today;
    if (!Number.isFinite(from)) from = to - 29;
    if (url.searchParams.get("today") === "1") from = to = today;   // FLUX COMMAND summary: today only
    from = Math.max(from, to - 400);
    const days = [], cohorts = [], months = [];
    for (let d = from; d <= to; d++) {
      const day = await st.get("an:day:" + d); if (day) days.push({ date: anDayStr(d), groups: day });
      const ret = await st.get("an:ret:" + d); if (ret) cohorts.push({ date: anDayStr(d), age: today - d, groups: ret });
    }
    for (let m = anMonth(from); m <= anMonth(to);) {
      const mon = await st.get("an:mon:" + m); if (mon) months.push({ month: m, groups: mon });
      const [y, mm] = m.split("-").map(Number); m = mm === 12 ? (y + 1) + "-01" : y + "-" + String(mm + 1).padStart(2, "0");
    }
    const rawDays = ((await st.get("an:days")) || []).length;
    return json({ ok: true, from: anDayStr(from), to: anDayStr(to), today: anDayStr(today), keepDays: AN_KEEP_DAYS, rawDays, days, months, cohorts });
  }

  /* Public rows for one board: real points. No difficulty = the ALL board:
     each player's best WEIGHTED score across difficulties (DIFF_WEIGHT). */
  async publicRows(difficulty) {
    const rows = [];
    for (const r of Object.values(this.players)) {
      if (await this.isRestricted(r.playerId)) continue;       // moderation exclusion
      const b = difficulty ? r.bests[difficulty] : weightedBestOf(r);
      if (!b) continue;
      rows.push({ r, score: difficulty ? b.score : b.weighted, points: b.score, level: b.level, difficulty: difficulty || b.difficulty, updatedAt: b.updatedAt || r.updatedAt || 0 });
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
      score: o.it.score,                           // real points on a difficulty board; weighted on ALL
      points: o.it.points,                         // the real points behind it
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
    return json({ top, countries, leadingCountry: countries[0] || null, difficulty, weighted: !difficulty, weights: { ...DIFF_WEIGHT } });
  }

  /* D-25: country figures are rebuilt from the player records every time
     something changes, so totals, counts, top scores and displayed leaders can
     never drift apart. RC2.7 subtracted a departing player's score but kept
     their name and top score as the country's leader. Each player counts once,
     at their single best public WEIGHTED score (DIFF_WEIGHT); restricted
     players are excluded. */
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
    await this.state.storage.put({ countries: totals, countriesWeights: JSON.stringify(DIFF_WEIGHT) });
    this.countries = totals;
  }

  async handleSubmit(request) {
    const body = await request.json();
    const { playerId, name, score, level, difficulty, country } = body;

    const now = Date.now();
    // REPLAY PROTECTION: a run id already accepted gets the same success reply
    // again, and nothing changes -- no second count, no new best, no country or
    // name change, no cooldown. Checked BEFORE the cooldown, so a retry whose
    // first reply was lost on the network succeeds at once.
    const runId = String(new URL(request.url).searchParams.get("run") || "").slice(0, RUN_ID_KEEP_CHARS);
    const pid = await this.pid(playerId);
    const runs = runId ? await this.readRuns(pid, now) : null;
    const seen = runs ? runs.find((e) => e.split(".")[0] === runId) : null;
    if (seen && ownGet(this.players, playerId)) return this.submitReply(playerId, seen.slice(-1) === "e" ? "easy" : seen.slice(-1) === "h" ? "hard" : "medium", seen.slice(-2, -1) === "1", true);

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
    const puts = { players: nextPlayers, lastSubmit: nextLast, flags: nextFlags };
    if (runId) {                         // stored in the SAME write as the score: accepted <=> remembered
      const entry = runId + "." + Math.floor(now / 1000).toString(36) + "." + (isNewBest ? "1" : "0") + difficulty[0];
      puts["runs:" + pid] = runs.concat([entry]).slice(-RUN_IDS_MAX).join(",");
    }
    await this.state.storage.put(puts);
    this.players = nextPlayers; this.lastSubmit = nextLast; this.flags = nextFlags;
    this.invalidateTags();

    await this.recomputeCountries();

    return this.submitReply(playerId, difficulty, isNewBest, false, score);
  }

  /* The success reply to an upload -- the same shape for a first upload and a
     repeated run id (which adds duplicate: true). */
  async submitReply(playerId, difficulty, isNewBest, duplicate, score) {
    const record = ownGet(this.players, playerId);
    const pid = await this.pid(playerId);
    const restricted = !!ownGet(this.restricted, pid);
    let rank = null;
    if (!restricted) {
      const rows = await this.publicRows(difficulty);
      rank = rows.findIndex((x) => x.r.playerId === playerId) + 1 || null;
    }
    const [o] = await this.tagRows([{ r: record }]);
    const b = record && ownGet(record.bests, difficulty);
    return json({
      ok: true, isNewBest, best: b ? b.score : score,
      country: record ? record.country : undefined, difficulty,
      public: !restricted,       // honest: no public rank is invented for a restricted player
      rank,
      tag: o.tag,
      ...(duplicate ? { duplicate: true } : {}),
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
      name: rec ? presetOrOwn(cleanName(rec.name), playerId) : "",   // PRESET NAMES
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
      incoming.name = presetOrOwn(cleanName(incoming.name), rec.playerId);   // PILOT NAMES
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
    const raw = String(q || "").toUpperCase().replace(/\s+/g, " ").trim();   // PILOT NAMES: "swift  comet 42" finds SWIFT COMET 42
    // D-38: "NAME #TAG" -- the way the game shows a pilot -- must match that
    // pilot. Plain "NAME", "TAG" or "#TAG" work as before.
    const both = /^(.+?)\s*#\s*([0-9A-Z]+)$/.exec(raw);
    const query = raw.replace(/^#/, "").trim();
    const matches = [];
    for (const r of Object.values(this.players)) {
      const v = await this.adminView(r);
      // The stored name OR the name the board shows (PILOT for a banned name, the preset for an old name that breaks the rules).
      const named = (n) => v.name.includes(n) || String(v.shownAs || "").includes(n);
      const hit = both
        ? (named(both[1].trim()) && (v.tag.startsWith(both[2]) || tagFromPid(v.pid, 12).startsWith(both[2])))
        : (named(query) || v.tag.startsWith(query) || tagFromPid(v.pid, 12).startsWith(query));
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
    await this.eraseFromSeasonArchive(id);   // SEASON 1: the archived Season 0 scores go too
    if ((await this.state.storage.get("runs:" + pid)) !== undefined) await this.state.storage.delete("runs:" + pid);   // REPLAY PROTECTION: the pilot's accepted run ids go too
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

  /* FLUX COMMAND summary: counts only. Purchases today = sessions delivered
     since 00:00 UTC (the purchase records keep the delivery time, not amounts). */
  handleAdminSummary() {
    const now = Date.now(), dayStart = Math.floor(now / AN_DAY_MS) * AN_DAY_MS;
    let purchasesToday = 0;
    for (const k of Object.keys(this.seenSessions)) { const t = this.seenSessions[k]; if (typeof t === "number" && t >= dayStart) purchasesToday++; }
    return json({ ok: true, flags: pruneFlags(this.flags, now).length, restrictedCount: Object.keys(this.restricted).length, purchasesToday });
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

  /* ----------------------------- backups ----------------------------- */
  /* BACKUPS: the whole storage of this instance, every key (listed page by page,
     never a fixed key list), as one canonical text. Nothing else runs while it
     is read, so the copy is one consistent moment. Refused if any value could
     not be copied exactly. */
  async handleBackupDump() {
    let text = "";
    await this.state.blockConcurrencyWhile(async () => {
      const entries = await bkListAll(this.state.storage);
      text = bkEncode(entries);
      if (!bkSameEntries(bkDecode(text), entries)) throw new Error("a stored value cannot be copied exactly");
    });
    return new Response(text, { headers: { "Content-Type": "application/json" } });
  }
  /* BACKUPS: replace the whole storage with a snapshot (called only by
     BackupStore.restore, which checks the admin's typed confirmation and takes a
     safety backup first). Keys that are not in the snapshot are deleted, every
     snapshot key is written, in one transaction where the runtime has one; then
     memory is reloaded from storage. */
  async handleBackupRestore(request) {
    let entries;
    try { entries = bkDecode(await request.text()); } catch (e) { return json({ error: "Not a FLUX backup" }, 400); }
    const want = new Set(entries.map((e) => e[0]));
    await this.state.blockConcurrencyWhile(async () => {
      const apply = async (st) => {
        const gone = (await bkListAll(st)).map((e) => e[0]).filter((k) => !want.has(k));
        for (let i = 0; i < gone.length; i += BACKUP_PUT_KEYS) await st.delete(gone.slice(i, i + BACKUP_PUT_KEYS));
        for (let i = 0; i < entries.length; i += BACKUP_PUT_KEYS) {
          const puts = Object.create(null);
          for (const [k, v] of entries.slice(i, i + BACKUP_PUT_KEYS)) puts[k] = v;
          await st.put(puts);
        }
      };
      const st = this.state.storage;
      if (typeof st.transaction === "function") await st.transaction(apply); else await apply(st);
      this.ready = false; this.tagCache = null; this.pidCache = new Map();
    });
    await this.load();
    return json({ ok: true, keys: entries.length });
  }
}

/* ------------------------------------------------------------------ */
/* BACKUPS                                                             */
/* ------------------------------------------------------------------ */
/* The leaderboard ("global" LeaderboardDO instance) is copied into a separate
   instance of the SAME class, "backups" (like "analytics"): it has its own
   storage, and needs no new binding, class, migration, bucket or namespace --
   nothing to set up in Cloudflare, nothing that can fail a deploy. Its requests
   use the /bk/ paths (LeaderboardDO.handleBackups -> BackupStore).
     - A snapshot is EVERY key and value of the leaderboard's storage (players and
       bests, purchases, seen sessions, restore log, name bans, restrictions,
       flags, countries, season marker, Season 0 archive chunks, anything added
       later), as one canonical text, stored in chunks well under the per-value
       limit, with a manifest: time, key count, size, SHA-256 of every chunk and
       of the whole, schema and season, and the counts the admin page shows.
     - Every snapshot is read back and checked (checksums, size, key count) right
       after it is written; the result is stored with it (verified yes/no).
     - Daily: the first cron run of each UTC day takes one (the 30-minute cron is
       reused; later runs that day do nothing; a failure is retried on the next
       run, at most BACKUP_DAILY_ATTEMPTS times a day, and shown on the admin page).
       The same run re-checks every stored snapshot.
     - Kept: the newest 14 daily snapshots, plus up to 4 weekly ones (the first
       daily of each week) while they are at most 28 days old; manual, safety and
       uploaded snapshots for at most 28 days (newest 10). A privacy deletion also
       erases the pilot from every snapshot (adminPrivacyDelete).
     - Restore (admin only): a dry run reports exactly what would change and writes
       nothing; the real restore needs "RESTORE <snapshot id>" typed by the owner,
       first takes a safety snapshot of the current state, then writes, then reads
       the leaderboard back and compares it with the snapshot. Nothing automatic
       ever restores.
   The analytics instance is NOT backed up: it is anonymous totals that rebuild
   themselves, and the leaderboard is what cannot be recreated. */
const BACKUP_SCHEMA = 1;
const BACKUP_INSTANCE_HEADER = "x-flux-instance";
const BACKUP_ROLE_KEY = "bk:role";         // stored only in the "backups" instance
const BACKUP_LIST_PAGE = 500;
const BACKUP_PUT_KEYS = 100;               // a DO put / delete takes at most 128 keys
const BACKUP_CHUNK_CHARS = 30000;          // <= 90 KB of UTF-8 per value: well under the 128 KiB limit
const BACKUP_KEEP_DAILY = 14;
const BACKUP_KEEP_WEEKLY = 4;
const BACKUP_KEEP_OTHER = 10;              // manual, safety, uploaded
const BACKUP_KEEP_FAILED = 3;
const BACKUP_MAX_AGE_DAYS = 28;            // weekly / manual / safety / uploaded; the privacy promise is 30 days
const BACKUP_DAILY_ATTEMPTS = 4;
const BACKUP_LOG_MAX = 60;
const BACKUP_DAY_MS = 86400000;
const BACKUP_KINDS = new Set(["daily", "manual", "safety", "imported"]);
const BACKUP_ID = /^\d{8}-\d{6}-(daily|manual|safety|imported)(-\d+)?$/;
const BK_MARK = "\u0000flux";              // marks a stored undefined / NaN / Infinity, which plain JSON would lose

function backupDO(env, path, init) {
  const headers = new Headers((init && init.headers) || {});
  headers.set(BACKUP_INSTANCE_HEADER, "backups");
  return env.LEADERBOARD_DO.get(env.LEADERBOARD_DO.idFromName("backups")).fetch("https://do.internal/bk" + path, { ...(init || {}), headers });
}
async function bkListAll(st) {
  const entries = [];
  let after;
  for (;;) {
    const page = await st.list(after === undefined ? { limit: BACKUP_LIST_PAGE } : { startAfter: after, limit: BACKUP_LIST_PAGE });
    let n = 0;
    for (const [k, v] of page) { entries.push([k, v]); after = k; n++; }
    if (n < BACKUP_LIST_PAGE) return entries;
  }
}
function bkEncode(entries) {
  return JSON.stringify({ v: BACKUP_SCHEMA, entries }, function (k, v) {
    if (v === undefined) return { [BK_MARK]: "undefined" };
    if (typeof v === "number" && !Number.isFinite(v)) return { [BK_MARK]: String(v) };
    return v;
  });
}
function bkRevive(x) {
  if (!x || typeof x !== "object") return x;
  const ks = Object.keys(x);
  if (!Array.isArray(x) && ks.length === 1 && ks[0] === BK_MARK) return x[BK_MARK] === "undefined" ? undefined : Number(x[BK_MARK]);
  for (const k of ks) Object.defineProperty(x, k, { value: bkRevive(x[k]), writable: true, enumerable: true, configurable: true });
  return x;
}
function bkDecode(text) {
  const o = JSON.parse(text);
  if (!o || o.v !== BACKUP_SCHEMA || !Array.isArray(o.entries) || !o.entries.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string")) throw new Error("not a FLUX backup");
  return bkRevive(o.entries);
}
function bkPlain(o) { const p = Object.getPrototypeOf(o); return Array.isArray(o) || p === Object.prototype || p === null; }
function bkSame(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b) || !bkPlain(a) || !bkPlain(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !bkSame(a[k], b[k])) return false;
  return true;
}
function bkSameEntries(a, b) {
  if (a.length !== b.length) return false;
  const m = new Map(b);
  return m.size === b.length && a.every(([k, v]) => m.has(k) && bkSame(v, m.get(k)));
}
function bkSplit(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let j = Math.min(text.length, i + BACKUP_CHUNK_CHARS);
    if (j < text.length) { const c = text.charCodeAt(j - 1); if (c >= 0xd800 && c <= 0xdbff) j--; }   // never split a surrogate pair
    out.push(text.slice(i, j)); i = j;
  }
  return out.length ? out : [""];
}
async function bkSha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const bkBytes = (text) => new TextEncoder().encode(text).length;
const bkDay = (t) => new Date(t).toISOString().slice(0, 10);
const bkWeek = (t) => Math.floor((Math.floor(t / BACKUP_DAY_MS) + 3) / 7);   // weeks start on Monday (UTC)
function bkIdFor(t, kind) {
  const iso = new Date(t).toISOString();
  return iso.slice(0, 10).replace(/-/g, "") + "-" + iso.slice(11, 19).replace(/:/g, "") + "-" + kind;
}
/* The counts the admin page shows for a snapshot (and before / after a restore). */
function bkSummary(entries) {
  const m = new Map(entries), obj = (k) => { const v = m.get(k); return v && typeof v === "object" ? v : {}; };
  const players = obj("players"), ent = obj("entitlements");
  const s = { keys: entries.length, players: 0, bests: { easy: 0, medium: 0, hard: 0 }, purchasePilots: 0, skins: { toxic: 0, cosmic: 0, solar: 0 },
    purchaseSessions: Object.keys(obj("seenSessions")).length, restoreLog: Array.isArray(m.get("restoreLog")) ? m.get("restoreLog").length : 0,
    nameBans: Object.keys(obj("nameBans")).length, restricted: Object.keys(obj("restricted")).length,
    flags: Array.isArray(m.get("flags")) ? m.get("flags").length : 0, countries: Object.keys(obj("countries")).length,
    season: m.has("season") ? m.get("season") : null, season0Scores: obj(SEASON_ARCHIVE_KEY).scores || 0 };
  for (const id of Object.keys(players)) {
    s.players++;
    const r = normaliseRecord(players[id] || {}, id);
    for (const d of VALID_DIFFICULTIES) if (r.bests[d]) s.bests[d]++;
  }
  for (const id of Object.keys(ent)) {
    const skus = Array.isArray(ent[id]) ? ent[id] : [];
    if (skus.length) s.purchasePilots++;
    for (const k of skus) if (k in s.skins) s.skins[k]++;
  }
  return s;
}
/* Dry run: exactly what restoring `snap` over `live` would change. */
function bkDiff(live, snap) {
  const L = new Map(live), S = new Map(snap), cap = (a) => a.slice(0, 200);
  const added = [], removed = [], changed = [];
  for (const [k, v] of snap) { if (!L.has(k)) added.push(k); else if (!bkSame(L.get(k), v)) changed.push(k); }
  for (const [k] of live) if (!S.has(k)) removed.push(k);
  const byId = (m, key) => { const o = m.get(key); return o && typeof o === "object" ? o : {}; };
  const cmp = (a, b) => {
    const out = { added: 0, removed: 0, changed: 0 };
    for (const id of Object.keys(b)) { if (!Object.prototype.hasOwnProperty.call(a, id)) out.added++; else if (!bkSame(a[id], b[id])) out.changed++; }
    for (const id of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(b, id)) out.removed++;
    return out;
  };
  return { keysAdded: cap(added), keysRemoved: cap(removed), keysChanged: cap(changed), counts: { added: added.length, removed: removed.length, changed: changed.length, unchanged: snap.length - added.length - changed.length },
    players: cmp(byId(L, "players"), byId(S, "players")), purchases: cmp(byId(L, "entitlements"), byId(S, "entitlements")) };
}
/* Erases one pilot from a snapshot with the SAME code as the live privacy
   deletion: a throw-away LeaderboardDO over an in-memory copy of the snapshot. */
class BkMemStorage {
  constructor(entries) { this.map = new Map(entries.map(([k, v]) => [k, structuredClone(v)])); }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { const o = typeof k === "object" ? k : { [k]: v }; for (const kk of Object.keys(o)) this.map.set(kk, structuredClone(o[kk])); }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
  async list() { return new Map([...this.map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))); }
  entries() { return [...this.map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); }
}
async function bkErasePilot(entries, pid, removePurchases) {
  const mem = new BkMemStorage(entries);
  const lb = new LeaderboardDO({ storage: mem, blockConcurrencyWhile: (fn) => fn() });
  const r = await lb.fetch(new Request("https://do.internal/admin-privacy-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid, removePurchases }) }));
  if (r.ok) return mem.entries();
  if (r.status !== 404) throw new Error("erase failed (" + r.status + ")");
  // Not a player in this snapshot: still erase the name and reason from its restore log, and its flags.
  let touched = false;
  const kept = entries.filter(([k]) => k !== "runs:" + pid);   // REPLAY PROTECTION: its accepted run ids go too
  if (kept.length !== entries.length) touched = true;
  const out = kept.map(([k, v]) => {
    if (k === "restoreLog" && Array.isArray(v) && v.some((e) => e && e.pid === pid && (e.name || e.reason !== "(erased on privacy request)"))) {
      touched = true; return [k, v.map((e) => (e && e.pid === pid ? { at: e.at, pid: e.pid, tag: e.tag, name: "", reason: "(erased on privacy request)" } : e))];
    }
    if (k === "flags" && Array.isArray(v) && v.some((f) => f && f.pid === pid)) { touched = true; return [k, v.filter((f) => !(f && f.pid === pid))]; }
    return [k, v];
  });
  return touched ? out : null;
}

class BackupStore {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.chain = Promise.resolve();
  }

  /* One request at a time, in order (cron and admin never interleave). */
  fetch(request, path) {
    const run = async () => {
      try { return await this.route(path, request); }
      catch (e) { console.error("backup:", e && e.message); return json({ ok: false, error: "Backup error: " + ((e && e.message) || e) }, 500); }
    };
    const p = this.chain.then(run, run);
    this.chain = p.then(() => {}, () => {});
    return p;
  }
  async route(path, request) {
    let body = {};
    try { const t = await request.text(); if (t) body = JSON.parse(t) || {}; } catch (e) { body = {}; }
    const id = typeof body.id === "string" && BACKUP_ID.test(body.id) ? body.id : "";
    switch (path) {
      case "/list": return this.list();
      case "/daily": return this.daily();
      case "/snapshot": return this.manual();
      case "/dry-run": return this.dryRun(id);
      case "/restore": return this.restore(id, body.confirm);
      case "/export": return this.exportFile(id);
      case "/import": return this.importFile(body);
      case "/purge-player": return this.purgePlayer(String(body.pid || ""), !!body.removePurchases);
    }
    return json({ error: "Not found" }, 404);
  }

  /* ---------- storage of snapshots ---------- */
  async lb(path, init) {
    const ns = this.env.LEADERBOARD_DO;
    if (!ns) throw new Error("the leaderboard is not configured (no LEADERBOARD_DO binding)");
    return ns.get(ns.idFromName("global")).fetch("https://do.internal" + path, init);
  }
  async dumpLive() {
    const r = await this.lb("/backup-dump", { method: "POST" });
    const text = await r.text();
    if (!r.ok) throw new Error("could not read the leaderboard (" + r.status + ")");
    bkDecode(text);
    return text;
  }
  async metas() {
    const out = [];
    for (const [, m] of await this.state.storage.list({ prefix: "m:" })) if (m && m.id) out.push(m);
    return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }
  chunkKey(id, gen, i) { return "c:" + id + ":" + gen + ":" + i; }
  async putMany(obj) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i += BACKUP_PUT_KEYS) {
      const part = {};
      for (const k of keys.slice(i, i + BACKUP_PUT_KEYS)) part[k] = obj[k];
      await this.state.storage.put(part);
    }
  }
  async deleteMany(keys) { for (let i = 0; i < keys.length; i += BACKUP_PUT_KEYS) await this.state.storage.delete(keys.slice(i, i + BACKUP_PUT_KEYS)); }
  /* Chunks first (under a new generation), then the manifest, then the old
     generation's chunks are removed: a failure part-way never leaves a manifest
     pointing at missing or mixed chunks. */
  async writeSnapshot(text, base) {
    const entries = bkDecode(text), chunks = bkSplit(text), gen = (base.gen || 0) + 1;
    const puts = {}, chunkSha = [];
    for (let i = 0; i < chunks.length; i++) { puts[this.chunkKey(base.id, gen, i)] = chunks[i]; chunkSha.push(await bkSha(chunks[i])); }
    await this.putMany(puts);
    const meta = { ...base, schema: BACKUP_SCHEMA, gen, keyCount: entries.length, bytes: bkBytes(text), chunks: chunks.length, chunkSha, sha256: await bkSha(text),
      season: new Map(entries).get("season") ?? null, summary: bkSummary(entries), verified: false, verifiedAt: 0, verifyError: "" };
    await this.state.storage.put("m:" + base.id, meta);
    if (base.gen) await this.deleteMany(Array.from({ length: base.chunks || 0 }, (_, i) => this.chunkKey(base.id, base.gen, i)));
    const v = await this.verify(base.id);
    meta.verified = v.ok; meta.verifiedAt = Date.now(); meta.verifyError = v.ok ? "" : v.error;
    await this.state.storage.put("m:" + base.id, meta);
    return meta;
  }
  /* Read back and check: every chunk present, each chunk's SHA-256, the whole
     text's SHA-256 and size, a readable backup with the recorded key count. */
  async verify(id) {
    const meta = await this.state.storage.get("m:" + id);
    if (!meta) return { ok: false, error: "no such backup", meta: null };
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) {
      const c = await this.state.storage.get(this.chunkKey(id, meta.gen, i));
      if (typeof c !== "string") return { ok: false, error: "part " + (i + 1) + " of " + meta.chunks + " is missing", meta };
      if ((await bkSha(c)) !== meta.chunkSha[i]) return { ok: false, error: "part " + (i + 1) + " of " + meta.chunks + " is damaged (checksum mismatch)", meta };
      parts.push(c);
    }
    const text = parts.join("");
    if ((await bkSha(text)) !== meta.sha256 || bkBytes(text) !== meta.bytes) return { ok: false, error: "the whole-backup checksum does not match", meta };
    let n = -1;
    try { n = bkDecode(text).length; } catch (e) { return { ok: false, error: "the backup cannot be read", meta }; }
    if (n !== meta.keyCount) return { ok: false, error: "key count " + n + " does not match " + meta.keyCount, meta };
    return { ok: true, error: "", meta, text };
  }
  async deleteSnapshot(m) {
    await this.deleteMany(Array.from({ length: m.chunks || 0 }, (_, i) => this.chunkKey(m.id, m.gen, i)));
    await this.state.storage.delete("m:" + m.id);
  }
  async newId(now, kind) {
    const base = bkIdFor(now, kind);
    let id = base;
    for (let n = 2; await this.state.storage.get("m:" + id); n++) id = base + "-" + n;
    return id;
  }
  async takeSnapshot(kind, note, text) {
    const now = Date.now();
    if (text === undefined) text = await this.dumpLive();
    const id = await this.newId(now, kind);
    return this.writeSnapshot(text, { id, kind, createdAt: now, day: bkDay(now), weekly: false, note: String(note || "").slice(0, 200) });
  }
  /* Newest 14 daily; up to 4 weekly while <= 28 days old; manual / safety /
     uploaded newest 10 while <= 28 days old; newest 3 failed ones (to show). */
  async prune() {
    const metas = await this.metas(), keep = new Set(), now = Date.now(), young = (m) => now - m.createdAt <= BACKUP_MAX_AGE_DAYS * BACKUP_DAY_MS;
    const take = (list, n) => list.slice(0, n).forEach((m) => keep.add(m.id));
    take(metas.filter((m) => m.verified && m.kind === "daily"), BACKUP_KEEP_DAILY);
    take(metas.filter((m) => m.verified && m.kind === "daily" && m.weekly && young(m)), BACKUP_KEEP_WEEKLY);
    take(metas.filter((m) => m.verified && m.kind !== "daily" && young(m)), BACKUP_KEEP_OTHER);
    take(metas.filter((m) => !m.verified && young(m)), BACKUP_KEEP_FAILED);
    let removed = 0;
    for (const m of metas) if (!keep.has(m.id)) { await this.deleteSnapshot(m); removed++; }
    return removed;
  }
  async status() { return (await this.state.storage.get("status")) || { daily: null, lastOk: null, lastError: null }; }
  async log(entry) {
    const log = (await this.state.storage.get("log")) || [];
    log.push({ at: Date.now(), ...entry });
    await this.state.storage.put("log", log.slice(-BACKUP_LOG_MAX));
  }

  /* ---------- routes ---------- */
  async list() {
    const metas = await this.metas();
    const snapshots = metas.map(({ chunkSha, ...m }) => m);
    const st = await this.status();
    const lastDaily = metas.find((m) => m.kind === "daily" && m.verified) || null;
    return json({ ok: true, snapshots, status: st, lastDaily: lastDaily ? { id: lastDaily.id, createdAt: lastDaily.createdAt } : null,
      stale: !lastDaily || Date.now() - lastDaily.createdAt > 36 * 3600 * 1000, log: ((await this.state.storage.get("log")) || []).slice(-20).reverse(),
      retention: { daily: BACKUP_KEEP_DAILY, weekly: BACKUP_KEEP_WEEKLY, maxAgeDays: BACKUP_MAX_AGE_DAYS, other: BACKUP_KEEP_OTHER } });
  }
  /* Cron: once per UTC day. Idempotent: a day that already has its verified
     daily snapshot does nothing; a failure is recorded and retried on the next
     run, at most BACKUP_DAILY_ATTEMPTS times a day. */
  async daily() {
    const now = Date.now(), day = bkDay(now), st = await this.status();
    const d = st.daily && st.daily.day === day ? st.daily : null;
    if (d && (d.ok || d.attempts >= BACKUP_DAILY_ATTEMPTS)) return json({ ok: true, skipped: true, day });
    let meta = null, error = "";
    try {
      meta = await this.takeSnapshot("daily", "automatic");
      if (!meta.verified) error = "the backup failed its check: " + meta.verifyError;
    } catch (e) { error = (e && e.message) || String(e); }
    if (meta && meta.verified && !(await this.metas()).some((m) => m.id !== meta.id && m.weekly && bkWeek(m.createdAt) === bkWeek(meta.createdAt))) {
      meta.weekly = true; await this.state.storage.put("m:" + meta.id, meta);
    }
    // Re-check every stored snapshot once a day, so a damaged one shows as failed.
    const damaged = [];
    for (const m of await this.metas()) {
      if (meta && m.id === meta.id) continue;
      const v = await this.verify(m.id);
      if (v.ok !== m.verified) { m.verified = v.ok; m.verifiedAt = Date.now(); m.verifyError = v.error; await this.state.storage.put("m:" + m.id, m); if (!v.ok) damaged.push(m.id); }
    }
    const removed = error ? 0 : await this.prune();
    const next = { ...st, daily: { day, attempts: (d ? d.attempts : 0) + 1, ok: !error, id: meta ? meta.id : "", error, at: now } };
    if (error) next.lastError = { at: now, id: meta ? meta.id : "", error, kind: "daily" }; else next.lastOk = { at: now, id: meta.id, kind: "daily" };
    await this.state.storage.put("status", next);
    await this.log(error ? { event: "daily backup FAILED", id: meta ? meta.id : "", error } : { event: "daily backup ok", id: meta.id, keys: meta.keyCount, bytes: meta.bytes, removed });
    for (const id of damaged) await this.log({ event: "stored backup failed its check", id });
    if (error) { console.error("backup: daily failed:", error); return json({ ok: false, error, id: meta ? meta.id : "" }, 500); }
    return json({ ok: true, id: meta.id, weekly: meta.weekly, removed, damaged });
  }
  async manual() {
    const meta = await this.takeSnapshot("manual", "Back up now");
    const st = await this.status(), now = Date.now();
    if (meta.verified) st.lastOk = { at: now, id: meta.id, kind: "manual" }; else st.lastError = { at: now, id: meta.id, error: meta.verifyError, kind: "manual" };
    await this.state.storage.put("status", st);
    const removed = meta.verified ? await this.prune() : 0;
    await this.log(meta.verified ? { event: "manual backup ok", id: meta.id, keys: meta.keyCount, bytes: meta.bytes, removed } : { event: "manual backup FAILED", id: meta.id, error: meta.verifyError });
    const { chunkSha, ...m } = meta;
    return json({ ok: meta.verified, snapshot: m, error: meta.verified ? "" : "The backup failed its check: " + meta.verifyError }, meta.verified ? 200 : 500);
  }
  async checked(id) {
    if (!id) return { resp: json({ error: "Choose a backup." }, 400) };
    const v = await this.verify(id);
    if (!v.meta) return { resp: json({ error: "No such backup." }, 404) };
    if (!v.ok) {
      if (v.meta.verified) { v.meta.verified = false; v.meta.verifiedAt = Date.now(); v.meta.verifyError = v.error; await this.state.storage.put("m:" + id, v.meta); await this.log({ event: "backup failed its check", id, error: v.error }); }
      return { resp: json({ ok: false, verified: false, error: "This backup failed its check (" + v.error + "). It cannot be restored or downloaded." }, 409) };
    }
    return { v };
  }
  /* Writes nothing, anywhere. */
  async dryRun(id) {
    const { resp, v } = await this.checked(id); if (resp) return resp;
    const liveText = await this.dumpLive(), live = bkDecode(liveText), snap = bkDecode(v.text);
    return json({ ok: true, dryRun: true, id, verified: true, identical: bkSameEntries(live, snap), createdAt: v.meta.createdAt,
      before: bkSummary(live), after: bkSummary(snap), diff: bkDiff(live, snap), confirm: "RESTORE " + id });
  }
  async restore(id, confirm) {
    if (!id) return json({ error: "Choose a backup." }, 400);
    if (confirm !== "RESTORE " + id) return json({ error: 'To restore, type exactly: RESTORE ' + id }, 400);
    const { resp, v } = await this.checked(id); if (resp) return resp;
    const liveText = await this.dumpLive();
    const safety = await this.takeSnapshot("safety", "before restoring " + id, liveText);
    if (!safety.verified) {
      await this.log({ event: "restore REFUSED: the safety backup failed its check", id, safety: safety.id });
      return json({ ok: false, error: "The safety backup of the current leaderboard failed its check, so nothing was restored." }, 500);
    }
    let r;
    try { r = await this.lb("/backup-restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: v.text }); }
    catch (e) { r = { ok: false, status: "error: " + ((e && e.message) || e) }; }
    if (!r.ok) {
      await this.log({ event: "restore FAILED while writing", id, safety: safety.id });
      return json({ ok: false, error: "The restore failed while writing (" + r.status + "). The safety backup " + safety.id + " holds the state from just before.", safetyId: safety.id }, 500);
    }
    const after = bkDecode(await this.dumpLive()), want = bkDecode(v.text), ok = bkSameEntries(after, want);
    await this.log(ok ? { event: "RESTORED", id, safety: safety.id } : { event: "restore written but the check FAILED", id, safety: safety.id });
    await this.prune();
    return json({ ok, restored: id, safetyId: safety.id, verified: ok, before: bkSummary(bkDecode(liveText)), after: bkSummary(after),
      error: ok ? "" : "The leaderboard does not match the backup after the restore. The safety backup " + safety.id + " holds the state from just before." }, ok ? 200 : 500);
  }
  async exportFile(id) {
    const { resp, v } = await this.checked(id); if (resp) return resp;
    const { chunkSha, gen, ...manifest } = v.meta;
    const text = '{"format":"flux-leaderboard-backup","manifest":' + JSON.stringify(manifest) + ',"snapshot":' + v.text + "}";
    return new Response(text, { headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="flux-backup-' + id + '.json"' } });
  }
  /* A downloaded file back in as a snapshot ("imported"), checked against its own
     checksum; then it can be dry-run and restored like any other. */
  async importFile(body) {
    const f = body && body.backup;
    if (!f || f.format !== "flux-leaderboard-backup" || !f.manifest || typeof f.manifest.sha256 !== "string" || !f.snapshot) return json({ error: "This is not a FLUX backup file." }, 400);
    const text = JSON.stringify(f.snapshot);
    let entries;
    try { entries = bkDecode(text); } catch (e) { return json({ error: "This is not a FLUX backup file." }, 400); }
    if ((await bkSha(text)) !== f.manifest.sha256 || entries.length !== f.manifest.keyCount) return json({ error: "This file does not match its own checksum; it was changed or damaged." }, 400);
    const meta = await this.takeSnapshot("imported", "uploaded copy of " + String(f.manifest.id || "?").slice(0, 60) + " from " + (f.manifest.createdAt ? new Date(f.manifest.createdAt).toISOString() : "?"), text);
    await this.log(meta.verified ? { event: "backup uploaded", id: meta.id, from: f.manifest.id } : { event: "upload FAILED its check", id: meta.id });
    const { chunkSha, ...m } = meta;
    return json({ ok: meta.verified, snapshot: m }, meta.verified ? 200 : 500);
  }
  /* Privacy deletion: the pilot is erased from every stored snapshot, with the
     same code as the live deletion. A snapshot that fails its check cannot be
     rewritten safely, so it is deleted (it could not be restored anyway). */
  async purgePlayer(pid, removePurchases) {
    if (!PID_RE.test(pid)) return json({ error: "Invalid entry" }, 400);
    let changed = 0, deleted = 0, checked = 0;
    for (const m of await this.metas()) {
      checked++;
      const v = await this.verify(m.id);
      if (!v.ok) { await this.deleteSnapshot(m); deleted++; continue; }
      const out = await bkErasePilot(bkDecode(v.text), pid, removePurchases);
      if (!out) continue;
      const text = bkEncode(out);
      if (text === v.text) continue;
      const meta = await this.writeSnapshot(text, { ...v.meta, purgedAt: Date.now() });
      if (!meta.verified) { await this.deleteSnapshot(meta); deleted++; } else changed++;
    }
    await this.log({ event: "privacy deletion applied to backups", changed, deleted });
    return json({ ok: true, checked, changed, deleted });
  }
}

/* Records: legacy single-score -> per-difficulty bests. */
/* FLUX COMMAND auth state helpers (the state object is described at handleCommandAuth). */
const CMD_HASH = /^[0-9a-f]{64}$/, CMD_CLIENT = /^[0-9a-f]{32}$/;
function cmdPrune(st, now) {
  const recent = (arr) => (Array.isArray(arr) ? arr : []).filter((t) => now - t < COMMAND_LOCK_MS);
  for (const h of Object.keys(st.s)) {
    const x = st.s[h];
    if (!x || now - x.l >= COMMAND_IDLE_MS || now - x.c >= COMMAND_MAX_MS) { delete st.s[h]; st.dirty = 1; }
  }
  for (const c of Object.keys(st.k)) {
    let x = st.k[c];
    const f = recent(x && x.f);
    if (!x || f.length !== x.f.length) { st.k[c] = x = { f, u: (x && x.u) || 0 }; st.dirty = 1; }
    if (!f.length && !(x.u > now)) { delete st.k[c]; st.dirty = 1; }
  }
  const gf = recent(st.g.f);
  if (gf.length !== st.g.f.length) { st.g.f = gf; st.dirty = 1; }
}
function cmdAttempt(st, b, now) {
  const client = CMD_CLIENT.test(b.client || "") ? b.client : "0".repeat(32);
  const k = st.k[client] || { f: [], u: 0 };
  if (k.u > now) return { ok: false, locked: true, retryAfter: Math.ceil((k.u - now) / 1000) };   // locked: the password is not even looked at
  if (b.ok === true) {
    if (st.k[client]) { delete st.k[client]; st.dirty = 1; }
    if (!CMD_HASH.test(b.hash || "")) return { ok: true };                                         // x-admin-token: no session
    st.s[b.hash] = { c: now, l: now };
    const oldest = Object.keys(st.s).sort((x, y) => st.s[x].c - st.s[y].c);
    while (oldest.length > COMMAND_MAX_SESSIONS) delete st.s[oldest.shift()];
    st.dirty = 1;
    return { ok: true, expiresAt: now + COMMAND_IDLE_MS, maxAt: now + COMMAND_MAX_MS };
  }
  const safety = st.g.u > now, limit = safety ? 1 : COMMAND_CLIENT_FAILS;
  k.f.push(now);
  st.g.f.push(now);
  if (st.g.f.length > 500) st.g.f = st.g.f.slice(-500);
  let locked = false, safetyOn = false;
  if (k.f.length >= limit) { k.u = now + COMMAND_LOCK_MS; k.f = []; locked = true; }
  st.k[client] = k;
  if (!safety && st.g.f.length >= COMMAND_GLOBAL_FAILS) { st.g.u = now + COMMAND_LOCK_MS; safetyOn = true; }
  st.a.push({ at: now, c: client.slice(0, 6), lock: locked ? 1 : 0, g: safetyOn ? 1 : 0 });
  if (st.a.length > COMMAND_ALERTS_KEPT) st.a = st.a.slice(-COMMAND_ALERTS_KEPT);
  st.dirty = 1;
  if (locked) return { ok: false, locked: true, retryAfter: COMMAND_LOCK_MS / 1000 };
  return { ok: false, attemptsLeft: limit - k.f.length };
}
function cmdCheck(st, b, now) {
  const x = CMD_HASH.test(b.hash || "") ? st.s[b.hash] : null;
  if (!x) return { ok: false };
  x.l = now; st.dirty = 1;                                                                           // idle timer restarts
  return { ok: true, expiresAt: Math.min(now + COMMAND_IDLE_MS, x.c + COMMAND_MAX_MS), maxAt: x.c + COMMAND_MAX_MS };
}
function cmdReport(st, now) {
  const day = st.a.filter((e) => now - e.at < AN_DAY_MS);
  return {
    ok: true, failed24h: day.length, lastFailedAt: st.a.length ? st.a[st.a.length - 1].at : null,
    lockedClients: Object.keys(st.k).filter((c) => st.k[c].u > now).length,
    safetyUntil: st.g.u > now ? st.g.u : null, recent: st.a.slice(-5).reverse(), sessions: Object.keys(st.s).length,
  };
}

function normaliseRecord(r, id) {
  if (r && r.bests && typeof r.bests === "object") return { ...r, bests: NP(r.bests), playerId: r.playerId || id };
  const d = VALID_DIFFICULTIES.has(r && r.difficulty) ? r.difficulty : "medium";
  const bests = Object.create(null);
  if (r && Number.isFinite(r.score)) bests[d] = { score: r.score, level: r.level || 1, updatedAt: r.updatedAt || 0 };
  return { playerId: (r && r.playerId) || id, name: r && r.name, country: r && r.country, updatedAt: (r && r.updatedAt) || 0, bests };
}
function weightedBestOf(r) {
  let best = null;
  for (const [d, b] of Object.entries((r && r.bests) || {})) {
    const w = b ? weightedScore(b.score, d) : -1;
    if (b && (!best || w > best.weighted)) best = { ...b, difficulty: d, weighted: w };
  }
  return best;
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
