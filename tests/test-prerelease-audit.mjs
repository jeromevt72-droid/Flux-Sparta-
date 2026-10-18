// PRE-RELEASE AUDIT (four small findings; gameplay frozen). The REAL shipped page in the harness.
//   A1 a 200 reply to a score upload is a success only when it is JSON with ok === true; anything
//      else (an HTML page, ok: false, an empty object, a cut-off body) keeps the run queued and does
//      NOT mark it uploaded (fluxAckSet is not called);
//   A2 an upload that hangs is cut after 15 s (AbortController); the abort is temporary: the run is
//      kept and retried; the timer is cleared when the server answers;
//   A3 a browser whose storage is blocked (every use throws) still starts the game with the defaults,
//      plays a run, and the small note says "STORAGE IS BLOCKED — PROGRESS WON'T BE SAVED"; a storage
//      that reads but cannot write keeps what it has; normal storage: no note, nothing changes.
//   (A4, a future season refused with the same 409, is in tests/test-season-reset.mjs, S6.)
// Ends with negative controls: each defect re-inserted MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'play', 'index.html'), 'utf8');
const ORIGIN = 'https://flux.example';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const tick = () => new Promise((r) => setImmediate(r));
const drain = async () => { for (let i = 0; i < 10; i++) await tick(); };

