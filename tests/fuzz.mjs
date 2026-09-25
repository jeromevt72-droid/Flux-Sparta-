import worker, { LeaderboardDO } from "./FLUX-Sparta/worker.js";

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
const makeEnv = () => ({
  LEADERBOARD_DO: makeNamespace(), STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh",
  STRIPE_PRICE_TOXIC: "p1", STRIPE_PRICE_COSMIC: "p2", STRIPE_PRICE_SOLAR: "p3",
});
function req(p, { method = "GET", body, cf, raw } = {}) {
  const r = new Request("https://x.dev" + p, {
    method, headers: { "Content-Type": "application/json" },
    body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined),
  });
  if (cf) Object.defineProperty(r, "cf", { value: cf });
  return r;
}
const call = (env, p, o) => worker.fetch(req(p, o), env);

let issues = [];
function note(msg) { issues.push(msg); console.log("  !! " + msg); }
function ok(msg) { console.log("  ok  " + msg); }

/* ---- prototype pollution ---- */
console.log("\n=== prototype pollution ===");
{
  const env = makeEnv();
  // D-29/D-30 (RC2.8.1): every inherited Object property name, not just four.
  for (const evil of ["__proto__", "proto", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty",
                      "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]) {
    const r = await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: evil, name: "X", score: 1000, level: 2, difficulty: "medium" },
    });
    const b = await r.json();
    if (r.status >= 500) note(`playerId="${evil}" caused ${r.status}: ${JSON.stringify(b)}`);
  }
  if (({}).polluted !== undefined) note("Object.prototype was polluted");
  const lb = await (await call(env, "/api/leaderboard?limit=100")).json();
  if (!Array.isArray(lb.top)) note("leaderboard top is not an array after pollution attempt");
  else ok(`survived, ${lb.top.length} entries on board`);

  const env2 = makeEnv();
  const r2 = await call(env2, "/api/submit-score", {
    method: "POST", cf: { country: "US" },
    body: { playerId: "pp", name: "X", score: 1000, level: 2, difficulty: "medium", country: "__proto__" },
  });
  const b2 = await r2.json();
  if (b2.country === "__proto__") note("country accepted __proto__ (ISO2 regex bypassed)");
  else ok(`country sanitised to ${b2.country}`);
}

/* ---- weird names ---- */
console.log("\n=== hostile names ===");
{
  const env = makeEnv();
  const names = ["", "   ", "𝔘𝔫𝔦𝔠𝔬𝔡𝔢", "<script>alert(1)</script>", "A".repeat(500), "\u0000null", "🇺🇸".repeat(40), "\n\r\tTAB"];
  for (let i = 0; i < names.length; i++) {
    const r = await call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "n" + i, name: names[i], score: 1000, level: 2, difficulty: "medium" },
    });
    if (r.status >= 500) note(`name #${i} caused ${r.status}`);
  }
  const lb = await (await call(env, "/api/leaderboard?limit=100")).json();
  const tooLong = lb.top.filter(x => [...x.name].length > 16 && x.name.length > 16);
  if (tooLong.length) note(`name length cap leaked: ${JSON.stringify(tooLong.map(t => t.name))}`);
  else ok("all names within cap");
  const xss = lb.top.find(x => x.name.includes("<SCRIPT"));
  if (xss) ok(`raw markup stored as "${xss.name}" — client must escape on render`);
}

/* ---- junk payloads ---- */
console.log("\n=== junk payloads ===");
{
  const env = makeEnv();
  const junk = [
    { raw: "" }, { raw: "null" }, { raw: "[]" }, { raw: '"str"' }, { raw: "123" },
    { raw: '{"playerId":{"a":1},"score":1,"level":1}' },
    { raw: '{"playerId":"a","score":null,"level":null}' },
    { raw: '{"playerId":"a","score":1e999,"level":1}' },
    { raw: '{"playerId":"a","score":1,"level":1,"difficulty":{"x":1}}' },
    { raw: JSON.stringify({ playerId: "a", score: 1, level: 1, extra: "z".repeat(50000) }) },
  ];
  for (let i = 0; i < junk.length; i++) {
    const r = await call(env, "/api/submit-score", { method: "POST", raw: junk[i].raw });
    if (r.status >= 500) note(`junk #${i} caused ${r.status}: ${junk[i].raw.slice(0, 60)}`);
    // D-35: the restore check takes the same hostile bodies
    const r2 = await call(env, "/api/restore-check", { method: "POST", raw: junk[i].raw });
    if (r2.status >= 500) note(`restore-check junk #${i} caused ${r2.status}: ${junk[i].raw.slice(0, 60)}`);
  }
  for (const id of ["toString","valueOf","hasOwnProperty","isPrototypeOf","propertyIsEnumerable","toLocaleString","__defineGetter__","__lookupSetter__","__proto__","constructor"]) {
    const r3 = await call(env, "/api/restore-check", { method: "POST", raw: JSON.stringify({ playerId: id }) });
    if (r3.status >= 500) note(`restore-check ${id} caused ${r3.status}`);
  }
  ok("no 5xx from malformed bodies");
}

