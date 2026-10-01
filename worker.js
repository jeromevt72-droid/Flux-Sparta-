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

/* FREE PLAN (owner decision: FLUX stays on the free Cloudflare Workers plan).
   Free-plan daily limits this server must stay under, reset at 00:00 UTC:
     Worker requests        100,000 / day  (static assets in ./public do NOT
                                            invoke this script: wrangler.jsonc)
     Durable Object requests 100,000 / day (every stub.fetch below)
     DO SQLite rows written  100,000 / day
     DO SQLite rows read   5,000,000 / day
   USAGE COUNTER: each Worker isolate counts, in memory, its own invocations
   (w), the Durable Object requests it makes (d) and an ESTIMATE of the rows
   those requests write (rw). The counts ride along, at no extra request, on
   the next call this isolate makes to the "analytics" instance anyway (a run's
   stats, a stats beacon, the cron, the admin page), which adds them into
   today's stats row -- no extra request and no extra row. Accuracy: a lower
   bound. An isolate that is evicted before its next analytics call loses its
   unsent counts (at most the requests since its last run upload); the
   analytics instance's own writes are counted exactly. The Cloudflare
   dashboard stays the authority; this is the early warning on the admin page
   (alert at USAGE_ALERT_PCT of any limit). */
const FREE_LIMITS = { workerRequests: 100_000, doRequests: 100_000, rowsWritten: 100_000, rowsRead: 5_000_000 };
const USAGE_ALERT_PCT = 80;
const SUBMIT_ROWS_EST = 3;              // an accepted score writes players, lastSubmit, countries (+ flags when one is added)
let USE = { day: -1, w: 0, d: 0, rw: 0 };
function useFresh() { const day = Math.floor(Date.now() / 86_400_000); if (USE.day !== day) USE = { day, w: 0, d: 0, rw: 0 }; }
function useCount(field, n = 1) { useFresh(); USE[field] += n; }
function takeUse() { useFresh(); const out = { day: USE.day, w: USE.w, d: USE.d, rw: USE.rw }; USE.w = 0; USE.d = 0; USE.rw = 0; return out; }

/* LEADERBOARD MEMO (FREE PLAN): GET /api/leaderboard answers from this
   isolate's memory for up to LB_MEMO_MS, so a busy isolate asks the Durable
   Object at most about once a minute per board. Any POST through this isolate
   (a score, an admin action) clears it at once. Each response says
   X-Flux-Cache: hit | miss. (The Cache API was not used: on a *.workers.dev
   address it stores nothing, and a cache hit is still a Worker request.) */
