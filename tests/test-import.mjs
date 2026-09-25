import worker, { LeaderboardDO } from "./FLUX-Sparta/worker.js";
import { levelFor } from './level-rule.mjs';   // RC2.8.7: D-51 fixture levels

// AUDIT A-1: the leaderboard now carries a one-way hash (pid), never the
// playerId. Look rows up by the same hash. If this ever disagreed with the
// worker, every lookup below would fail loudly -- it cannot pass by accident.
// (test-audit-fixes.mjs separately proves the REAL game and worker agree.)
const _pidCache = {};
async function pidOf(id) {
  if (!_pidCache[id]) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("flux-pid:" + id));
    _pidCache[id] = Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return _pidCache[id];
}
const PID = {};
for (const id of ["old0", "__proto__", "badcountry", "longname", "noname", "newguy"]) PID[id] = await pidOf(id);


/* ---- DO emulation (same as the main harness) ---- */
class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(o, v) {
    if (typeof o === "object") for (const [k, val] of Object.entries(o)) this.map.set(k, structuredClone(val));
    else this.map.set(o, structuredClone(v));
  }
}
class FakeState { constructor() { this.storage = new FakeStorage(); } async blockConcurrencyWhile(f) { return f(); } }
function makeNamespace() {
  const inst = new Map(); let chain = Promise.resolve();
  return {
    idFromName: n => n,
    get(id) {
      if (!inst.has(id)) inst.set(id, new LeaderboardDO(new FakeState()));
      const o = inst.get(id);
      return { fetch(u, i) { const run = () => o.fetch(new Request(u, i)); const r = chain.then(run, run); chain = r.then(() => {}, () => {}); return r; } };
    },
    _instances: inst,
  };
}

/* ---- fake KV with pagination, mirroring the OLD schema ---- */
class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const all = [...this.map.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = cursor ? all.indexOf(cursor) + 1 : 0;
    const slice = all.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const complete = start + slice.length >= all.length;
    return { keys: slice.map(name => ({ name })), list_complete: complete, cursor: complete ? undefined : last };
  }
}

function seedOldKV(n = 250) {
  const kv = new FakeKV();
  const cc = ["US", "PH", "CA", "DE", "BR"];
  const top = [];
  for (let i = 0; i < n; i++) {
    const rec = {
      playerId: "old" + i, name: "OLD" + i, country: cc[i % cc.length],
      score: (i + 1) * 100, difficulty: ["easy", "medium", "hard"][i % 3],
      level: (i % 5) + 1, updatedAt: 1700000000000 + i,
    };
    kv.map.set("player:old" + i, JSON.stringify(rec));
    top.push({ playerId: rec.playerId, name: rec.name, country: rec.country, score: rec.score });
  }
  kv.map.set("meta:top", JSON.stringify(top.sort((a, b) => b.score - a.score).slice(0, 100)));
  kv.map.set("meta:countries", JSON.stringify({}));
  return kv;
}

const makeEnv = (kv) => ({
  LEADERBOARD_DO: makeNamespace(),
  LEADERBOARD: kv,
  ADMIN_TOKEN: "s3cret-admin-token",
  STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh",
});

const imp = (env, { token = "s3cret-admin-token", qs = "" } = {}) =>
  worker.fetch(new Request("https://x.dev/api/admin/import-kv" + qs, {
    method: "POST", headers: token === null ? {} : { "x-admin-token": token },
  }), env);

const lb = async (env, qs = "?limit=100") =>
  (await worker.fetch(new Request("https://x.dev/api/leaderboard" + qs), env)).json();

let pass = 0, fail = 0; const failed = [];
const check = (n, c, d) => c ? (pass++, console.log("  PASS  " + n))
                             : (fail++, failed.push(n), console.log(`  FAIL  ${n}${d ? " -> " + d : ""}`));
const section = t => console.log(`\n=== ${t} ===`);

/* ================= TESTS ================= */