/* ---- race on the SAME player ---- */
console.log("\n=== same-player race ===");
{
  const env = makeEnv();
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "racer", name: "R", score: 30000, level: 2, difficulty: "medium" },
    })
  ));
  const accepted = results.filter(r => r.status === 200).length;
  const lb = await (await call(env, "/api/leaderboard")).json();
  const us = lb.countries.find(c => c.country === "US");
  console.log(`     accepted ${accepted}/20, US total=${us.totalScore}, playerCount=${us.playerCount}`);
  if (us.totalScore !== 30000) note(`same-player race inflated country total to ${us.totalScore} (expected 30000)`);
  if (us.playerCount !== 1) note(`same-player race inflated playerCount to ${us.playerCount} (expected 1)`);
  if (lb.top.filter(t => t.playerId === "racer").length > 1) note("duplicate rows for one player");
  if (us.totalScore === 30000 && us.playerCount === 1) ok("cooldown + DO serialisation held");
}

/* ---- many countries, ordering ---- */
console.log("\n=== scale sanity ===");
{
  const env = makeEnv();
  const cc = ["US","PH","CA","DE","BR","JP","GB","MX","AU","FR","IN","NG","KE","VN","IT"];
  await Promise.all(Array.from({ length: 300 }, (_, i) =>
    call(env, "/api/submit-score", {
      method: "POST", cf: { country: "US" },
      body: { playerId: "s" + i, name: "S" + i, score: (i % 90) * 1000 + 500, level: 2,
              difficulty: ["easy","medium","hard"][i % 3], country: cc[i % cc.length] },
    })
  ));
  const lb = await (await call(env, "/api/leaderboard?limit=100")).json();
  const sorted = lb.countries.every((c, i, a) => i === 0 || a[i-1].totalScore >= c.totalScore);
  if (!sorted) note("country list not sorted descending");
  else ok("countries sorted, " + lb.countries.length + " of them");
  const sum = lb.countries.reduce((a, c) => a + c.totalScore, 0);
  const players = lb.countries.reduce((a, c) => a + c.playerCount, 0);
  console.log(`     ${players} players tracked, total score ${sum}`);
  if (players !== 300) note(`expected 300 players, tracked ${players}`);
  if (lb.top.length !== 100) note(`limit=100 returned ${lb.top.length}`);
  else ok("limit honoured");
  const bad = await (await call(env, "/api/leaderboard?limit=abc")).json();
  const neg = await (await call(env, "/api/leaderboard?limit=-5")).json();
  const huge = await (await call(env, "/api/leaderboard?limit=99999")).json();
  console.log(`     limit=abc -> ${bad.top.length}, limit=-5 -> ${neg.top.length}, limit=99999 -> ${huge.top.length}`);
  if (huge.top.length > 100) note("limit cap bypassed");
  else ok("limit cap holds");
}

/* D-30 (RC2.8.1): a REAL release gate. RC2.8's fuzz pass found a server crash,
   printed it, and still exited 0 -- so "every suite passed" was reported while
   a known crash shipped. Any recorded issue now fails the run. */
console.log("\n" + "=".repeat(46));
if (issues.length === 0) console.log("  no defects found in adversarial pass");
else {
  console.log(`  DEFECT SUMMARY -- ${issues.length} issue(s) found:`);
  issues.forEach(i => console.log("   - " + i));
  console.log("  FUZZ FAILED");
}
console.log("=".repeat(46));
process.exit(issues.length ? 1 : 0);