const LB_MEMO_MS = 60_000;
const lbMemo = new WeakMap();
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
    useCount("w");                        // FREE PLAN: a cron run is a Worker request too (48 a day)
    ctx.waitUntil(reconcilePayments(env).catch((e) => console.error("reconcile:", e && e.message)));
    ctx.waitUntil(analyticsDO(env, "/an-purge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ use: takeUse() }) }).catch(() => {}));   // STATS: raw events older than 90 days -> totals only
    // BACKUPS: the first run of each UTC day takes the daily leaderboard backup; later runs that day do nothing.
    if (env.LEADERBOARD_DO) ctx.waitUntil(backupDO(env, "/daily", { method: "POST" })
      .then(async (r) => { if (!r.ok) console.error("backup: daily failed:", (await r.text()).slice(0, 300)); })
      .catch((e) => console.error("backup: daily failed:", e && e.message)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    useCount("w");                        // FREE PLAN: every invocation of this script

    try {
      if (path.startsWith("/api/")) {
        if (request.method === "OPTIONS") return preflight();
        if (request.method !== "GET") lbMemo.delete(env);   // LEADERBOARD MEMO: a write through this isolate shows at once

        if (path === "/api/leaderboard" && request.method === "GET") {
          return withCors(await getLeaderboard(request, env, url));
        }
        if (path === "/api/submit-score" && request.method === "POST") {
          return withCors(await submitRun(request, env, ctx));   // FREE PLAN: a run's score AND its stats, one request
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
            "/api/admin/usage":              () => adminUsage(request, env),         // FREE PLAN: today's requests vs the free limits
            "/api/admin/backups":            () => adminBackup(request, env, "/list"),        // BACKUPS: list + last status
            "/api/admin/backup-now":         () => adminBackup(request, env, "/snapshot"),    // BACKUPS: manual backup
            "/api/admin/backup-dry-run":     () => adminBackup(request, env, "/dry-run"),     // BACKUPS: what a restore would change; writes nothing
            "/api/admin/backup-restore":     () => adminBackup(request, env, "/restore"),     // BACKUPS: real restore, typed confirmation only
            "/api/admin/backup-download":    () => adminBackup(request, env, "/export"),      // BACKUPS: the snapshot as a JSON file
            "/api/admin/backup-import":      () => adminBackup(request, env, "/import"),      // BACKUPS: a downloaded file back in, as a snapshot
            "/api/admin/session":            () => adminSession(request, env),       // FLUX COMMAND: "am I still logged in?"
            "/api/admin/summary":            () => adminSummary(request, env),       // FLUX COMMAND: owner summary, one request
            "/api/admin/world-grid-dry-run": () => adminDO(request, env, "/world-grid-dry-run", {}),   // COMBINED WORLD GRID: before/after report, writes nothing
            "/api/admin/world-grid-apply":   () => adminWorldGridApply(request, env),                 // COMBINED WORLD GRID: typed APPLY <id> + recent checked backup
            "/api/admin/world-grid-revert":  () => adminDO(request, env, "/world-grid-revert", { reason: "by the owner" }),   // COMBINED WORLD GRID: switch back
            "/api/admin/founding-status":    () => adminFounding(request, env, "status"),      // FOUNDING PILOT: counter, exclusions, log
            "/api/admin/founding-dry-run":   () => adminFounding(request, env, "dry-run"),     // FOUNDING PILOT: who WOULD be numbered; writes nothing
            "/api/admin/founding-switch":    () => adminFounding(request, env, "switch"),      // FOUNDING PILOT: ON (typed + backup < 60 min) / OFF
            "/api/admin/founding-continue":  () => adminFounding(request, env, "continue"),    // FOUNDING PILOT: resume numbering (ON only)
            "/api/admin/founding-exclude":   () => adminFounding(request, env, "exclude"),     // FOUNDING PILOT: exclusion list by #TAG
            "/api/admin/founding-take-back": () => adminFounding(request, env, "take-back"),   // FOUNDING PILOT: typed TAKE BACK #TAG
            "/api/admin/storage-status":          () => adminStorage(request, env, "status"),     // STORAGE FIX: layout, size, move progress
            "/api/admin/migrate-storage-dry-run": () => adminStorage(request, env, "dry-run"),    // STORAGE FIX: builds the new layout in memory; writes nothing live
            "/api/admin/migrate-storage":         () => adminStorage(request, env, "migrate"),    // STORAGE FIX: typed confirmation + backup < 60 min + safety backup
            "/api/admin/migrate-storage-check":   () => adminStorage(request, env, "check"),      // STORAGE FIX: old vs new, PASS / FAIL
            "/api/admin/migrate-storage-rollback": () => adminStorage(request, env, "rollback"),  // STORAGE FIX: back to the old layout
            "/api/admin/migrate-storage-cleanup": () => adminStorage(request, env, "cleanup"),    // STORAGE FIX: removes the old layout's values (later, by hand)
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

      // FREE PLAN: never reached in production. wrangler.jsonc serves every file
      // in ./public, and every missing path (not_found_handling "404-page"),
      // without invoking this script; only /api/* runs it (run_worker_first).
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
  const stub = env.LEADERBOARD_DO.get(id);
  return { fetch(u, init) { useCount("d"); return stub.fetch(u, init); } };   // FREE PLAN: every DO request is counted
}
/* LEADERBOARD MEMO (see LB_MEMO_MS). */
async function getLeaderboard(request, env, url) {
  let memo = lbMemo.get(env);
  if (!memo) { memo = new Map(); lbMemo.set(env, memo); }
  const now = Date.now(), key = url.search, hit = memo.get(key);
  if (hit && now - hit.at < LB_MEMO_MS) return new Response(hit.body, { status: 200, headers: { "Content-Type": "application/json", "X-Flux-Cache": "hit" } });
  const resp = await forwardToDO(request, env, "/leaderboard" + url.search);
  if (resp.status !== 200) return resp;
  const body = await resp.text();
  if (memo.size >= 16) memo.clear();
  memo.set(key, { at: now, body });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json", "X-Flux-Cache": "miss" } });
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
async function rlKeys(route, request, playerCode) {
  const lim = RATE_LIMITS[route], keys = [], ip = await ipCode(request);
  if (ip && lim.ip) keys.push({ k: "i:" + route + ":" + ip, max: lim.ip });
  if (playerCode && lim.player) keys.push({ k: "p:" + route + ":" + playerCode, max: lim.player });
  return keys;
}
function rlRefusal(d) {
  if (!d || !d.limited) return null;
  const sec = Math.max(1, Math.min(60, Math.ceil(Number(d.retryAfterSec) || 60)));
  return json({ error: "Too many requests — please wait a moment", retryAfterSec: sec, rateLimited: true }, 429, { "Retry-After": String(sec) });
}
async function rateLimit(env, instance, route, request, playerCode) {
  try {
    if (!env.LEADERBOARD_DO) return null;
    const keys = await rlKeys(route, request, playerCode);
    if (!keys.length) return null;
    useCount("d");
    const r = await env.LEADERBOARD_DO.get(env.LEADERBOARD_DO.idFromName(instance)).fetch("https://do.internal/rl", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) });
    return rlRefusal(r.ok ? await r.json() : null);
  } catch (e) { return null; }           // fail open: the limiter never costs a legitimate request
}
/* FREE PLAN: for uploads and stats the limiter keys ride INSIDE the request
   the route makes anyway (header X-Flux-RL), and the Durable Object that
   serves it checks them in memory first -- same limits, same 429 +
   Retry-After, no extra Durable Object round trip. (Restore check and admin
   keep the separate /rl call: rare routes.) */
const RL_HEADER = "X-Flux-RL", RL_LIMITED_HEADER = "X-Flux-Limited";
async function rlHeaders(route, request, playerCode, headers) {
  try { const keys = await rlKeys(route, request, playerCode); if (keys.length) headers[RL_HEADER] = JSON.stringify(keys); } catch (e) {}   // fail open
  return headers;
}
async function rlFromDO(resp) {
  if (resp.status !== 429 || resp.headers.get(RL_LIMITED_HEADER) !== "1") return resp;
  return rlRefusal(await resp.json().catch(() => ({ limited: true }))) || resp;
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
  useCount("d");
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
    const bid = typeof body.bid === "string" && BATCH_ID_RE.test(body.bid) ? body.bid : "";   // older pages send none
    const c = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
    const cf = (request.cf && request.cf.country) || "";
    const country = ISO2.test(c) ? c : (ISO2.test(cf) ? cf : "XX");   // country only, never a precise location
    const r = await rlFromDO(await analyticsDO(env, "/an-ingest", { method: "POST", headers: await rlHeaders("events", request, h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ h, bid, src: cleanSrc(body.src), country, events, use: takeUse() }) }));
    if (r.status === 429) return r;
    return json({ ok: r.ok }, r.ok ? 200 : 500);
  } catch (e) { return json({ ok: false }, 500); }
}
/* FREE PLAN: ONE REQUEST PER RUN. At game over the game sends its score and
   that run's stats together to /api/submit-score:
     { playerId, name, score, level, difficulty, country, season,
       stats: { src, events: [...] } }            (stats is optional)
   The score goes to the leaderboard exactly as before (same checks, same
   forwarded fields). The stats go to the "analytics" instance exactly as
   /api/events would send them (same cleaning, same one-way code, country
   only) -- but only once the score has a final answer: on 429 / 5xx the game
   keeps the whole upload queued and sends it again, so the stats are not
   counted twice. They are sent after the reply (waitUntil), so the player
   never waits for them. Pages from before this change send no "stats" and
   keep using /api/events: both paths stay. */
function runStats(body, playerId) {
  const st = body && body.stats;
  if (!st || typeof st !== "object" || !validPlayerId(playerId)) return null;
  const events = (Array.isArray(st.events) ? st.events : []).slice(0, AN_MAX_BATCH).map(cleanEvent).filter(Boolean);
  return events.length ? { src: st.src, events } : null;
}
async function ingestRunStats(request, env, playerId, chosen, stats, runId) {
  const c = typeof chosen === "string" ? chosen.trim().toUpperCase() : "";
  const cf = (request.cf && request.cf.country) || "";
  const country = ISO2.test(c) ? c : (ISO2.test(cf) ? cf : "XX");   // country only, never a precise location
  const r = await analyticsDO(env, "/an-ingest", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ h: await analyticsCode(playerId), bid: runId, src: cleanSrc(stats.src), country, events: stats.events, use: takeUse() }) });
  return r.ok;
}
async function submitRun(request, env, ctx) {
  const body = await readJsonObject(request);
  const resp = await submitScore(body, request, env);
  if (resp.ok) useCount("rw", SUBMIT_ROWS_EST);
  const playerId = body && typeof body.playerId === "string" ? body.playerId.trim() : "";
  const stats = runStats(body, playerId);
  // REPLAY PROTECTION: the run id is also the stats batch id, so a retried
  // run is counted once; a reply marked duplicate needs no stats request at all.
  const runId = body && typeof body.runId === "string" && BATCH_ID_RE.test(body.runId) ? body.runId : "";
  const dup = resp.ok ? !!(await resp.clone().json().catch(() => ({}))).duplicate : false;
  if (stats && !dup && resp.status !== 429 && resp.status < 500) {
    const p = ingestRunStats(request, env, playerId, body.country, stats, runId).catch(() => false);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); else await p;
  }
  return resp;
}
/* FREE PLAN: today's usage against the free limits, for the admin page. */
async function adminUsage(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  const r = await analyticsDO(env, "/an-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ use: takeUse() }) });
  const headers = new Headers(r.headers); headers.set("Cache-Control", "no-store");
  return new Response(r.body, { status: r.status, headers });
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
/* FREE PLAN: adds one Worker isolate's counts (only today's) and the rows this
   write itself makes into day._use. Returns whether anything was added. */
function anUse(day, use, today, ownRows) {
  const u = day._use || { w: 0, d: 0, rw: 0 };
  const n = (v) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x > 0 ? Math.min(x, 10_000_000) : 0; };
  const ok = !!use && typeof use === "object" && use.day === today;
  u.w += ok ? n(use.w) : 0; u.d += ok ? n(use.d) : 0; u.rw += (ok ? n(use.rw) : 0) + n(ownRows);
  day._use = u;
  return ok || n(ownRows) > 0;
}
function anAdd(bucket, groups, field, n) { for (const g of groups) { const o = bucket[g] || (bucket[g] = {}); o[field] = (o[field] || 0) + n; } }

/* ------------------------------------------------------------------ */
/* Score submission                                                    */
/* ------------------------------------------------------------------ */

async function submitScore(body, request, env) {
  if (!body) return json({ error: "Invalid request body" }, 400);

  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!validPlayerId(playerId)) {
    return json({ error: "Missing or invalid playerId" }, 400);
  }

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

  return rlFromDO(await forwardToDO(request, env, "/submit" + (runId ? "?run=" + encodeURIComponent(runId) : ""), {
    method: "POST",
    headers: await rlHeaders("submit", request, await pidHash(playerId), { "Content-Type": "application/json" }),   // FREE PLAN: limiter checked inside the DO
    body: JSON.stringify({ playerId, name, score, level, difficulty, country, detected }),
  }));
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
  useCount("d");
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
  const [rep, lb, delivery, sec, bk, usage] = await Promise.all([
    body(analyticsDO(env, "/an-report?today=1")),
    body(forwardToDO(request, env, "/admin-summary", { method: "POST" })),
    safe(listDeliveryExceptions(env)),
    env.LEADERBOARD_DO ? safe(commandIds(request, env).then(({ fp }) => commandDO(env, "/auth-report", { fp }))) : null,
    env.LEADERBOARD_DO ? body(backupDO(env, "/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })) : null,
    body(analyticsDO(env, "/an-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ use: takeUse() }) })),   // FREE PLAN
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
    // FOUNDING PILOT: the counter (given / 1,000, spots left) on the first screen
    founding: lb && lb.founding ? lb.founding : null,
    // COMBINED WORLD GRID: is the combined grid (Season 0 + Season 1) live?
    worldGrid: lb && lb.worldGrid ? { combined: !!lb.worldGrid.combined, appliedAt: lb.worldGrid.appliedAt, revertedAt: lb.worldGrid.revertedAt, layout: lb.worldGrid.layout, ready: lb.worldGrid.ready !== false } : null,
    // FREE PLAN: today's requests vs the free daily limits; alert from USAGE_ALERT_PCT (80%).
    usage: usage && usage.ok ? usage : null,
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
/* COMBINED WORLD GRID: APPLY, in this order, stopping at the first problem:
     0. the leaderboard is on the new storage layout (else "Move the storage first");
     1. the owner typed exactly "APPLY <dry-run id>";
     2. a CHECKED backup (daily, manual or safety) exists from the last 60 minutes --
        otherwise refused with needBackup, and the admin page offers BACK UP NOW;
     3. the leaderboard re-runs the dry run: the id is under 60 minutes old, the
        archive is unchanged since, and every check passes (writes nothing);
     4. a safety backup of the leaderboard as it is now (verified), then the switch;
     5. the same checks against the live /leaderboard route. If they fail, the
        switch is turned back off at once and the answer says so.
   Written: the switch, the Season 0 table (once, from the archive) and the
   summary row -- no best, no archive entry, no pilot row is rewritten. */
async function adminWorldGridApply(request, env) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  if (!env.LEADERBOARD_DO) return json({ error: "Leaderboard storage is not configured (missing LEADERBOARD_DO binding)" }, 500);
  const b = await adminBody(request);
  const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const lb = async (path, body) => { const r = await forwardToDO(request, env, path, post(body)); return { r, d: await r.json().catch(() => ({})) }; };
  const lay = await lb("/world-grid-apply", { stage: "layout" });   // the new storage layout only: "Move the storage first"
  if (!lay.r.ok) return json(lay.d, lay.r.status);
  const id = typeof b.id === "string" && WORLD_GRID_ID.test(b.id) ? b.id : "";
  if (!id) return json({ error: "Run a DRY RUN first; applying needs its id." }, 400);
  if (b.confirm !== "APPLY " + id) return json({ error: "To apply, type exactly: APPLY " + id }, 400);
  let list = null;
  try { const r = await backupDO(env, "/list", post({})); list = r.ok ? await r.json() : null; } catch (e) { list = null; }
  if (!list) return json({ error: "Could not read the backups, so nothing was changed. Try again in a minute." }, 503);
  const now = Date.now();
  const recent = (list.snapshots || []).find((m) => m.verified && m.kind !== "imported" && now - m.createdAt <= WORLD_GRID_BACKUP_MAX_AGE_MS && m.createdAt <= now + 60000);
  if (!recent) return json({ error: "No checked backup from the last 60 minutes, so nothing was changed. Press BACK UP NOW, then apply again.", needBackup: true }, 409);
  const pre = await lb("/world-grid-apply", { id, stage: "check" });
  if (!pre.r.ok) return json(pre.d, pre.r.status);
  let safety = null;
  try { const r = await backupDO(env, "/safety", post({ note: "before the combined World Grid " + id })); const d = await r.json(); safety = r.ok && d.ok ? d.snapshot : null; } catch (e) { safety = null; }
  if (!safety) return json({ error: "The safety backup failed its check, so nothing was changed." }, 500);
  const sw = await lb("/world-grid-apply", { id, stage: "switch", backupId: recent.id, safetyId: safety.id });
  if (!sw.r.ok) return json({ ...sw.d, safetyId: safety.id }, sw.r.status);
  const ck = await lb("/world-grid-check", {});
  if (!ck.r.ok || !ck.d.ok) {
    await lb("/world-grid-revert", { reason: "the check after APPLY failed" });
    return json({ ok: false, reverted: true, error: "The check after switching failed, so the World Grid was switched back to Season 1 only. Nothing else changed.", checks: ck.d.checks || [], safetyId: safety.id }, 500);
  }
  return json({ ok: true, applied: id, backupId: recent.id, safetyId: safety.id, checks: ck.d.checks, worldGrid: sw.d.worldGrid });
}
/* STORAGE FIX (see PilotLayoutV2): the owner's storage move, one step per
   button, every step behind the admin password. The move itself refuses unless
   a verified backup of the leaderboard is less than 60 minutes old, takes its
   own safety backup first, and then copies in batches (the admin page calls
   again while "more" is true). Nothing here ever runs by itself. */
async function adminStorage(request, env, action) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  if (!env.LEADERBOARD_DO) return json({ error: "Storage is not set up on this server (no LEADERBOARD_DO binding)." }, 500);
  const b = await adminBody(request);
  const confirm = typeof b.confirm === "string" ? b.confirm.trim() : "";
  const call = (path, body) => forwardToDO(request, env, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const out = (resp) => { const h = new Headers(resp.headers); h.set("Cache-Control", "no-store"); return new Response(resp.body, { status: resp.status, headers: h }); };
  const nostore = { "Cache-Control": "no-store" };
  if (action === "status") {
    const s = await (await call("/mig-status")).json().catch(() => ({ ok: false }));
    s.backup = await sfLatestBackup(env);
    return json(s, 200, nostore);
  }
  if (action === "dry-run") return out(await call("/mig-dry-run"));
  if (action === "check") return out(await call("/mig-check", { mode: b.mode === "all" ? "all" : "sample", cursor: Math.max(0, Math.floor(Number(b.cursor) || 0)) }));
  if (action === "migrate") {
    const bk = await sfLatestBackup(env);
    if (!bk.fresh) return json({ ok: false, needBackup: true, backup: bk,
      error: "The move needs a verified backup taken in the last 60 minutes" + (bk.createdAt ? " (the newest is " + bk.ageMin + " minutes old)" : "") + ". Press BACK UP NOW, then try again." }, 409, nostore);
    const pre = await call("/mig-batch", { confirm, validateOnly: true });
    if (!pre.ok) return out(pre);
    const p = await pre.json();
    let safetyId = p.safetyId || "";
    if (p.needSafety) {
      const sf = await sfSafety(env, "before the storage move " + confirm.slice(8));
      if (!sf.ok) return json({ ok: false, error: "The safety backup failed its check, so nothing was changed." + (sf.error ? " (" + sf.error + ")" : "") }, 500, nostore);
      safetyId = sf.id;
    }
    let last = null;
    for (let i = 0; i < MIG_CALLS_PER_REQUEST; i++) {
      const r = await call("/mig-batch", { confirm, safetyId, backupId: bk.id });
      last = { status: r.status, body: await r.json().catch(() => ({ ok: false, error: "no answer" })) };
      if (r.status !== 200 || !last.body.more) break;
    }
    return json(last.body, last.status, nostore);
  }
  if (action === "rollback" || action === "cleanup") {
    const path = action === "rollback" ? "/mig-rollback" : "/mig-cleanup";
    const pre = await call(path, { confirm, validateOnly: true });
    if (!pre.ok) return out(pre);
    const p = await pre.json();
    if (p.needSafety) {
      const sf = await sfSafety(env, "before storage " + action);
      if (!sf.ok) return json({ ok: false, error: "The safety backup failed its check, so nothing was changed." }, 500, nostore);
    }
    return out(await call(path, { confirm }));
  }
  return json({ error: "Not found" }, 404);
}
/* FOUNDING PILOT (see FND_SCHEMA): the owner's switch, one step per button, every step behind
   the admin login. ON needs the typed "FOUNDING ON" and a verified backup from the last 60
   minutes; it numbers the existing pilots in batches (resumable: "more" -> CONTINUE). OFF,
   the dry run, the exclusion list and the status need neither. */
async function adminFounding(request, env, action) {
  const denied = requireAdmin(request, env); if (denied) return denied;
  if (!env.LEADERBOARD_DO) return json({ error: "Leaderboard storage is not configured (missing LEADERBOARD_DO binding)" }, 500);
  const b = await adminBody(request);
  const call = async (path, body) => {
    const r = await forwardToDO(request, env, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return { status: r.status, d: await r.json().catch(() => ({ ok: false, error: "No answer from the leaderboard." })) };
  };
  const out = (x) => json(x.d, x.status);
  const tag = String(b.tag || "").slice(0, 40);
  if (action === "status") { const x = await call("/founding-status"); if (x.status === 200) x.d.backup = await sfLatestBackup(env); return out(x); }
  if (action === "dry-run") return out(await call("/founding-dry-run"));
  if (action === "exclude") return out(await call("/founding-exclude", { tag, remove: !!b.remove }));
  if (action === "take-back") return out(await call("/founding-take-back", { tag, confirm: String(b.confirm || "").slice(0, 60) }));
  if (action === "switch" && !b.on) return out(await call("/founding-switch", { on: false }));
  if (action === "switch") {
    if (String(b.confirm || "").trim() !== FOUNDING_CONFIRM) return json({ error: "To switch the offer ON, type exactly: " + FOUNDING_CONFIRM }, 400);
    const st = await call("/founding-status");
    if (st.status !== 200) return out(st);
    if (st.d.layout !== "new") return json({ error: FOUNDING_MOVE_FIRST }, 409);
    const bk = await sfLatestBackup(env);
    if (!bk.fresh) return json({ ok: false, needBackup: true, backup: bk,
      error: "Switching ON needs a verified backup taken in the last 60 minutes" + (bk.createdAt ? " (the newest is " + bk.ageMin + " minutes old)" : "") + ". Press BACK UP NOW, then try again." }, 409);
  }
  let x = null, numbered = 0, rows = 0;
  for (let i = 0; i < FOUNDING_CALLS_PER_REQUEST; i++) {
    x = await call(i === 0 && action === "switch" ? "/founding-switch" : "/founding-continue", { on: true, limit: b.limit });
    if (x.status !== 200) break;
    numbered += x.d.numbered || 0; rows += x.d.rowsWritten || 0;
    if (!x.d.more) break;
  }
  if (x.status === 200) { x.d.numbered = numbered; x.d.rowsWritten = rows; }
  return out(x);
}
/* The newest verified backup that is a copy of the live leaderboard (daily,
   BACK UP NOW or a safety copy -- not an uploaded file), and whether it is
   recent enough for the storage move. */
async function sfLatestBackup(env) {
  try {
    const r = await backupDO(env, "/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d = await r.json();
    const m = (d.snapshots || []).find((x) => x && x.verified && x.kind !== "imported");
    if (!m) return { fresh: false, id: "", createdAt: 0, ageMin: null };
    const age = Date.now() - m.createdAt;
    return { fresh: age >= 0 && age <= MIG_BACKUP_MAX_AGE_MS, id: m.id, kind: m.kind, createdAt: m.createdAt, ageMin: Math.floor(age / 60000) };
  } catch (e) { return { fresh: false, id: "", createdAt: 0, ageMin: null, error: "could not read the backups" }; }
}
async function sfSafety(env, note) {
  try {
    const r = await backupDO(env, "/safety", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) });
    const d = await r.json();
    return { ok: r.ok && d.ok === true, id: d.snapshot ? d.snapshot.id : "", error: d.error || "" };
  } catch (e) { return { ok: false, id: "", error: (e && e.message) || "safety backup failed" }; }
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
  const r = await stub.fetch("https://do.internal/entitlements?paid=1&playerId=" + encodeURIComponent(playerId));   // FOUNDING PILOT: Stripe purchases only
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
  if (typeof a !== "string" || typeof b !== "string") return false;
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
      // STORAGE FIX: which layout holds the pilots. No "storageLayout" = the old one (every pilot in "players").
      this.restoring = !!(await this.state.storage.get(V2_RESTORING_KEY));
      this.migPhase = ((await this.state.storage.get(MIG_KEY)) || {}).phase || "";
      if ((await this.state.storage.get(STORAGE_LAYOUT_KEY)) === "v2") { await this.loadV2(); this.ready = true; return; }
      this.layout = "v1";
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
      this.archiveCache = null;
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
    this.archiveCache = null;
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
    if (this.layout === "v2" && this.v2) this.v2.wgForget(playerId);   // COMBINED WORLD GRID: the Season 0 row goes too
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
    this.archiveCache = null; this.rowsCache = null;
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
    const rlk = request.headers.get(RL_HEADER);                                          // FREE PLAN: limiter keys inside the request
    if (rlk) {
      let keys = []; try { keys = JSON.parse(rlk); } catch (e) {}
      keys = (Array.isArray(keys) ? keys : []).slice(0, 4).filter((x) => x && typeof x.k === "string" && x.k.length <= 80 && Number.isFinite(x.max) && x.max > 0);
      const d = this.rateCheck(keys, Date.now());
      if (d.limited) return json({ limited: true, retryAfterSec: d.retryAfterSec }, 429, { [RL_LIMITED_HEADER]: "1" });
    }
    if (url0.pathname.startsWith("/an-")) return this.handleAnalytics(request, url0);   // STATS instance: never loads the leaderboard
    if (url0.pathname.startsWith("/auth-")) return this.handleCommandAuth(request, url0);   // FLUX COMMAND instance: never loads the leaderboard
    if (url0.pathname.startsWith("/bk/")) return this.handleBackups(request, url0);    // BACKUPS instance: never loads the leaderboard
    // BACKUPS: the "backups" instance never serves leaderboard routes.
    if (this.role === undefined) this.role = (await this.state.storage.get(BACKUP_ROLE_KEY)) || "";
    if (this.role) return json({ error: "Not found" }, 404);
    if (url0.pathname.startsWith("/mig-") || url0.pathname.startsWith("/v2bk-")) return this.handleStorageFix(request, url0);   // STORAGE FIX: the owner's move + paged backups
    await this.load();
    const url = new URL(request.url);
    // STORAGE FIX: while a backup copies the new layout, or a restore runs, writes wait (503 + Retry-After;
    // the game keeps the score queued and retries). Writes in flight are counted, so a layout switch or a
    // backup starts only after they have finished -- none can land in the layout being left behind.
    if (!V2_WRITE_ROUTES.has(url.pathname)) return this.routeLayout(request, url);
    if (this.writesBlocked()) return v2Busy();
    this.writing = (this.writing || 0) + 1;
    try { return await this.routeLayout(request, url); } finally { this.writing--; }
  }

  routeLayout(request, url) {
    if (this.layout === "v2") return this.v2.fetch(request, url);   // STORAGE FIX: one SQL row per pilot
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
      "/world-grid-dry-run": () => this.handleWorldGridDryRun(),     // COMBINED WORLD GRID (admin; writes nothing)
      "/world-grid-apply": () => this.handleWorldGridApply(request),
      "/world-grid-check": () => this.handleWorldGridCheck(),
      "/world-grid-revert": () => this.handleWorldGridRevert(request),
      "/founding-status": () => json({ ok: true, layout: "old", on: false, given: 0, cap: FOUNDING_CAP, left: FOUNDING_CAP, excluded: [], log: [] }),   // FOUNDING PILOT: new layout only
      "/founding-dry-run": () => json({ error: FOUNDING_MOVE_FIRST }, 409),
      "/founding-switch": () => json({ error: FOUNDING_MOVE_FIRST }, 409),
      "/founding-continue": () => json({ error: FOUNDING_MOVE_FIRST }, 409),
      "/founding-exclude": () => json({ error: FOUNDING_MOVE_FIRST }, 409),
      "/founding-take-back": () => json({ error: FOUNDING_MOVE_FIRST }, 409),
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
        if (url.pathname === "/an-purge") return await this.anPurge(await this.anBody(request));
        if (url.pathname === "/an-usage") return await this.anUsage(await this.anBody(request));   // FREE PLAN
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
    anUse(day, b.use, today, Object.keys(puts).length);   // FREE PLAN: the usage counter rides in today's row
    await st.put(puts);
    return json({ ok: true });
  }
  async anBody(request) { try { const t = await request.text(); return t ? JSON.parse(t) || {} : {}; } catch (e) { return {}; } }
  /* FREE PLAN: a Worker isolate's usage counts (see FREE_LIMITS), added into today's row. */
  async anAddUse(use) {
    if (!use || !(Number(use.w) > 0 || Number(use.d) > 0 || Number(use.rw) > 0)) return;
    const st = this.state.storage, today = this.anToday(), day = (await st.get("an:day:" + today)) || {};
    if (!anUse(day, use, today, 1)) return;
    const days = (await st.get("an:days")) || [], puts = { ["an:day:" + today]: day };
    if (days[days.length - 1] !== today) { days.push(today); puts["an:days"] = days; }
    await st.put(puts);
  }
  async anUsage(b) {
    await this.anAddUse(b && b.use);
    const st = this.state.storage, today = this.anToday(), days = [];
    for (let d = today - 6; d <= today; d++) {
      const u = ((await st.get("an:day:" + d)) || {})._use || { w: 0, d: 0, rw: 0 };
      days.push({ date: anDayStr(d), w: u.w || 0, d: u.d || 0, rw: u.rw || 0 });
    }
    const u = days[days.length - 1], L = FREE_LIMITS;
    const pct = { workerRequests: 100 * u.w / L.workerRequests, doRequests: 100 * u.d / L.doRequests, rowsWritten: 100 * u.rw / L.rowsWritten };
    const nowMs = this.nowMs ? this.nowMs() : Date.now(), dayFrac = Math.max(1 / 24, (nowMs - today * AN_DAY_MS) / AN_DAY_MS);
    const peak = Math.max(pct.workerRequests, pct.doRequests, pct.rowsWritten);
    return json({ ok: true, today: anDayStr(today), usage: { workerRequests: u.w, doRequests: u.d, rowsWritten: u.rw }, limits: L, pct,
      alertPct: USAGE_ALERT_PCT, alert: peak >= USAGE_ALERT_PCT, projectedPct: Math.round(peak / dayFrac), resetsAt: new Date((today + 1) * AN_DAY_MS).toISOString(),
      accuracy: "approximate lower bound: counted in each Worker instance's memory and saved on its next stats call; the Cloudflare dashboard is exact",
      days });
  }
  async anPurge(b) {
    await this.anAddUse(b && b.use);
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
      const day = await st.get("an:day:" + d); if (day) { const { _use, ...groups } = day; days.push({ date: anDayStr(d), groups }); }   // FREE PLAN: usage is not a stats group
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
     each player's best WEIGHTED score across difficulties (DIFF_WEIGHT; kept
     for the country totals / World Grid and for old cached pages -- the game
     no longer shows an All board).
     LEADERBOARD REFRESH (FREE PLAN, CPU): the sorted rows of each board are
     built ONCE and cached in memory (this.rowsCache) until the players, the
     restrictions or the name bans change -- the same moments the tag map is
     rebuilt (invalidateTags). A cached board also carries, for every row, its
     rank inside its own country, so a pilot's world rank, country rank and the
     score just above are read in O(1) (a Map lookup), never with a new sort.
     Cost: one O(n log n) sort per board after a change (about 2-4 ms at 10,000
     pilots, which the old code already paid on EVERY leaderboard read), then
     nothing until the next change. Memory only: nothing is ever written.
     COMBINED WORLD GRID: new storage layout only (PilotLayoutV2); the old
     layout always serves this season's grid. */
  async publicRows(difficulty) { return (await this.boardIndex(difficulty)).rows; }
  async boardIndex(difficulty) {
    const key = difficulty || "all";
    const cache = this.rowsCache || (this.rowsCache = new Map());
    const hit = cache.get(key);
    if (hit && hit.players === this.players && hit.restricted === this.restricted) return hit;
    const rows = [];
    for (const r of Object.values(this.players)) {
      if (await this.isRestricted(r.playerId)) continue;       // moderation exclusion
      const b = difficulty ? r.bests[difficulty] : weightedBestOf(r);
      if (!b) continue;
      rows.push({ r, score: difficulty ? b.score : b.weighted, points: b.score, level: b.level, difficulty: difficulty || b.difficulty, updatedAt: b.updatedAt || r.updatedAt || 0 });
    }
    rows.sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);
    const at = new Map(), cRank = new Array(rows.length), cCount = new Map();
    for (let i = 0; i < rows.length; i++) {
      const cc = countryOf(rows[i].r);
      const n = (cCount.get(cc) || 0) + 1;
      cCount.set(cc, n); cRank[i] = n; at.set(rows[i].r.playerId, i);
    }
    const idx = { players: this.players, restricted: this.restricted, rows, at, cRank, cCount };
    cache.set(key, idx);
    return idx;
  }
  /* LEADERBOARD REFRESH: one pilot's standing on one board, for that pilot's
     own upload reply only. O(1) on the cached board; null when not on it. */
  async standing(playerId, difficulty) {
    const idx = await this.boardIndex(difficulty);
    const i = idx.at.get(playerId);
    if (i === undefined) return null;
    const row = idx.rows[i], cc = countryOf(row.r), up = i > 0 ? idx.rows[i - 1] : null;
    let above = null;
    if (up) { const [o] = await this.tagRows([up]); above = { rank: i, name: this.displayName(up.r), tag: o.tag, country: countryOf(up.r), score: up.score }; }
    return { rank: i + 1, total: idx.rows.length, country: cc, countryRank: idx.cRank[i], countryTotal: idx.cCount.get(cc) || 0, score: row.score, above };
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
  invalidateTags() { this.tagCache = null; this.rowsCache = null; }   // LEADERBOARD REFRESH: the cached boards too

  /* ------------------------ COMBINED WORLD GRID ------------------------ */
  /* NEW STORAGE LAYOUT ONLY (see PilotLayoutV2 and WG0_SCHEMA). On the old
     layout every route below refuses with "Move the storage first" and the
     leaderboards stay this season's. The admin routes read the Season 0
     archive (a few chunk values) and every pilot row once, page by page; the
     game's routes never do (they use the per-board indexes and the summary row).
     Nothing here rewrites a best or the archive: APPLY writes the switch, the
     Season 0 table (derived from the archive, once) and the summary row. */
  worldGridState() {
    const w = this.worldGrid || {}, v2 = this.layout === "v2" ? this.v2 : null, live = !!(v2 && v2.comb);
    return { combined: live, layout: this.layout === "v2" ? "new" : "old", switchOn: !!w.combined, ready: !w.combined || live,
      appliedAt: w.appliedAt || null, revertedAt: w.revertedAt || null, dryRunId: w.dryRunId || null,
      backupId: w.backupId || null, safetyId: w.safetyId || null, log: (w.log || []).slice(-5).reverse() };
  }
  wgRefuse() {
    return this.layout === "v2" ? null : json({ ok: false, moveStorageFirst: true, layout: "old", error: WORLD_GRID_MOVE_FIRST }, 409);
  }
  async archivePilots() {
    if (!this.archiveCache) this.archiveCache = (await this.readSeasonArchive()).players;
    return this.archiveCache;
  }
  wgUse() { const u = this.sqlUse || { read: 0, written: 0 }; return { read: u.read, written: u.written }; }
  wgCost(u0, kvRead, kvWritten) {
    const u = this.wgUse();
    return { rowsRead: u.read - u0.read + (kvRead || 0), rowsWritten: u.written - u0.written + (kvWritten || 0) };
  }
  /* Every pilot row once (page by page), the archive, and the labels. */
  async worldGridInput() {
    const cached = !!this.archiveCache, archive = await this.archivePilots();
    const meta = cached ? null : await this.state.storage.get(SEASON_ARCHIVE_KEY);
    const pilots = [], restrictedIds = new Set(), erasedIds = new Set(), labels = new Map(), names = new Map();
    const erasedPids = new Set(this.restoreLog.filter((e) => e && e.reason === "(erased on privacy request)").map((e) => e.pid));
    this.v2.scanPilots((row) => {
      const rec = v2dec(row.rec);
      pilots.push({ playerId: row.id, name: rec.name, country: rec.country, updatedAt: rec.updatedAt || 0, bests: NP(rec.bests) });
      if (row.rs || ownGet(this.restricted, row.pid)) restrictedIds.add(row.id);
      labels.set(row.id, { pid: row.pid, tag: row.tag }); names.set(row.id, row.dname);
    });
    for (const a of archive) {
      const id = a && a.playerId;
      if (!validPlayerId(id) || labels.has(id)) continue;
      const pid = await this.pid(id);
      labels.set(id, { pid, tag: tagFromPid(pid, 7) });
      if (erasedPids.has(pid)) erasedIds.add(id);
    }
    return { archive, pilots, restrictedIds, erasedIds, labels, weights: DIFF_WEIGHT, archiveReads: cached ? 0 : 1 + ((meta && meta.chunks) || 0),
      nameOf: (r) => names.get(r.playerId) || cleanName(r.name),
      labelOf: (id) => (labels.has(id) ? "#" + labels.get(id).tag : "an archive entry") };
  }
  async worldGridFingerprint(archive) {
    return (await sha256Hex(JSON.stringify({ archive, weights: DIFF_WEIGHT }))).slice(0, 8);
  }
  /* The before/after report. Public hashes and tags only, never a playerId. */
  async worldGridReport(now) {
    const input = await this.worldGridInput();
    const before = seasonGrid(input), after = consolidateWorldGrid(input);
    const tagOf = (id) => (input.labels.get(id) || {}).tag || "";
    const rank = (totals) => { const m = new Map(); Object.values(totals).sort((a, b) => b.totalScore - a.totalScore).forEach((c, i) => m.set(c.country, { rank: i + 1, totalScore: c.totalScore, playerCount: c.playerCount })); return m; };
    const rb = rank(before.countries), ra = rank(after.countries);
    const countries = [...new Set([...ra.keys(), ...rb.keys()])].map((cc) => {
      const b = rb.get(cc) || null, a = ra.get(cc) || null;
      return { country: cc, before: b, after: a, change: (a ? a.totalScore : 0) - (b ? b.totalScore : 0), rankChange: a && b ? b.rank - a.rank : 0 };
    }).sort((x, y) => (x.after ? x.after.rank : 1e9) - (y.after ? y.after.rank : 1e9) || (x.before ? x.before.rank : 1e9) - (y.before ? y.before.rank : 1e9));
    const top = (rows, withSeason) => rows.slice(0, 10).map((x, i) => ({ rank: i + 1, name: input.nameOf(x.r), tag: tagOf(x.r.playerId), country: x.r.country || "", score: x.score,
      difficulty: x.difficulty, ...(withSeason ? { season: (ownGet(x.r.bests, x.difficulty) || {}).season } : {}) }));
    const archiveScores = input.archive.reduce((n, a) => n + Object.keys((a && a.bests) || {}).length, 0);
    const currentScores = input.pilots.reduce((n, r) => n + Object.keys(r.bests || {}).filter((d) => r.bests[d]).length, 0);
    const beforeIds = new Set(before.rows.map((x) => x.r.playerId));
    const fromS0 = { easy: 0, medium: 0, hard: 0 }, fromS1 = { easy: 0, medium: 0, hard: 0 };
    let onlyArchive = 0, both = 0, raised = 0;
    const cur = new Map(input.pilots.map((r) => [r.playerId, r]));
    for (const x of after.rows) {
      const p = x.r, c = cur.get(p.playerId);
      let s0 = false;
      for (const d of Object.keys(p.bests)) {
        const b = p.bests[d];
        if (b.season === 0) { s0 = true; fromS0[d] = (fromS0[d] || 0) + 1; if (c && ownGet(c.bests, d)) raised++; }
        else fromS1[d] = (fromS1[d] || 0) + 1;
      }
      if (!beforeIds.has(p.playerId)) onlyArchive++;        // on the grid again thanks to Season 0 only
      else if (s0) both++;                                  // Season 1 pilot whose Season 0 best is higher somewhere
    }
    const flaggedScores = after.flagged.filter((f) => f.code !== "restricted").reduce((n, f) => n + Object.keys(f.scores || {}).length, 0);
    const sum = (t) => Object.values(t).reduce((n, c) => n + c.totalScore, 0);
    const id = "WG-" + now.toString(36) + "-" + (await this.worldGridFingerprint(input.archive));
    const r = {
      id, confirm: "APPLY " + id, createdAt: now, dryRun: true, combinedNow: this.v2.comb, weights: { ...DIFF_WEIGHT }, layout: "new",
      checks: after.checks, allPass: after.ok,
      counts: {
        currentPilots: input.pilots.length, currentScores, archivePilots: input.archive.length, archiveScores,
        mergedScores: archiveScores - flaggedScores, flaggedScores, raisedScores: raised,
        pilotsBefore: before.rows.length, pilotsAfter: after.rows.length, onlyArchive, both, onlyCurrent: after.rows.length - onlyArchive - both,
        fromS0, fromS1, restrictedExcluded: input.restrictedIds.size, countriesBefore: rb.size, countriesAfter: ra.size, totalBefore: sum(before.countries), totalAfter: sum(after.countries),
      },
      notes: after.notes, countries,
      topBefore: top(before.rows, false), topAfter: top(after.rows, true),
      flagged: after.flagged.map((f) => ({ tag: f.playerId && input.labels.has(f.playerId) ? input.labels.get(f.playerId).tag : "", name: f.name ? cleanName(f.name) : "", country: f.country,
        code: f.code, reason: WORLD_GRID_REASONS[f.code] || f.code, difficulty: f.difficulty, scores: f.scores })),
    };
    return { report: r, input, after };
  }
  /* DRY RUN: the report; writes NOTHING. Cost: every pilot row read once + the archive's chunk values. */
  async handleWorldGridDryRun() {
    const no = this.wgRefuse(); if (no) return no;
    const u0 = this.wgUse();
    const { report, input } = await this.worldGridReport(Date.now());
    report.cost = { dryRun: this.wgCost(u0, input.archiveReads, 0), ...worldGridCosts(input.pilots.length, input.archive.length) };
    report.text = worldGridReportText(report);
    return json({ ok: true, ...report, worldGrid: this.worldGridState() });
  }
  /* APPLY (called by adminWorldGridApply after its backup checks): stage
     "check" re-verifies and writes nothing; stage "switch" builds the Season 0
     table from the archive (once; skipped when an earlier APPLY built it from
     the same archive), turns the switch on and rebuilds the summary row. No
     best and no archive entry is rewritten. */
  async handleWorldGridApply(request) {
    const no = this.wgRefuse(); if (no) return no;
    const b = (await readJsonObject(request)) || {};
    if (b.stage === "layout") return json({ ok: true, layout: "new" });
    const id = typeof b.id === "string" && WORLD_GRID_ID.test(b.id) ? b.id : "";
    if (!id) return json({ error: "Run a dry run first." }, 400);
    const now = Date.now(), made = parseInt(id.split("-")[1], 36);
    if (!(made <= now + 60000 && now - made <= WORLD_GRID_DRY_RUN_MAX_AGE_MS)) return json({ error: "This dry run is more than 60 minutes old. Run a new dry run, check it, then apply.", stale: true }, 409);
    const u0 = this.wgUse();
    const input = await this.worldGridInput();
    if ((await this.worldGridFingerprint(input.archive)) !== id.slice(-8)) return json({ error: "The Season 0 archive changed since this dry run (a privacy deletion or a restore). Run a new dry run.", stale: true }, 409);
    const res = consolidateWorldGrid(input);
    if (!res.ok) return json({ error: "A check failed, so nothing was changed: " + res.checks.filter((k) => !k.ok).map((k) => k.label).join(", ") + ".", checks: res.checks }, 409);
    if (b.stage !== "switch") return json({ ok: true, checked: true, checks: res.checks, cost: this.wgCost(u0, input.archiveReads, 0) });
    const built = this.v2.wgBuild(input.archive, id);
    const prev = this.worldGrid || {};
    const next = { ...prev, combined: true, appliedAt: now, dryRunId: id, backupId: String(b.backupId || ""), safetyId: String(b.safetyId || ""),
      log: [...(prev.log || []), { at: now, event: "applied", id, backupId: String(b.backupId || ""), safetyId: String(b.safetyId || "") }].slice(-WORLD_GRID_LOG_MAX) };
    await this.state.storage.put({ [WORLD_GRID_KEY]: next });
    this.worldGrid = next;
    this.v2.regrid();
    return json({ ok: true, worldGrid: this.worldGridState(), season0Rows: built, cost: this.wgCost(u0, input.archiveReads, 1) });
  }
  /* The same checks again, plus the LIVE routes: /leaderboard (what the game
     and the gateway read, incl. ?boards=1) must serve exactly the consolidated grid. */
  async handleWorldGridCheck() {
    const no = this.wgRefuse(); if (no) return no;
    const u0 = this.wgUse(), eng = this.v2, comb = eng.comb;
    const input = await this.worldGridInput();
    const res = consolidateWorldGrid(input), checks = res.checks.slice();
    const want = comb ? res : seasonGrid(input);
    const lbU = this.wgUse();
    eng.dropCaches();   // measured from the rows, as after a restart
    const live = await eng.leaderboard(new URL("https://do.internal/leaderboard?limit=100&boards=1")).json();
    const lbCost = this.wgCost(lbU, 0, 0);
    const pidOf = (id) => (input.labels.get(id) || {}).pid;
    const cKey = (c) => c.country + ":" + c.totalScore + ":" + c.playerCount;
    /* Same scores in the same order and the same pilots; pilots tied at the 100th place may be listed in another order. */
    const sameBoard = (w, l) => {
      if (JSON.stringify(w.map((x) => x.s)) !== JSON.stringify(l.map((x) => x.s))) return false;
      const cut = w.length ? w[w.length - 1].s : 0, key = (a) => a.filter((x) => x.s > cut).map((x) => x.p + ":" + x.s).sort();
      return JSON.stringify(key(w)) === JSON.stringify(key(l));
    };
    const bad = [];
    if (!!live.combined !== comb) bad.push("the leaderboard says combined=" + live.combined);
    const wc = Object.values(want.countries).map(cKey).sort(), lc = (live.countries || []).map(cKey).sort();
    if (JSON.stringify(wc) !== JSON.stringify(lc)) bad.push("country totals differ from the consolidated ones");
    if (!sameBoard(want.rows.slice(0, 100).map((x) => ({ p: pidOf(x.r.playerId), s: x.score })), (live.top || []).map((t) => ({ p: t.pid, s: t.score })))) bad.push("the top pilots differ from the consolidated ones");
    const recs = (comb ? res.pilots : input.pilots).filter((p) => !input.restrictedIds.has(p.playerId));
    for (const d of VALID_DIFFICULTIES) {   // the EARTH / MARS / JUPITER boards
      const wd = boardRows(recs, d).slice(0, 100).map((x) => ({ p: pidOf(x.r.playerId), s: x.score })), ld = ((live.boards || {})[d] || []).map((t) => ({ p: t.pid, s: t.score }));
      if (!sameBoard(wd, ld)) bad.push("the " + d + " board differs from the consolidated one");
      if (((live.totals || {})[d] || 0) !== boardRows(recs, d).length) bad.push("the " + d + " board count differs");
    }
    checks.push({ id: "live-grid", label: "Live World Grid (game + gateway) serves the " + (comb ? "combined" : "Season 1") + " grid", ok: !bad.length, detail: bad.length ? bad.join("; ") : "countries, the ALL board and the easy / medium / hard boards match" });
    // Every current best, per difficulty, as the live code reads it (the pilot row + its Season 0 row).
    const lost = []; let n = 0;
    eng.scanPilots((row) => {
      if (row.rs || ownGet(this.restricted, row.pid)) return;
      const rec = v2dec(row.rec), live2 = eng.recOf(row);
      for (const d of Object.keys(rec.bests || {})) {
        const cb = rec.bests[d]; if (!cb || !Number.isFinite(cb.score)) continue; n++;
        const lb = ownGet(live2.bests, d);
        if (!lb || !(lb.score >= cb.score)) lost.push(input.labelOf(row.id) + " " + d + " " + cb.score + " -> " + (lb ? lb.score : "missing"));
      }
      const w = weightedBestOf(rec), lw = weightedBestOf(live2);
      if (w && !(lw && lw.weighted >= w.weighted)) lost.push(input.labelOf(row.id) + " ALL " + w.weighted + " -> " + (lw ? lw.weighted : "missing"));
    });
    checks.push({ id: "live-no-current-score-lost", label: "No current score lost on the live World Grid", ok: !lost.length, detail: lost.length ? lost.length + " problem(s): " + lost.slice(0, 5).join("; ") : "all " + n + " current bests checked" });
    return json({ ok: checks.every((k) => k.ok), combined: comb, checks, cost: { check: this.wgCost(u0, input.archiveReads, 0), leaderboardAfterRestart: lbCost } });
  }
  /* REVERT: the switch back to this season only; the summary row is rebuilt.
     The Season 0 table stays (APPLY re-uses it); nothing else changes. */
  async handleWorldGridRevert(request) {
    const no = this.wgRefuse(); if (no) return no;
    const b = (await readJsonObject(request)) || {};
    const u0 = this.wgUse();
    const now = Date.now(), prev = this.worldGrid || {};
    const next = { ...prev, combined: false, revertedAt: now,
      log: [...(prev.log || []), { at: now, event: "reverted", reason: String(b.reason || "by the owner").slice(0, 120) }].slice(-WORLD_GRID_LOG_MAX) };
    await this.state.storage.put({ [WORLD_GRID_KEY]: next });
    this.worldGrid = next;
    this.v2.regrid();
    return json({ ok: true, wasCombined: !!prev.combined, worldGrid: this.worldGridState(), cost: this.wgCost(u0, 0, 1) });
  }

  async handleLeaderboard(url) {
    const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
    const difficulty = VALID_DIFFICULTIES.has(url.searchParams.get("difficulty")) ? url.searchParams.get("difficulty") : null;
    const rows = (await this.publicRows(difficulty)).slice(0, limit);
    const top = await this.publicTop(rows);
    // The leader's tag comes from the SAME live tag map as every other view,
    // resolved now -- never a copy stored earlier. leaderId never leaves the server.
    const countries = [];
    for (const { leaderId, leaderPid, topTag, ...c } of Object.values(this.countries)) {
      countries.push({ ...c, topTag: leaderId ? await this.tagFor(leaderId) : "" });
    }
    countries.sort((a, b) => b.totalScore - a.totalScore);
    const out = { top, countries, leadingCountry: countries[0] || null, difficulty, weighted: !difficulty, weights: { ...DIFF_WEIGHT } };
    /* LEADERBOARD REFRESH: ?boards=1 adds the three difficulty boards (real
       points) to the SAME response, so the game's EARTH / MARS / JUPITER / WORLD
       tabs still cost one request, cached for a minute (FREE PLAN). Read from
       the cached sorted boards: no sort, no write. Old pages never ask for it. */
    if (url.searchParams.get("boards") === "1") {
      out.boards = {}; out.totals = {};
      for (const d of VALID_DIFFICULTIES) {
        const all = await this.publicRows(d);
        out.boards[d] = await this.publicTop(all.slice(0, limit));
        out.totals[d] = all.length;
      }
    }
    return json(out);
  }
  async publicTop(rows) {
    const tagged = await this.tagRows(rows);
    return tagged.map((o) => ({
      pid: o.pid,                                  // A-1: a hash, never the playerId
      tag: o.tag,
      name: this.displayName(o.it.r),
      country: o.it.r.country,
      score: o.it.score,                           // real points on a difficulty board; weighted on ALL
      points: o.it.points,                         // the real points behind it
      level: o.it.level,
      difficulty: o.it.difficulty,
    }));
  }

  /* D-25: country figures are rebuilt from the player records every time
     something changes, so totals, counts, top scores and displayed leaders can
     never drift apart. RC2.7 subtracted a departing player's score but kept
     their name and top score as the country's leader. Each player counts once,
     at their single best public WEIGHTED score (DIFF_WEIGHT); restricted
     players are excluded. */
  async recomputeCountries() {
    const totals = countryTotals(await this.publicRows(null), (r) => this.displayName(r));   // COMBINED WORLD GRID: one function for both grids
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
    // FREE PLAN: "flags" is written only when this upload adds one (a row written less per score).
    const puts = flag ? { players: nextPlayers, lastSubmit: nextLast, flags: nextFlags } : { players: nextPlayers, lastSubmit: nextLast };
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
    // LEADERBOARD REFRESH: rank, country rank and the pilot just above, read
    // from the cached board (O(1), no sort, no write) -- for this pilot only.
    const st = restricted ? null : await this.standing(playerId, difficulty);
    const rank = st ? st.rank : null;
    const [o] = await this.tagRows([{ r: record }]);
    const b = record && ownGet(record.bests, difficulty);
    return json({
      ok: true, isNewBest, best: b ? b.score : score,
      country: record ? record.country : undefined, difficulty,
      public: !restricted,       // honest: no public rank is invented for a restricted player
      rank,
      ...(st ? { total: st.total, countryRank: st.countryRank, countryTotal: st.countryTotal, above: st.above } : {}),
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
    if ((this.migPhase === "copying" || this.migPhase === "paused") && this.state.storage.sql) new V2SqlDb(this.state.storage).forget(id, removePurchases);   // STORAGE FIX: nor in a half-made copy
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
    return json({ ok: true, flags: pruneFlags(this.flags, now).length, restrictedCount: Object.keys(this.restricted).length, purchasesToday, worldGrid: this.worldGridState() });
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
      // STORAGE FIX: a backup of the old layout brings the old layout back; the new layout's tables go.
      if (!want.has(STORAGE_LAYOUT_KEY) && st.sql) new V2SqlDb(st).drop();
      this.v2 = null; this.layout = undefined;
      this.ready = false; this.tagCache = null; this.rowsCache = null; this.pidCache = new Map();
    });
    await this.load();
    return json({ ok: true, keys: entries.length });
  }

  /* ============================ STORAGE FIX ============================ */
  /* See PilotLayoutV2. The new layout lives in this object's SQLite tables;
     the small shared values (restricted, nameBans, flags, restoreLog, season,
     archive) stay where they are, for both layouts. */
  sqlDb() { return new V2SqlDb(this.state.storage, this.sqlUse || (this.sqlUse = { read: 0, written: 0 })); }
  async loadV2() {
    const st = this.state.storage;
    this.layout = "v2";
    this.players = null; this.entitlements = null; this.seenSessions = null; this.lastSubmit = null; this.countries = null;
    this.restricted = NP(await st.get("restricted"));
    this.nameBans = NP(await st.get("nameBans"));
    this.tagCache = null;
    this.flags = (await st.get("flags")) || [];
    const rl = await st.get("restoreLog");
    this.restoreLog = Array.isArray(rl) ? rl : [];
    this.worldGrid = (await st.get(WORLD_GRID_KEY)) || null;   // COMBINED WORLD GRID switch (off unless the owner applied it)
    this.archiveCache = null;
    this.v2 = new PilotLayoutV2(this, this.sqlDb());
    this.fcfg = undefined;      // FOUNDING PILOT settings: read when first needed (admin, exclusions)
    await this.v2.wgEnsure();   // 1 row when the switch is on; nothing when it is off
    this.v2.init();
    if (this.v2.foLost) {       // FOUNDING PILOT: only when the summary had to be rebuilt without its counter
      const fo = this.v2.foRebuild(await st.get(FOUNDING_KEY));
      if (fo) { this.v2.sum.fo = fo; this.v2.saveSum(this.v2.sum, true); }
    }
    if (!((await st.get("season")) >= SEASON)) await this.v2.startSeason();   // a future season, on the new layout
  }
  writesBlocked() {
    const s = this.bkSession;
    return !!this.restoring || !!(s && s.mode === "dump" && Date.now() - s.at < V2_FREEZE_MS);
  }
  async waitIdle() { for (let i = 0; (this.writing || 0) > 0 && i < 6000; i++) await new Promise((r) => setTimeout(r, 5)); }
  /* After the move, until CLEAN UP: the pilots changed by something other than a
     score upload (purchases, deletions, imports), so the check can tell "changed
     since the move" from "different". Public hashes only. */
  async migTouched(pids) {
    const add = [].concat(pids).filter(Boolean);
    if (this.migPhase !== "switched" || !add.length) return;
    const list = (await this.state.storage.get(MIG_CHANGED_KEY)) || [], have = new Set(list);
    const fresh = add.filter((p) => !have.has(p) && have.add(p));
    if (fresh.length) await this.state.storage.put(MIG_CHANGED_KEY, list.concat(fresh).slice(-MIG_CHANGED_MAX));
  }
  /* The old layout's values minus one pilot (a privacy deletion after the move). */
  async v1ValuesWithout(id, removePurchases) {
    const st = this.state.storage, out = {};
    const players = await st.get("players");
    if (players && typeof players === "object" && ownGet(players, id) !== undefined) out.players = dropKey(players, id);
    const ls = await st.get("lastSubmit");
    if (ls && typeof ls === "object" && ownGet(ls, id) !== undefined) out.lastSubmit = dropKey(ls, id);
    if (removePurchases) { const e = await st.get("entitlements"); if (e && typeof e === "object" && ownGet(e, id) !== undefined) out.entitlements = dropKey(e, id); }
    const cs = await st.get("countries");
    if (cs && typeof cs === "object" && Object.keys(cs).some((k) => cs[k] && cs[k].leaderId === id)) {
      const n = NP(cs);
      for (const k of Object.keys(n)) if (n[k] && n[k].leaderId === id) n[k] = { ...n[k], topName: "", leaderId: "" };
      out.countries = n;
    }
    return out;
  }
  /* The old layout as it was left at the switch (read-only), with today's
     restrictions and name bans: what the check compares the new layout with. */
  async migTwin() {
    if (this.twin) return this.twin;
    const st = this.state.storage;
    if ((await st.get("players")) === undefined) return null;
    const entries = [];
    for (const k of V1_TWIN_KEYS) { const v = await st.get(k); if (v !== undefined) entries.push([k, v]); }
    const twin = new LeaderboardDO({ storage: new BkMemStorage(entries), blockConcurrencyWhile: (fn) => fn() }, {});
    await twin.load();
    await twin.recomputeCountries();
    this.twin = twin;
    return twin;
  }
  async migChangedSet(mig) {
    const set = new Set((await this.state.storage.get(MIG_CHANGED_KEY)) || []);
    this.v2.scanPilots((r) => { const rec = v2dec(r.rec); if ((rec.updatedAt || 0) > mig.switchedAt) set.add(r.pid); });
    return set;
  }
  /* Every pilot of the old layout as a row. seq keeps the order of the
     "players" value (it breaks full ties on the boards): the order saved when
     the move started; pilots added (or re-added) since then come after. */
  async v1Rows(eng, order) {
    const pos = new Map();
    (order || []).forEach((id, i) => pos.set(id, i + 1));
    const L = (order || []).length, rows = [], byId = new Map();
    let last = 0, tail = false;
    for (const id of Object.keys(this.players)) {
      let seq = tail ? undefined : pos.get(id);
      if (seq === undefined || seq <= last) { tail = true; seq = Math.max(L, last) + 1; }
      last = seq;
      const row = eng.rowFor(this.players[id], id, await this.pid(id));
      row.seq = seq;
      row.tag = await this.tagFor(id);
      row.ls = ownGet(this.lastSubmit, id) !== undefined ? v2enc(this.lastSubmit[id]) : null;
      rows.push(row); byId.set(id, row);
    }
    return { rows, byId };
  }
  v1Tables() {
    const cool = Object.create(null);
    for (const id of Object.keys(this.lastSubmit)) if (ownGet(this.players, id) === undefined) cool[id] = this.lastSubmit[id];
    return { ents: this.entitlements, seen: this.seenSessions, cool };
  }
  /* One storage request at a time, in order. */
  handleStorageFix(request, url) {
    const run = async () => {
      let b = {};
      try { const t = await request.text(); if (t) b = JSON.parse(t) || {}; } catch (e) { b = {}; }
      try {
        await this.load();
        switch (url.pathname) {
          case "/mig-status": return await this.migStatus();
          case "/mig-dry-run": return await this.migDryRun();
          case "/mig-batch": return await this.migBatch(b);
          case "/mig-check": return await this.migCheck(b);
          case "/mig-rollback": return await this.migRollback(b);
          case "/mig-cleanup": return await this.migCleanup(b);
          case "/v2bk-layout": return json({ layout: this.layout });
          case "/v2bk-begin": return await this.bkBegin(b);
          case "/v2bk-page": return this.bkPage(b);
          case "/v2bk-end": return await this.bkEnd(b);
          case "/v2bk-diff": return await this.bkDiffRange(b);
          case "/v2bk-kv": return await this.bkKv(b);
          case "/v2bk-summary": return await this.bkSummaryLive();
        }
        return json({ error: "Not found" }, 404);
      } catch (e) {
        console.error("storage:", e && e.message);
        return json({ ok: false, error: "Storage error: " + ((e && e.message) || e) }, 500);
      }
    };
    const p = (this.sfChain || Promise.resolve()).then(run, run);
    this.sfChain = p.then(() => {}, () => {});
    return p;
  }

  /* ---------- status ---------- */
  async migStatus() {
    const st = this.state.storage;
    const mig = (await st.get(MIG_KEY)) || null, dry = (await st.get(MIG_DRY_KEY)) || null, check = (await st.get(MIG_CHECK_KEY)) || null;
    const out = { ok: true, layout: this.layout === "v2" ? "new" : "old", restoring: !!this.restoring, phase: mig ? mig.phase : "none", mig, dry, check, freePlan: FREE_PLAN,
      limits: { valueBytes: V1_VALUE_LIMIT, backupMaxAgeMin: MIG_BACKUP_MAX_AGE_MS / 60000, batch: MIG_BATCH, dayRowBudget: MIG_DAY_ROW_BUDGET, rankExactMax: RANK_EXACT_MAX } };
    if (this.layout === "v2") {
      out.pilots = this.v2.sum.n;
      out.oldValue = mig && mig.oldBytes ? { bytes: mig.oldBytes, limit: V1_VALUE_LIMIT, pct: Math.round(1000 * mig.oldBytes / V1_VALUE_LIMIT) / 10, kept: mig.phase !== "cleaned" } : null;
    } else {
      out.pilots = Object.keys(this.players).length;
      const bytes = v2Bytes(this.players);
      out.oldValue = { bytes, limit: V1_VALUE_LIMIT, pct: Math.round(1000 * bytes / V1_VALUE_LIMIT) / 10, kept: true };
    }
    out.costs = { now: v2Costs(out.pilots), at10k: v2Costs(10_000), at50k: v2Costs(50_000), at200k: v2Costs(200_000) };
    return json(out);
  }

  /* ---------- dry run: the new layout in memory; nothing live is written ---------- */
  async migDryRun() {
    if (this.layout !== "v1") return json({ error: "FLUX already uses the new layout; there is nothing to move." }, 409);
    const t0 = Date.now(), db = new V2MemDb(), eng = new PilotLayoutV2(this, db);
    const { rows } = await this.v1Rows(eng, null);
    for (const r of rows) db.insertPilot(r);
    const tabs = this.v1Tables();
    for (const t of ["ents", "seen", "cool"]) for (const id of Object.keys(tabs[t])) db.kvPut(t, id, v2enc(tabs[t][id]));
    eng.sum = eng.buildSum();
    const checks = await v2Reconcile(this, eng);
    const now = Date.now(), id = "DR-" + bkIdFor(now, "x").slice(0, 15);
    const report = { id, at: now, pass: checks.every((c) => c.pass), pilots: rows.length, counts: v2Counts(this), est: v2Estimate(rows, tabs), checks,
      oldBytes: v2Bytes(this.players), ms: now - t0, confirm: "MIGRATE " + id };
    await this.state.storage.put(MIG_DRY_KEY, report);   // the report only (the move asks for its id)
    return json({ ok: true, dryRun: true, wroteLive: false, ...report });
  }

  /* ---------- the move: batches, then the switch ---------- */
  async migBatch(b) {
    if (this.layout !== "v1") return json({ error: "FLUX already uses the new layout." }, 409);
    const st = this.state.storage, now = Date.now();
    const dry = await st.get(MIG_DRY_KEY);
    if (!dry || !dry.pass) return json({ error: "Run a DRY RUN first; every check must pass." }, 409);
    if (b.confirm !== "MIGRATE " + dry.id) return json({ error: "To move the storage, type exactly: MIGRATE " + dry.id }, 400);
    let mig = await st.get(MIG_KEY);
    const going = mig && (mig.phase === "copying" || mig.phase === "paused") && mig.id === dry.id;
    if (!going && now - dry.at > MIG_DRY_MAX_AGE_MS) return json({ error: "The dry run is more than 24 hours old. Run it again." }, 409);   // a move already under way continues
    if (b.validateOnly) return json({ ok: true, valid: true, needSafety: !going, safetyId: going ? mig.safetyId : "" });
    const db = this.sqlDb(), eng = new PilotLayoutV2(this, db);
    if (!going) {
      if (!b.safetyId) return json({ error: "A safety backup is taken first; start the move from the admin page." }, 409);
      db.drop(); db.create();
      const order = Object.keys(this.players);
      mig = { id: dry.id, phase: "copying", startedAt: now, safetyId: String(b.safetyId), backupId: String(b.backupId || ""), total: order.length, cursor: 0,
        batches: 0, rows: 0, day: bkDay(now), dayRows: 0, oldBytes: v2Bytes(this.players), log: [{ at: now, event: "move started", pilots: order.length }] };
      await st.put({ [MIG_ORDER_KEY]: order, [MIG_KEY]: mig });
      this.migPhase = "copying";
    }
    if (mig.day !== bkDay(now)) { mig.day = bkDay(now); mig.dayRows = 0; }
    if (mig.dayRows >= MIG_DAY_ROW_BUDGET) {
      if (mig.phase !== "paused") { mig.phase = "paused"; await st.put(MIG_KEY, mig); this.migPhase = "paused"; }
      return json({ ok: true, more: false, paused: true, phase: "paused", mig,
        message: "Paused for today: the move wrote " + mig.dayRows + " rows today (the daily limit is kept for play). Press MOVE again after midnight UTC; it continues where it stopped." });
    }
    if (mig.phase === "paused") { mig.phase = "copying"; this.migPhase = "copying"; }
    const order = (await st.get(MIG_ORDER_KEY)) || [];
    if (mig.cursor < order.length) {
      const slice = order.slice(mig.cursor, mig.cursor + MIG_BATCH), rows = [];
      for (let i = 0; i < slice.length; i++) {
        const id = slice[i];
        if (ownGet(this.players, id) === undefined) continue;   // deleted since the move started
        const row = eng.rowFor(this.players[id], id, await this.pid(id));
        row.seq = mig.cursor + i + 1; row.tag = row.t12.slice(0, 7);
        row.ls = ownGet(this.lastSubmit, id) !== undefined ? v2enc(this.lastSubmit[id]) : null;
        rows.push(row);
      }
      const w0 = this.sqlUse.written;
      db.tx(() => { for (const r of rows) db.replacePilot(r); });   // all or nothing; re-running a batch writes the same rows
      const w = this.sqlUse.written - w0;
      mig.cursor += slice.length; mig.batches++; mig.rows += w; mig.dayRows += w;
      await st.put(MIG_KEY, mig);
      return json({ ok: true, more: true, phase: "copying", copied: mig.cursor, total: order.length, mig });
    }
    return this.migSwitch(mig);
  }
  /* The switch. Nothing else runs meanwhile (blockConcurrencyWhile), writes in
     flight finish first, then every pilot is synced from the old layout as it is
     NOW and compared again. Only if every comparison passes does FLUX read and
     write the new layout; otherwise the copy is dropped and nothing changed. */
  async migSwitch(mig) {
    const st = this.state.storage, db = this.sqlDb(), eng = new PilotLayoutV2(this, db);
    let res = null;
    await this.state.blockConcurrencyWhile(async () => {
      await this.waitIdle();
      const w0 = this.sqlUse.written;
      const want = await this.v1Rows(eng, (await st.get(MIG_ORDER_KEY)) || []);
      const have = new Map();
      eng.scanPilots((r) => have.set(r.id, r));
      const tabs = this.v1Tables(), tabRows = {};
      for (const t of ["ents", "seen", "cool"]) { tabRows[t] = new Map(); let after = null; for (;;) { const rs = db.rowsById(t, after, null, V2_SCAN_PAGE); for (const x of rs) tabRows[t].set(x.id, x.v); if (rs.length < V2_SCAN_PAGE) break; after = rs[rs.length - 1].id; } }
      db.tx(() => {
        for (const [id, h] of have) { const r = want.byId.get(id); if (!r || r.seq !== h.seq) db.deletePilot(h.seq); }
        for (const r of want.rows) {
          const h = have.get(r.id);
          if (!h || h.seq !== r.seq) db.insertPilot(r);
          else { const ch = v2Changed(h, r); if (ch) db.updatePilot(h.seq, ch); }
        }
        for (const t of ["ents", "seen", "cool"]) {
          const src = tabs[t], cur = tabRows[t];
          for (const id of cur.keys()) if (ownGet(src, id) === undefined) db.kvDel(t, id);
          for (const id of Object.keys(src)) { const v = v2enc(src[id]); if (cur.get(id) !== v) db.kvPut(t, id, v); }
        }
      });
      eng.sum = eng.buildSum();
      eng.saveSum(eng.sum, true);
      const checks = await v2Reconcile(this, eng);
      const now = Date.now(), pass = checks.every((c) => c.pass);
      const log = (mig.log || []).concat([{ at: now, event: pass ? "switched to the new layout" : "switch REFUSED: a comparison failed" }]).slice(-30);
      if (pass) {
        const next = { ...mig, phase: "switched", switchedAt: now, rows: mig.rows + (this.sqlUse.written - w0), pilots: want.rows.length, checks, log };
        await st.put({ [STORAGE_LAYOUT_KEY]: "v2", [MIG_KEY]: next });
        await st.delete([MIG_ORDER_KEY, MIG_CHECK_KEY, MIG_CHANGED_KEY]);
        this.ready = false; this.v2 = null; this.migPhase = "switched"; this.twin = null;
        res = json({ ok: true, more: false, done: true, switched: true, phase: "switched", checks, mig: next });
      } else {
        db.drop();
        const next = { ...mig, phase: "failed", failedAt: now, checks, log };
        await st.put(MIG_KEY, next);
        await st.delete(MIG_ORDER_KEY);
        this.migPhase = "failed";
        res = json({ ok: false, more: false, done: true, switched: false, phase: "failed", checks, mig: next,
          error: "The copy did not match the old layout, so nothing was switched. FLUX keeps using the old layout." }, 409);
      }
    });
    return res;
  }

  /* ---------- after the move: old vs new, PASS / FAIL ---------- */
  async migCheck(b) {
    if (this.layout !== "v2") return json({ error: "The check runs after the move; FLUX still uses the old layout." }, 409);
    const st = this.state.storage, mig = await st.get(MIG_KEY);
    if (!mig || !mig.switchedAt) return json({ error: "There is no move to check." }, 409);
    const twin = await this.migTwin();
    if (!twin) return json({ error: "The old layout was already cleaned up; there is nothing left to compare with." }, 409);
    const mode = b.mode === "all" ? "all" : "sample", cursor = Math.max(0, Math.floor(Number(b.cursor) || 0));
    const ids = [...new Set(Object.keys(twin.players).concat(Object.keys(twin.entitlements)))];
    let state = cursor ? await st.get(MIG_CHECK_KEY) : null;
    if (cursor && (!state || state.mode !== mode || state.cursor !== cursor)) return json({ error: "That check was interrupted; start it again." }, 409);
    if (!cursor || !this.migCheckSkip) this.migCheckSkip = await this.migChangedSet(mig);
    const skip = this.migCheckSkip;
    if (!cursor) state = { mode, startedAt: Date.now(), at: 0, cursor: 0, total: ids.length, done: false, pass: false, changed: skip.size,
      pilots: { compared: 0, skipped: 0, failed: 0, restore: 0, ents: 0, tags: 0, examples: [] }, checks: await v2CheckGlobal(twin, this.v2, skip) };
    let pick;
    if (mode === "sample") { const step = Math.max(1, Math.floor(ids.length / MIG_CHECK_SAMPLE)); pick = ids.filter((_, i) => i % step === 0).slice(0, MIG_CHECK_SAMPLE); state.cursor = ids.length; }
    else { pick = ids.slice(cursor, cursor + MIG_CHECK_BATCH); state.cursor = cursor + pick.length; }
    const r = await v2PilotChecks(twin, this.v2, pick, skip), P = state.pilots;
    for (const k of ["compared", "skipped", "failed", "restore", "ents", "tags"]) P[k] += r[k];
    P.examples = P.examples.concat(r.examples).slice(0, 10);
    state.done = state.cursor >= ids.length;
    if (state.done) { state.at = Date.now(); state.pass = state.checks.every((c) => c.pass) && P.failed === 0; }
    await st.put(MIG_CHECK_KEY, state);
    return json({ ok: true, more: !state.done, ...state });
  }

  /* ---------- rollback: the new layout back into the old one ---------- */
  async migRollback(b) {
    if (b.confirm !== "ROLLBACK") return json({ error: "To roll back, type exactly: ROLLBACK" }, 400);
    const st = this.state.storage, now = Date.now(), mig = await st.get(MIG_KEY);
    if (this.layout !== "v2") {
      if (!mig || (mig.phase !== "copying" && mig.phase !== "paused")) return json({ error: "Nothing to roll back: FLUX uses the old layout." }, 409);
      if (b.validateOnly) return json({ ok: true, needSafety: false });
      this.sqlDb().drop();   // a half-made copy; the old layout was never left
      await st.put(MIG_KEY, { ...mig, phase: "cancelled", cancelledAt: now });
      await st.delete(MIG_ORDER_KEY);
      this.migPhase = "cancelled";
      return json({ ok: true, cancelled: true, phase: "cancelled" });
    }
    if (b.validateOnly) return json({ ok: true, needSafety: true });
    let res = null;
    await this.state.blockConcurrencyWhile(async () => {
      await this.waitIdle();
      const eng = this.v2, db = eng.db;
      const players = Object.create(null), lastSubmit = Object.create(null);
      const tab = (t) => { const o = Object.create(null); let after = null; for (;;) { const rs = db.rowsById(t, after, null, V2_SCAN_PAGE); for (const x of rs) o[x.id] = v2dec(x.v); if (rs.length < V2_SCAN_PAGE) return o; after = rs[rs.length - 1].id; } };
      const cool = tab("cool");
      for (const id of Object.keys(cool)) lastSubmit[id] = cool[id];
      eng.scanPilots((r) => { const rec = v2dec(r.rec); rec.bests = NP(rec.bests); players[r.id] = rec; if (r.ls != null) lastSubmit[r.id] = v2dec(r.ls); });
      const entitlements = tab("ents"), seenSessions = tab("seen"), bytes = v2Bytes(players);
      if (bytes > V1_ROLLBACK_MAX_BYTES) {
        res = json({ ok: false, error: "The pilots no longer fit the old layout (" + (bytes / 1048576).toFixed(2) + " MB of 2 MB). Roll back is not possible; restore the backup from before the move instead." }, 409);
        return;
      }
      const shared = [];
      for (const k of ["restricted", "nameBans", "flags", "restoreLog", "nameRulesV1", "season"]) { const v = await st.get(k); if (v !== undefined) shared.push([k, v]); }
      const twin = new LeaderboardDO({ storage: new BkMemStorage(shared.concat([["players", players], ["lastSubmit", lastSubmit], ["entitlements", entitlements], ["seenSessions", seenSessions], ["countriesWeights", JSON.stringify(DIFF_WEIGHT)]])), blockConcurrencyWhile: (fn) => fn() }, {});
      await twin.load();
      await twin.recomputeCountries();
      const checks = await v2Reconcile(twin, eng);
      if (!checks.every((c) => c.pass)) { res = json({ ok: false, checks, error: "The old layout rebuilt from the new one does not match it, so nothing was changed." }, 409); return; }
      await st.put({ players, lastSubmit, entitlements, seenSessions, countries: twin.countries, countriesWeights: JSON.stringify(DIFF_WEIGHT),
        [MIG_KEY]: { ...mig, phase: "rolledback", rolledBackAt: now, log: ((mig && mig.log) || []).concat([{ at: now, event: "rolled back to the old layout" }]).slice(-30) } });
      await st.delete([STORAGE_LAYOUT_KEY, MIG_CHECK_KEY, MIG_CHANGED_KEY]);
      db.drop();
      this.ready = false; this.v2 = null; this.layout = undefined; this.migPhase = "rolledback"; this.twin = null;
      res = json({ ok: true, rolledBack: true, phase: "rolledback", pilots: Object.keys(players).length, checks });
    });
    return res;
  }

  /* ---------- clean-up: the old layout's values go (only after a full check passed) ---------- */
  async migCleanup(b) {
    if (this.layout !== "v2") return json({ error: "FLUX uses the old layout; there is nothing to clean up." }, 409);
    const st = this.state.storage, mig = await st.get(MIG_KEY);
    if (!mig || mig.phase !== "switched") return json({ error: "Clean-up is offered once, after a move." }, 409);
    if (b.confirm !== "CLEANUP " + mig.id) return json({ error: "To clean up, type exactly: CLEANUP " + mig.id }, 400);
    const chk = await st.get(MIG_CHECK_KEY);
    if (!chk || chk.mode !== "all" || !chk.done || !chk.pass || !(chk.at >= mig.switchedAt)) return json({ error: "Run CHECK EVERY PILOT first; it must pass." }, 409);
    if (b.validateOnly) return json({ ok: true, needSafety: true });
    await st.delete(V1_OLD_ONLY_KEYS.concat([MIG_CHANGED_KEY]));
    const now = Date.now();
    await st.put(MIG_KEY, { ...mig, phase: "cleaned", cleanedAt: now, log: (mig.log || []).concat([{ at: now, event: "old layout cleaned up" }]).slice(-30) });
    this.migPhase = "cleaned"; this.twin = null;
    return json({ ok: true, cleaned: true, phase: "cleaned" });
  }

  /* ---------- paged backups of the new layout (called by BackupStore only) ---------- */
  async bkBegin(b) {
    const token = v2Token();
    if (b.mode === "dump") {
      if (this.layout !== "v2") return json({ error: "The leaderboard uses the old layout; it is backed up in one piece." }, 409);
      this.bkSession = { token, mode: "dump", at: Date.now() };   // writes wait from now (503 + Retry-After)
      await this.waitIdle();
      const kv = (await bkListAll(this.state.storage)).filter(([k]) => !V2_BK_SKIP_KEYS.has(k));
      const text = bkEncode(kv);
      if (!bkSameEntries(bkDecode(text), kv)) throw new Error("a stored value cannot be copied exactly");
      return json({ ok: true, token, kv: text, tables: V2_TABLES });
    }
    if (b.mode === "restore") {
      let K;
      try { K = new Map(bkDecode(String(b.kv || ""))); } catch (e) { return json({ error: "Not a FLUX backup" }, 400); }
      await this.state.storage.put(V2_RESTORING_KEY, { at: Date.now(), id: String(b.id || "") });   // writes stay paused until the restore finishes
      this.restoring = true;
      // the backup's own restrictions and name bans: the rows' other columns are rebuilt with them
      this.bkSession = { token, mode: "restore", at: Date.now(), bans: NP(K.get("nameBans")), restricted: NP(K.get("restricted")) };
      await this.waitIdle();
      this.sqlDb().create();
      return json({ ok: true, token });
    }
    return json({ error: "Unknown mode" }, 400);
  }
  bkPage(b) {
    const t = String(b.table || "");
    if (!V2_TABLES.includes(t)) return json({ error: "Unknown table" }, 400);
    const s = this.bkSession;
    if (b.token) {
      if (!s || s.token !== b.token) return json({ error: "The backup session ended (the leaderboard restarted). Try again." }, 409);
      s.at = Date.now();
    }
    const db = this.sqlDb();
    const rows = db.exists() ? db.rowsById(t, b.after == null || b.after === "" ? null : String(b.after), null, clampInt(String(b.limit || ""), 1, V2_BK_PAGE, V2_BK_PAGE)) : [];
    const entries = rows.map((r) => ["sql:" + t + ":" + r.id, t === "pilots" ? v2Slim(r) : { ...r }]);
    return new Response(bkEncode(entries), { headers: { "Content-Type": "application/json", "x-flux-n": String(entries.length),
      "x-flux-last": encodeURIComponent(rows.length ? rows[rows.length - 1].id : "") } });
  }
  async bkEnd(b) {
    const s = this.bkSession;
    if (!b.restore) { if (s && s.token === b.token && s.mode === "dump") this.bkSession = null; return json({ ok: true }); }
    if (!s || s.token !== b.token || s.mode !== "restore") return json({ error: "The restore session ended (the leaderboard restarted). Run the restore again; it continues where it stopped." }, 409);
    let want;
    try { want = bkDecode(String(b.kv || "")).filter(([k]) => !V2_BK_SKIP_KEYS.has(k)); } catch (e) { return json({ error: "Not a FLUX backup" }, 400); }
    const W = new Map(want), st = this.state.storage;
    await this.state.blockConcurrencyWhile(async () => {
      const live = await bkListAll(st), L = new Map(live);
      const gone = live.map((e) => e[0]).filter((k) => !W.has(k) && !V2_BK_SKIP_KEYS.has(k));
      for (let i = 0; i < gone.length; i += BACKUP_PUT_KEYS) await st.delete(gone.slice(i, i + BACKUP_PUT_KEYS));
      const puts = want.filter(([k, v]) => !L.has(k) || !bkSame(L.get(k), v));
      for (let i = 0; i < puts.length; i += BACKUP_PUT_KEYS) { const o = Object.create(null); for (const [k, v] of puts.slice(i, i + BACKUP_PUT_KEYS)) o[k] = v; await st.put(o); }
      const db = this.sqlDb();
      if (W.get(STORAGE_LAYOUT_KEY) === "v2") { const eng = new PilotLayoutV2(this, db); eng.retagAll(); eng.sum = eng.buildSum(); const fo = eng.foRebuild(W.get(FOUNDING_KEY)); if (fo) eng.sum.fo = fo; eng.saveSum(eng.sum, true); db.kvDel("v2meta", "wg"); }   // FOUNDING PILOT: the counter as restored   // COMBINED WORLD GRID: rebuilt from the restored archive on load
      else db.drop();
      await st.delete(V2_RESTORING_KEY);
      this.restoring = false; this.bkSession = null;
      this.ready = false; this.v2 = null; this.layout = undefined; this.tagCache = null; this.pidCache = new Map(); this.twin = null;
    });
    await this.load();
    return json({ ok: true });
  }
  /* A backup page against the same range of the live table: counts, and (restore) the differences written. */
  async bkDiffRange(b) {
    const t = String(b.table || "");
    if (!V2_TABLES.includes(t)) return json({ error: "Unknown table" }, 400);
    const apply = !!b.apply, s = this.bkSession;
    if (apply && (!s || s.token !== b.token || s.mode !== "restore")) return json({ error: "The restore session ended (the leaderboard restarted). Run the restore again; it continues where it stopped." }, 409);
    if (s && b.token && s.token === b.token) s.at = Date.now();
    let snap;
    try { snap = bkDecode(String(b.text || "")); } catch (e) { return json({ error: "Not a FLUX backup" }, 400); }
    const want = new Map();
    for (const [k, row] of snap) want.set(v2RowId(t, k), row);
    const lo = b.lo == null ? null : String(b.lo), hi = b.hi == null ? null : String(b.hi);
    const db = this.sqlDb(), c = { added: 0, removed: 0, changed: 0, unchanged: 0 }, seen = new Set(), dels = [], puts = [];
    if (db.exists()) {
      let after = lo;
      for (;;) {
        const rows = db.rowsById(t, after, hi, V2_BK_PAGE);
        for (const r of rows) {
          seen.add(r.id);
          const w = want.get(r.id);
          if (!w) { c.removed++; dels.push(r); } else if (!bkSame(t === "pilots" ? v2Slim(r) : { ...r }, w)) { c.changed++; puts.push(w); } else c.unchanged++;
        }
        if (rows.length < V2_BK_PAGE) break;
        after = rows[rows.length - 1].id;
      }
    }
    for (const [id, w] of want) if (!seen.has(id)) { c.added++; puts.push(w); }
    const eng = t === "pilots" && apply ? new PilotLayoutV2(this, db) : null;
    if (apply && (dels.length || puts.length)) db.tx(() => {
      for (const r of dels) { if (t === "pilots") db.deletePilot(r.seq); else db.kvDel(t, r.id); }
      for (const w of puts) {
        if (t !== "pilots") { db.kvPut(t, w.id, w.v); continue; }
        const row = eng.rowFor(w.rec, w.id, w.pid, s.bans, s.restricted);   // tags are regrouped at the end
        row.seq = w.seq; row.ls = w.ls == null ? null : w.ls; row.tag = row.t12.slice(0, 7);
        db.replacePilot(row);
      }
    });
    return json({ ok: true, ...c });
  }
  async bkKv(b) {
    let snap;
    try { snap = bkDecode(String(b.text || "")).filter(([k]) => !V2_BK_SKIP_KEYS.has(k)); } catch (e) { return json({ error: "Not a FLUX backup" }, 400); }
    const live = (await bkListAll(this.state.storage)).filter(([k]) => !V2_BK_SKIP_KEYS.has(k));
    const d = bkDiff(live, snap);
    return json({ ok: true, keysAdded: d.keysAdded, keysRemoved: d.keysRemoved, keysChanged: d.keysChanged, counts: { added: d.counts.added, removed: d.counts.removed, changed: d.counts.changed, unchanged: d.counts.unchanged } });
  }
  async bkSummaryLive() {
    const kv = (await bkListAll(this.state.storage)).filter(([k]) => !V2_BK_SKIP_KEYS.has(k));
    if (this.layout !== "v2") return json(bkSummary(kv));
    const acc = v2SumStart(), db = this.sqlDb();
    v2SumAdd(acc, "", kv);
    for (const t of V2_TABLES) { let after = null; for (;;) { const rows = db.rowsById(t, after, null, V2_BK_PAGE); v2SumAdd(acc, t, rows.map((r) => ["", t === "pilots" ? v2Slim(r) : r])); if (rows.length < V2_BK_PAGE) break; after = rows[rows.length - 1].id; } }
    return json(v2SumEnd(acc));
  }
}
/* COMBINED WORLD GRID: the pure functions, for the tests and the World Grid
   redesign (a static property: the module still exports only the worker and
   LeaderboardDO). */
LeaderboardDO.worldGrid = { mergeWorldGrid, checkWorldGrid, consolidateWorldGrid, seasonGrid, boardRows, countryTotals, worldGridReportText };

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
  useCount("d");
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
      case "/safety": return this.safety(String(body.note || "safety copy"));   // STORAGE FIX: before the storage move / rollback / clean-up
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
    if (meta.schema === 2) return this.verifyPaged(meta);   // STORAGE FIX: the new layout, page by page
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
    if (text === undefined && (await this.livePaged())) return this.takeSnapshotPaged(kind, note);   // STORAGE FIX
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
    if (v.meta.schema === 2 || (await this.livePaged())) return this.dryRunPaged(id, v);   // STORAGE FIX
    const liveText = await this.dumpLive(), live = bkDecode(liveText), snap = bkDecode(v.text);
    return json({ ok: true, dryRun: true, id, verified: true, identical: bkSameEntries(live, snap), createdAt: v.meta.createdAt,
      before: bkSummary(live), after: bkSummary(snap), diff: bkDiff(live, snap), confirm: "RESTORE " + id });
  }
  async restore(id, confirm) {
    if (!id) return json({ error: "Choose a backup." }, 400);
    if (confirm !== "RESTORE " + id) return json({ error: 'To restore, type exactly: RESTORE ' + id }, 400);
    if (await this.restoreIsPaged(id)) return this.restorePaged(id);   // STORAGE FIX: a backup of the new layout, or the new layout live
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
    if (v.meta.schema === 2) return this.exportPaged(v.meta);   // STORAGE FIX: streamed, never one big text
    const { chunkSha, gen, ...manifest } = v.meta;
    const text = '{"format":"flux-leaderboard-backup","manifest":' + JSON.stringify(manifest) + ',"snapshot":' + v.text + "}";
    return new Response(text, { headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="flux-backup-' + id + '.json"' } });
  }
  /* A downloaded file back in as a snapshot ("imported"), checked against its own
     checksum; then it can be dry-run and restored like any other. */
  async importFile(body) {
    const f = body && body.backup;
    if (f && f.format === "flux-leaderboard-backup" && f.manifest && f.manifest.schema === 2 && Array.isArray(f.pages)) return this.importPaged(f);   // STORAGE FIX
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
      if (m.schema === 2) { const r = await this.purgePaged(m, pid, removePurchases); if (r === "deleted") deleted++; else if (r === "changed") changed++; continue; }   // STORAGE FIX
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

  /* ================= STORAGE FIX: backups of the new layout ================= */
  /* The new layout (one SQL row per pilot) is copied PAGE BY PAGE, so no step ever
     holds the whole leaderboard in memory: page 0 is every stored value (as
     before), then each table in pages of V2_BK_PAGE rows, ordered by id. While
     the pages are read the leaderboard refuses writes (503 + Retry-After, which
     the game's upload queue honours; at most V2_FREEZE_MS after the last page),
     so the copy is still one moment. Each page is its own canonical text, split
     into chunks like before; the manifest (schema 2) keeps a short checksum per
     chunk and a SHA-256 over all of them. Dry run and restore compare each page
     with the same id range of the live table and write only the differences; a
     restore pauses writes until it has finished (it can be run again to finish). */
  async livePaged() {
    const r = await this.lb("/v2bk-layout", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    return d.layout === "v2";
  }
  async lbJson(path, body) {
    const r = await this.lb(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ("the leaderboard answered " + r.status));
    return d;
  }
  async lbPage(body) {
    const r = await this.lb("/v2bk-page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || ("could not read the leaderboard (" + r.status + ")")); }
    return { text: await r.text(), n: Number(r.headers.get("x-flux-n")) || 0, last: decodeURIComponent(r.headers.get("x-flux-last") || "") };
  }
  async safety(note) {
    const meta = await this.takeSnapshot("safety", note);
    const st = await this.status(), now = Date.now();
    if (meta.verified) st.lastOk = { at: now, id: meta.id, kind: "safety" }; else st.lastError = { at: now, id: meta.id, error: meta.verifyError, kind: "safety" };
    await this.state.storage.put("status", st);
    const removed = meta.verified ? await this.prune() : 0;
    await this.log(meta.verified ? { event: "safety backup ok", id: meta.id, keys: meta.keyCount, bytes: meta.bytes, removed } : { event: "safety backup FAILED", id: meta.id, error: meta.verifyError });
    const { chunkSha, ...m } = meta;
    return json({ ok: meta.verified, snapshot: m, error: meta.verified ? "" : "The backup failed its check: " + meta.verifyError }, meta.verified ? 200 : 500);
  }
  async takeSnapshotPaged(kind, note) {
    const now = Date.now(), id = await this.newId(now, kind);
    const begin = await this.lbJson("/v2bk-begin", { mode: "dump" });
    const self = this;
    async function* pages() {
      yield { t: "", text: begin.kv };
      for (const t of begin.tables) {
        let after = null;
        for (;;) {
          const p = await self.lbPage({ token: begin.token, table: t, after, limit: V2_BK_PAGE });
          if (p.n) yield { t, text: p.text };
          if (p.n < V2_BK_PAGE) break;
          after = p.last;
        }
      }
    }
    let meta;
    try { meta = await this.writePagedRaw({ id, kind, createdAt: now, day: bkDay(now), weekly: false, note: String(note || "").slice(0, 200) }, pages()); }
    finally { await this.lbJson("/v2bk-end", { token: begin.token }).catch(() => {}); }   // writes resume before the read-back check
    return this.finishPaged(meta);
  }
  /* Pages -> chunks under a new generation, then the manifest, then the old
     generation goes (as writeSnapshot). A failure part-way removes what it wrote. */
  async writePagedRaw(base, pages) {
    const gen = (base.gen || 0) + 1, written = [], chunkSha = [], info = [], acc = v2SumStart();
    let bytes = 0, keyCount = 0, i = 0, season = null;
    try {
      for await (const p of pages) {
        const entries = bkDecode(p.text), chunks = bkSplit(p.text), puts = {};
        for (const c of chunks) { const k = this.chunkKey(base.id, gen, i++); puts[k] = c; written.push(k); chunkSha.push((await bkSha(c)).slice(0, 16)); }
        await this.putMany(puts);
        info.push({ t: p.t, c: chunks.length, n: entries.length });
        bytes += bkBytes(p.text); keyCount += entries.length;
        v2SumAdd(acc, p.t, entries);
        if (!p.t) { const m = new Map(entries); season = m.has("season") ? m.get("season") : null; }
      }
    } catch (e) { await this.deleteMany(written); throw e; }
    const meta = { ...base, schema: 2, gen, keyCount, bytes, chunks: i, chunkSha, pages: info, sha256: await bkSha(chunkSha.join("")), season,
      summary: v2SumEnd(acc), verified: false, verifiedAt: 0, verifyError: "" };
    await this.state.storage.put("m:" + base.id, meta);
    if (base.gen) await this.deleteMany(Array.from({ length: base.chunks || 0 }, (_, j) => this.chunkKey(base.id, base.gen, j)));
    return meta;
  }
  async finishPaged(meta) {
    const v = await this.verify(meta.id);
    meta.verified = v.ok; meta.verifiedAt = Date.now(); meta.verifyError = v.ok ? "" : v.error;
    await this.state.storage.put("m:" + meta.id, meta);
    return meta;
  }
  /* Read back page by page: every chunk present and unchanged, each page readable
     with its recorded count, then the checksum over all chunks, size and count. */
  async *readPages(meta) {
    const shas = [];
    let i = 0, bytes = 0, n = 0;
    for (const p of meta.pages || []) {
      const parts = [];
      for (let j = 0; j < p.c; j++, i++) {
        const c = await this.state.storage.get(this.chunkKey(meta.id, meta.gen, i));
        if (typeof c !== "string") throw new Error("part " + (i + 1) + " of " + meta.chunks + " is missing");
        const h = (await bkSha(c)).slice(0, 16);
        if (h !== meta.chunkSha[i]) throw new Error("part " + (i + 1) + " of " + meta.chunks + " is damaged (checksum mismatch)");
        shas.push(h); parts.push(c);
      }
      const text = parts.join("");
      let entries;
      try { entries = bkDecode(text); } catch (e) { throw new Error("the backup cannot be read"); }
      if (entries.length !== p.n) throw new Error("a page holds " + entries.length + " entries instead of " + p.n);
      bytes += bkBytes(text); n += entries.length;
      yield { p, entries, text };
    }
    if (i !== meta.chunks || (await bkSha(shas.join(""))) !== meta.sha256 || bytes !== meta.bytes) throw new Error("the whole-backup checksum does not match");
    if (n !== meta.keyCount) throw new Error("key count " + n + " does not match " + meta.keyCount);
  }
  async verifyPaged(meta) {
    try { for await (const x of this.readPages(meta)) void x; return { ok: true, error: "", meta }; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e), meta }; }
  }
  /* Dry run / restore of a new-layout backup: each page against the same id
     range of the live table; the stored values against the live ones. */
  async diffPaged(meta, apply) {
    const diff = { keysAdded: [], keysRemoved: [], keysChanged: [], counts: { added: 0, removed: 0, changed: 0, unchanged: 0 },
      players: { added: 0, removed: 0, changed: 0 }, purchases: { added: 0, removed: 0, changed: 0 } };
    const last = {}, token = apply ? apply.token : "";
    const tally = (t, c) => {
      for (const k of ["added", "removed", "changed", "unchanged"]) diff.counts[k] += c[k] || 0;
      const into = t === "pilots" ? diff.players : t === "ents" ? diff.purchases : null;
      if (into) for (const k of ["added", "removed", "changed"]) into[k] += c[k] || 0;
    };
    let kv = "";
    for await (const { p, entries, text } of this.readPages(meta)) {
      if (!p.t) { kv = text; continue; }
      const hi = v2RowId(p.t, entries[entries.length - 1][0]);
      tally(p.t, await this.lbJson("/v2bk-diff", { token, table: p.t, lo: last[p.t] === undefined ? null : last[p.t], hi, text, apply: !!apply }));
      last[p.t] = hi;
    }
    for (const t of V2_TABLES) tally(t, await this.lbJson("/v2bk-diff", { token, table: t, lo: last[t] === undefined ? null : last[t], hi: null, text: bkEncode([]), apply: !!apply }));
    const k = await this.lbJson("/v2bk-kv", { text: kv });
    diff.keysAdded = k.keysAdded; diff.keysRemoved = k.keysRemoved; diff.keysChanged = k.keysChanged;
    for (const x of ["added", "removed", "changed", "unchanged"]) diff.counts[x] += k.counts[x] || 0;
    return { identical: !diff.counts.added && !diff.counts.removed && !diff.counts.changed, diff, kv };
  }
  /* An old-layout backup while the new layout is live: restoring it brings the old
     layout back and drops the new tables. Pilots and purchases compared one by one. */
  async diffOldIntoNew(text) {
    const snap = bkDecode(text), S = new Map(snap), obj = (k) => { const v = S.get(k); return v && typeof v === "object" ? v : {}; };
    const k = await this.lbJson("/v2bk-kv", { text });
    const diff = { keysAdded: k.keysAdded, keysRemoved: k.keysRemoved, keysChanged: k.keysChanged, counts: { ...k.counts },
      players: { added: 0, removed: 0, changed: 0 }, purchases: { added: 0, removed: 0, changed: 0 } };
    const sp = obj("players"), se = obj("entitlements"), gotP = new Set(), gotE = new Set();
    for (const t of V2_TABLES) {
      let after = null;
      for (;;) {
        const p = await this.lbPage({ token: "", table: t, after, limit: V2_BK_PAGE });
        const entries = p.n ? bkDecode(p.text) : [];
        diff.counts.removed += entries.length;   // the new layout's tables go
        for (const [key, row] of entries) {
          const id = v2RowId(t, key);
          if (t === "pilots") { gotP.add(id); if (!Object.prototype.hasOwnProperty.call(sp, id)) diff.players.removed++; else if (!bkSame(JSON.parse(v2enc(normaliseRecord(sp[id], id))), JSON.parse(v2enc(row.rec)))) diff.players.changed++; }
          if (t === "ents") { gotE.add(id); if (!Object.prototype.hasOwnProperty.call(se, id)) diff.purchases.removed++; else if (!bkSame(se[id], v2dec(row.v))) diff.purchases.changed++; }
        }
        if (p.n < V2_BK_PAGE) break;
        after = p.last;
      }
    }
    for (const id of Object.keys(sp)) if (!gotP.has(id)) diff.players.added++;
    for (const id of Object.keys(se)) if (!gotE.has(id)) diff.purchases.added++;
    return { identical: false, diff };
  }
  async dryRunPaged(id, v) {
    const before = await this.lbJson("/v2bk-summary", {});
    const d = v.meta.schema === 2 ? await this.diffPaged(v.meta) : await this.diffOldIntoNew(v.text);
    return json({ ok: true, dryRun: true, id, verified: true, identical: d.identical, createdAt: v.meta.createdAt, before,
      after: v.meta.schema === 2 ? v.meta.summary : bkSummary(bkDecode(v.text)), diff: d.diff, confirm: "RESTORE " + id });
  }
  async restoreIsPaged(id) {
    const m = await this.state.storage.get("m:" + id);
    return !!m && (m.schema === 2 || (await this.livePaged()));
  }
  async restorePaged(id) {
    const { resp, v } = await this.checked(id); if (resp) return resp;
    const before = await this.lbJson("/v2bk-summary", {});
    const safety = await this.takeSnapshot("safety", "before restoring " + id);
    if (!safety.verified) {
      await this.log({ event: "restore REFUSED: the safety backup failed its check", id, safety: safety.id });
      return json({ ok: false, error: "The safety backup of the current leaderboard failed its check, so nothing was restored." }, 500);
    }
    let ok = false, after = null;
    try {
      if (v.meta.schema !== 2) {
        const r = await this.lb("/backup-restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: v.text });
        if (!r.ok) throw new Error("status " + r.status);
        const got = bkDecode(await this.dumpLive());
        ok = bkSameEntries(got, bkDecode(v.text)); after = bkSummary(got);
      } else {
        let kv = "";
        for await (const { p, text } of this.readPages(v.meta)) { if (!p.t) { kv = text; break; } }
        const begin = await this.lbJson("/v2bk-begin", { mode: "restore", id, kv });
        const d = await this.diffPaged(v.meta, { token: begin.token });
        await this.lbJson("/v2bk-end", { token: begin.token, restore: true, kv: d.kv });
        ok = (await this.diffPaged(v.meta)).identical;
        after = await this.lbJson("/v2bk-summary", {});
      }
    } catch (e) {
      await this.log({ event: "restore FAILED while writing", id, safety: safety.id, error: (e && e.message) || String(e) });
      return json({ ok: false, safetyId: safety.id, error: "The restore failed while writing (" + ((e && e.message) || e) + "). Score uploads stay paused until a restore finishes: run this restore again (it continues where it stopped), or restore the safety backup " + safety.id + ", which holds the state from just before." }, 500);
    }
    await this.log(ok ? { event: "RESTORED", id, safety: safety.id } : { event: "restore written but the check FAILED", id, safety: safety.id });
    await this.prune();
    return json({ ok, restored: id, safetyId: safety.id, verified: ok, before, after,
      error: ok ? "" : "The leaderboard does not match the backup after the restore. The safety backup " + safety.id + " holds the state from just before." }, ok ? 200 : 500);
  }
  /* The download, streamed chunk by chunk (never one big text in memory). */
  exportPaged(meta) {
    const { chunkSha, gen, ...manifest } = meta;
    const st = this.state.storage, self = this, enc = new TextEncoder();
    let started = false, page = 0, j = 0, i = 0;
    const stream = new ReadableStream({
      async pull(ctl) {
        if (!started) { started = true; ctl.enqueue(enc.encode('{"format":"flux-leaderboard-backup","manifest":' + JSON.stringify(manifest) + ',"pages":[')); return; }
        if (page >= meta.pages.length) { ctl.enqueue(enc.encode("]}")); ctl.close(); return; }
        const c = await st.get(self.chunkKey(meta.id, meta.gen, i++));
        ctl.enqueue(enc.encode((j === 0 && page > 0 ? "," : "") + c));
        if (++j >= meta.pages[page].c) { page++; j = 0; }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="flux-backup-' + meta.id + '.json"' } });
  }
  async importPaged(f) {
    const mf = f.manifest, info = Array.isArray(mf.pages) ? mf.pages : null, bad = () => json({ error: "This file does not match its own checksum; it was changed or damaged." }, 400);
    if (!info || info.length !== f.pages.length || typeof mf.sha256 !== "string") return json({ error: "This is not a FLUX backup file." }, 400);
    const texts = [], shas = [];
    let n = 0;
    for (let k = 0; k < f.pages.length; k++) {
      const text = JSON.stringify(f.pages[k]);
      let entries;
      try { entries = bkDecode(text); } catch (e) { return json({ error: "This is not a FLUX backup file." }, 400); }
      if (!info[k] || entries.length !== info[k].n || typeof info[k].t !== "string" || (info[k].t && !V2_TABLES.includes(info[k].t)) || (k === 0) !== (info[k].t === "")) return bad();
      for (const c of bkSplit(text)) shas.push((await bkSha(c)).slice(0, 16));
      texts.push(text); n += entries.length;
    }
    if ((await bkSha(shas.join(""))) !== mf.sha256 || n !== mf.keyCount) return bad();
    const now = Date.now(), id = await this.newId(now, "imported");
    const base = { id, kind: "imported", createdAt: now, day: bkDay(now), weekly: false,
      note: ("uploaded copy of " + String(mf.id || "?").slice(0, 60) + " from " + (mf.createdAt ? new Date(mf.createdAt).toISOString() : "?")).slice(0, 200) };
    const meta = await this.finishPaged(await this.writePagedRaw(base, (async function* () { for (let k = 0; k < texts.length; k++) yield { t: info[k].t, text: texts[k] }; })()));
    await this.log(meta.verified ? { event: "backup uploaded", id: meta.id, from: mf.id } : { event: "upload FAILED its check", id: meta.id });
    const { chunkSha, ...m } = meta;
    return json({ ok: meta.verified, snapshot: m }, meta.verified ? 200 : 500);
  }
  /* Privacy deletion in a new-layout backup: the pilot's rows (and purchases if
     asked) go, and the stored values lose them as in the old layout. */
  async purgePaged(m, pid, removePurchases) {
    const ids = new Set();
    let kvEntries = null;
    try {
      for await (const { p, entries } of this.readPages(m)) {
        if (!p.t) { kvEntries = entries; continue; }
        for (const [k, row] of entries) {
          const id = v2RowId(p.t, k);
          if (p.t === "pilots" ? row.pid === pid : (p.t === "ents" || p.t === "cool" || p.t === "fnd") && (await pidHash(id)) === pid) ids.add(id);
        }
      }
    } catch (e) { await this.deleteSnapshot(m); return "deleted"; }
    const kvOut = await v2EraseKv(kvEntries || [], pid, ids, removePurchases);
    if (!ids.size && !kvOut) return "unchanged";
    const drop = (t, id) => ids.has(id) && ((t !== "ents" && t !== "fnd") || removePurchases), self = this;   // FOUNDING PILOT: like a purchase
    const meta = await this.finishPaged(await this.writePagedRaw({ ...m, purgedAt: Date.now() }, (async function* () {
      for await (const { p, entries, text } of self.readPages(m)) {
        if (!p.t) { yield { t: "", text: kvOut ? bkEncode(kvOut) : text }; continue; }
        const kept = entries.filter(([k]) => !drop(p.t, v2RowId(p.t, k)));
        if (kept.length === entries.length) yield { t: p.t, text }; else if (kept.length) yield { t: p.t, text: bkEncode(kept) };
      }
    })()));
    if (!meta.verified) { await this.deleteSnapshot(meta); return "deleted"; }
    return "changed";
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
function countryOf(r) { const c = String((r && r.country) || ""); return ISO2.test(c) ? c : "XX"; }
function weightedBestOf(r, weights = DIFF_WEIGHT) {
  let best = null;
  for (const [d, b] of Object.entries((r && r.bests) || {})) {
    const w = b ? Math.round((Number(b.score) || 0) * (weights[d] || 1)) : -1;
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
/* One board from pilot records (already filtered for restrictions): real
   points on a difficulty board; no difficulty = the ALL board, each pilot's
   best WEIGHTED score across difficulties (DIFF_WEIGHT). Highest first, the
   earlier score first on a tie. */
function boardRows(records, difficulty, weights = DIFF_WEIGHT) {
  const rows = [];
  for (const r of records) {
    const b = difficulty ? ownGet(r.bests, difficulty) : weightedBestOf(r, weights);
    if (!b) continue;
    rows.push({ r, score: difficulty ? b.score : b.weighted, points: b.score, level: b.level, difficulty: difficulty || b.difficulty, updatedAt: b.updatedAt || r.updatedAt || 0 });
  }
  rows.sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);
  return rows;
}
/* D-25 country figures from ALL-board rows: each pilot counts once, at their
   single best weighted score. leaderId is internal only (stripped from every
   response). COMBINED WORLD GRID: the same function builds the Season 1 grid
   and the combined grid; the World Grid redesign (every-run points) extends it. */
function countryTotals(rows, nameOf = (r) => r.name) {
  const totals = Object.create(null);   // D-29
  const leaders = Object.create(null);
  for (const x of rows) {
    const cc = ISO2.test(String(x.r.country || "")) ? x.r.country : "XX";
    const c = totals[cc] || (totals[cc] = { country: cc, totalScore: 0, playerCount: 0, topScore: 0, topName: "", leaderId: "" });
    c.totalScore += x.score;
    c.playerCount += 1;
    if (!leaders[cc] || x.score > leaders[cc].score) leaders[cc] = x;
  }
  for (const [cc, x] of Object.entries(leaders)) {
    totals[cc].topScore = x.score;
    totals[cc].topName = nameOf(x.r);
    totals[cc].leaderId = x.r.playerId;
  }
  return totals;
}
/* ------------------------------------------------------------------ */
/* COMBINED WORLD GRID (owner)                                         */
/* ------------------------------------------------------------------ */
/* ONE World Grid from the Season 0 archive and this season's bests.
   Per pilot and per difficulty the grid uses the HIGHER of the two bests,
   never their sum; then, exactly like the ALL board and the country totals,
   each pilot counts once at their single best weighted score (DIFF_WEIGHT).
   Nothing is rewritten: the archive and the Season 1 bests stay as stored,
   and the combined grid is computed from them on every read, behind one
   stored switch (WORLD_GRID_KEY) that the owner turns on with APPLY and off
   with REVERT. Archive entries that cannot be matched to a pilot who still
   exists are FLAGGED and left out -- never guessed, never brought back:
     pilot-gone            the pilot's record is gone (score removed, or deleted);
     privacy-deleted       the restore log marks the pilot as privacy-deleted;
     conflicting-identity  the archive holds the pilot twice with different data;
     invalid-id / invalid-score  the entry or one score is not valid;
     restricted            hidden from the boards and country totals, as today.
   mergeWorldGrid() builds the grid, checkWorldGrid() checks it independently
   (it does not reuse the merge), consolidateWorldGrid() does both. The World
   Grid redesign (every-run country points) extends countryTotals(). */
const WORLD_GRID_KEY = "worldGrid";                     // { combined, appliedAt, revertedAt, dryRunId, backupId, safetyId, log[] }
const WORLD_GRID_DRY_RUN_MAX_AGE_MS = 60 * 60 * 1000;   // APPLY accepts a dry run made in the last 60 minutes
const WORLD_GRID_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;    // ...and needs a checked backup from the last 60 minutes
const WORLD_GRID_ID = /^WG-[0-9a-z]{6,11}-[0-9a-f]{8}$/;
const WORLD_GRID_LOG_MAX = 20;
const WORLD_GRID_MOVE_FIRST = "Move the storage first: the combined World Grid works on the new storage layout only. Open STORAGE above, move it, then run the WORLD GRID dry run.";
/* The Season 0 table (new layout only): one row per archived pilot with a valid
   best, built from the archive by APPLY (never by a run), with one index per
   difficulty -- so every combined board is two indexed reads of about 100 rows
   (Season 1 rows + Season 0 rows), exactly like the Season 1 boards. */
const WG0_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS wg0 (id TEXT PRIMARY KEY, e_s NUMERIC, e_t NUMERIC, e_l NUMERIC, m_s NUMERIC, m_t NUMERIC, m_l NUMERIC, h_s NUMERIC, h_t NUMERIC, h_l NUMERIC) WITHOUT ROWID",
  "CREATE INDEX IF NOT EXISTS wg0_e ON wg0 (e_s DESC, e_t) WHERE e_s IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS wg0_m ON wg0 (m_s DESC, m_t) WHERE m_s IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS wg0_h ON wg0 (h_s DESC, h_t) WHERE h_s IS NOT NULL",
];
const WG0_COLS = ["e_s", "e_t", "e_l", "m_s", "m_t", "m_l", "h_s", "h_t", "h_l"];
const WG0_SEL = "w.id AS w_id, " + WG0_COLS.map((k) => "w." + k + " AS w_" + k).join(", ");
/* The Season 0 columns of a joined row, as row._w (null: no Season 0 row). */
function wgSplit(r) {
  if (!r || r._w !== undefined) return r;
  const w = r.w_id != null ? {} : null;
  for (const k of WG0_COLS) { if (w) w[k] = r["w_" + k]; delete r["w_" + k]; }
  delete r.w_id; r._w = w;
  return r;
}
/* The owner's cost table for the combined grid (rows; measured by the tests). */
function worldGridCosts(pilots, archived) {
  return {
    apply: { rowsRead: 7 * pilots + archived + 50, rowsWritten: 4 * archived + 3, note: "reads every pilot about 7 times (re-check, safety backup, summary rebuild, the live check) + the archive; writes the Season 0 table once (each row + its 3 indexes), the switch and the summary row" },
    revert: { rowsRead: pilots + 5, rowsWritten: 2, note: "the switch and the summary row" },
    run: { rowsWritten: "unchanged (1-5)", rowsRead: "as today + 1 (the pilot's Season 0 row, once per pilot until a restart); + about 200 when a board changed; the rank floor below the top 100 reads 1,000 rows on each of the two indexes once per 10 minutes per board" },
    leaderboard: { rowsRead: "0 from memory; about 200 per board after a restart (Season 1 rows + Season 0 rows), about 1,300 for the game's request at 5,000 pilots" },
    coldStart: { rowsRead: "about 12 (the summary row + the Season 0 table's name; never the pilots)" },
  };
}
const WORLD_GRID_REASONS = {
  "pilot-gone": "pilot no longer exists (score removed or pilot deleted): not brought back",
  "privacy-deleted": "pilot was privacy-deleted: never brought back",
  "conflicting-identity": "archived more than once with different data: not merged (no guessing)",
  "invalid-id": "archive entry without a valid pilot ID: not merged",
  "invalid-score": "archived score is not valid for that difficulty: not merged",
  "restricted": "pilot is restricted: hidden from the boards and country totals, as today",
};
function wgValidBest(d, b) {
  return VALID_DIFFICULTIES.has(d) && !!b && typeof b === "object" && Number.isFinite(b.score) && b.score >= 0 && b.score <= MAX_SCORE;
}
function wgScores(a, d) {
  const out = {};
  for (const k of Object.keys((a && a.bests) || {})) if (!d || k === d) { const b = a.bests[k]; out[k] = b && Number.isFinite(b.score) ? b.score : null; }
  return out;
}
/* archive: [{ playerId, name, country, bests }]  (the Season 0 archive)
   pilots:  the current pilot records (LeaderboardDO.pilotRecords())
   erasedIds: Set of archived playerIds the restore log marks as privacy-deleted
   -> { pilots: consolidated records (current pilots only), flagged[], notes } */
function mergeWorldGrid({ archive, pilots, erasedIds }) {
  const erased = erasedIds || new Set();
  const out = new Map();
  for (const r of pilots) {
    const bests = Object.create(null);
    for (const d of Object.keys(r.bests || {})) { const b = r.bests[d]; if (b) bests[d] = { score: b.score, level: b.level, updatedAt: b.updatedAt || 0, season: SEASON }; }
    out.set(r.playerId, { playerId: r.playerId, name: r.name, country: r.country, updatedAt: r.updatedAt || 0, bests });
  }
  const groups = new Map(), flagged = [];
  const flag = (a, code, difficulty) => flagged.push({ playerId: a && typeof a.playerId === "string" ? a.playerId : "", name: code === "privacy-deleted" ? "" : String((a && a.name) || ""),
    country: String((a && a.country) || ""), code, difficulty: difficulty || null, scores: wgScores(a, difficulty) });
  for (const a of Array.isArray(archive) ? archive : []) {
    if (!a || typeof a !== "object" || !validPlayerId(a.playerId)) { flag(a, "invalid-id"); continue; }
    const g = groups.get(a.playerId);
    if (g) g.push(a); else groups.set(a.playerId, [a]);
  }
  const notes = { countryChanged: 0, nameChanged: 0, repeatedSame: 0 };
  for (const [id, list] of groups) {
    if (!list.every((x) => JSON.stringify(x) === JSON.stringify(list[0]))) { for (const a of list) flag(a, "conflicting-identity"); continue; }
    notes.repeatedSame += list.length - 1;
    const a = list[0], m = out.get(id);
    if (!m) { flag(a, erased.has(id) ? "privacy-deleted" : "pilot-gone"); continue; }
    if (String(a.country || "") !== String(m.country || "")) notes.countryChanged++;   // counted for the pilot's CURRENT country
    if (String(a.name || "") !== String(m.name || "")) notes.nameChanged++;             // shown under the pilot's CURRENT name
    for (const d of Object.keys(a.bests || {})) {
      const b = a.bests[d];
      if (!wgValidBest(d, b)) { flag(a, "invalid-score", d); continue; }
      const c = ownGet(m.bests, d);
      if (!c || b.score > c.score) m.bests[d] = { score: b.score, level: b.level, updatedAt: b.updatedAt || 0, season: 0 };   // the higher best, never a sum
    }
  }
  return { pilots: [...out.values()], flagged, notes };
}
/* The independent checks (owner): computed from the inputs, not from the merge. */
function checkWorldGrid(input, res) {
  const weights = input.weights || DIFF_WEIGHT, restricted = input.restrictedIds || new Set();
  const label = input.labelOf || (() => "a pilot");
  const cur = new Map(input.pilots.map((r) => [r.playerId, r]));
  const outById = new Map(); let listedTwice = 0;
  for (const p of res.pilots) { if (outById.has(p.playerId)) listedTwice++; outById.set(p.playerId, p); }
  const rowById = new Map(); let rowsTwice = 0;
  for (const x of res.rows) { if (rowById.has(x.r.playerId)) rowsTwice++; rowById.set(x.r.playerId, x); }
  const flaggedKeys = new Set(res.flagged.filter((f) => f.code !== "restricted").map((f) => f.playerId + "|" + (f.difficulty || "*")));
  const isFlagged = (id, d) => flaggedKeys.has(id + "|*") || flaggedKeys.has(id + "|" + d);
  const archById = new Map();
  for (const a of input.archive || []) { const id = a && typeof a.playerId === "string" ? a.playerId : ""; if (!archById.has(id)) archById.set(id, []); archById.get(id).push(a); }
  const checks = [];
  const add = (id, text, bad, total) => checks.push({ id, label: text, ok: bad.length === 0, detail: bad.length ? bad.length + " problem(s): " + bad.slice(0, 5).join("; ") : "all " + total + " checked" });
  const wBest = (r) => { let w = -1; for (const d of Object.keys((r && r.bests) || {})) { const b = r.bests[d]; if (b && Number.isFinite(b.score)) w = Math.max(w, Math.round(b.score * (weights[d] || 1))); } return w; };

  // 1. Every current best is still there, at least as high (per difficulty and on the ALL board).
  const lost = []; let n1 = 0;
  for (const r of input.pilots) {
    for (const d of Object.keys(r.bests || {})) {
      const b = r.bests[d]; if (!b || !Number.isFinite(b.score)) continue; n1++;
      const o = outById.get(r.playerId), ob = o && ownGet(o.bests, d);
      if (!ob || !(ob.score >= b.score)) lost.push(label(r.playerId) + " " + d + " " + b.score + " -> " + (ob ? ob.score : "missing"));
    }
    const w = wBest(r);
    if (w >= 0 && !restricted.has(r.playerId)) { const x = rowById.get(r.playerId); if (!x || !(x.score >= w)) lost.push(label(r.playerId) + " ALL " + w + " -> " + (x ? x.score : "missing")); }
  }
  add("no-current-score-lost", "No current score lost", lost, n1 + " current bests");

  // 2. Every archived best is merged (the grid holds at least that score) or flagged with a reason.
  const unaccounted = []; let n2 = 0, merged = 0, flaggedScores = 0;
  for (const a of input.archive || []) {
    const id = a && typeof a.playerId === "string" ? a.playerId : "";
    for (const d of Object.keys((a && a.bests) || {})) {
      n2++;
      if (isFlagged(id, d)) { flaggedScores++; continue; }
      const o = outById.get(id), ob = o && ownGet(o.bests, d), ab = a.bests[d];
      if (ob && ab && Number.isFinite(ab.score) && ob.score >= ab.score) merged++;
      else unaccounted.push(label(id) + " " + d + " " + (ab && ab.score) + " -> " + (ob ? ob.score : "missing"));
    }
  }
  add("archive-accounted", "Every Season 0 best merged or flagged", unaccounted, n2 + " archived bests (" + merged + " merged, " + flaggedScores + " flagged)");

  // 3. No pilot counted twice: listed once, and every best IS one of its sources (the higher one), never a sum.
  const twice = [];
  if (listedTwice) twice.push(listedTwice + " pilot(s) listed twice");
  if (rowsTwice) twice.push(rowsTwice + " pilot(s) twice on the ALL board");
  for (const p of res.pilots) {
    for (const d of Object.keys(p.bests || {})) {
      const c = cur.get(p.playerId), cb = c && ownGet(c.bests, d);
      const sources = [];
      if (cb && Number.isFinite(cb.score)) sources.push(cb.score);
      for (const a of archById.get(p.playerId) || []) { const ab = a.bests && a.bests[d]; if (ab && Number.isFinite(ab.score) && !isFlagged(p.playerId, d)) sources.push(ab.score); }
      const ob = p.bests[d];
      if (!sources.includes(ob.score) || ob.score !== Math.max(...sources)) twice.push(label(p.playerId) + " " + d + " " + ob.score + " is not the higher of " + (sources.join(" / ") || "nothing"));
    }
  }
  add("no-double-count", "No pilot counted twice (best of both, never added)", twice, res.pilots.length + " pilots");

  // 4. Country totals = the sum of the consolidated pilots' single best weighted score.
  const sums = Object.create(null), bad4 = [];
  for (const p of res.pilots) {
    if (restricted.has(p.playerId)) continue;
    const w = wBest(p); if (w < 0) continue;
    const cc = ISO2.test(String(p.country || "")) ? p.country : "XX";
    const s = sums[cc] || (sums[cc] = { t: 0, n: 0 }); s.t += w; s.n++;
  }
  for (const cc of new Set([...Object.keys(sums), ...Object.keys(res.countries)])) {
    const s = sums[cc], c = res.countries[cc];
    if (!s || !c || s.t !== c.totalScore || s.n !== c.playerCount) bad4.push(cc + " " + (c ? c.totalScore + "/" + c.playerCount : "missing") + " vs " + (s ? s.t + "/" + s.n : "no pilots"));
  }
  add("country-totals", "Country totals = sum of consolidated weighted bests", bad4, Object.keys(sums).length + " countries");

  // 5. Restricted pilots are not on the board or in any country total, as today.
  const bad5 = [];
  for (const x of res.rows) if (restricted.has(x.r.playerId)) bad5.push(label(x.r.playerId) + " on the ALL board");
  for (const c of Object.values(res.countries)) if (restricted.has(c.leaderId)) bad5.push(c.country + " led by a restricted pilot");
  add("restricted-excluded", "Restricted pilots excluded (as today)", bad5, restricted.size + " restricted");

  // 6. Nobody comes back from the archive: every pilot on the grid exists today.
  const bad6 = [];
  for (const p of res.pilots) if (!cur.has(p.playerId)) bad6.push(label(p.playerId) + " is not a current pilot");
  for (const x of res.rows) if (!cur.has(x.r.playerId)) bad6.push(label(x.r.playerId) + " on the ALL board");
  add("deleted-not-resurrected", "Deleted pilots never brought back", bad6, res.pilots.length + " pilots");
  return checks;
}
/* The whole consolidation, with its checks. input = { archive, pilots,
   restrictedIds, erasedIds, weights, nameOf, labelOf }. */
function consolidateWorldGrid(input) {
  const weights = input.weights || DIFF_WEIGHT, restricted = input.restrictedIds || new Set();
  const m = mergeWorldGrid(input);
  const archived = new Set((input.archive || []).map((a) => a && a.playerId));
  for (const p of m.pilots) if (restricted.has(p.playerId) && archived.has(p.playerId)) m.flagged.push({ playerId: p.playerId, name: String(p.name || ""), country: String(p.country || ""), code: "restricted", difficulty: null, scores: {} });
  const rows = boardRows(m.pilots.filter((p) => !restricted.has(p.playerId)), null, weights);
  const res = { pilots: m.pilots, rows, countries: countryTotals(rows, input.nameOf), flagged: m.flagged, notes: m.notes };
  res.checks = checkWorldGrid(input, res);
  res.ok = res.checks.every((c) => c.ok);
  return res;
}
/* Today's grid (this season only), from the same functions. */
function seasonGrid(input) {
  const restricted = input.restrictedIds || new Set();
  const rows = boardRows(input.pilots.filter((p) => !restricted.has(p.playerId)), null, input.weights || DIFF_WEIGHT);
  return { rows, countries: countryTotals(rows, input.nameOf) };
}
/* The dry-run report in plain words (the admin page shows the same). */
function worldGridReportText(r) {
  const n = (x) => Number(x || 0).toLocaleString("en-US");
  const c = r.counts, L = [];
  L.push("COMBINED WORLD GRID -- DRY RUN " + r.id + (r.dryRun ? " (nothing was changed)" : ""));
  L.push("Made " + new Date(r.createdAt).toISOString() + ". The World Grid is now: " + (r.combinedNow ? "COMBINED (Season 0 + Season 1)" : "Season 1 only") + ".");
  L.push("Storage: " + (r.layout === "new" ? "the new layout (one row per pilot)" : "the old layout") + ".");
  L.push("Weights (ALL board and country totals, as today): Hard x" + r.weights.hard + ", Medium x" + r.weights.medium + ", Easy x" + r.weights.easy + ".");
  L.push("");
  L.push("CHECKS");
  for (const k of r.checks) L.push("  " + k.label.toLowerCase() + ": " + (k.ok ? "PASS" : "FAIL") + "  (" + k.detail + ")");
  L.push("  => " + (r.allPass ? "ALL CHECKS PASS. Safe to apply after your approval." : "A CHECK FAILED. Do not apply."));
  L.push("");
  L.push("COUNTS");
  L.push("  Pilots today: " + n(c.currentPilots) + " (" + n(c.currentScores) + " Season 1 bests). Season 0 archive: " + n(c.archivePilots) + " pilots, " + n(c.archiveScores) + " bests.");
  L.push("  Season 0 bests merged: " + n(c.mergedScores) + " (" + n(c.raisedScores) + " higher than the pilot's Season 1 best, so they now count). Flagged and left out: " + n(c.flaggedScores) + ".");
  L.push("  On the World Grid (ALL board): " + n(c.pilotsBefore) + " pilots before -> " + n(c.pilotsAfter) + " after (" + n(c.onlyArchive) + " back from Season 0 only, " + n(c.both) + " raised by a Season 0 best, " + n(c.onlyCurrent) + " unchanged).");
  L.push("  Best used per difficulty: easy " + n(c.fromS0.easy) + " from Season 0 / " + n(c.fromS1.easy) + " from Season 1; medium " + n(c.fromS0.medium) + " / " + n(c.fromS1.medium) + "; hard " + n(c.fromS0.hard) + " / " + n(c.fromS1.hard) + ".");
  L.push("  Restricted pilots left out (as today): " + n(c.restrictedExcluded) + ". Countries: " + n(c.countriesBefore) + " -> " + n(c.countriesAfter) + ". World total (weighted): " + n(c.totalBefore) + " -> " + n(c.totalAfter) + ".");
  if (r.notes.countryChanged || r.notes.nameChanged) L.push("  Changed since Season 0 (merged under the pilot's CURRENT name and country): " + n(r.notes.countryChanged) + " country, " + n(r.notes.nameChanged) + " name.");
  L.push("");
  L.push("COUNTRIES (before -> after)");
  for (const x of r.countries) L.push("  " + (x.after ? "#" + x.after.rank : "--") + "  " + x.country + "  " + (x.before ? n(x.before.totalScore) + " (#" + x.before.rank + ", " + x.before.playerCount + " pilots)" : "not on the grid") + "  ->  " + (x.after ? n(x.after.totalScore) + " (#" + x.after.rank + ", " + x.after.playerCount + " pilots)" : "gone") + (x.rankChange ? "  rank " + (x.rankChange > 0 ? "up " : "down ") + Math.abs(x.rankChange) : ""));
  L.push("");
  L.push("TOP PILOTS BEFORE (Season 1 only)");
  r.topBefore.forEach((p) => L.push("  #" + p.rank + " " + p.name + " #" + p.tag + " " + p.country + "  " + n(p.score)));
  if (!r.topBefore.length) L.push("  (nobody yet)");
  L.push("TOP PILOTS AFTER (combined)");
  r.topAfter.forEach((p) => L.push("  #" + p.rank + " " + p.name + " #" + p.tag + " " + p.country + "  " + n(p.score) + "  (" + p.difficulty + ", Season " + p.season + ")"));
  L.push("");
  if (r.cost) {
    const k = r.cost;
    L.push("FREE PLAN COST (rows; free plan: " + n(FREE_PLAN.rowsReadPerDay) + " read, " + n(FREE_PLAN.rowsWrittenPerDay) + " written a day)");
    L.push("  This dry run: " + n(k.dryRun.rowsRead) + " read, " + n(k.dryRun.rowsWritten) + " written.");
    L.push("  APPLY (once): about " + n(k.apply.rowsRead) + " read, about " + n(k.apply.rowsWritten) + " written. REVERT: about " + n(k.revert.rowsRead) + " read, " + n(k.revert.rowsWritten) + " written.");
    L.push("  After APPLY: a run writes the same rows as today (" + k.run.rowsWritten + "); reads " + k.run.rowsRead + ". A restart reads " + k.coldStart.rowsRead + ". A leaderboard: " + k.leaderboard.rowsRead + ".");
    L.push("");
  }
  L.push("FLAGGED (" + r.flagged.length + ")" + (r.flagged.length ? "" : ": none"));
  r.flagged.forEach((f) => L.push("  " + (f.name || "(erased)") + (f.tag ? " #" + f.tag : "") + " " + (f.country || "??") + (f.difficulty ? " " + f.difficulty : "") + "  " + Object.entries(f.scores || {}).map(([d, s]) => d + " " + n(s)).join(", ") + "  -- " + f.reason));
  L.push("");
  L.push("To apply: take a backup (BACK UP NOW), then type APPLY " + r.id + " within 60 minutes. REVERT switches back at any time; no score is rewritten or deleted either way.");
  return L.join("\n");
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
/* STORAGE FIX: one SQL row per pilot (layout "v2")                    */
/* ------------------------------------------------------------------ */
/* THE PROBLEM. The old layout keeps EVERY pilot in one stored value,
   "players" (plus "lastSubmit", "entitlements", "seenSessions", which also
   grow with pilots). Cloudflare caps one value at 2 MB: about 8,000 pilots,
   then every score upload fails.

   THE NEW LAYOUT (same LeaderboardDO class, same "global" instance, its
   SQLite database -- no new class, binding or migration in wrangler.jsonc):
     pilots  one row per pilot: the exact old record (JSON, "rec") plus the
             columns the boards need: best score and time per difficulty
             (e_s/e_t, m_s/m_t, h_s/h_t), country, restricted, displayed name,
             public tag, last upload (the cooldown). seq keeps the old order
             of the "players" value, which breaks full ties on the boards.
             Indexes: id (unique), the 12-character tag (tag collisions, NAME
             #TAG search, lookups by the public hash) and one per difficulty
             board, holding only public pilots with a best (partial indexes).
     ents    one row per buyer (skins, incl. Solar Inferno)
     seen    one row per delivered checkout session
     cool    the cooldown of a pilot whose score was removed (no pilot row)
     v2meta  one small summary row: country totals and leaders, pilot count
   Small values stay where they are: restricted, nameBans, flags (max 200),
   restoreLog (max 500), season + Season 0 archive (chunked).

   NO FULL READ ON A COLD START. A restart reads about 10 rows (the small
   values and the summary row), never the pilots. A board (top 100) is one
   indexed query of about 100 rows, kept in memory until a write can change
   it; ALL (difficulty weights, #33) merges the three boards' top rows and
   adds every row whose weighted score could tie, so it is exact without a
   weighted column (a weights change never rewrites a row). Country totals are
   kept up to date on every write (add the new weighted best, remove the old);
   a leader is looked up again only when a leader gets worse or leaves. Ranks
   in an upload's answer: exact up to RANK_EXACT_MAX (counted on the index),
   no rank beyond (the game then shows none, as for a restricted pilot).

   FREE PLAN (Workers Free, SQLite Durable Objects; check the numbers in the
   Cloudflare dashboard, they may change): 5,000,000 rows read, 100,000 rows
   written a day, 5 GB stored. Measured with the tests' row counter (an index
   entry counts as a row written; Cloudflare's own counts are the authority):
     a run (score upload)    written: 1-2 without a new best, 2-4 with one,
                             about 5 for a new pilot; read: 2-5, + about 100
                             when that board changed since, + 1,000 once per
                             10 minutes per board (the rank floor)
     leaderboard request     read: 0 from memory; about 100 per board (ALL
                             about 400) the first time after a restart
     cold start              read: about 10, at 6,000 or 200,000 pilots alike
     daily backup            read: every row once (200,000 pilots: ~201,000),
                             written: one row per 30,000 characters (200,000
                             pilots: ~2,100 rows, ~58 MB per copy)
   The old layout's own rows were cheap (a run wrote 5 values, a cold start
   read 12); its limit was the SIZE of one value, not the row budget. With the
   new layout the budget that binds on the free plan is the number of runs a
   day (100,000 rows written, shared with the stats), not the number of pilots.
   See v2Costs() for the figures at 10k / 50k / 200k pilots.

   THE MOVE (owner-triggered only, admin page STORAGE): back up -> dry run
   (builds the new layout in memory, compares everything, writes nothing live)
   -> "MIGRATE <dry-run id>" (needs a verified backup < 60 minutes old, takes a
   safety backup, copies in batches of MIG_BATCH, resumable, stops for the day
   at MIG_DAY_ROW_BUDGET rows written) -> switch (all at once: nothing else runs,
   writes in flight finish first, every pilot is synced and compared again, the
   new layout is used only if every comparison passes) -> check (old vs new,
   every public answer) -> rollback if needed / clean-up later. Until the switch,
   and after a rollback, FLUX runs on the old layout exactly as before. The old
   values stay untouched (read-only) until CLEAN UP. */
const STORAGE_LAYOUT_KEY = "storageLayout";
const V2_RESTORING_KEY = "v2:restoring";
const MIG_KEY = "mig", MIG_DRY_KEY = "mig:dry", MIG_ORDER_KEY = "mig:order", MIG_CHECK_KEY = "mig:check", MIG_CHANGED_KEY = "mig:changed";
const V1_OLD_ONLY_KEYS = ["players", "lastSubmit", "entitlements", "seenSessions", "countries", "countriesWeights"];
const V1_TWIN_KEYS = V1_OLD_ONLY_KEYS.concat(["restricted", "nameBans", "flags", "restoreLog", "nameRulesV1", "season"]);
const V1_VALUE_LIMIT = 2 * 1024 * 1024;      // Cloudflare's cap on one stored value
const V1_ROLLBACK_MAX_BYTES = 1_900_000;     // a rollback must fit the old layout with room to spare
const BOARD_MAX = 100;
const RANK_EXACT_MAX = 1000;
const RANK_FLOOR_TTL_MS = 10 * 60 * 1000;
const V2_TIE_MAX = 5000;
const V2_SCAN_PAGE = 1000;
const V2_BK_PAGE = 2000;
const V2_FREEZE_MS = 60_000;
const V2_BUSY_SEC = 5;
const V2_PID_CACHE_MAX = 20_000;
const MIG_BATCH = 1000;
const MIG_CALLS_PER_REQUEST = 30;            // batches per admin request (a Worker request makes at most 50 subrequests on the free plan)
const MIG_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;
const MIG_DRY_MAX_AGE_MS = 24 * 3600 * 1000;
const MIG_DAY_ROW_BUDGET = 60_000;           // the move pauses for the day here, leaving the rest of the 100,000 for play
const MIG_CHECK_BATCH = 2000;
const MIG_CHECK_SAMPLE = 200;
const MIG_CHANGED_MAX = 5000;
const V2_ROW_BYTES_EST = 310;                // one pilot in a backup (measured in the tests)
const FREE_PLAN = { rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000, storageBytes: 5 * 1024 * 1024 * 1024, note: "Workers Free plan, SQLite Durable Objects -- check the current limits in the Cloudflare dashboard" };
const V2_WRITE_ROUTES = new Set(["/submit", "/grant", "/revoke", "/import", "/recompute", "/admin-remove-score", "/admin-restrict", "/admin-unrestrict",
  "/admin-privacy-delete", "/admin-name-ban", "/admin-name-unban", "/admin-dismiss-flag", "/admin-issue-restore", "/world-grid-apply", "/world-grid-revert",
  "/founding-switch", "/founding-continue", "/founding-exclude", "/founding-take-back"]);
const V2_TABLES = ["pilots", "ents", "seen", "cool", "fnd"];   // backed up; v2meta (derived totals) is rebuilt instead
const V2_ALL_TABLES = V2_TABLES.concat(["v2meta"]);
const V2_BK_SKIP_KEYS = new Set([V2_RESTORING_KEY]);
const V2_DIFFS = ["easy", "medium", "hard"];
const V2_COL = { easy: "e", medium: "m", hard: "h" };
/* FOUNDING PILOT (owner): the first FOUNDING_CAP pilots, in creation order (seq), get the
   whole Solar Inferno package free forever -- the "solar" sku, which unlocks everything the
   paid Solar Inferno unlocks in the game (SKINS.solar: its five orb colours, its orange
   launcher, and the Solar Inferno backdrop in WORLD). The grant is its OWN row in "fnd" (id =
   playerId, v = { n, at, src: "founding" } -- never a Stripe purchase, never in "ents"); the
   public /entitlements and /restore-check answers add "solar" for an active grant, so every
   device and every restore code brings it back exactly like a purchase. Numbering only on the
   new storage layout; OFF (the default) changes nothing anywhere.
     KV "founding" (backed up): { on, given, cur, done, excl: { pid: { tag, name, at } }, onAt, offAt, log }
     summary row (v2meta "sum").fo = { on, given, cur, done }: the live counter, read with the
     summary at a cold start (no extra row) and written with it (a run already writes it).
   given = numbers handed out (never reused, never lowered); cur = the last seq looked at;
   done = every pilot up to cur was looked at, so a NEW pilot gets the next number at creation. */
const FND_SCHEMA = "CREATE TABLE IF NOT EXISTS fnd (id TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID";
const FOUNDING_CAP = 1000;
const FOUNDING_KEY = "founding";
const FOUNDING_SRC = "founding";
const FOUNDING_LOG_MAX = 30;
const FOUNDING_EXCL_MAX = 500;
const FOUNDING_LIST_SHOWN = 50;
const FOUNDING_CONFIRM = "FOUNDING ON";
const FOUNDING_CALLS_PER_REQUEST = 10;
const FOUNDING_MOVE_FIRST = "Move the storage first: Founding Pilot works on the new storage layout only (STORAGE above).";
function foOf(cfg) { return cfg && typeof cfg === "object" ? { on: cfg.on ? 1 : 0, given: Math.max(0, cfg.given | 0), cur: Math.max(0, cfg.cur | 0), done: cfg.done ? 1 : 0 } : undefined; }
const V2_PILOT_COLS = ["seq", "id", "pid", "t12", "tag", "dname", "nb1", "nb2", "cc", "rs", "ls", "e_s", "e_t", "m_s", "m_t", "h_s", "h_t", "rec"];
const V2_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS pilots (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, pid TEXT NOT NULL, t12 TEXT NOT NULL, tag TEXT NOT NULL, dname TEXT NOT NULL, nb1 TEXT NOT NULL, nb2 TEXT NOT NULL, cc TEXT NOT NULL, rs INTEGER NOT NULL, ls TEXT, e_s NUMERIC, e_t NUMERIC, m_s NUMERIC, m_t NUMERIC, h_s NUMERIC, h_t NUMERIC, rec TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS pilots_t12 ON pilots (t12)",
  "CREATE INDEX IF NOT EXISTS pilots_e ON pilots (e_s DESC, e_t, seq) WHERE e_s IS NOT NULL AND rs = 0",
  "CREATE INDEX IF NOT EXISTS pilots_m ON pilots (m_s DESC, m_t, seq) WHERE m_s IS NOT NULL AND rs = 0",
  "CREATE INDEX IF NOT EXISTS pilots_h ON pilots (h_s DESC, h_t, seq) WHERE h_s IS NOT NULL AND rs = 0",
  "CREATE TABLE IF NOT EXISTS ents (id TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS cool (id TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS v2meta (id TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  FND_SCHEMA,
];

/* Values stored as text keep undefined / NaN / Infinity, exactly like a backup. */
function v2enc(v) {
  return JSON.stringify(v, function (k, x) {
    if (x === undefined) return { [BK_MARK]: "undefined" };
    if (typeof x === "number" && !Number.isFinite(x)) return { [BK_MARK]: String(x) };
    return x;
  });
}
function v2dec(t) { return t == null ? undefined : bkRevive(JSON.parse(t)); }
function v2Busy() {
  return json({ error: "FLUX is saving or restoring the leaderboard. Try again in a few seconds.", retryAfterSec: V2_BUSY_SEC, busy: true }, 503, { "Retry-After": String(V2_BUSY_SEC) });
}
function v2Token() { return crypto.randomUUID(); }
function v2RowId(t, key) { return String(key).slice(("sql:" + t + ":").length); }
/* Board order: higher score first, then the earlier time, then the older pilot (seq). */
function v2KeyLess(a, b) { return a.s !== b.s ? a.s > b.s : a.t !== b.t ? a.t < b.t : a.seq < b.seq; }
function v2Changed(a, b) {
  let ch = null;
  for (const k of V2_PILOT_COLS) if (k !== "seq" && a[k] !== b[k]) (ch || (ch = {}))[k] = b[k];
  return ch;
}
function v2SameSum(a, b) {
  const plain = (x) => JSON.parse(JSON.stringify(x || {}));
  if (!a || !b || a.n !== b.n || !bkSame(plain(a.list), plain(b.list)) || !bkSame(plain(a.bc), plain(b.bc)) || !bkSame(plain(a.bcc), plain(b.bcc))) return false;
  const ka = Object.keys(a.lead), kb = Object.keys(b.lead);
  if (ka.length !== kb.length) return false;
  for (const cc of ka) { const x = a.lead[cc], y = b.lead[cc]; if (!y || x.id !== y.id || x.s !== y.s || x.t !== y.t || x.seq !== y.seq || x.tag !== y.tag) return false; }
  return true;
}
/* A pilot row in a backup: only what cannot be recomputed (the record as an
   object, not escaped text); the other columns are rebuilt on restore. */
function v2Slim(row) { return { seq: row.seq, id: row.id, pid: row.pid, ls: row.ls, rec: v2dec(row.rec) }; }
function v2Bytes(v) { return new TextEncoder().encode(JSON.stringify(v) || "").length; }
/* The owner's cost table (see the note above): rows a day at n pilots. */
function v2Costs(n) {
  const bytes = n * V2_ROW_BYTES_EST, chunks = Math.ceil(bytes / BACKUP_CHUNK_CHARS) + 1;
  const kept = BACKUP_KEEP_DAILY + BACKUP_KEEP_WEEKLY;
  return {
    pilots: n,
    run: { rowsWritten: "1-2 (no new best), 2-4 (new best), about 5 (new pilot)", rowsRead: "2-5; about 100 more when that board changed; " + RANK_EXACT_MAX + " once per 10 minutes per board (rank floor)" },
    leaderboardRequest: { rowsRead: "0 from memory; about 100 per board (ALL about 400) after a restart" },
    coldStart: { rowsRead: "about 10 (never the pilots)" },
    dailyBackup: { rowsRead: n + chunks * (1 + kept), rowsWritten: chunks + 6, bytes, keptBytes: bytes * kept,
      note: "reads every pilot once, writes the copy in " + chunks + " parts, re-checks every kept copy (" + kept + " typical)" },
  };
}

/* ---- the SQL tables (Cloudflare: ctx.storage.sql) ---- */
class V2SqlDb {
  constructor(storage, use) { this.st = storage; this.sql = storage.sql; this.use = use || { read: 0, written: 0 }; }
  q(query, ...args) {
    const c = this.sql.exec(query, ...args), rows = c.toArray();
    this.use.read += c.rowsRead || 0; this.use.written += c.rowsWritten || 0;
    return rows;
  }
  create() { for (const s of V2_SCHEMA) this.q(s); }
  drop() { for (const t of V2_ALL_TABLES) this.q("DROP TABLE IF EXISTS " + t); }
  exists() { try { this.q("SELECT seq FROM pilots LIMIT 1"); return true; } catch (e) { return false; } }
  tx(fn) { return typeof this.st.transactionSync === "function" ? this.st.transactionSync(fn) : fn(); }
  pilot(id) { return this.q("SELECT * FROM pilots WHERE id = ?", id)[0] || null; }
  pilotsT12(lo, hi) { return this.q("SELECT * FROM pilots WHERE t12 >= ? AND t12 < ?", lo, hi); }
  pilotsByT12(t12) { return this.q("SELECT * FROM pilots WHERE t12 = ?", t12); }
  board(d, limit, smin) {
    const c = V2_COL[d];
    return smin == null
      ? this.q(`SELECT * FROM pilots WHERE ${c}_s IS NOT NULL AND rs = 0 ORDER BY ${c}_s DESC, ${c}_t, seq LIMIT ?`, limit)
      : this.q(`SELECT * FROM pilots WHERE ${c}_s IS NOT NULL AND rs = 0 AND ${c}_s >= ? ORDER BY ${c}_s DESC, ${c}_t, seq LIMIT ?`, smin, limit);
  }
  boardKeys(d, limit, smin) {
    const c = V2_COL[d];
    return smin == null
      ? this.q(`SELECT ${c}_s AS s, ${c}_t AS t, seq, id, cc FROM pilots WHERE ${c}_s IS NOT NULL AND rs = 0 ORDER BY ${c}_s DESC, ${c}_t, seq LIMIT ?`, limit)
      : this.q(`SELECT ${c}_s AS s, ${c}_t AS t, seq, id, cc FROM pilots WHERE ${c}_s IS NOT NULL AND rs = 0 AND ${c}_s >= ? ORDER BY ${c}_s DESC, ${c}_t, seq LIMIT ?`, smin, limit);
  }
  pilotPage(afterSeq, limit) { return this.q("SELECT * FROM pilots WHERE seq > ? ORDER BY seq LIMIT ?", afterSeq, limit); }
  insertPilot(row) {
    return this.q(`INSERT INTO pilots (${V2_PILOT_COLS.join(", ")}) VALUES (${V2_PILOT_COLS.map(() => "?").join(", ")}) RETURNING seq`,
      ...V2_PILOT_COLS.map((k) => (row[k] === undefined ? null : row[k])))[0].seq;
  }
  replacePilot(row) {
    this.q(`INSERT OR REPLACE INTO pilots (${V2_PILOT_COLS.join(", ")}) VALUES (${V2_PILOT_COLS.map(() => "?").join(", ")})`,
      ...V2_PILOT_COLS.map((k) => (row[k] === undefined ? null : row[k])));
  }
  updatePilot(seq, ch) {
    const ks = Object.keys(ch || {}).filter((k) => k !== "seq" && V2_PILOT_COLS.includes(k));
    if (ks.length) this.q(`UPDATE pilots SET ${ks.map((k) => k + " = ?").join(", ")} WHERE seq = ?`, ...ks.map((k) => (ch[k] === undefined ? null : ch[k])), seq);
  }
  deletePilot(seq) { this.q("DELETE FROM pilots WHERE seq = ?", seq); }
  kvGet(t, id) { const r = this.q(`SELECT v FROM ${t} WHERE id = ?`, id)[0]; return r ? r.v : null; }
  kvPut(t, id, v) { this.q(`INSERT OR REPLACE INTO ${t} (id, v) VALUES (?, ?)`, id, v); }
  kvDel(t, id) { this.q(`DELETE FROM ${t} WHERE id = ?`, id); }
  rowsById(t, lo, hi, limit) {
    const w = [], a = [];
    if (lo != null) { w.push("id > ?"); a.push(lo); }
    if (hi != null) { w.push("id <= ?"); a.push(hi); }
    return this.q(`SELECT ${t === "pilots" ? "*" : "id, v"} FROM ${t}${w.length ? " WHERE " + w.join(" AND ") : ""} ORDER BY id LIMIT ?`, ...a, limit);
  }
  /* ---- FOUNDING PILOT (see FND_SCHEMA): a missing table reads as empty ---- */
  fndEnsure() { this.q(FND_SCHEMA); }
  fndMany(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      try { for (const r of this.q(`SELECT id, v FROM fnd WHERE id IN (${part.map(() => "?").join(", ")})`, ...part)) out.set(r.id, v2dec(r.v)); } catch (e) { /* no table yet */ }
    }
    return out;
  }
  lastSeq() { const r = this.q("SELECT seq FROM pilots ORDER BY seq DESC LIMIT 1")[0]; return r ? r.seq : 0; }
  /* ---- COMBINED WORLD GRID: the Season 0 table (see WG0_SCHEMA) ---- */
  wgCreate() { for (const x of WG0_SCHEMA) this.q(x); }
  wgClear() { this.q("DELETE FROM wg0"); }
  wgPut(r) { this.q("INSERT OR REPLACE INTO wg0 (id, " + WG0_COLS.join(", ") + ") VALUES (?, " + WG0_COLS.map(() => "?").join(", ") + ")", r.id, ...WG0_COLS.map((k) => (r[k] === undefined ? null : r[k]))); }
  wgGet(id) { try { return this.q("SELECT * FROM wg0 WHERE id = ?", id)[0] || null; } catch (e) { return null; } }
  wgDel(id) { try { this.q("DELETE FROM wg0 WHERE id = ?", id); } catch (e) { /* no table */ } }
  /* Board d with each pilot's Season 0 row joined (Season 1 index order). */
  boardW(d, limit, smin) {
    const c = V2_COL[d], sel = `SELECT p.*, ${WG0_SEL} FROM pilots p LEFT JOIN wg0 w ON w.id = p.id WHERE p.${c}_s IS NOT NULL AND p.rs = 0`;
    return smin == null ? this.q(sel + ` ORDER BY p.${c}_s DESC, p.${c}_t, p.seq LIMIT ?`, limit) : this.q(sel + ` AND p.${c}_s >= ? ORDER BY p.${c}_s DESC, p.${c}_t, p.seq LIMIT ?`, smin, limit);
  }
  /* Season 0 bests of current public pilots, best first (Season 0 index order), with the pilot row. */
  wgBoard(d, limit, smin) {
    const c = V2_COL[d], sel = `SELECT p.*, ${WG0_SEL} FROM wg0 w JOIN pilots p ON p.id = w.id WHERE w.${c}_s IS NOT NULL AND p.rs = 0`;
    return smin == null ? this.q(sel + ` ORDER BY w.${c}_s DESC, w.${c}_t LIMIT ?`, limit) : this.q(sel + ` AND w.${c}_s >= ? ORDER BY w.${c}_s DESC, w.${c}_t LIMIT ?`, smin, limit);
  }
  wgTies(d, sc, t) {
    const c = V2_COL[d];
    return this.q(`SELECT p.*, ${WG0_SEL} FROM wg0 w JOIN pilots p ON p.id = w.id WHERE w.${c}_s = ? AND w.${c}_t = ? AND p.rs = 0 LIMIT ?`, sc, t, V2_TIE_MAX);
  }
  wgKeys(d, limit, smin) {
    const c = V2_COL[d], sel = `SELECT w.${c}_s AS s, w.${c}_t AS t, p.seq AS seq, p.id AS id, p.cc AS cc FROM wg0 w JOIN pilots p ON p.id = w.id WHERE w.${c}_s IS NOT NULL AND p.rs = 0`;
    return smin == null ? this.q(sel + ` ORDER BY w.${c}_s DESC, w.${c}_t LIMIT ?`, limit) : this.q(sel + ` AND w.${c}_s >= ? ORDER BY w.${c}_s DESC, w.${c}_t LIMIT ?`, smin, limit);
  }
  pilotPageW(afterSeq, limit) { return this.q(`SELECT p.*, ${WG0_SEL} FROM pilots p LEFT JOIN wg0 w ON w.id = p.id WHERE p.seq > ? ORDER BY p.seq LIMIT ?`, afterSeq, limit); }
  /* A privacy deletion while a move is half-copied: the copy loses the pilot too. */
  forget(id, removePurchases) {
    try { this.q("DELETE FROM pilots WHERE id = ?", id); this.q("DELETE FROM cool WHERE id = ?", id); if (removePurchases) this.q("DELETE FROM ents WHERE id = ?", id); } catch (e) { /* no copy yet */ }
  }
}

/* ---- the same tables in memory: the dry run builds the new layout here ---- */
class V2MemDb {
  constructor() { this.use = { read: 0, written: 0 }; this.drop(); }
  drop() { this.rows = new Map(); this.ids = new Map(); this.tabs = { ents: new Map(), seen: new Map(), cool: new Map(), fnd: new Map(), v2meta: new Map() }; this.max = 0; this.sorted = null; }
  fndEnsure() {}
  fndMany(ids) { const out = new Map(); for (const id of ids) { const v = this.tabs.fnd.get(id); if (v !== undefined) out.set(id, v2dec(v)); } return out; }
  lastSeq() { let m = 0; for (const k of this.rows.keys()) if (k > m) m = k; return m; }
  create() {}
  exists() { return true; }
  tx(fn) { return fn(); }
  pilot(id) { const r = this.ids.get(id); return r ? { ...r } : null; }
  pilotsT12(lo, hi) { const out = []; for (const r of this.rows.values()) if (r.t12 >= lo && r.t12 < hi) out.push({ ...r }); return out; }
  pilotsByT12(t12) { return this.pilotsT12(t12, t12 + "\u0000"); }
  boardAll(d, smin) {
    const c = V2_COL[d], out = [];
    for (const r of this.rows.values()) { const s = r[c + "_s"]; if (s != null && !r.rs && (smin == null || s >= smin)) out.push(r); }
    return out.sort((a, b) => b[c + "_s"] - a[c + "_s"] || a[c + "_t"] - b[c + "_t"] || a.seq - b.seq);
  }
  board(d, limit, smin) { return this.boardAll(d, smin).slice(0, limit).map((r) => ({ ...r })); }
  boardKeys(d, limit, smin) { const c = V2_COL[d]; return this.boardAll(d, smin).slice(0, limit).map((r) => ({ s: r[c + "_s"], t: r[c + "_t"], seq: r.seq, id: r.id, cc: r.cc })); }
  pilotPage(afterSeq, limit) {
    const all = this.sorted || (this.sorted = [...this.rows.values()].sort((a, b) => a.seq - b.seq));
    let lo = 0, hi = all.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (all[m].seq > afterSeq) hi = m; else lo = m + 1; }
    return all.slice(lo, lo + limit).map((r) => ({ ...r }));
  }
  insertPilot(row) {
    const seq = row.seq != null ? row.seq : this.max + 1;
    if (this.rows.has(seq) || this.ids.has(row.id)) throw new Error("UNIQUE constraint failed");
    const r = {}; for (const k of V2_PILOT_COLS) r[k] = row[k] === undefined ? null : row[k];
    r.seq = seq; this.rows.set(seq, r); this.ids.set(r.id, r); this.max = Math.max(this.max, seq); this.sorted = null;
    return seq;
  }
  replacePilot(row) { const a = this.rows.get(row.seq); if (a) this.deletePilot(a.seq); const b = this.ids.get(row.id); if (b) this.deletePilot(b.seq); this.insertPilot(row); }
  updatePilot(seq, ch) { const r = this.rows.get(seq); if (r && ch) for (const k of Object.keys(ch)) if (k !== "seq" && V2_PILOT_COLS.includes(k)) r[k] = ch[k] === undefined ? null : ch[k]; }
  deletePilot(seq) { const r = this.rows.get(seq); if (!r) return; this.rows.delete(seq); this.ids.delete(r.id); this.sorted = null; }
  kvGet(t, id) { const v = this.tabs[t].get(id); return v === undefined ? null : v; }
  kvPut(t, id, v) { this.tabs[t].set(id, v); }
  kvDel(t, id) { this.tabs[t].delete(id); }
  rowsById(t, lo, hi, limit) {
    const src = t === "pilots" ? [...this.ids.values()] : [...this.tabs[t].entries()].map(([id, v]) => ({ id, v }));
    return src.filter((r) => (lo == null || r.id > lo) && (hi == null || r.id <= hi)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit).map((r) => ({ ...r }));
  }
  forget() {}
}

/* ---- the new layout: every leaderboard answer, from rows (see the note above) ---- */
class PilotLayoutV2 {
  constructor(o, db) { this.o = o; this.db = db; this.sum = null; this.sumText = ""; this.boards = Object.create(null); this.floor = Object.create(null); this.wgId = null; this.wgMemo = new Map(); }

  /* Cold start: the summary row only. The tables are created when missing; the
     summary is rebuilt from the rows only when it is missing or the difficulty
     weights changed. */
  init() {
    let raw = null;
    try { raw = this.db.kvGet("v2meta", "sum"); } catch (e) { this.db.create(); }
    try { this.db.fndEnsure(); } catch (e) { /* FOUNDING PILOT: a missing table reads as empty */ }
    const sum = raw ? v2dec(raw) : null;
    if (sum && sum.weights === JSON.stringify(DIFF_WEIGHT) && sum.bc && (sum.grid || "s") === this.gridTag()) { this.sum = sum; this.sumText = raw; return; }
    this.sum = this.buildSum();
    if (sum && sum.fo) this.sum.fo = sum.fo;   // FOUNDING PILOT: the counter survives a rebuild
    this.foLost = !(sum && sum.fo);            // rebuilt without it: loadV2 reads it back from "founding"
    this.saveSum(this.sum);
  }
  saveSum(sum, force) { const t = v2enc(sum); if (force || t !== this.sumText) this.db.kvPut("v2meta", "sum", t); this.sumText = t; }

  scanPilots(fn) {
    const comb = this.comb;   // COMBINED WORLD GRID: each row comes with its Season 0 row (one joined read)
    let after = 0;
    for (;;) {
      const rows = comb ? this.db.pilotPageW(after, V2_SCAN_PAGE) : this.db.pilotPage(after, V2_SCAN_PAGE);
      for (const r of rows) fn(comb ? wgSplit(r) : r);
      if (rows.length < V2_SCAN_PAGE) return;
      after = rows[rows.length - 1].seq;
    }
  }
  dnameOf(rec, bans) {
    const n = presetOrOwn(cleanName(rec.name), rec.playerId);
    return ownGet(bans, normaliseForBan(rec.name)) || ownGet(bans, normaliseForBan(n)) ? "PILOT" : n;
  }
  /* A pilot record as a row (seq, tag and ls are set by the caller). */
  rowFor(rec, id, pid, bans = this.o.nameBans, restricted = this.o.restricted) {
    const n = presetOrOwn(cleanName(rec.name), rec.playerId);
    const row = { seq: null, id, pid, t12: tagFromPid(pid, 12), tag: "", dname: this.dnameOf(rec, bans), nb1: normaliseForBan(rec.name), nb2: normaliseForBan(n),
      cc: ISO2.test(String(rec.country || "")) ? rec.country : "XX", rs: ownGet(restricted, pid) ? 1 : 0, ls: null,
      e_s: null, e_t: null, m_s: null, m_t: null, h_s: null, h_t: null, rec: v2enc(rec) };
    for (const d of V2_DIFFS) {
      const b = ownGet(rec.bests, d);
      if (!b) continue;
      const c = V2_COL[d], t = b.updatedAt || rec.updatedAt || 0;
      row[c + "_s"] = Number.isFinite(b.score) ? b.score : 0;
      row[c + "_t"] = Number.isFinite(t) ? t : 0;
    }
    return row;
  }
  /* The pilot's entry on the ALL board / in the country figures (public pilots with a best). */
  entryOf(row) {
    if (!row || row.rs) return null;
    const rec = this.recOf(row), b = weightedBestOf(rec);
    if (!b) return null;
    return { id: row.id, leaderId: rec.playerId, cc: row.cc, s: b.weighted, t: b.updatedAt || rec.updatedAt || 0, seq: row.seq, dname: row.dname, tag: row.tag };
  }

  /* ---- country figures (same as recomputeCountries, kept up to date) ---- */
  buildSum() {
    const sum = { v: 1, weights: JSON.stringify(DIFF_WEIGHT), grid: this.gridTag(), n: 0, list: {}, lead: {}, bc: {}, bcc: {} };
    if (this.sum && this.sum.fo) sum.fo = Object.assign({}, this.sum.fo);   // FOUNDING PILOT: not derived from the pilots; kept
    this.scanPilots((row) => { sum.n++; this.boardCount(sum, row, 1); const e = this.entryOf(row); if (e) this.ctryAdd(sum, e); });
    return sum;
  }
  /* Public pilots per board, and per board and country: the "of N" in an upload's reply. */
  boardCount(sum, row, sign) {
    if (!row || row.rs) return;
    const bc = sum.bc || (sum.bc = {}), bcc = sum.bcc || (sum.bcc = {});
    for (const d of V2_DIFFS) {
      if (!this.keyOf(row, d)) continue;   // COMBINED WORLD GRID: a Season 0 best counts too once applied
      bc[d] = (bc[d] || 0) + sign;
      const m = bcc[d] || (bcc[d] = {});
      m[row.cc] = (m[row.cc] || 0) + sign;
      if (m[row.cc] <= 0) delete m[row.cc];
    }
  }
  ctryAdd(sum, e) {
    const c = sum.list[e.cc] || (sum.list[e.cc] = { country: e.cc, totalScore: 0, playerCount: 0, topScore: 0, topName: "", leaderId: "" });
    c.totalScore += e.s; c.playerCount += 1;
    const L = sum.lead[e.cc];
    if (!L || v2KeyLess(e, L)) this.setLead(sum, e);
  }
  setLead(sum, e) {
    sum.lead[e.cc] = { id: e.id, s: e.s, t: e.t, seq: e.seq, tag: e.tag };
    const c = sum.list[e.cc]; c.topScore = e.s; c.topName = e.dname; c.leaderId = e.leaderId;
  }
  /* One pilot's entry changed from `before` to `after` (either may be null). */
  applyCountry(sum, before, after) {
    const need = new Set();
    if (before) {
      const c = sum.list[before.cc];
      if (c) { c.totalScore -= before.s; c.playerCount -= 1; }
      const L = sum.lead[before.cc];
      if (L && L.id === before.id) { delete sum.lead[before.cc]; need.add(before.cc); }
    }
    if (after) {
      const cc = after.cc;
      const c = sum.list[cc] || (sum.list[cc] = { country: cc, totalScore: 0, playerCount: 0, topScore: 0, topName: "", leaderId: "" });
      c.totalScore += after.s; c.playerCount += 1;
      const L = sum.lead[cc];
      if (L ? v2KeyLess(after, L) : (c.playerCount === 1 || (before && before.cc === cc && !v2KeyLess(before, after)))) { this.setLead(sum, after); need.delete(cc); }
    }
    for (const cc of Object.keys(sum.list)) if (sum.list[cc].playerCount <= 0) { delete sum.list[cc]; delete sum.lead[cc]; need.delete(cc); }
    for (const cc of need) this.relead(sum, cc);
  }
  /* Rare (a leader got worse, left, was restricted or deleted): every row is read once. */
  relead(sum, cc) {
    delete sum.lead[cc];
    let best = null;
    this.scanPilots((row) => { if (row.cc !== cc || row.rs) return; const e = this.entryOf(row); if (e && (!best || v2KeyLess(e, best))) best = e; });
    if (best) this.setLead(sum, best);
  }
  leadTags(sum, ids) {
    const set = new Set(ids);
    for (const cc of Object.keys(sum.lead)) { const L = sum.lead[cc]; if (set.has(L.id)) { const r = this.db.pilot(L.id); if (r) L.tag = r.tag; } }
  }
  refreshLeads(sum) {
    for (const cc of Object.keys(sum.lead)) { const L = sum.lead[cc], r = this.db.pilot(L.id); if (r) { L.tag = r.tag; sum.list[cc].topName = r.dname; } }
  }
  countryList() {
    const out = [];
    for (const cc of Object.keys(this.sum.list)) {
      const { leaderId, leaderPid, topTag, ...c } = this.sum.list[cc], L = this.sum.lead[cc];
      out.push({ c: { ...c, topTag: leaderId ? (L ? L.tag : "") : "" }, L: L || { s: 0, t: 0, seq: 0 } });
    }
    out.sort((a, b) => b.c.totalScore - a.c.totalScore || (v2KeyLess(a.L, b.L) ? -1 : v2KeyLess(b.L, a.L) ? 1 : 0));
    return out.map((x) => x.c);
  }

  /* ---- public tags (D-33): 7 characters, 12 where two pilots share a shown name and a short tag ---- */
  retag(dname, tag7) {
    const rows = this.db.pilotsT12(tag7, tag7 + "~").filter((r) => r.dname === dname);
    const len = rows.length > 1 ? 12 : 7, changed = [];
    for (const r of rows) { const t = r.t12.slice(0, len); if (r.tag !== t) { this.db.updatePilot(r.seq, { tag: t }); changed.push(r.id); } }
    return changed;
  }
  retagAll() {
    const groups = new Map();
    this.scanPilots((r) => { const k = r.dname + "#" + r.t12.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ seq: r.seq, t12: r.t12, tag: r.tag }); });
    this.db.tx(() => { for (const list of groups.values()) for (const r of list) { const t = r.t12.slice(0, list.length > 1 ? 12 : 7); if (r.tag !== t) this.db.updatePilot(r.seq, { tag: t }); } });
  }

  /* ---- boards ---- */
  board(d) { return this.boards[d] || (this.boards[d] = this.markFounders(d === "all" ? this.computeAll() : this.rowsD(d, BOARD_MAX, null).map((r) => this.itemD(r, d)))); }
  /* FOUNDING PILOT: the badge on a board row (fp). Read only once a number was ever given:
     one lookup of the board's ids, cached with the board. */
  markFounders(items) {
    const fo = this.sum && this.sum.fo;
    if (!fo || !fo.given || !items.length) return items;
    const f = this.db.fndMany(items.map((x) => x.id));
    for (const x of items) { const v = f.get(x.id); if (v && !v.off) x.fp = 1; }
    return items;
  }
  itemD(row, d) {
    const rec = this.recOf(row), b = ownGet(rec.bests, d), k = this.keyOf(row, d);
    return { id: row.id, seq: row.seq, pid: row.pid, tag: row.tag, name: row.dname, country: rec.country, cc: row.cc, score: b.score, points: b.score, level: b.level, difficulty: d, s: k.s, t: k.t };
  }
  itemAll(row) {
    const rec = this.recOf(row), b = weightedBestOf(rec);
    if (!b) return null;
    return { id: row.id, seq: row.seq, pid: row.pid, tag: row.tag, name: row.dname, country: rec.country, score: b.weighted, points: b.score, level: b.level, difficulty: b.difficulty, s: b.weighted, t: b.updatedAt || rec.updatedAt || 0 };
  }
  /* ALL: each pilot's best WEIGHTED score (DIFF_WEIGHT). Candidates: the top rows of
     each difficulty board, then every row that could reach the 100th weighted score
     (score * weight >= that score - 0.5, rounding included), so ties are exact. */
  computeAll() {
    const cand = new Map();
    const add = (rows) => { for (const r of rows) if (!cand.has(r.id)) { const it = this.itemAll(r); if (it) cand.set(r.id, it); } };
    const sorted = () => [...cand.values()].sort((a, b) => (v2KeyLess(a, b) ? -1 : v2KeyLess(b, a) ? 1 : 0));
    for (const d of V2_DIFFS) add(this.rowsD(d, BOARD_MAX, null));
    let items = sorted();
    if (items.length >= BOARD_MAX) {
      const v = items[BOARD_MAX - 1].s;
      for (const d of V2_DIFFS) add(this.rowsD(d, V2_TIE_MAX, (v - 0.5) / (DIFF_WEIGHT[d] || 1) - 1e-6));
      items = sorted();
    }
    return items.slice(0, BOARD_MAX);
  }
  /* After a write to one pilot: drop only the cached boards it can change. */
  touch(id, row) {
    for (const d of V2_DIFFS) {
      const B = this.boards[d]; if (!B) continue;
      const k = row && !row.rs ? this.keyOf(row, d) : null;
      if (B.some((x) => x.id === id) || (k && (B.length < BOARD_MAX || v2KeyLess(k, B[B.length - 1])))) delete this.boards[d];
    }
    const A = this.boards.all;
    if (A) { const it = row && !row.rs ? this.itemAll(row) : null; if (A.some((x) => x.id === id) || (it && (A.length < BOARD_MAX || v2KeyLess(it, A[A.length - 1])))) delete this.boards.all; }
  }
  dropCaches() { this.boards = Object.create(null); this.floor = Object.create(null); }
  /* LEADERBOARD REFRESH on the new layout: the pilot's standing on board d --
     world rank, rank in its country, the pilot just above -- from the cached top
     100, else counted on the board index up to RANK_EXACT_MAX (null beyond: the
     game then shows no rank line, as for a restricted pilot). Totals from the
     summary row. Same answer as the old layout's standing() within that range. */
  standing(d, row) {
    if (!row || row.rs) return null;
    const mk = this.keyOf(row, d);
    if (!mk) return null;
    const total = (this.sum.bc || {})[d] || 0, countryTotal = ((this.sum.bcc || {})[d] || {})[row.cc] || 0;
    const B = this.board(d), i = B.findIndex((x) => x.id === row.id);
    let rank, countryRank = 1, up = null;
    if (i >= 0) {
      rank = i + 1;
      for (let k = 0; k < i; k++) if (B[k].cc === row.cc) countryRank++;
      if (i > 0) up = B[i - 1];
    } else {
      if (B.length < BOARD_MAX) return null;
      const me = { s: mk.s, t: mk.t, seq: row.seq };
      if (this.comb) {   // COMBINED WORLD GRID: counted on both indexes (Season 1 rows, Season 0 rows)
        const far = this.farComb(d, row, me);
        if (!far) return null;
        ({ rank, countryRank, up } = far);
      } else {
        let f = this.floor[d];
        if (!f || Date.now() - f.at > RANK_FLOOR_TTL_MS) {
        const keys = this.db.boardKeys(d, RANK_EXACT_MAX, null);
        f = this.floor[d] = { at: Date.now(), key: keys.length >= RANK_EXACT_MAX ? keys[keys.length - 1] : null };
      }
      if (f.key && v2KeyLess(f.key, me)) return null;
      let n = 0, last = null;
      for (const k of this.db.boardKeys(d, RANK_EXACT_MAX, mk.s)) { if (!v2KeyLess(k, me)) break; n++; last = k; if (k.cc === row.cc) countryRank++; }
      if (n >= RANK_EXACT_MAX) return null;
      rank = n + 1;
      const r = last ? this.db.pilot(last.id) : null;
      if (r) up = this.itemD(r, d);
      }
    }
    const above = up ? { rank: rank - 1, name: up.name, tag: up.tag, country: up.cc, score: up.score } : null;
    return { rank, total, country: row.cc, countryRank, countryTotal, score: mk.s, above };
  }
  /* COMBINED WORLD GRID: the rank of a pilot below the top 100 = the pilots whose
     Season 1 key OR Season 0 key beats theirs (each pilot once), counted on the two
     indexes up to RANK_EXACT_MAX (no rank beyond, as on Season 1 only). */
  farComb(d, row, me) {
    const beatsMe = (k) => k.s > me.s || (k.s === me.s && k.t < me.t);   // Season 0 index order (score, time)
    let f = this.floor["c:" + d];
    if (!f || Date.now() - f.at > RANK_FLOOR_TTL_MS) {
      const a = this.db.boardKeys(d, RANK_EXACT_MAX, null), b = this.db.wgKeys(d, RANK_EXACT_MAX, null);
      f = this.floor["c:" + d] = { at: Date.now(), a: a.length >= RANK_EXACT_MAX ? a[a.length - 1] : null, b: b.length >= RANK_EXACT_MAX ? b[b.length - 1] : null };
    }
    if ((f.a && v2KeyLess(f.a, me)) || (f.b && beatsMe(f.b))) return null;
    const a = this.db.boardKeys(d, RANK_EXACT_MAX, me.s), b = this.db.wgKeys(d, RANK_EXACT_MAX, me.s);
    if ((a.length >= RANK_EXACT_MAX && v2KeyLess(a[a.length - 1], me)) || (b.length >= RANK_EXACT_MAX && !(me.s > b[b.length - 1].s || (me.s === b[b.length - 1].s && me.t < b[b.length - 1].t)))) return null;
    const better = new Map();
    for (const k of a.concat(b)) {
      if (k.id === row.id || !v2KeyLess(k, me)) continue;
      const o = better.get(k.id);
      if (!o || v2KeyLess(k, o)) better.set(k.id, k);
    }
    if (better.size >= RANK_EXACT_MAX) return null;
    let countryRank = 1, last = null;
    for (const k of better.values()) { if (k.cc === row.cc) countryRank++; if (!last || v2KeyLess(last, k)) last = k; }
    const r = last ? this.db.pilot(last.id) : null;
    return { rank: better.size + 1, countryRank, up: r ? this.itemD(r, d) : null };
  }
  /* ---- COMBINED WORLD GRID (see WG0_SCHEMA): on only when the owner applied it
     AND the Season 0 table was built for that APPLY. Off, every method below
     answers exactly as Season 1 only. ---- */
  get comb() { const g = this.o.worldGrid; return !!(g && g.combined && this.wgId && this.wgId === g.dryRunId); }
  gridTag() { return this.comb ? "c:" + this.wgId : "s"; }
  wgLoad() { try { const t = this.db.kvGet("v2meta", "wg"); return t ? v2dec(t) || null : null; } catch (e) { return null; } }
  /* After a restart: 1 row (only when the switch is on). After a restore, the
     table is rebuilt from the restored archive for the restored switch. */
  async wgEnsure() {
    const g = this.o.worldGrid;
    if (!(g && g.combined && g.dryRunId)) return;
    const m = this.wgLoad();
    if (m && m.id === g.dryRunId) { this.wgId = m.id; return; }
    this.wgBuild((await this.o.readSeasonArchive()).players, g.dryRunId);
  }
  /* The pilot's Season 0 row (null: none): joined rows carry it; else one read, remembered. */
  wOf(row) {
    if (!row || !this.comb) return null;
    if (row._w !== undefined) return row._w;
    if (this.wgMemo.has(row.id)) return this.wgMemo.get(row.id);
    if (this.wgMemo.size > V2_PID_CACHE_MAX) this.wgMemo = new Map();
    const w = this.db.wgGet(row.id), v = w ? { ...w } : null;
    if (v) delete v.id;
    this.wgMemo.set(row.id, v);
    return v;
  }
  /* Board order key on difficulty d: the higher of the Season 1 and Season 0 bests (never their sum). */
  keyOf(row, d) {
    const c = V2_COL[d], s = row[c + "_s"], w = this.wOf(row), ws = w ? w[c + "_s"] : null;
    if (ws != null && (s == null || ws > s)) return { s: ws, t: w[c + "_t"], seq: row.seq, s0: true };
    return s == null ? null : { s, t: row[c + "_t"], seq: row.seq, s0: false };
  }
  /* The pilot's record as the grid shows it: per difficulty the higher best. */
  recOf(row) {
    const rec = v2dec(row.rec), w = this.wOf(row);
    if (!w) return rec;
    const bests = NP(rec.bests);
    for (const d of V2_DIFFS) {
      const c = V2_COL[d], ws = w[c + "_s"];
      if (ws == null) continue;
      const b = ownGet(bests, d);
      if (!b || ws > (Number.isFinite(b.score) ? b.score : 0)) bests[d] = { score: ws, level: w[c + "_l"] == null ? undefined : w[c + "_l"], updatedAt: w[c + "_t"] || 0, season: 0 };
    }
    return { ...rec, bests };
  }
  /* Board d, best first, as rows. Combined: the top rows of the Season 1 index and
     of the Season 0 index (+ rows tied with its last one), each pilot once at its
     higher key -- exact, since any pilot in the combined top N is in the top N of
     the index its key comes from. */
  rowsD(d, limit, smin) {
    if (!this.comb) return this.db.board(d, limit, smin);
    const got = new Map(), c = V2_COL[d];
    const take = (rows) => { for (const r of rows) { wgSplit(r); if (!got.has(r.id)) { got.set(r.id, r); if (this.wgMemo.size < V2_PID_CACHE_MAX) this.wgMemo.set(r.id, r._w); } } };
    take(this.db.boardW(d, limit, smin));
    const arch = this.db.wgBoard(d, limit, smin);
    take(arch);
    if (arch.length >= limit) { const L = arch[arch.length - 1]._w; take(this.db.wgTies(d, L[c + "_s"], L[c + "_t"])); }
    const keyed = [];
    for (const r of got.values()) { const k = this.keyOf(r, d); if (k) keyed.push({ r, k }); }
    keyed.sort((x, y) => (v2KeyLess(x.k, y.k) ? -1 : v2KeyLess(y.k, x.k) ? 1 : 0));
    return keyed.slice(0, limit).map((x) => x.r);
  }
  /* APPLY: the Season 0 table from the archive, with the same rules as
     mergeWorldGrid (invalid ids and scores left out, a pilot archived twice with
     different data left out). Pilots who no longer exist are left out by the join.
     Skipped when an earlier APPLY built it from the same archive. */
  wgBuild(archive, id) {
    const m = this.wgLoad();
    if (m && m.fp === id.slice(-8) && m.id) {
      this.db.kvPut("v2meta", "wg", v2enc({ ...m, id }));
      this.wgId = id; this.wgMemo = new Map();
      return 0;
    }
    const groups = new Map();
    for (const a of Array.isArray(archive) ? archive : []) {
      if (!a || typeof a !== "object" || !validPlayerId(a.playerId)) continue;
      const g = groups.get(a.playerId); if (g) g.push(a); else groups.set(a.playerId, [a]);
    }
    const rows = [];
    for (const [pid, list] of groups) {
      if (!list.every((x) => JSON.stringify(x) === JSON.stringify(list[0]))) continue;
      const a = list[0], r = { id: pid };
      let any = false;
      for (const d of Object.keys(a.bests || {})) {
        const b = a.bests[d];
        if (!wgValidBest(d, b)) continue;
        const c = V2_COL[d];
        r[c + "_s"] = b.score; r[c + "_t"] = Number.isFinite(b.updatedAt) ? b.updatedAt : 0; r[c + "_l"] = Number.isFinite(b.level) ? b.level : null; any = true;
      }
      if (any) rows.push(r);
    }
    this.db.tx(() => {
      this.db.wgCreate(); this.db.wgClear();
      for (const r of rows) this.db.wgPut(r);
      this.db.kvPut("v2meta", "wg", v2enc({ id, fp: id.slice(-8), at: Date.now(), n: rows.length }));
    });
    this.wgId = id; this.wgMemo = new Map();
    return rows.length;
  }
  /* A privacy deletion: the pilot's Season 0 row goes with the archive entry. */
  wgForget(id) { if (this.wgId || this.wgLoad()) this.db.wgDel(id); this.wgMemo.delete(id); }
  /* APPLY / REVERT: the summary row (country totals, board counts) for the grid now live. */
  regrid() {
    this.wgMemo = new Map();
    const sum = this.buildSum();
    this.saveSum(sum, true); this.sum = sum; this.dropCaches();
    return sum;
  }
  rankOf(d, row) { const st = this.standing(d, row); return st ? st.rank : null; }

  /* ---- writing one pilot (synchronous: runs inside one transaction) ---- */
  putPilot(sum, row, rec, id, pid, ls) {
    const next = this.rowFor(rec, id, pid);
    next.ls = ls === undefined ? (row ? row.ls : null) : ls;
    const before = row ? this.entryOf(row) : null;
    let changedTags = [];
    if (row) {
      next.seq = row.seq; next.tag = row.tag;
      const ch = v2Changed(row, next);
      if (ch) this.db.updatePilot(row.seq, ch);
    } else {
      next.tag = next.t12.slice(0, 7);
      next.seq = this.db.insertPilot(next);
      sum.n = (sum.n || 0) + 1;
    }
    if (!row || row.dname !== next.dname) {
      if (row) changedTags = changedTags.concat(this.retag(row.dname, row.t12.slice(0, 7)));
      changedTags = changedTags.concat(this.retag(next.dname, next.t12.slice(0, 7)));
    }
    const cur = changedTags.length ? this.db.pilot(id) : next;
    this.boardCount(sum, row, -1); this.boardCount(sum, cur, 1);
    this.applyCountry(sum, before, this.entryOf(cur));
    if (changedTags.length) this.leadTags(sum, changedTags);
    return { cur, changedTags };
  }
  dropPilot(sum, row) {
    const before = this.entryOf(row);
    this.db.deletePilot(row.seq);
    sum.n = Math.max(0, (sum.n || 0) - 1);
    const ch = this.retag(row.dname, row.t12.slice(0, 7));
    this.boardCount(sum, row, -1);
    this.applyCountry(sum, before, null);
    if (ch.length) this.leadTags(sum, ch);
    return ch;
  }
  commit(sum, id, res) {
    this.sum = sum;
    if (res && res.changedTags && res.changedTags.length) this.dropCaches(); else this.touch(id, res ? res.cur : null);
  }
  pilotByPid(pid) {
    if (!PID_RE.test(String(pid || ""))) return null;
    return this.db.pilotsByT12(tagFromPid(pid, 12)).find((r) => r.pid === pid) || null;
  }
  async findIdByPid(pid) {
    const row = this.pilotByPid(pid);
    if (row) return row.id;
    if (!PID_RE.test(String(pid || ""))) return null;
    for (const t of ["ents", "fnd"]) {   // FOUNDING PILOT: a grant without a pilot row (score removed) is found too
      let after = null;
      for (;;) {
        let rows = [];
        try { rows = this.db.rowsById(t, after, null, V2_SCAN_PAGE); } catch (e) { break; }
        for (const r of rows) if ((await this.o.pid(r.id)) === pid) return r.id;
        if (rows.length < V2_SCAN_PAGE) break;
        after = rows[rows.length - 1].id;
      }
    }
    return null;
  }
  ents(id) { const v = this.db.kvGet("ents", id); return v == null ? undefined : v2dec(v); }

  /* ---- FOUNDING PILOT (see FND_SCHEMA) ---- */
  fndActive(id) {   // the pilot's grant, unless the owner took it back; no read before a number was ever given
    const fo = this.sum && this.sum.fo;
    if (!fo || !fo.given || !validPlayerId(id)) return null;
    const v = this.db.fndMany([id]).get(id);
    return v && !v.off && Number.isFinite(v.n) ? v : null;
  }
  foundingLeft() { const fo = this.sum && this.sum.fo; return fo && fo.on ? Math.max(0, FOUNDING_CAP - fo.given) : null; }
  foundingInfo() { const fo = (this.sum && this.sum.fo) || foOf({}); return { on: !!fo.on, given: fo.given, cap: FOUNDING_CAP, left: Math.max(0, FOUNDING_CAP - fo.given), done: !!fo.done }; }
  /* The counter from the stored "founding" value and the grants (after a restore, or a rebuilt summary). */
  foRebuild(cfg) {
    const fo = foOf(cfg);
    if (!fo) return undefined;
    let after = null;
    for (;;) {
      let rows = [];
      try { rows = this.db.rowsById("fnd", after, null, V2_SCAN_PAGE); } catch (e) { break; }
      for (const r of rows) { const v = v2dec(r.v); if (v && v.n > fo.given) fo.given = v.n; }
      if (rows.length < V2_SCAN_PAGE) break;
      after = rows[rows.length - 1].id;
    }
    if (fo.done) fo.cur = Math.max(fo.cur, this.db.lastSeq());
    return fo;
  }
  /* The stored settings (exclusions, log), read once; the counter always comes from the summary row. */
  async fLoad() {
    const o = this.o;
    if (o.fcfg === undefined) { const v = await o.state.storage.get(FOUNDING_KEY); if (o.fcfg === undefined) o.fcfg = v && typeof v === "object" ? v : null; }
  }
  fCfg() {
    const c = this.o.fcfg || {}, fo = (this.sum && this.sum.fo) || foOf(c) || foOf({});
    return { onAt: c.onAt || null, offAt: c.offAt || null, excl: NP(c.excl), log: Array.isArray(c.log) ? c.log : [], on: !!fo.on, given: fo.given, cur: fo.cur, done: !!fo.done };
  }
  fState(cfg) {
    return { layout: "new", on: cfg.on, given: cfg.given, cap: FOUNDING_CAP, left: Math.max(0, FOUNDING_CAP - cfg.given), done: cfg.done, onAt: cfg.onAt, offAt: cfg.offAt,
      excluded: Object.keys(cfg.excl).map((pid) => ({ tag: cfg.excl[pid].tag, name: cfg.excl[pid].name, at: cfg.excl[pid].at })), log: cfg.log.slice(-FOUNDING_LOG_MAX) };
  }
  fLogged(cfg, now, event) { return cfg.log.concat([{ at: now, event }]).slice(-FOUNDING_LOG_MAX); }
  /* Who gets the next numbers: pilots after cur, in creation order (seq), skipping restricted
     pilots, the owner's exclusion list and pilots who already have a number; at most `limit`
     and never past FOUNDING_CAP. Removed and privacy-deleted pilots have no pilot row, so they
     are never looked at. Synchronous: the caller writes in the same turn (nothing else runs). */
  fPlan(cfg, limit) {
    const have = new Set();
    let after = null;
    for (;;) {
      let rows = [];
      try { rows = this.db.rowsById("fnd", after, null, V2_SCAN_PAGE); } catch (e) { break; }
      for (const r of rows) have.add(r.id);
      if (rows.length < V2_SCAN_PAGE) break;
      after = rows[rows.length - 1].id;
    }
    const take = [], skipped = [];
    let cur = cfg.cur, done = false, full = cfg.given >= FOUNDING_CAP;
    if (!full) scan: for (;;) {
      const rows = this.db.pilotPage(cur, V2_SCAN_PAGE);
      for (const r of rows) {
        if (cfg.given + take.length >= FOUNDING_CAP) { full = true; break scan; }
        if (take.length >= limit) break scan;
        cur = r.seq;
        const why = have.has(r.id) ? "already a Founding Pilot" : r.rs || ownGet(this.o.restricted, r.pid) ? "restricted" : ownGet(cfg.excl, r.pid) ? "on your exclusion list" : "";
        if (why) skipped.push({ tag: r.tag, name: r.dname, why });
        else take.push({ id: r.id, tag: r.tag, name: r.dname, n: cfg.given + take.length + 1 });
      }
      if (rows.length < V2_SCAN_PAGE) { done = true; break; }
    }
    if (full) done = true;
    return { take, skipped, cur, done, full };
  }
  fShow(list) { return list.map((x) => ({ n: x.n, name: x.name, tag: x.tag })); }
  async fStatus() { await this.fLoad(); return json({ ok: true, ...this.fState(this.fCfg()) }); }
  async fDryRun() {
    await this.fLoad();
    const cfg = this.fCfg(), p = this.fPlan(cfg, FOUNDING_CAP), t = p.take;
    return json({ ok: true, dryRun: true, wroteNothing: true, ...this.fState(cfg), wouldNumber: t.length,
      from: t.length ? t[0].n : null, to: t.length ? t[t.length - 1].n : null,
      first: this.fShow(t.slice(0, 5)), last: this.fShow(t.length > 5 ? t.slice(-5) : []),
      excludedCount: p.skipped.length, skipped: p.skipped.slice(0, FOUNDING_LIST_SHOWN),
      rowsWouldWrite: t.length + 2, leftAfter: Math.max(0, FOUNDING_CAP - cfg.given - t.length), confirm: FOUNDING_CONFIRM });
  }
  async fSwitch(request) {
    const b = (await request.json().catch(() => null)) || {};
    await this.fLoad();
    const cfg = this.fCfg(), now = Date.now();   // from here on, nothing awaits until the write
    if (!b.on) {
      if (!cfg.on) return json({ ok: true, changed: false, numbered: 0, rowsWritten: 0, ...this.fState(cfg) });
      return this.fWrite({ ...cfg, on: false, offAt: now, log: this.fLogged(cfg, now, "switched OFF") }, [], now);
    }
    const next = cfg.on ? cfg : { ...cfg, on: true, onAt: now, log: this.fLogged(cfg, now, "switched ON") };
    return this.fNumber(next, b.limit, now);
  }
  async fContinue(request) {
    const b = (await request.json().catch(() => null)) || {};
    await this.fLoad();
    const cfg = this.fCfg();
    if (!cfg.on) return json({ error: "The Founding Pilot offer is OFF." }, 409);
    return this.fNumber(cfg, b.limit, Date.now());
  }
  fNumber(cfg, limit, now) {
    const p = this.fPlan(cfg, clampInt(String(limit == null ? "" : limit), 1, FOUNDING_CAP, FOUNDING_CAP));
    const next = { ...cfg, given: cfg.given + p.take.length, cur: p.cur, done: p.done };
    if (p.take.length) next.log = this.fLogged(next, now, "numbered #" + (cfg.given + 1) + " to #" + next.given + " (" + p.take.length + " pilots)");
    return this.fWrite(next, p.take, now, p);
  }
  /* ONE transaction: a grant row per pilot + the summary row; the settings value in the same turn. */
  async fWrite(next, take, now, plan) {
    const o = this.o, sum = structuredClone(this.sum), u = o.sqlUse || { written: 0 }, w0 = u.written;
    sum.fo = foOf(next);
    this.db.tx(() => {
      this.db.fndEnsure();
      for (const x of take) this.db.kvPut("fnd", x.id, v2enc({ n: x.n, at: now, src: FOUNDING_SRC }));
      this.saveSum(sum, true);
    });
    const stored = next;
    const saving = o.state.storage.put(FOUNDING_KEY, stored);
    o.fcfg = stored; this.sum = sum;
    if (take.length) this.dropCaches();
    await saving;
    return json({ ok: true, changed: true, numbered: take.length, first: this.fShow(take.slice(0, 5)), last: this.fShow(take.length > 5 ? take.slice(-5) : []),
      skippedCount: plan ? plan.skipped.length : 0, more: !!(next.on && !next.done), rowsWritten: u.written - w0 + 1, ...this.fState(next) });
  }
  fTagOf(b) { return String((b && b.tag) || "").toUpperCase().replace(/^.*#/, "").replace(/[^0-9A-Z]/g, ""); }
  async fExclude(request) {
    const b = (await request.json().catch(() => null)) || {};
    const t = this.fTagOf(b);
    if (t.length < 4 || t.length > 12) return json({ error: "Type the pilot's #TAG as the leaderboard shows it, e.g. #K7Q2MX8." }, 400);
    await this.fLoad();
    const o = this.o, cfg = this.fCfg(), now = Date.now(), excl = { ...cfg.excl };
    let note = "", event;
    if (b.remove) {
      const pids = Object.keys(excl).filter((pid) => tagFromPid(pid, 12).startsWith(t));
      if (!pids.length) return json({ error: "#" + t + " is not on the exclusion list." }, 404);
      for (const pid of pids) delete excl[pid];
      event = "#" + t + " removed from the exclusion list";
    } else {
      const rows = this.db.pilotsT12(t, t + "~");
      if (!rows.length) return json({ error: "No pilot has the tag #" + t + "." }, 404);
      if (rows.length > 1) return json({ error: "Several pilots start with #" + t + ". Type more of the tag (FIND A PLAYER shows the longer one)." }, 409);
      const r = rows[0];
      if (!ownGet(excl, r.pid) && Object.keys(excl).length >= FOUNDING_EXCL_MAX) return json({ error: "The exclusion list is full (" + FOUNDING_EXCL_MAX + ")." }, 409);
      excl[r.pid] = { tag: r.tag, name: r.dname, at: now };
      const f = this.db.fndMany([r.id]).get(r.id);
      if (f && !f.off) note = r.dname + " #" + r.tag + " is already Founding Pilot #" + f.n + ". Excluding stops nothing already given; use TAKE BACK to remove it.";
      event = "#" + r.tag + " added to the exclusion list";
    }
    const stored = { ...cfg, excl, log: this.fLogged(cfg, now, event) };
    const saving = o.state.storage.put(FOUNDING_KEY, stored);
    o.fcfg = stored;
    await saving;
    return json({ ok: true, note, ...this.fState(this.fCfg()) });
  }
  /* The owner's explicit action: the grant is marked taken back (Solar Inferno goes with it,
     unless bought); the number is never given again. */
  async fTakeBack(request) {
    const b = (await request.json().catch(() => null)) || {};
    const t = this.fTagOf(b);
    if (t.length < 4 || t.length > 12) return json({ error: "Type the pilot's #TAG." }, 400);
    if (String(b.confirm || "").trim() !== "TAKE BACK #" + t) return json({ error: "To take the number back, type exactly: TAKE BACK #" + t }, 400);
    await this.fLoad();
    const rows = this.db.pilotsT12(t, t + "~");
    if (rows.length !== 1) return json({ error: rows.length ? "Several pilots start with #" + t + ". Type more of the tag." : "No pilot has the tag #" + t + "." }, rows.length ? 409 : 404);
    const r = rows[0], f = this.db.fndMany([r.id]).get(r.id);
    if (!f || f.off) return json({ error: r.dname + " #" + r.tag + " is not a Founding Pilot." }, 404);
    const o = this.o, cfg = this.fCfg(), now = Date.now();
    this.db.kvPut("fnd", r.id, v2enc({ ...f, off: now }));
    const stored = { ...cfg, log: this.fLogged(cfg, now, "#" + f.n + " taken back from #" + r.tag) };
    const saving = o.state.storage.put(FOUNDING_KEY, stored);
    o.fcfg = stored; this.dropCaches();
    await saving;
    return json({ ok: true, takenBack: f.n, ...this.fState(this.fCfg()) });
  }

  /* ---- routes (same answers as the old layout) ---- */
  fetch(request, url) {
    const o = this.o;
    if (o.pidCache.size > V2_PID_CACHE_MAX) o.pidCache = new Map();   // memory stays bounded however many pilots play
    const route = {
      "/leaderboard": () => this.leaderboard(url),
      "/submit": () => this.submit(request),
      "/entitlements": () => this.entitlements(url, true),
      "/restore-check": () => this.restoreCheck(request, true),
      "/grant": () => this.grant(request),
      "/revoke": () => this.revoke(request),
      "/import": () => this.importRecords(request),
      "/recompute": () => this.recompute(),
      "/admin-find": () => this.find(request),
      "/admin-remove-score": () => this.removeScore(request),
      "/admin-restrict": () => this.restrict(request, true),
      "/admin-unrestrict": () => this.restrict(request, false),
      "/admin-privacy-delete": () => this.privacyDelete(request),
      "/admin-name-ban": () => this.nameBan(request, true),
      "/admin-name-unban": () => this.nameBan(request, false),
      "/admin-overview": () => o.handleAdminOverview(),
      "/admin-dismiss-flag": () => o.handleAdminDismissFlag(request),
      "/admin-issue-restore": () => this.issueRestore(request),
      "/admin-season-archive": () => this.seasonArchive(),
      "/admin-summary": () => this.summary(),
      "/world-grid-dry-run": () => o.handleWorldGridDryRun(),     // COMBINED WORLD GRID (admin; the dry run writes nothing)
      "/world-grid-apply": () => o.handleWorldGridApply(request),
      "/world-grid-check": () => o.handleWorldGridCheck(),
      "/world-grid-revert": () => o.handleWorldGridRevert(request),
      "/founding-status": () => this.fStatus(),                  // FOUNDING PILOT (admin)
      "/founding-dry-run": () => this.fDryRun(),                 //   writes nothing
      "/founding-switch": () => this.fSwitch(request),
      "/founding-continue": () => this.fContinue(request),
      "/founding-exclude": () => this.fExclude(request),
      "/founding-take-back": () => this.fTakeBack(request),
      "/backup-dump": () => json({ error: "The leaderboard uses the new layout; it is backed up page by page.", paged: true, layout: "v2" }, 409),
      "/backup-restore": () => o.handleBackupRestore(request),
    }[url.pathname];
    return route ? route() : json({ error: "Not found" }, 404);
  }

  leaderboard(url) {
    const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
    const difficulty = VALID_DIFFICULTIES.has(url.searchParams.get("difficulty")) ? url.searchParams.get("difficulty") : null;
    const top = this.board(difficulty || "all").slice(0, limit).map((x) => ({
      pid: x.pid, tag: x.tag, name: x.name, country: x.country, score: x.score, points: x.points, level: x.level, difficulty: x.difficulty, ...(x.fp ? { fp: 1 } : {}),
    }));
    const countries = this.countryList();
    const out = { top, countries, leadingCountry: countries[0] || null, difficulty, weighted: !difficulty, weights: { ...DIFF_WEIGHT } };
    const left = this.foundingLeft();
    if (left != null) out.foundingLeft = left;   // FOUNDING PILOT: spots left while the offer is ON (absent = OFF)
    if (this.comb) { out.combined = true; out.gridCombined = true; }   // COMBINED WORLD GRID: the game and the gateway say so (absent = Season 1 only, as before)
    if (url.searchParams.get("boards") === "1") {   // LEADERBOARD REFRESH: the three boards in the same response
      out.boards = {}; out.totals = {};
      for (const d of VALID_DIFFICULTIES) {
        out.boards[d] = this.board(d).slice(0, limit).map((x) => ({ pid: x.pid, tag: x.tag, name: x.name, country: x.country, score: x.score, points: x.points, level: x.level, difficulty: x.difficulty, ...(x.fp ? { fp: 1 } : {}) }));
        out.totals[d] = (this.sum.bc || {})[d] || 0;
      }
    }
    return json(out);
  }
  /* FLUX COMMAND summary on the new layout: purchases today from the seen table. */
  summary() {
    const o = this.o, now = Date.now(), dayStart = Math.floor(now / AN_DAY_MS) * AN_DAY_MS;
    let purchasesToday = 0, after = null;
    for (;;) {
      const rows = this.db.rowsById("seen", after, null, V2_SCAN_PAGE);
      for (const r of rows) { const t = v2dec(r.v); if (typeof t === "number" && t >= dayStart) purchasesToday++; }
      if (rows.length < V2_SCAN_PAGE) break;
      after = rows[rows.length - 1].id;
    }
    return json({ ok: true, flags: pruneFlags(o.flags, now).length, restrictedCount: Object.keys(o.restricted).length, purchasesToday, worldGrid: o.worldGridState(), founding: this.foundingInfo() });
  }

  async submit(request) {
    const o = this.o, body = await request.json();
    const { playerId, name, score, level, difficulty, country } = body;
    const now = Date.now();
    const pid = await o.pid(playerId);
    const row = this.db.pilot(playerId);
    // REPLAY PROTECTION (as the old layout): a run id already accepted gets the same reply, nothing changes.
    const runId = String(new URL(request.url).searchParams.get("run") || "").slice(0, RUN_ID_KEEP_CHARS);
    const runs = runId ? await o.readRuns(pid, now) : null;
    const seenRun = runs ? runs.find((e) => e.split(".")[0] === runId) : null;
    if (seenRun && row) return this.submitReply(row, pid, seenRun.slice(-1) === "e" ? "easy" : seenRun.slice(-1) === "h" ? "hard" : "medium", seenRun.slice(-2, -1) === "1", true);
    let last = row && row.ls != null ? v2dec(row.ls) : undefined, cooled = false;
    if (last === undefined) { const c = this.db.kvGet("cool", playerId); if (c != null) { last = v2dec(c); cooled = true; } }
    last = last || 0;
    if (now - last < SUBMIT_COOLDOWN_MS) {
      return json({ error: "Slow down — too many submissions", retryAfterSec: Math.ceil((SUBMIT_COOLDOWN_MS - (now - last)) / 1000) }, 429,
                  { "Retry-After": String(Math.ceil((SUBMIT_COOLDOWN_MS - (now - last)) / 1000)) });
    }
    const prev = row ? v2dec(row.rec) : null;
    const prevBest = prev && ownGet(prev.bests, difficulty) ? prev.bests[difficulty].score : 0;
    const isNewBest = score > prevBest;
    const record = { playerId, name, country, updatedAt: now, bests: NP(prev ? prev.bests : null) };
    if (isNewBest) record.bests[difficulty] = { score, level, updatedAt: now };
    const flag = this.maybeFlag(pid, playerId, name, difficulty, score, prevBest, now);
    const nextFlags = flag ? pruneFlags([...o.flags.filter((f) => f.id !== flag.id), flag], now) : o.flags;
    // FOUNDING PILOT: a NEW pilot gets the next number while the offer is ON, every earlier pilot was
    // looked at (done) and spots remain -- in the same transaction as the pilot row (no await from here).
    const fo = this.sum.fo, fHave = fo && fo.given ? this.db.fndMany([playerId]).get(playerId) : undefined;
    const fnum = !row && fo && fo.on && fo.done && fo.given < FOUNDING_CAP && !cooled && !fHave && !ownGet(o.restricted, pid) && !ownGet((o.fcfg || {}).excl, pid) ? fo.given + 1 : 0;
    const sum = structuredClone(this.sum);
    let res;
    this.db.tx(() => {
      res = this.putPilot(sum, row, record, playerId, pid, v2enc(now));
      if (cooled) this.db.kvDel("cool", playerId);
      if (fnum) {
        this.db.kvPut("fnd", playerId, v2enc({ n: fnum, at: now, src: FOUNDING_SRC }));
        sum.fo = { ...sum.fo, given: fnum, cur: Math.max(sum.fo.cur, res.cur.seq) };
      }
      this.saveSum(sum);
    });
    const kv = {};
    if (flag) kv.flags = nextFlags;
    if (runId) kv["runs:" + pid] = runs.concat([runId + "." + Math.floor(now / 1000).toString(36) + "." + (isNewBest ? "1" : "0") + difficulty[0]]).slice(-RUN_IDS_MAX).join(",");
    const saving = Object.keys(kv).length ? o.state.storage.put(kv) : null;   // same moment as the rows (no await in between)
    this.commit(sum, playerId, res);
    if (saving) await saving;
    o.flags = nextFlags;
    const fn = fnum || (fHave && !fHave.off ? fHave.n : 0);
    return this.submitReply(res.cur, pid, difficulty, isNewBest, false, score, fn ? { founding: fn } : null);   // FOUNDING PILOT: the badge / the one-time message at the run's end
  }
  /* The same reply shape as the old layout's submitReply (LEADERBOARD REFRESH standing included). */
  submitReply(row, pid, difficulty, isNewBest, duplicate, score, extra) {
    const rec = v2dec(row.rec), restricted = !!ownGet(this.o.restricted, pid);
    const st = restricted ? null : this.standing(difficulty, row);
    const b = ownGet(rec.bests, difficulty);
    return json({
      ok: true, isNewBest, best: b ? b.score : score,
      country: rec.country, difficulty,
      public: !restricted,
      rank: st ? st.rank : null,
      ...(st ? { total: st.total, countryRank: st.countryRank, countryTotal: st.countryTotal, above: st.above } : {}),
      tag: row.tag,
      ...(duplicate ? { duplicate: true } : {}),
      ...(extra || {}),
    });
  }
  maybeFlag(pid, playerId, name, difficulty, score, prevBest, now) {
    let boardTop = 0;
    for (const x of this.board(difficulty)) { if (x.id !== playerId) { boardTop = x.score; break; } }
    let reason = null;
    if (score >= FLAG_ABSOLUTE) reason = "exceptionally high score";
    else if (score >= FLAG_MIN_SCORE && boardTop > 0 && score > boardTop * FLAG_JUMP_FACTOR) reason = "far above the current #1";
    else if (score >= FLAG_MIN_SCORE && prevBest > 0 && score > prevBest * FLAG_PERSONAL_JUMP) reason = "sudden jump over this player's own best";
    if (!reason) return null;
    return { id: pid + ":" + difficulty, pid, name: cleanName(name), difficulty, score, prevBest, boardTop, reason, at: now };
  }

  async restoreCheck(request, pub) {
    let body = null;
    try { body = await request.json(); } catch (e) {}
    const playerId = body && typeof body.playerId === "string" ? body.playerId : "";
    if (!validPlayerId(playerId)) return json({ error: "Missing or invalid playerId" }, 400);
    const row = this.db.pilot(playerId), rec = row ? v2dec(row.rec) : null;
    const owned = this.ents(playerId);
    let skus = Array.isArray(owned) ? owned.filter((s) => VALID_SKUS.has(s)) : [];
    const fnd = pub ? this.fndActive(playerId) : null;   // FOUNDING PILOT: a restore code brings Solar Inferno back like a purchase
    if (fnd && !skus.includes("solar")) skus = skus.concat(["solar"]);
    if (!rec && !skus.length) return json({ found: false });
    const bests = {};
    if (rec) for (const d of VALID_DIFFICULTIES) {
      const b = ownGet(rec.bests, d);
      if (b && Number.isFinite(b.score)) bests[d] = { score: b.score, level: Number.isFinite(b.level) ? b.level : 1 };
    }
    return json({
      found: true,
      name: rec ? presetOrOwn(cleanName(rec.name), playerId) : "",
      tag: row ? row.tag : tagFromPid(await this.o.pid(playerId), 7),
      country: rec && ISO2.test(String(rec.country || "")) ? rec.country : "",
      bests,
      skus,
      ...(fnd ? { founding: fnd.n } : {}),
    });
  }
  /* pub: the game's own request (FOUNDING PILOT added); without it (or with paid=1) only the
     Stripe purchases -- what the admin purchase tools and the storage checks compare. */
  entitlements(url, pub) {
    const playerId = url.searchParams.get("playerId") || "";
    const skus = this.ents(playerId) || [];
    if (!pub || url.searchParams.get("paid") === "1") return json({ playerId, skus });
    const fnd = this.fndActive(playerId), left = this.foundingLeft();
    return json({ playerId, skus: fnd && !skus.includes("solar") ? skus.concat(["solar"]) : skus,
      ...(fnd ? { founding: fnd.n } : {}), ...(left != null ? { foundingLeft: left } : {}) });
  }
  async grant(request) {
    const o = this.o, { playerId, sku, sessionId, force } = await request.json();
    if (!force && sessionId) { const seen = this.db.kvGet("seen", sessionId); if (seen != null && v2dec(seen)) return json({ ok: true, duplicate: true, skus: this.ents(playerId) || [] }); }
    const owned = new Set(this.ents(playerId) || []);
    owned.add(sku);
    const skus = [...owned];
    this.db.tx(() => {   // durable first: both rows or neither
      this.db.kvPut("ents", playerId, v2enc(skus));
      if (sessionId) this.db.kvPut("seen", sessionId, v2enc(Date.now()));
    });
    await o.migTouched(await o.pid(playerId));
    return json({ ok: true, skus });
  }
  async revoke(request) {
    const o = this.o, { playerId, sku } = await request.json();
    const owned = (this.ents(playerId) || []).filter((s) => s !== sku);
    if (owned.length) this.db.kvPut("ents", playerId, v2enc(owned)); else this.db.kvDel("ents", playerId);
    await o.migTouched(await o.pid(playerId));
    return json({ ok: true, skus: owned });
  }
  async importRecords(request) {
    const { records } = await request.json();
    const list = [];
    for (const rec of Array.isArray(records) ? records : []) {
      if (!rec || typeof rec.playerId !== "string" || !validPlayerId(rec.playerId)) continue;
      list.push({ rec, pid: await this.o.pid(rec.playerId) });
    }
    let imported = 0, merged = 0;
    const sum = structuredClone(this.sum);
    this.db.tx(() => {
      for (const { rec, pid } of list) {
        const incoming = normaliseRecord(rec, rec.playerId);
        incoming.name = presetOrOwn(cleanName(incoming.name), rec.playerId);
        const row = this.db.pilot(rec.playerId);
        if (!row) { this.putPilot(sum, null, incoming, rec.playerId, pid); imported++; continue; }
        const existing = v2dec(row.rec), bests = NP(existing.bests);
        for (const [d, b] of Object.entries(incoming.bests)) if (!bests[d] || b.score > bests[d].score) bests[d] = b;
        this.putPilot(sum, row, { ...existing, bests }, rec.playerId, pid);
        merged++;
      }
      this.saveSum(sum);
    });
    this.sum = sum; this.dropCaches();
    await this.o.migTouched(list.map((x) => x.pid));
    return json({ ok: true, imported, merged });
  }
  recompute() {
    const sum = this.buildSum();
    this.saveSum(sum, true); this.sum = sum; this.dropCaches();
    return json({ ok: true, players: sum.n, countries: Object.keys(sum.list).length });
  }

  /* ---- admin (by public hash; never a playerId out) ---- */
  adminView(row) {
    const rec = v2dec(row.rec), r = ownGet(this.o.restricted, row.pid);
    return { pid: row.pid, tag: row.tag, name: cleanName(rec.name), shownAs: row.dname, country: rec.country,
      bests: rec.bests, restricted: !!r, restriction: r || null, updatedAt: rec.updatedAt || null };
  }
  async find(request) {
    const { q } = await request.json();
    const raw = String(q || "").toUpperCase().replace(/\s+/g, " ").trim();
    const both = /^(.+?)\s*#\s*([0-9A-Z]+)$/.exec(raw);
    const query = raw.replace(/^#/, "").trim();
    const matches = [];
    const test = (row) => {
      const v = this.adminView(row);
      const named = (n) => v.name.includes(n) || String(v.shownAs || "").includes(n);
      const hit = both
        ? (named(both[1].trim()) && (v.tag.startsWith(both[2]) || tagFromPid(v.pid, 12).startsWith(both[2])))
        : (named(query) || v.tag.startsWith(query) || tagFromPid(v.pid, 12).startsWith(query));
      if (hit) matches.push(v);
    };
    if (both) for (const row of this.db.pilotsT12(both[2], both[2] + "~")) test(row);   // "NAME #TAG": the tag index, a few rows
    else this.scanPilots(test);                                                          // anything else: every pilot is read once
    matches.sort((a, b) => (bestOf({ bests: b.bests }) || { score: 0 }).score - (bestOf({ bests: a.bests }) || { score: 0 }).score);
    const shown = matches.slice(0, 25);
    if (this.sum.fo && this.sum.fo.given && shown.length) {   // FOUNDING PILOT: the number beside the pilot (admin only)
      const ids = new Map(); for (const v of shown) { const r = this.pilotByPid(v.pid); if (r) ids.set(v.pid, r.id); }
      const f = this.db.fndMany([...ids.values()]);
      for (const v of shown) { const x = f.get(ids.get(v.pid)); if (x) v.founding = { n: x.n, takenBack: !!x.off }; }
    }
    return json({ ok: true, matches: shown });
  }
  async removeScore(request) {
    const o = this.o, { pid } = await request.json();
    const row = this.pilotByPid(pid);
    if (!row) return json({ error: "Entry not found" }, 404);
    const rec = v2dec(row.rec), nextFlags = o.flags.filter((f) => f.pid !== pid);
    const sum = structuredClone(this.sum);
    this.db.tx(() => {
      this.dropPilot(sum, row);
      if (row.ls != null) this.db.kvPut("cool", row.id, row.ls);   // the cooldown is kept
      this.saveSum(sum);
    });
    const saving = o.state.storage.put({ flags: nextFlags });
    this.sum = sum; this.dropCaches();
    await saving;
    o.flags = nextFlags;
    await o.migTouched(pid);
    return json({ ok: true, removed: { name: cleanName(rec.name), country: rec.country } });
  }
  async restrict(request, on) {
    const o = this.o, { pid, reason } = await request.json();
    const next = NP(o.restricted);
    if (on) next[pid] = { at: Date.now(), reason: String(reason || "").slice(0, 120) };
    else delete next[pid];
    const row = this.pilotByPid(pid), sum = structuredClone(this.sum);
    if (row && row.rs !== (on ? 1 : 0)) this.db.tx(() => {
      const before = this.entryOf(row);
      this.db.updatePilot(row.seq, { rs: on ? 1 : 0 });
      this.boardCount(sum, row, -1); this.boardCount(sum, { ...row, rs: on ? 1 : 0 }, 1);
      this.applyCountry(sum, before, this.entryOf({ ...row, rs: on ? 1 : 0 }));
      this.saveSum(sum);
    });
    const saving = o.state.storage.put({ restricted: next });
    this.sum = sum; this.dropCaches();
    await saving;
    o.restricted = next;
    return json({ ok: true, restricted: on });
  }
  async privacyDelete(request) {
    const o = this.o, { pid, removePurchases } = await request.json();
    const id = await this.findIdByPid(pid);
    if (!id) return json({ error: "No records found for that entry" }, 404);
    const row = this.db.pilot(id), owned = this.ents(id);
    const purchasesRemoved = removePurchases && Array.isArray(owned) ? owned.length : 0;
    const nextFlags = o.flags.filter((f) => f.pid !== pid);
    const nextLog = o.restoreLog.map((e) => (e.pid === pid ? { at: e.at, pid: e.pid, tag: e.tag, name: "", reason: "(erased on privacy request)" } : e));
    await o.eraseFromSeasonArchive(id);                        // SEASON 1: the archived Season 0 scores go too
    const old = await o.v1ValuesWithout(id, !!removePurchases);   // and the old layout's values, kept until CLEAN UP
    await this.fLoad();
    const fc = o.fcfg && o.fcfg.excl && ownGet(o.fcfg.excl, pid) ? { ...o.fcfg, excl: dropKey(o.fcfg.excl, pid) } : null;   // FOUNDING PILOT: off the exclusion list
    if ((await o.state.storage.get("runs:" + pid)) !== undefined) await o.state.storage.delete("runs:" + pid);   // REPLAY PROTECTION: accepted run ids go too
    const sum = structuredClone(this.sum);
    this.db.tx(() => {
      if (row) this.dropPilot(sum, row);
      this.db.kvDel("cool", id);
      if (removePurchases) { this.db.kvDel("ents", id); try { this.db.kvDel("fnd", id); } catch (e) { /* no table */ } }   // FOUNDING PILOT: goes with the purchases (the number is not reused)
      this.saveSum(sum);
    });
    const saving = o.state.storage.put({ flags: nextFlags, restoreLog: nextLog, ...old });
    const fSaving = fc ? o.state.storage.put(FOUNDING_KEY, fc) : null;   // same turn: written together
    this.sum = sum; this.dropCaches();
    if (fc) o.fcfg = fc;
    await saving; if (fSaving) await fSaving;
    o.flags = nextFlags; o.restoreLog = nextLog; o.twin = null;
    await o.migTouched(pid);
    return json({ ok: true, purchasesRemoved, restrictionKept: !!ownGet(o.restricted, pid) });
  }
  async nameBan(request, on) {
    const o = this.o, { name } = await request.json();
    const key = normaliseForBan(name);
    if (!key) return json({ error: "Enter a name" }, 400);
    const next = NP(o.nameBans);
    if (on) next[key] = { at: Date.now() }; else delete next[key];
    const hit = [];
    this.scanPilots((r) => { if (r.nb1 === key || r.nb2 === key) hit.push(r); });   // every pilot is read once
    const sum = structuredClone(this.sum);
    let any = false;
    this.db.tx(() => {
      for (const r of hit) {
        const d = this.dnameOf(v2dec(r.rec), next);
        if (d === r.dname) continue;
        any = true;
        this.db.updatePilot(r.seq, { dname: d });
        this.retag(r.dname, r.t12.slice(0, 7));
        this.retag(d, r.t12.slice(0, 7));
      }
      if (any) { this.refreshLeads(sum); this.saveSum(sum); }
    });
    const saving = o.state.storage.put({ nameBans: next });
    this.sum = sum; this.dropCaches();
    await saving;
    o.nameBans = next;
    return json({ ok: true, name: key, banned: on });
  }
  async issueRestore(request) {
    const o = this.o, { pid, reason } = await request.json();
    const id = await this.findIdByPid(pid);
    if (!id) return json({ error: "Entry not found" }, 404);
    const row = this.db.pilot(id);
    const tag = row ? row.tag : tagFromPid(await o.pid(id), 7);
    const name = row ? cleanName(v2dec(row.rec).name) : "";
    const logged = { at: Date.now(), pid, tag, name, reason: String(reason || "").slice(0, RESTORE_REASON_MAX) };
    const next = [...o.restoreLog, logged].slice(-RESTORE_LOG_MAX);
    try { await o.state.storage.put({ restoreLog: next }); }
    catch (e) { return json({ error: "Could not record this in the log, so no code was issued. Try again." }, 503); }
    o.restoreLog = next;
    return json({ ok: true, code: await restoreCodeFor(id), tag, name });
  }
  async seasonArchive() {
    const { meta, players } = await this.o.readSeasonArchive();
    const rows = [];
    for (const p of players) {
      const pid = await this.o.pid(p.playerId), row = this.db.pilot(p.playerId), tag = row ? row.tag : tagFromPid(pid, 7);
      for (const d of Object.keys(p.bests || {})) {
        const b = p.bests[d];
        rows.push({ difficulty: d, pid, tag, name: cleanName(p.name), country: p.country || "", score: b.score, level: b.level, updatedAt: b.updatedAt || 0 });
      }
    }
    rows.sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);
    return json({ ok: true, season: 0, archivedAt: meta ? meta.archivedAt : null, players: meta ? meta.players : 0, count: rows.length, rows });
  }
  /* SEASON (a future season on the new layout): the bests are archived (read page
     by page) and cleared. Rows written: every pilot with a best -- plan it (see
     the note at the top). Runs inside load()'s blockConcurrencyWhile. */
  async startSeason() {
    const st = this.o.state.storage, players = [];
    this.scanPilots((r) => {
      const rec = v2dec(r.rec), bests = {};
      for (const d of Object.keys(rec.bests || {})) { const b = rec.bests[d]; if (b && Number.isFinite(b.score)) bests[d] = { score: b.score, level: b.level, updatedAt: b.updatedAt || 0 }; }
      if (Object.keys(bests).length) players.push({ playerId: rec.playerId || r.id, name: rec.name, country: rec.country, bests });
    });
    const chunks = [];
    let cur = [], size = 2;
    for (const p of players) {
      const n = new TextEncoder().encode(JSON.stringify(p)).length + 1;
      if (cur.length && size + n > SEASON_ARCHIVE_CHUNK_BYTES) { chunks.push(cur); cur = []; size = 2; }
      cur.push(p); size += n;
    }
    if (cur.length) chunks.push(cur);
    for (let i = 0; i < chunks.length; i += SEASON_ARCHIVE_PUT_KEYS) {
      const part = {};
      chunks.slice(i, i + SEASON_ARCHIVE_PUT_KEYS).forEach((c, j) => { part[SEASON_ARCHIVE_KEY + ":" + (i + j)] = c; });
      await st.put(part);
    }
    const scores = players.reduce((n, p) => n + Object.keys(p.bests).length, 0);
    const meta = { season: 0, archivedAt: Date.now(), players: players.length, scores, chunks: chunks.length };
    const clear = [];
    this.scanPilots((r) => { if (r.e_s != null || r.m_s != null || r.h_s != null || Object.keys(v2dec(r.rec).bests || {}).length) clear.push(r); });
    this.db.tx(() => {
      for (const r of clear) { const rec = v2dec(r.rec); rec.bests = {}; this.db.updatePilot(r.seq, { rec: v2enc(rec), e_s: null, e_t: null, m_s: null, m_t: null, h_s: null, h_t: null }); }
      this.sum = { v: 1, weights: JSON.stringify(DIFF_WEIGHT), n: this.sum ? this.sum.n : 0, list: {}, lead: {}, bc: {}, bcc: {} };
      this.saveSum(this.sum, true);
    });
    await st.put({ [SEASON_ARCHIVE_KEY]: meta, season: SEASON });
    this.dropCaches();
  }
}

/* ---- the move: comparisons (dry run, switch, check, rollback) ---- */
function v2Counts(v1) {
  const c = { pilots: 0, bests: { easy: 0, medium: 0, hard: 0 }, purchasePilots: 0, skins: { toxic: 0, cosmic: 0, solar: 0 }, purchaseSessions: Object.keys(v1.seenSessions || {}).length,
    cooldowns: Object.keys(v1.lastSubmit || {}).length, flags: (v1.flags || []).length, nameBans: Object.keys(v1.nameBans || {}).length,
    restricted: Object.keys(v1.restricted || {}).length, restoreLog: (v1.restoreLog || []).length, countries: Object.keys(v1.countries || {}).length };
  for (const id of Object.keys(v1.players || {})) { c.pilots++; for (const d of V2_DIFFS) if (ownGet(v1.players[id].bests, d)) c.bests[d]++; }
  for (const id of Object.keys(v1.entitlements || {})) {
    const skus = Array.isArray(v1.entitlements[id]) ? v1.entitlements[id] : [];
    if (skus.length) c.purchasePilots++;
    for (const k of skus) if (ownGet(c.skins, k) !== undefined) c.skins[k]++;
  }
  c.solarInferno = c.skins.solar;
  return c;
}
function v2Estimate(rows, tabs) {
  let w = 0;
  for (const r of rows) { w += 3; for (const d of V2_DIFFS) if (r[V2_COL[d] + "_s"] != null && !r.rs) w++; }   // row + id index + tag index + a board index per best
  const other = Object.keys(tabs.ents).length + Object.keys(tabs.seen).length + Object.keys(tabs.cool).length;
  const rowsWritten = w + other + 10, batches = Math.max(1, Math.ceil(rows.length / MIG_BATCH));
  return { rowsWritten, rowsRead: 4 * rows.length + 2 * other + 20, batches, adminRequests: Math.ceil(batches / MIG_CALLS_PER_REQUEST),
    seconds: 5 + Math.ceil(batches * 1.5), pctOfDailyWrites: Math.round(100 * rowsWritten / FREE_PLAN.rowsWrittenPerDay), days: Math.max(1, Math.ceil(rowsWritten / MIG_DAY_ROW_BUDGET)) };
}
async function v2PilotChecks(v1, eng, ids, skip) {
  const r = { compared: 0, skipped: 0, failed: 0, restore: 0, ents: 0, tags: 0, examples: [] };
  for (const id of ids) {
    const pid = await v1.pid(id);
    if (skip && skip.has(pid)) { r.skipped++; continue; }
    r.compared++;
    const rq = () => new Request("https://do.internal/restore-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId: id }) });
    const a = await (await v1.handleRestoreCheck(rq())).text(), b = await (await eng.restoreCheck(rq())).text();
    const u = new URL("https://do.internal/entitlements?playerId=" + encodeURIComponent(id));
    const ea = await (await v1.handleEntitlements(u)).text(), eb = await (await eng.entitlements(u)).text();
    const row = eng.db.pilot(id), ta = ownGet(v1.players, id) !== undefined ? await v1.tagFor(id) : null, tb = row ? row.tag : null;
    let bad = false;
    if (a !== b) { r.restore++; bad = true; }
    if (ea !== eb) { r.ents++; bad = true; }
    if (ta !== tb) { r.tags++; bad = true; }
    if (bad) { r.failed++; if (r.examples.length < 5) r.examples.push("#" + tagFromPid(pid, 7)); }
  }
  return r;
}
function v2FirstDiff(a, b) {
  const x = a.top || [], y = b.top || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (JSON.stringify(x[i]) !== JSON.stringify(y[i])) return "first difference at #" + (i + 1);
  return "the country figures or the header differ";
}
async function v2CheckGlobal(v1, eng, skip) {
  const out = [], add = (name, pass, detail) => out.push({ name, pass: !!pass, detail: String(detail || "") });
  const n = skip ? skip.size : 0;
  // COMBINED WORLD GRID: the old layout only knows Season 1, so the comparison reads the new layout's Season 1 view.
  let view = eng;
  if (eng.comb) { view = new PilotLayoutV2(eng.o, eng.db); view.sum = view.buildSum(); }
  for (const d of ["", "easy", "medium", "hard"]) {
    const u = new URL("https://do.internal/leaderboard?limit=100" + (d ? "&difficulty=" + d : "&boards=1"));   // ALL request also carries the three boards (LEADERBOARD REFRESH)
    const A = JSON.parse(await (await v1.handleLeaderboard(u)).text()), B = JSON.parse(await (await view.leaderboard(u)).text());
    const name = "Leaderboard " + (d ? d.toUpperCase() : "ALL (difficulty weights)") + ", top 100";
    if (!n) add(name, JSON.stringify(A) === JSON.stringify(B), JSON.stringify(A) === JSON.stringify(B) ? (A.top || []).length + " rows identical" : v2FirstDiff(A, B));
    else {
      const f = (x) => (x.top || []).filter((e) => !skip.has(e.pid)).slice(0, Math.max(0, BOARD_MAX - n));
      const same = JSON.stringify(f(A)) === JSON.stringify(f(B));
      add(name + " (pilots unchanged since the move)", same, same ? f(A).length + " rows identical" : v2FirstDiff({ top: f(A) }, { top: f(B) }));
    }
    if (!d) {
      if (!n) { const same = JSON.stringify(A.countries) === JSON.stringify(B.countries); add("Country totals and leaders", same, same ? (A.countries || []).length + " countries identical" : "they differ"); }
      else add("Country totals and leaders", true, "not compared old vs new: " + n + " pilot(s) changed since the move; the next check covers them");
    }
  }
  const fresh = eng.buildSum(), same = v2SameSum(fresh, eng.sum);
  add("Country totals kept up to date = a fresh count of every pilot", same, same ? Object.keys(fresh.list).length + " countries, " + fresh.n + " pilots" : "the running totals drifted from the rows");
  return out;
}
async function v2Reconcile(v1, eng) {
  const checks = [], add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail || "") });
  const ids = Object.keys(v1.players), rows = new Map();
  eng.scanPilots((r) => rows.set(r.id, r));
  const bad = [];
  for (const id of ids) { const r = rows.get(id); if (!r || !bkSame(v2dec(r.rec), v1.players[id])) bad.push("#" + tagFromPid(await v1.pid(id), 7)); }
  const extra = [...rows.keys()].filter((id) => ownGet(v1.players, id) === undefined).length;
  add("Pilots: every record identical", !bad.length && !extra, bad.length ? bad.length + " differ, e.g. " + bad.slice(0, 5).join(" ") : extra ? extra + " extra row(s)" : ids.length + " pilots identical");
  const b1 = { easy: 0, medium: 0, hard: 0 }, b2 = { easy: 0, medium: 0, hard: 0 };
  for (const id of ids) for (const d of V2_DIFFS) if (ownGet(v1.players[id].bests, d)) b1[d]++;
  for (const r of rows.values()) for (const d of V2_DIFFS) if (r[V2_COL[d] + "_s"] != null) b2[d]++;
  add("Bests per difficulty", bkSame(b1, b2), "easy " + b2.easy + " / medium " + b2.medium + " / hard " + b2.hard + (bkSame(b1, b2) ? "" : " (old: " + b1.easy + " / " + b1.medium + " / " + b1.hard + ")"));
  const tab = (t) => { const o = {}; let after = null; for (;;) { const rs = eng.db.rowsById(t, after, null, V2_SCAN_PAGE); for (const x of rs) o[x.id] = v2dec(x.v); if (rs.length < V2_SCAN_PAGE) return o; after = rs[rs.length - 1].id; } };
  const ls = tab("cool");
  for (const r of rows.values()) if (r.ls != null) ls[r.id] = v2dec(r.ls);
  add("Upload cooldowns", bkSame(JSON.parse(v2enc(v1.lastSubmit)), JSON.parse(v2enc(ls))), Object.keys(ls).length + " pilots");
  const ents = tab("ents"), solar = Object.keys(ents).filter((k) => Array.isArray(ents[k]) && ents[k].includes("solar")).length;
  add("Purchases (skins) of every buyer, incl. Solar Inferno", bkSame(JSON.parse(v2enc(v1.entitlements)), JSON.parse(v2enc(ents))), Object.keys(ents).length + " buyers, " + solar + " own Solar Inferno");
  const seen = tab("seen");
  add("Delivered checkout sessions", bkSame(JSON.parse(v2enc(v1.seenSessions)), JSON.parse(v2enc(seen))), Object.keys(seen).length + " sessions");
  checks.push(...(await v2CheckGlobal(v1, eng, null)));
  const everyone = [...new Set(ids.concat(Object.keys(v1.entitlements)))];
  const p = await v2PilotChecks(v1, eng, everyone, null);
  add("Restore codes (/api/restore-check) of every pilot and buyer", !p.restore, p.compared + " compared" + (p.restore ? ", " + p.restore + " differ, e.g. " + p.examples.join(" ") : ""));
  add("Skins (/api/entitlements) of every pilot and buyer", !p.ents, p.compared + " compared" + (p.ents ? ", " + p.ents + " differ" : ""));
  add("Public #tags of every pilot (incl. lengthened ones)", !p.tags, ids.length + " compared" + (p.tags ? ", " + p.tags + " differ" : ""));
  add("Flags, name bans, restrictions, restore log, Season 0 archive: kept as they are", true,
    (v1.flags || []).length + " flags, " + Object.keys(v1.nameBans || {}).length + " name bans, " + Object.keys(v1.restricted || {}).length + " restrictions, " + (v1.restoreLog || []).length + " restore-log entries");
  return checks;
}
/* The stored values of a new-layout backup, minus one pilot (a privacy deletion):
   the old layout's values (until CLEAN UP), flags, restore log, Season 0 archive. */
async function v2EraseKv(entries, pid, ids, removePurchases) {
  const layout = entries.find(([k]) => k === STORAGE_LAYOUT_KEY), rest = entries.filter(([k]) => k !== STORAGE_LAYOUT_KEY);
  const out = await bkErasePilot(rest, pid, removePurchases);
  let cur = out || rest, touched = !!out;
  const M = new Map(cur), meta = M.get(SEASON_ARCHIVE_KEY);
  if (ids.size && meta) {
    let removed = 0, lost = 0, hit = false;
    cur = cur.map(([k, v]) => {
      if (!k.startsWith(SEASON_ARCHIVE_KEY + ":") || !Array.isArray(v) || !v.some((p) => p && ids.has(p.playerId))) return [k, v];
      hit = true;
      for (const p of v) if (p && ids.has(p.playerId)) { removed++; lost += Object.keys(p.bests || {}).length; }
      return [k, v.filter((p) => !(p && ids.has(p.playerId)))];
    });
    if (hit) { touched = true; cur = cur.map(([k, v]) => (k === SEASON_ARCHIVE_KEY ? [k, { ...v, players: Math.max(0, v.players - removed), scores: Math.max(0, (v.scores || 0) - lost) }] : [k, v])); }
  }
  const fk = cur.findIndex(([k]) => k === FOUNDING_KEY), fv = fk >= 0 ? cur[fk][1] : null;   // FOUNDING PILOT: off the exclusion list too
  if (fv && fv.excl && ownGet(fv.excl, pid)) { cur = cur.slice(); cur[fk] = [FOUNDING_KEY, { ...fv, excl: dropKey(fv.excl, pid) }]; touched = true; }
  if (!touched) return null;
  if (layout) cur = cur.concat([layout]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return cur;
}
/* Backup summaries of the new layout (the same fields as bkSummary). */
function v2SumStart() { return { kv: null, restricted: {}, keys: 0, players: 0, bests: { easy: 0, medium: 0, hard: 0 }, purchasePilots: 0, skins: { toxic: 0, cosmic: 0, solar: 0 }, purchaseSessions: 0, cc: new Set() }; }
function v2SumAdd(acc, t, entries) {
  acc.keys += entries.length;
  if (!t) { acc.kv = entries; const r = new Map(entries).get("restricted"); acc.restricted = r && typeof r === "object" ? r : {}; return; }
  for (const [, row] of entries) {
    if (t === "pilots") {
      acc.players++;
      const rec = row.rec || {}, bests = rec.bests || {};
      let any = false;
      for (const d of V2_DIFFS) if (ownGet(bests, d)) { acc.bests[d]++; any = true; }
      if (any && !ownGet(acc.restricted, row.pid)) acc.cc.add(ISO2.test(String(rec.country || "")) ? rec.country : "XX");
    } else if (t === "ents") {
      const skus = v2dec(row.v), list = Array.isArray(skus) ? skus : [];
      if (list.length) acc.purchasePilots++;
      for (const k of list) if (ownGet(acc.skins, k) !== undefined) acc.skins[k]++;
    } else if (t === "seen") acc.purchaseSessions++;
  }
}
function v2SumEnd(acc) {
  const s = bkSummary(acc.kv || []);
  return { ...s, keys: acc.keys, players: acc.players, bests: acc.bests, purchasePilots: acc.purchasePilots, skins: acc.skins, purchaseSessions: acc.purchaseSessions, countries: acc.cc.size, layout: "new" };
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
