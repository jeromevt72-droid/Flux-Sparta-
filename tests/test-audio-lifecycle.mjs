// D-11 RC2.2: the iOS Web Audio lifecycle, modelled from the real failure.
// Safari parks a backgrounded AudioContext in state 'interrupted', NOT
// 'suspended'. RC2.1 only checked for 'suspended', so the resume never fired.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','play','index.html'),'utf8');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};

// Extract the real function from the built file.
const m = src.match(/function tryResumeAudio\(\)\{[\s\S]*?\n\}/);
if(!m){ console.log('  FAIL  tryResumeAudio not found'); process.exit(1); }

function harness(state, ready){
  let resumes=0, created=0;
  const ctx={ get state(){return state;}, resume(){ resumes++; state='running'; } };
  const fn = new Function('audioReady','audioCtx','AudioContext',
    m[0].replace('function tryResumeAudio()','return (function tryResumeAudio()')+')');
  const t = fn(ready, ctx, function(){created++;});
  t();
  return {resumes, created, state};
}

console.log('-- the actual iOS state after backgrounding --');
let r=harness('interrupted', true);
ck("resumes from 'interrupted' (the RC2.1 miss)", r.resumes===1, 'resumes='+r.resumes);
ck('context ends up running', r.state==='running');
ck('no new AudioContext created', r.created===0);

console.log('\n-- other states --');
ck("resumes from 'suspended'", harness('suspended',true).resumes===1);
ck("does nothing when already 'running'", harness('running',true).resumes===0);
ck("resumes from 'closed' attempt is harmless", harness('closed',true).resumes===1);

console.log('\n-- respects the player never having enabled sound --');
r=harness('interrupted', false);
ck('no resume when audioReady is false', r.resumes===0);
ck('still no context created', r.created===0);

console.log('\n-- safety: missing context must not throw --');
let threw=false;
try{
  const fn=new Function('audioReady','audioCtx', m[0].replace('function tryResumeAudio()','return (function tryResumeAudio()')+')');
  fn(true,null)();
  fn(true,undefined)();
}catch(e){ threw=true; }
ck('null/undefined context safe', !threw);

console.log('\n-- wiring: one listener each, no duplicates, no state changes --');
ck('gesture fallback on pointerdown', src.includes("addEventListener('pointerdown', tryResumeAudio"));
ck('gesture fallback on touchstart', src.includes("addEventListener('touchstart', tryResumeAudio"));
ck('pointerdown registered exactly once', (src.match(/addEventListener\('pointerdown'/g)||[]).length===1);
ck('touchstart registered exactly once', (src.match(/addEventListener\('touchstart'/g)||[]).length===1);
ck('visibilitychange calls the same routine', src.includes('tryResumeAudio();\n},{passive:true});'));
ck('tryResumeAudio defined exactly once', (src.match(/function tryResumeAudio\(\)/g)||[]).length===1);
const BODY = m[0];   // the extracted function, not the whole file
ck('does not touch playing/paused', !/\b(playing|paused)\s*=[^=]/.test(BODY), BODY.replace(/\n/g,' ').slice(0,60));
ck('does not create a context', !/new\s+\(?\s*window\.\s*\)?AudioContext|new\s+AudioContext/.test(BODY));
ck('does not add listeners', !/addEventListener/.test(BODY));
ck('only calls resume()', (BODY.match(/audioCtx\.\w+/g)||[]).every(x=>['audioCtx.state','audioCtx.resume'].includes(x)));
ck('no second AudioContext anywhere', (src.match(/new \(window\.AudioContext/g)||[]).length<=1);
ck("no lingering 'suspended'-only check", !src.includes("audioCtx.state==='suspended') audioCtx.resume()") || src.includes("state !== 'running'"));

console.log('\n'+'='.repeat(50));
console.log(F? '  '+F+' FAILED' : '  ALL AUDIO-LIFECYCLE TESTS PASSED');
console.log('='.repeat(50));
process.exit(F?1:0);
