// NEGATIVE CONTROLS. Each case re-introduces a real defect into a scratch copy
// of the production files and requires the runtime audit to FAIL on it.
// A test that still passes with the bug put back is not protecting anything.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};

function cloneTo(dir){
  // Copy EVERY suite and runner: the D-30 controls run the whole release gate.
  // FLUX-Sparta may be a SYMLINK to the repo root (tests/FLUX-Sparta -> ..). Copy the
  // real files (dereference) -- never the link, or every mutation below would be
  // written into the live source tree -- and skip .git and the tests folder itself.
  const src = fs.realpathSync(path.join(ROOT,'FLUX-Sparta'));
  const skip = new Set([path.join(src,'.git'), path.join(src,'tests'), fs.realpathSync(ROOT)]);
  fs.cpSync(src, path.join(dir,'FLUX-Sparta'), { recursive:true, dereference:true,
    filter: p => !skip.has(p) && !p.endsWith('.zip') });
  if (fs.existsSync(path.join(ROOT,'FLUX-Gateway-Redirect')))
    fs.cpSync(path.join(ROOT,'FLUX-Gateway-Redirect'), path.join(dir,'FLUX-Gateway-Redirect'), { recursive:true });
  for (const f of fs.readdirSync(ROOT))
    if (/\.(mjs|py|json|txt)$/.test(f)) fs.copyFileSync(path.join(ROOT,f), path.join(dir,f));
}
function mutate(dir, rel, from, to){
  const f = path.join(dir, rel);
  const s = fs.readFileSync(f,'utf8');
  if (!s.includes(from)) throw new Error('mutation anchor missing in '+rel+': '+from.slice(0,50));
  fs.writeFileSync(f, s.replace(from, to));
}
function run(dir, test='test-one-app-runtime.mjs', args=[]){
  try { execFileSync('node',[test, ...args],{ cwd:dir, stdio:'pipe', maxBuffer: 64*1024*1024 }); return { failed:false, out:'' }; }
  catch(e){ return { failed:true, out:String(e.stdout||'') }; }
}
const cases = [
  { name:'old cross-origin Play URL restored',
    rel:'FLUX-Sparta/public/index.html',
    from:"window.FLUX_GAME_URL = window.location.origin + '/play/';",
    to:"window.FLUX_GAME_URL = 'https://flux-gateway.jeromevt72.workers.dev';",
    expect:/FAIL  Play navigates within the same origin/ },
  { name:'demo allowed to touch real storage (isolation shim removed)',
    rel:'FLUX-Sparta/public/hero-demo.html',
    from:"Object.defineProperty(window, 'localStorage', { value: demoStorage, configurable: false });",
    to:"/* shim disabled */",
    expect:/FAIL  (demo was NOT blocked|production storage byte-for-byte unchanged)/ },
  { name:'a second playerId created on every launch',
    rel:'FLUX-Sparta/public/play/index.html',
    from:"if(!localStorage.fluxPlayerId){localStorage.fluxPlayerId=",
    to:"if(true){localStorage.fluxPlayerId=",
    expect:/FAIL  10 relaunches: still exactly ONE playerId ever created/ },
  { name:'Gateway mints its own player',
    rel:'FLUX-Sparta/public/index.html',
    from:"window.FLUX_GAME_URL = window.location.origin + '/play/';",
    to:"window.FLUX_GAME_URL = window.location.origin + '/play/'; localStorage.fluxPlayerId = 'gateway-'+Date.now();",
    expect:/FAIL  Gateway does NOT create a player/ },
  { name:'purchase lock not released on return',
    rel:'FLUX-Sparta/public/play/index.html',
    from:"  // Coming back from Stripe must never leave a purchase lock held.\n  purchaseInFlight = false;",
    to:"  // (lock reset removed)",
    expect:/FAIL  (purchase lock released|after returning, another purchase is NOT refused)/ },
  { name:'return does not verify its own pending checkout',
    rel:'FLUX-Sparta/public/play/index.html',
    from:"addEventListener('pageshow', function () { resumePendingCheckout(); });",
    to:"/* pageshow hook removed */",
    expect:/FAIL  return triggered server verification/ },
  { name:'demo can reach the real API (fetch guard removed)',
    rel:'FLUX-Sparta/public/hero-demo.html',
    from:"    if (/\\/api\\//.test(u)) {",
    to:"    if (false) {",
    expect:/FAIL  ZERO requests reached the network from the demo/ },
  { name:'service worker caches the Gateway as the game again',
    rel:'FLUX-Sparta/public/sw.js',
    from:"if (isGameShell && isCacheable(res)) {",
    to:"if (isCacheable(res)) {",
    test:'test-sw.mjs',
    expect:/FAIL  online Gateway visit does NOT overwrite the game shell/ },
  { name:'offline Gateway launch no longer reaches the game',
    rel:'FLUX-Sparta/public/sw.js',
    from:"if (!isGameShell) return Response.redirect(GAME_ROOT, 302);",
    to:"",
    test:'test-sw.mjs',
    expect:/FAIL  cold offline: start_url "\/" redirects to the game/ },
  { name:'Gateway links a competing manifest again',
    rel:'FLUX-Sparta/public/index.html',
    from:'<link rel="manifest" href="/manifest.webmanifest">',
    to:'<link rel="manifest" href="gateway-manifest.webmanifest">',
    test:'test-merge-one-identity.mjs',
    expect:/FAIL  Gateway links the ONE manifest/ },
  { name:'app starts at /welcome/ again (the device failure)',
    rel:'FLUX-Sparta/public/manifest.webmanifest',
    from:'"start_url": "/"',
    to:'"start_url": "/welcome/"',
    test:'test-sw.mjs',
    expect:/FAIL  start_url is the site root/ },
  { name:'API requested under /play/ after the move',
    rel:'FLUX-Sparta/public/index.html',
    from:"fetch(window.FLUX_ORIGIN + '/api/leaderboard?limit=50')",
    to:"fetch(window.FLUX_GAME_URL + 'api/leaderboard?limit=50')",
    expect:/FAIL  Gateway leaderboard request hits the origin API/ },
  { name:'Stripe return no longer forwarded to the game',
    rel:'FLUX-Sparta/public/index.html',
    from:"window.location.replace(window.location.origin + '/play/' + q);",
    to:"/* forward removed */",
    expect:/FAIL  Stripe return/ },
  { name:'service worker treats "/" (the Gateway) as the game again',
    rel:'FLUX-Sparta/public/sw.js',
    from:"const PRECACHE = [\n  GAME_ROOT,",
    to:"const PRECACHE = [\n  SCOPE_ROOT,\n  GAME_ROOT,",
    test:'test-sw.mjs',
    expect:/FAIL  Gateway root "\/" is NOT cached as the game/ },
  { name:'store opened in the shipped build while Stripe is in Sandbox',
    rel:'FLUX-Sparta/public/play/index.html',
    from:'const STORE_OPEN = false;',
    to:'const STORE_OPEN = true;',
    expect:/FAIL  (shipped game has the store switch set to CLOSED|every paid skin shows SOON)/ },
  { name:'buySkin no longer refuses while the store is closed',
    rel:'FLUX-Sparta/public/play/index.html',
    from:"  if (!STORE_OPEN) {                                   // STORE SWITCH\n    showInfo('COMING SOON',",
    to:"  if (false) {\n    showInfo('COMING SOON',",
    expect:/FAIL  direct buySkin\(\) refuses with COMING SOON/ },
  { name:'A-1: leaderboard leaks playerIds again',
    rel:'FLUX-Sparta/worker.js',
    from:'pid: o.pid,                                  // A-1: a hash, never the playerId',
    to:'pid: o.pid, playerId: o.it.r.playerId,',
    test:'test-audit-fixes.mjs',
    expect:/FAIL  no playerId field on any row/ },
  { name:'A-2: admin password check removed',
    rel:'FLUX-Sparta/worker.js',
    from:'if (!timingSafeEqual(supplied, env.ADMIN_TOKEN)) return json({ error: "Unauthorized" }, 401);',
    to:'',
    test:'test-audit-fixes.mjs',
    expect:/FAIL  (no password -> 401|wrong password -> 401)/ },
  { name:'A-2: country totals not rebuilt after removal',
    rel:'FLUX-Sparta/worker.js',
    from:'    this.players = next; this.flags = nextFlags;\n    this.invalidateTags();\n    await this.recomputeCountries();\n    return json({ ok: true, removed:',
    to:'    this.players = next; this.flags = nextFlags;\n    this.invalidateTags();\n    return json({ ok: true, removed:',
    test:'test-audit-fixes.mjs',
    expect:/FAIL  country totals rebuilt/ },
  { name:'A-3: name filter bypassed',
    rel:'FLUX-Sparta/worker.js',
    from:'function cleanName(raw) {',
    to:'function cleanName(raw) { return String(raw || "PILOT").toUpperCase();',
    test:'test-audit-fixes.mjs',
    expect:/FAIL  (markup characters stripped|impersonating ADMIN is blocked)/ },
  { name:'A-3: filter so broad it blocks innocent names (RAPE matched anywhere)',
    rel:'FLUX-Sparta/worker.js',
    from:'"MOLEST", "PEDOPHILE", "JIZZ", "DILDO",\n];',
    to:'"MOLEST", "PEDOPHILE", "JIZZ", "DILDO", "RAPE",\n];',
    test:'test-audit-fixes.mjs',
    expect:/FAIL  innocent names are NOT blocked/ },
  { name:'A-4: server store gate removed',
    rel:'FLUX-Sparta/worker.js',
    from:'if (String(env.STORE_OPEN || "").toLowerCase() !== "true") {',
    to:'if (false) {',
    test:'test-audit-fixes.mjs',
    expect:/FAIL  STORE_OPEN unset -> 403 STORE_CLOSED/ },
  { name:'D-22: one best per player again (difficulties overwrite each other)',
    rel:'FLUX-Sparta/worker.js',
    from:'    if (isNewBest) record.bests[difficulty] = { score, level, updatedAt: now };',
    to:'    if (isNewBest) record.bests = { [difficulty]: { score, level, updatedAt: now } };',
    test:'test-rc28-worker.mjs', expect:/FAIL  Easy board keeps the player's Easy 3,000/ },
  { name:'D-25: country figures not rebuilt after a submit',
    rel:'FLUX-Sparta/worker.js',
    from:'    this.players = nextPlayers; this.lastSubmit = nextLast; this.flags = nextFlags;\n    this.invalidateTags();\n\n    await this.recomputeCountries();',
    to:'    this.players = nextPlayers; this.lastSubmit = nextLast; this.flags = nextFlags;\n    this.invalidateTags();',
    test:'test-rc28-worker.mjs', expect:/FAIL  former country's leader is no longer the departed player/ },
  { name:'restricted players shown publicly again',
    rel:'FLUX-Sparta/worker.js',
    from:'      if (await this.isRestricted(r.playerId)) continue;       // moderation exclusion',
    to:'',
    test:'test-rc28-worker.mjs', expect:/FAIL  restricted player gone from the leaderboard/ },
  { name:'a public rank fabricated for a restricted player',
    rel:'FLUX-Sparta/worker.js',
    // Fabricate a rank outright. (An earlier version of this control only
    // removed the restricted check, which changes nothing: restricted players
    // are already excluded upstream, so it could never fail.)
    from:'    let rank = null;\n    if (!restricted) {',
    to:'    let rank = 1;\n    if (!restricted) {',
    test:'test-rc28-worker.mjs', expect:/FAIL  \.\.\.but is given NO public rank/ },
  { name:'Remove score also resets the cooldown',
    rel:'FLUX-Sparta/worker.js',
    from:'    this.players = next; this.flags = nextFlags;\n    this.invalidateTags();\n    await this.recomputeCountries();\n    return json({ ok: true, removed:',
    to:'    this.players = next; this.flags = nextFlags; this.lastSubmit = {};\n    this.invalidateTags();\n    await this.recomputeCountries();\n    return json({ ok: true, removed:',
    test:'test-rc28-worker.mjs', expect:/FAIL  remove-score does NOT reset the submit cooldown/ },
  { name:'Remove score also deletes purchases',
    rel:'FLUX-Sparta/worker.js',
    from:'    const removed = this.players[id];\n    const next = dropKey(this.players, id);',
    to:'    const removed = this.players[id];\n    const next = dropKey(this.players, id); delete this.entitlements[id];',
    test:'test-rc28-worker.mjs', expect:/FAIL  purchases are NOT touched by remove-score/ },
  { name:'tag collisions not lengthened',
    rel:'FLUX-Sparta/worker.js',
    from:'      for (const pid of list) map.set(pid, tagFromPid(pid, list.length > 1 ? 12 : 7));',
    to:'      for (const pid of list) map.set(pid, tagFromPid(pid, 7));',
    test:'test-rc28-worker.mjs', expect:/FAIL  colliding short tags are detected and lengthened/ },
  { name:'D-26: failed grant acknowledged with 200 again',
    rel:'FLUX-Sparta/worker.js',
    from:'        if (!ok) return json({ error: "Delivery failed; retry" }, 500);',
    to:'',
    test:'test-rc28-worker.mjs', expect:/FAIL  failed internal grant -> retryable non-2xx/ },
  { name:'D-26: session marked seen before the write succeeds',
    rel:'FLUX-Sparta/worker.js',
    from:'    await this.state.storage.put({ entitlements: nextEnt, seenSessions: nextSeen });\n    this.entitlements = nextEnt; this.seenSessions = nextSeen;',
    to:'    this.seenSessions = nextSeen;\n    await this.state.storage.put({ entitlements: nextEnt, seenSessions: nextSeen });\n    this.entitlements = nextEnt;',
    test:'test-rc28-worker.mjs', expect:/FAIL  retry after a failed write is NOT treated as a duplicate/ },
  { name:'D-26: unfulfillable payment acknowledged without a durable record',
    rel:'FLUX-Sparta/worker.js',
    from:'        const recorded = await recordDeliveryException(env, session, "missing ownership binding");',
    to:'        const recorded = true;',
    test:'test-rc28-worker.mjs', expect:/FAIL  paid event with no ownership binding is recorded as an exception/ },
  { name:'reconciliation delivers unpaid checkouts',
    rel:'FLUX-Sparta/worker.js',
    from:'    if (sesh.payment_status !== "paid") continue;',
    to:'',
    test:'test-rc28-worker.mjs', expect:/FAIL  reconciliation never delivers an UNPAID checkout/ },
  { name:'D-23: update gate checks only `playing` again',
    rel:'FLUX-Sparta/public/play/index.html',
    from:'if(playing || paused || runActive){ setTimeout(tryActivate,2000); return; }',
    to:'if(playing){ setTimeout(tryActivate,2000); return; }',
    test:'test-rc28-client.mjs', expect:/FAIL  no update applied during a paused run/ },
  { name:'D-24: temporary failures delete the queued best again',
    rel:'FLUX-Sparta/public/play/index.html',
    from:'          if(k>=0){ cur[k]=item; saveQueue(cur); }',
    to:'          saveQueue(cur.filter(function(x){return x.id!==item.id;}));',
    test:'test-rc28-client.mjs', expect:/FAIL  HTTP 429 x12: the personal best is still queued/ },
  { name:'D-24: the stale-processor bug (no yield before starting)',
    rel:'FLUX-Sparta/public/play/index.html',
    from:'    await Promise.resolve();\n    try{\n      do {',
    to:'    try{\n      do {',
    test:'test-rc28-client.mjs', expect:/FAIL  (a retry is SCHEDULED after a temporary failure|only ONE queue processor runs at a time)/ },
  { name:'D-24: work arriving mid-run is left waiting',
    rel:'FLUX-Sparta/public/play/index.html',
    from:'  if(_flushing){ _flushAgain=true; return _flushing; }',
    to:'  if(_flushing){ return _flushing; }',
    test:'test-rc28-client.mjs', expect:/FAIL  work arriving mid-run is sent in the same run/ },
  { name:'Retry-After ignored',
    rel:'FLUX-Sparta/public/play/index.html',
    from:'      if(ra && isFinite(+ra)) waitMs=(+ra)*1000;',
    to:'',
    test:'test-rc28-client.mjs', expect:/FAIL  Retry-After is respected/ },
  { name:'D-29: players map is an ordinary object again',
    rel:'FLUX-Sparta/worker.js',
    // The D-29 fix is layered: prototype-free maps, prototype-free copies, and
    // own-property reads of the player and of their bests. Undoing only some
    // layers is still safe (verified step by step), so this restores RC2.8's
    // exact unsafe code path -- all four -- to genuinely reinsert the crash.
    muts:[['      this.players = Object.create(null);                       // D-29','      this.players = {};'],
          ['    const prev = ownGet(this.players, playerId) || null;','    const prev = this.players[playerId] || null;'],
          ['    const prevBest = prev && ownGet(prev.bests, difficulty) ? prev.bests[difficulty].score : 0;',
           '    const prevBest = prev && prev.bests[difficulty] ? prev.bests[difficulty].score : 0;'],
          // ...and copies back to ordinary objects, as RC2.8's spreads were.
          ['function setKey(o, k, v) { const n = NP(o); n[k] = v; return n; }','function setKey(o, k, v) { return { ...o, [k]: v }; }']],
    test:'test-rc281.mjs', expect:/FAIL  (toString: submit is 200 or a controlled 4xx|map 'players' has no inherited)/ },
  { name:'D-29: map updates copy into ordinary objects again',
    rel:'FLUX-Sparta/worker.js',
    from:'function setKey(o, k, v) { const n = NP(o); n[k] = v; return n; }',
    to:'function setKey(o, k, v) { return { ...o, [k]: v }; }',
    test:'test-rc281.mjs', expect:/FAIL/ },
  { name:'D-30: a known crash reinserted -> fuzz exits nonzero',
    rel:'FLUX-Sparta/worker.js',
    // The D-29 fix is layered: prototype-free maps, prototype-free copies, and
    // own-property reads of the player and of their bests. Undoing only some
    // layers is still safe (verified step by step), so this restores RC2.8's
    // exact unsafe code path -- all four -- to genuinely reinsert the crash.
    muts:[['      this.players = Object.create(null);                       // D-29','      this.players = {};'],
          ['    const prev = ownGet(this.players, playerId) || null;','    const prev = this.players[playerId] || null;'],
          ['    const prevBest = prev && ownGet(prev.bests, difficulty) ? prev.bests[difficulty].score : 0;',
           '    const prevBest = prev && prev.bests[difficulty] ? prev.bests[difficulty].score : 0;'],
          // ...and copies back to ordinary objects, as RC2.8's spreads were.
          ['function setKey(o, k, v) { const n = NP(o); n[k] = v; return n; }','function setKey(o, k, v) { return { ...o, [k]: v }; }']],
    test:'fuzz.mjs', expect:/FUZZ FAILED/ },
  { name:'D-30: a known crash reinserted -> the WHOLE release gate exits nonzero',
    rel:'FLUX-Sparta/worker.js',
    // The D-29 fix is layered: prototype-free maps, prototype-free copies, and
    // own-property reads of the player and of their bests. Undoing only some
    // layers is still safe (verified step by step), so this restores RC2.8's
    // exact unsafe code path -- all four -- to genuinely reinsert the crash.
    muts:[['      this.players = Object.create(null);                       // D-29','      this.players = {};'],
          ['    const prev = ownGet(this.players, playerId) || null;','    const prev = this.players[playerId] || null;'],
          ['    const prevBest = prev && ownGet(prev.bests, difficulty) ? prev.bests[difficulty].score : 0;',
           '    const prevBest = prev && prev.bests[difficulty] ? prev.bests[difficulty].score : 0;'],
          // ...and copies back to ordinary objects, as RC2.8's spreads were.
          ['function setKey(o, k, v) { const n = NP(o); n[k] = v; return n; }','function setKey(o, k, v) { return { ...o, [k]: v }; }']],
    test:'run-all-tests.mjs', args:['--skip-negative-controls'], expect:/RELEASE GATE FAILED[\s\S]*fuzz\.mjs/ },
  { name:'D-31: verify-session ignores the grant result again',
    rel:'FLUX-Sparta/worker.js',
    from:'  const delivered = await grantEntitlement(env, playerId, sku, data.id || sessionId);',
    to:'  await grantEntitlement(env, playerId, sku, data.id || sessionId); const delivered = true;',
    test:'test-rc281.mjs', expect:/FAIL  paid \+ grant refused -> delivered:false, pendingDelivery:true/ },
  { name:'D-31: pending delivery reported without a durable exception',
    rel:'FLUX-Sparta/worker.js',
    from:'  const recorded = await recordDeliveryException(env, data, "delivery failed; will retry");\n  if (!recorded) return json({ error: "Temporarily unable to record the payment; retry" }, 503, { "Retry-After": "30" });',
    to:'  const recorded = await recordDeliveryException(env, data, "delivery failed; will retry");',
    test:'test-rc281.mjs', expect:/FAIL  grant fails AND exception cannot be stored -> retryable non-2xx/ },
  { name:'D-31: the game claims PURCHASE COMPLETE while delivery is pending',
    rel:'FLUX-Sparta/public/play/index.html',
    from:'    if (data.paid && data.playerId === playerId && data.pendingDelivery === true) {',
    to:'    if (false) {',
    test:'test-rc281.mjs', expect:/FAIL  payment ok but delivery pending -> a clear pending-delivery message/ },
  { name:'D-33: tags ignore the global collision map',
    rel:'FLUX-Sparta/worker.js',
    from:'    return (await this.tagMap()).get(pid) || tagFromPid(pid, 7);',
    to:'    return tagFromPid(pid, 7);',
    test:'test-rc281.mjs', expect:/FAIL  collision with a player OUTSIDE the top 25 is detected/ },
  { name:'D-33: country leader tag not resolved from the live map',
    rel:'FLUX-Sparta/worker.js',
    from:'      countries.push({ ...c, topTag: leaderId ? await this.tagFor(leaderId) : "" });',
    to:'      countries.push({ ...c, topTag: "" });',
    test:'test-rc281.mjs', expect:/FAIL  country leader shows the same tag/ },
  { name:'country leader playerId leaks into the public response',
    rel:'FLUX-Sparta/worker.js',
    from:'    for (const { leaderId, leaderPid, topTag, ...c } of Object.values(this.countries)) {',
    to:'    for (const c0 of Object.values(this.countries)) { const { leaderPid, topTag, ...c } = c0; const leaderId = c0.leaderId;',
    test:'test-audit-fixes.mjs', expect:/FAIL  no playerId appears ANYWHERE in the response/ },
  { name:'D-34: reconciliation reads one page only',
    rel:'FLUX-Sparta/worker.js',
    from:'    after = page.has_more && list.length ? list[list.length - 1].id : null;',
    to:'    after = null;',
    test:'test-rc281.mjs', expect:/FAIL  all pages checked: 249 of 250 delivered/ },
  { name:'D-34: resolved exceptions keep showing',
    rel:'FLUX-Sparta/worker.js',
    from:'        if (ok) { delivered++; await clearDeliveryException(env, sesh.id); }',
    to:'        if (ok) { delivered++; }',
    test:'test-rc281.mjs', expect:/FAIL  \.\.\.and clears its exception/ },
];
for (const c of cases){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'flux-neg-'));
  try {
    cloneTo(dir);
    // Most controls make one edit; some must undo TWO layers of a fix to truly
    // reinsert the defect (defence in depth), so they list several edits.
    for (const [from, to] of (c.muts || [[c.from, c.to]])) mutate(dir, c.rel, from, to);
    const r = run(dir, c.test, c.args || []);
    ck('caught: '+c.name, r.failed && c.expect.test(r.out),
       r.failed ? (c.expect.test(r.out) ? 'failed on the right check' : 'failed, but on a different check') : 'TEST STILL PASSED -- not protected');
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
}
console.log('\n'+'='.repeat(56));
console.log(F? '  '+F+' NEGATIVE CONTROL(S) NOT CAUGHT' : '  ALL NEGATIVE CONTROLS CAUGHT — the tests have teeth');
console.log('='.repeat(56));
process.exit(F?1:0);
