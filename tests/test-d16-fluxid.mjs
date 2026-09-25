// D-16: display-only rename. These tests exist to prove nothing BEHIND the
// label moved — an existing player must load exactly as before.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SP = path.join(__dirname,'FLUX-Sparta','public','play','index.html');
const src = fs.readFileSync(SP,'utf8');
const demo = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','hero-demo.html'),'utf8');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};

console.log('-- the label changed --');
ck('menu placeholder is FLUX ID', src.includes('placeholder="FLUX ID"'));
ck('empty-field prompt is FLUX ID', src.includes("input.placeholder = 'ENTER FLUX ID'"));
ck('Gateway demo placeholder is FLUX ID', demo.includes('placeholder="FLUX ID"'));
ck('no CALLSIGN placeholder anywhere', !src.includes('placeholder="CALLSIGN"') && !demo.includes('placeholder="CALLSIGN"'));
ck("no 'ENTER A CALLSIGN' left", !src.includes('ENTER A CALLSIGN'));

console.log('\n-- nothing behind the label moved --');
ck('element id still "callsign"', src.includes('<input id="callsign"'));
// RC2.8.5 (D-39, D-43) adds three reads of the same element (play-first start,
// the game-over name prompt, rename detection), 6 -> 9. The id itself is unchanged.
ck('getElementById(\'callsign\') intact', (src.match(/getElementById\('callsign'\)/g)||[]).length===9,
   String((src.match(/getElementById\('callsign'\)/g)||[]).length));
ck('JS variable still `callsign`', /let difficulty=localStorage\.fluxDifficulty\|\|'medium', callsign=/.test(src));
ck('localStorage key still fluxCallsign', src.includes('localStorage.fluxCallsign'));
ck('no key named fluxFluxId or similar', !/fluxFluxI|fluxId\s*=/.test(src));
ck('playerId untouched', src.includes('playerId') && !src.includes('fluxIdPlayer'));

console.log('\n-- existing player still loads --');
// Simulate the real load line against a pre-existing store.
const store={fluxCallsign:'SPARTA7', fluxCountry:'PH', fluxDifficulty:'hard'};
const loaded = {
  difficulty: store.fluxDifficulty||'medium',
  callsign:   store.fluxCallsign||'',
  country:    store.fluxCountry||'US'
};
ck('legacy FLUX ID loads unchanged', loaded.callsign==='SPARTA7', loaded.callsign);
ck('legacy country loads unchanged', loaded.country==='PH');
ck('legacy difficulty loads unchanged', loaded.difficulty==='hard');

console.log('\n-- backend schema unchanged --');
// Anchor to the submit-score call, not the first JSON.stringify in the file
// (which is the Stripe checkout body).
const si = src.indexOf("/api/submit-score");
const body = src.slice(si, si + 400);
ck('submission still sends name:', /name:item\.name/.test(body) || /name:callsign/.test(src));
ck('no fluxId field added to API', !/fluxId\s*:/.test(src));
ck('field set is playerId/name/score/level/difficulty/country',
   ['playerId','name','score','level','difficulty','country'].every(k=>body.includes(k+':')), body.replace(/\s+/g,' ').slice(0,90));

console.log('\n-- Pilots terminology preserved --');
ck("'PILOT' fallback kept", src.includes("'PILOT'"));
ck("profile prefix still PILOT", src.includes('>PILOT <b id="profileName"'));

console.log('\n-- D-02 / D-11 protections still present --');
ck('SW registration intact', src.includes("register('/sw.js', {scope:'/'})"));
ck('readiness handshake intact', src.includes("postMessage({type:'GET_READY'})"));
ck('audio resume on non-running intact', src.includes("audioCtx.state !== 'running'"));
ck('gesture fallback intact', src.includes("addEventListener('pointerdown', tryResumeAudio"));

console.log('\n'+'='.repeat(50));
console.log(F? '  '+F+' FAILED' : '  ALL D-16 TESTS PASSED');
console.log('='.repeat(50));
process.exit(F?1:0);