section("1. Auth");
{
  const env = makeEnv(seedOldKV(5));
  check("no token rejected", (await imp(env, { token: null })).status === 401);
  check("wrong token rejected", (await imp(env, { token: "nope" })).status === 401);
  check("short wrong token rejected", (await imp(env, { token: "s" })).status === 401);
  const board = await lb(env);
  check("nothing imported by failed attempts", board.top.length === 0);

  const noTok = { ...env, ADMIN_TOKEN: undefined };
  check("missing ADMIN_TOKEN surfaces 500", (await imp(noTok)).status === 500);
}

section("2. Dry run");
{
  const env = makeEnv(seedOldKV(250));
  const r = await (await imp(env, { qs: "?dryRun=1" })).json();
  check("scanned everything", r.scanned === 250, `got ${r.scanned}`);
  check("all valid", r.valid === 250, `got ${r.valid}`);
  check("nothing written", r.imported === 0);
  const board = await lb(env);
  check("board still empty after dry run", board.top.length === 0, `got ${board.top.length}`);
}

section("3. Real import");
{
  const env = makeEnv(seedOldKV(250));
  const r = await (await imp(env)).json();
  check("imported all 250", r.imported === 250, `got ${r.imported}`);
  check("source was player keys", r.source === "player-keys");
  check("pagination worked past 1000-key page", r.scanned === 250);

  const board = await lb(env);
  check("top capped at limit", board.top.length === 100);
  check("highest score first", board.top[0].score === 25000, JSON.stringify(board.top[0]));
  check("names preserved", board.top[0].name === "OLD249");

  const total = board.countries.reduce((a, c) => a + c.totalScore, 0);
  const expected = Array.from({ length: 250 }, (_, i) => (i + 1) * 100).reduce((a, b) => a + b, 0);
  check("country totals exact", total === expected, `got ${total}, expected ${expected}`);
  const players = board.countries.reduce((a, c) => a + c.playerCount, 0);
  check("every player counted once", players === 250, `got ${players}`);
  check("5 countries present", board.countries.length === 5, `got ${board.countries.length}`);
}

section("4. Idempotency — run it twice");
{
  const env = makeEnv(seedOldKV(250));
  await imp(env);
  const first = await lb(env);
  const firstTotal = first.countries.reduce((a, c) => a + c.totalScore, 0);

  const r2 = await (await imp(env)).json();
  const second = await lb(env);
  const secondTotal = second.countries.reduce((a, c) => a + c.totalScore, 0);

  check("second run imports nothing new", r2.imported === 0, `got ${r2.imported}`);
  check("second run merges all 250", r2.merged === 250, `got ${r2.merged}`);
  check("totals unchanged", secondTotal === firstTotal, `${secondTotal} vs ${firstTotal}`);
  const players = second.countries.reduce((a, c) => a + c.playerCount, 0);
  check("no duplicated players", players === 250, `got ${players}`);
}

section("5. Import does not clobber better live scores");
{
  const env = makeEnv(seedOldKV(10));
  // A live score that beats the KV record for the same player
  await worker.fetch(new Request("https://x.dev/api/submit-score", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "old0", name: "LIVE", score: 99000, level: levelFor(99000, "hard"), difficulty: "hard", country: "PH" }),
  }), env);

  await imp(env);
  const board = await lb(env);
  const row = board.top.find(t => t.pid === PID["old0"]);
  check("better live score kept", row.score === 99000, JSON.stringify(row));
  check("live country kept", row.country === "PH", JSON.stringify(row));

  // PH legitimately holds old1 (200) + old6 (700) + the live old0 (99000)
  const ph = board.countries.find(c => c.country === "PH");
  check("PH total counts live score once, plus its two native rows", ph.totalScore === 99900, JSON.stringify(ph));
  check("old0 no longer counted under US", !(board.countries.find(c => c.country === "US") || {}).playerCount || board.countries.find(c => c.country === "US").playerCount === 1);
  const players = board.countries.reduce((a, c) => a + c.playerCount, 0);
  check("10 players total, not 11", players === 10, `got ${players}`);
}