async function suite(gameHtml, quiet) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const GAME = scriptsOf(gameHtml);
  const keep = { fluxSeason: '1', fluxPlayerId: 'p-audit-1', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxRunsPlayed: '5', fluxWelcomeDone: '1',
    fluxEntitlementsV1: JSON.stringify({ v: 1, source: 'server', playerId: 'p-audit-1', skus: [], verifiedAt: Date.now() }),
    fluxLbCache: JSON.stringify({ at: Date.now(), data: { top: [], countries: [], boards: { easy: [], medium: [], hard: [] } } }) };
  const bootGame = (store, answer) => {
    const calls = [], timers = [], cleared = [];
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, standalone: false, fetchImpl: (u, o = {}) => { calls.push({ u: String(u), o });
      if (String(u).includes('submit-score')) return answer(o);
      return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })); } });
    g.win.setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
    g.win.clearTimeout = (id) => { cleared.push(id); };
    const run = (c) => vm.runInContext(c, g.ctx);
    const ups = () => calls.filter((c) => c.u.includes('submit-score')).length;
    return { g, run, calls, timers, cleared, ups };
  };
  const reply = (body, ct = 'application/json') => () => Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': ct } }));
  const upload = async (b) => { b.run("difficulty='medium'; recordBestRun(2600, 2);"); b.run('submitScore()'); await drain(); };   // not awaited: a hanging upload must not hang the test
  try {
    /* A1 */
    if (!quiet) console.log('== A1 a 200 reply counts only when it is JSON with ok === true ==');
    const bad = [['an HTML page (a captive Wi-Fi login)', reply('<html><body>Sign in to Wi-Fi</body></html>', 'text/html')],
      ['JSON with ok: false', reply('{"ok":false}')], ['an empty JSON object', reply('{}')], ['a cut-off body', reply('{"ok":tr')]];
    for (const [label, ans] of bad) {
      const { store, mem } = makeStore(keep); const b = bootGame(store, ans);
      await upload(b);
      const q = JSON.parse(mem.fluxPendingSubmits || '[]');
      ck('A1 ' + label + ': the run stays queued (temporary), NOT marked uploaded, and a retry is scheduled',
        b.ups() === 1 && q.length === 1 && q[0].score === 2600 && q[0].attempts === 1 && !mem.fluxUploadedBest && b.timers.some((t) => t.ms >= 5000 && t.ms !== 15000),
        'ups=' + b.ups() + ' queued=' + q.length + ' acked=' + (mem.fluxUploadedBest || 'no'));
    }
    const { store: s1, mem: m1 } = makeStore(keep); const good = bootGame(s1, reply(JSON.stringify({ ok: true, isNewBest: true, best: 2600, public: true, rank: 3, difficulty: 'medium', tag: 'ABCDEFG' })));
    await upload(good);
    ck('A1 the server\'s real answer (JSON, ok: true): the run leaves the queue and is marked uploaded', JSON.parse(m1.fluxPendingSubmits || '[]').length === 0 && JSON.parse(m1.fluxUploadedBest || '{}').medium === 2600, m1.fluxUploadedBest || 'not acked');
    /* A2 */
    if (!quiet) console.log('== A2 an upload that hangs is cut after 15 s; the abort is temporary ==');
    const { store: s2, mem: m2 } = makeStore(keep);
    let sawSignal = false;
    const hang = bootGame(s2, (o) => new Promise((res, rej) => { sawSignal = !!(o.signal && typeof o.signal.addEventListener === 'function'); if (o.signal) o.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; rej(e); }); }));
    await upload(hang);
    const cut = hang.timers.filter((t) => t.ms === 15000);
    const before = JSON.parse(m2.fluxPendingSubmits || '[]').length;
    ck('A2 the upload carries an abort signal and a 15-second timer is set', sawSignal && cut.length === 1, 'signal=' + sawSignal + ' timers=' + hang.timers.map((t) => t.ms).join(','));
    if (cut[0]) cut[0].f();
    await drain();
    const q2 = JSON.parse(m2.fluxPendingSubmits || '[]');
    ck('A2 after 15 s the upload is aborted: temporary -- the run stays queued, not marked uploaded, a retry is scheduled',
      before === 1 && q2.length === 1 && q2[0].attempts === 1 && !m2.fluxUploadedBest && hang.timers.some((t) => t.ms >= 5000 && t.ms !== 15000), 'queued=' + q2.length + ' attempts=' + (q2[0] && q2[0].attempts));
    const t15 = good.timers.findIndex((t) => t.ms === 15000) + 1;
    ck('A2 when the server answers in time, the 15-second timer is cleared', t15 > 0 && good.cleared.includes(t15), 'timer id ' + t15 + ' cleared ' + good.cleared.join(','));
    /* A3 */
    if (!quiet) console.log('== A3 blocked storage: the game still starts with defaults, and says progress won\'t be saved ==');
    const thrower = new Proxy({}, { get() { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e; }, set() { throw new Error('SecurityError'); }, has() { throw new Error('SecurityError'); }, deleteProperty() { throw new Error('SecurityError'); } });
    const bl = bootGame(thrower, reply('{"ok":true}'));
    const note = bl.g.els.fluxNetNote;
    ck('A3 every use of storage throws: the page still starts (no script error), with the defaults', bl.g.errors.length === 0 && bl.run('fluxStorageBlocked') === true && bl.run('difficulty') !== '' && bl.run('typeof callsign') === 'string' && bl.run('country') !== '', bl.g.errors.join(' | ') || [bl.run('difficulty'), bl.run('callsign'), bl.run('country'), bl.run('profileComplete')].join(','));
    bl.g.ctx.__thrower = thrower;
    const guarded = bl.run("(function(){ const keepLs=localStorage; Object.defineProperty(window,'localStorage',{ value:__thrower, configurable:true }); try{ return typeof fluxStartRead==='function' ? [fluxStartRead('fluxDifficulty','medium'), fluxStartRead('fluxCallsign',''), fluxStartRead('fluxCountry','US'), fluxStartRead('fluxProfileComplete','')==='1'].join('|') : 'no guarded reader'; }catch(e){ return 'threw: '+e.name; } finally{ Object.defineProperty(window,'localStorage',{ value:keepLs, configurable:true }); } })()");
    ck('A3 ...the four startup reads (difficulty, callsign, country, profileComplete) are guarded: with storage throwing they give the defaults (medium, none, US, not complete)', guarded === 'medium||US|false', guarded);
    const src = gameHtml.slice(gameHtml.indexOf('var fluxStorageBlocked='), gameHtml.indexOf('/* PILOT NAMES (child privacy)'));
    ck('A3 ...and they are read only through the guard', /let difficulty=fluxStartRead\('fluxDifficulty','medium'\), callsign=fluxStartRead\('fluxCallsign',''\), country=fluxStartRead\('fluxCountry','US'\);\nlet profileComplete=fluxStartRead\('fluxProfileComplete',''\)==='1';/.test(src));
    let played = true; try { bl.g.ctx.newGame(); bl.run('score=1200; level=1;'); bl.g.ctx.endGame(); await drain(); } catch (e) { played = String(e).slice(0, 80); }
    ck('A3 ...a run can be played and ended', played === true, String(played));
    bl.run('playing=false; runActive=false; fluxNetNote()');
    ck('A3 ...the small note says "STORAGE IS BLOCKED — PROGRESS WON\'T BE SAVED" (on the menu, not during a run)',
      note && /^STORAGE IS BLOCKED — PROGRESS WON.T BE SAVED$/.test(String(note.textContent)) && note.className === 'show' && (bl.run('playing=true; fluxNetNote()'), note.className === ''), note ? String(note.textContent) + ' / ' + note.className : 'no note');
    // storage that reads but cannot write (full / read-only): what it has is kept
    const ro = makeStore(keep); const roStore = new Proxy(ro.store, { get: (t, k) => (k === 'setItem' ? () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } : t[k]), set() { throw new Error('QuotaExceededError'); } });
    const rb = bootGame(roStore, reply('{"ok":true}'));
    ck('A3 storage that reads but cannot write: the game starts with what it has (TITAN, Philippines), progress kept in memory', rb.g.errors.length === 0 && rb.run('fluxStorageBlocked') === true && rb.run('callsign') === 'TITAN' && rb.run('country') === 'PH' && rb.run('profileComplete') === true, rb.g.errors.join(' | ') || [rb.run('callsign'), rb.run('country')].join(','));
    // normal storage: nothing changes
    const { store: s3 } = makeStore(keep); const nb = bootGame(s3, reply('{"ok":true}'));
    nb.run('fluxNetNote()');
    ck('A3 normal storage: not blocked, no note, the saved pilot is read as before', nb.run('fluxStorageBlocked') === false && nb.g.els.fluxNetNote.className === '' && nb.run('callsign') === 'TITAN' && nb.run('difficulty') === 'medium');
    const { store: s4 } = makeStore(Object.assign({}, keep, { fluxDifficulty: 'hard' })); const hb = bootGame(s4, reply('{"ok":true}'));
    ck('A3 ...a saved difficulty is still read', hb.run('difficulty') === 'hard');
  } catch (e) { ck('suite ran without an exception', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  return { F, failed };
}

const res = await suite(GAME_HTML, false);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
async function control(label, expect, edit) {
  const g2 = edit(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = await suite(g2, true); const hit = r.failed.filter((f) => f.startsWith(expect));
  console.log((hit.length ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (hit[0] || 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!hit.length) NC++;
}
await control('any 200 counts as success (the old rule)', 'A1', rep("if(!body || body.ok!==true){ fluxNetDown=true; return { kind:'temporary', waitMs:0 }; }", ''));
await control('a 200 with any JSON counts (ok not checked)', 'A1', rep("if(!body || body.ok!==true){", "if(!body){"));
await control('no timeout on the upload', 'A2', rep("    if(ctl) timer=setTimeout(function(){ try{ ctl.abort(); }catch(e){} }, 15000);", ''));
await control('the abort signal not passed to fetch', 'A2', rep("        signal:ctl ? ctl.signal : undefined\n", "        signal:undefined\n"));
await control('the timer never cleared', 'A2', rep("  }finally{ if(timer){ try{ clearTimeout(timer); }catch(e){} } }", "  }finally{}"));
await control('an abort treated as a permanent refusal (run dropped)', 'A2', rep("    }catch(e){ fluxNetDown=true; return { kind:'temporary', waitMs:0 }; }   // offline, or cut after 15 s", "    }catch(e){ return { kind:e && e.name==='AbortError' ? 'permanent' : 'temporary', waitMs:0 }; }   // offline, or cut after 15 s"));
await control('the startup reads unguarded (the old code)', 'A3', rep("let difficulty=fluxStartRead('fluxDifficulty','medium'), callsign=fluxStartRead('fluxCallsign',''), country=fluxStartRead('fluxCountry','US');\nlet profileComplete=fluxStartRead('fluxProfileComplete','')==='1';", "let difficulty=localStorage.fluxDifficulty||'medium', callsign=localStorage.fluxCallsign||'', country=localStorage.fluxCountry||'US';\nlet profileComplete=localStorage.fluxProfileComplete==='1';"));
await control('no in-memory storage when blocked', 'A3', rep("    Object.defineProperty(window,'localStorage',{ value:mem, configurable:true });", ''));
await control('no note when storage is blocked', 'A3', rep("const show=(blocked || fluxNetHeld() || fluxNetDown)", "const show=(fluxNetHeld() || fluxNetDown)"));
await control('a read-only storage loses what it has', 'A3', rep("    try{ const st=window.localStorage; for(let i=0;i<st.length;i++){ const k=st.key(i); if(k!=null) m[k]=st.getItem(k); } }catch(e){}\n", ''));
const total = res.F + NC;
console.log('\n' + (total ? 'PRE-RELEASE AUDIT FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PRE-RELEASE AUDIT PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