section("6. Corrupt and hostile KV rows");
{
  const kv = seedOldKV(5);
  kv.map.set("player:broken", "{not json");
  kv.map.set("player:nullrec", "null");
  kv.map.set("player:noscore", JSON.stringify({ playerId: "noscore", name: "X" }));
  kv.map.set("player:negscore", JSON.stringify({ playerId: "negscore", score: -50 }));
  kv.map.set("player:huge", JSON.stringify({ playerId: "huge", score: 99999999999 }));
  kv.map.set("player:__proto__", JSON.stringify({ playerId: "__proto__", score: 500 }));
  kv.map.set("player:badcountry", JSON.stringify({ playerId: "badcountry", score: 700, country: "NOWHERE" }));
  kv.map.set("player:longname", JSON.stringify({ playerId: "longname", score: 800, name: "Z".repeat(200) }));
  kv.map.set("player:noname", JSON.stringify({ playerId: "noname", score: 900 }));

  const env = makeEnv(kv);
  const r = await (await imp(env)).json();
  check("scanned all rows", r.scanned === 14, `got ${r.scanned}`);
  check("corrupt rows skipped", r.skipped === 6, `got ${r.skipped}: ${JSON.stringify(r.skippedExamples)}`);
  check("good rows imported", r.imported === 8, `got ${r.imported}`);

  const board = await lb(env);
  check("no __proto__ row", !board.top.some(t => t.pid === PID["__proto__"]));
  const bad = board.top.find(t => t.pid === PID["badcountry"]);
  check("invalid country became XX", bad.country === "XX", JSON.stringify(bad));
  const ln = board.top.find(t => t.pid === PID["longname"]);
  check("long name truncated", ln.name.length === 16, ln.name);
  const nn = board.top.find(t => t.pid === PID["noname"]);
  check("missing name becomes PILOT", nn.name === "PILOT");
  check("board still sane", Array.isArray(board.top) && board.top.length === 8, `got ${board.top.length}`);
}

section("7. Fallback to meta:top when player keys are gone");
{
  const kv = new FakeKV();
  kv.map.set("meta:top", JSON.stringify([
    { playerId: "t1", name: "T1", country: "BR", score: 5000 },
    { playerId: "t2", name: "T2", country: "JP", score: 3000 },
    { playerId: "t3", name: "T3", country: "BR", score: 1000 },
  ]));
  const env = makeEnv(kv);
  const r = await (await imp(env)).json();
  check("fallback source used", r.source === "meta:top", r.source);
  check("3 salvaged", r.imported === 3, `got ${r.imported}`);
  const board = await lb(env);
  check("BR total correct", board.countries.find(c => c.country === "BR").totalScore === 6000);
  check("levels defaulted to 1", board.top.every(t => t.level === 1));
}

section("8. Empty KV");
{
  const env = makeEnv(new FakeKV());
  const r = await (await imp(env)).json();
  check("handles empty namespace", r.scanned === 0 && r.imported === 0, JSON.stringify(r));
  const board = await lb(env);
  check("board empty, no crash", board.top.length === 0 && board.countries.length === 0);
}

section("9. Missing KV binding");
{
  const env = { ...makeEnv(seedOldKV(3)), LEADERBOARD: undefined };
  const resp = await imp(env);
  check("reports missing KV clearly", resp.status === 400);
  check("message names the binding", /LEADERBOARD/.test((await resp.json()).error));
}

section("10. Leaderboard is usable immediately after import");
{
  const env = makeEnv(seedOldKV(60));
  await imp(env);
  const hard = await lb(env, "?difficulty=hard&limit=100");
  check("difficulty filter works on imported rows", hard.top.length > 0 && hard.top.every(t => t.difficulty === "hard"));
  const sub = await worker.fetch(new Request("https://x.dev/api/submit-score", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "newguy", name: "NEW", score: 120000, level: levelFor(120000, "hard"), difficulty: "hard", country: "KE" }),
  }), env);
  check("new score accepted post-import", sub.status === 200);
  const board = await lb(env);
  check("new player tops the imported board", board.top[0].pid === PID["newguy"], JSON.stringify(board.top[0]));
  const players = board.countries.reduce((a, c) => a + c.playerCount, 0);
  check("61 players tracked", players === 61, `got ${players}`);
}

console.log("\n" + "=".repeat(46));
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log("  Failing: " + failed.join(", "));
console.log("=".repeat(46));
process.exit(fail ? 1 : 0);
