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

// AUDIO REOPEN (owner): reopening the Home Screen app after a game left the context 'interrupted';
// PLAY only woke a 'suspended' one, and the gesture fallback only listened to finger-DOWN events,
// which iOS does not count as a tap for audio. So the run stayed silent until the app was left again.
function reopenChecks(src, quiet){
  let n=0; const c=(l,ok,x='')=>{ if(!quiet) ck(l,ok,x); else if(!ok) n++; };
  const init = src.match(/function initAudio\(\)\{[\s\S]*?\n\}/);
  const run = (state) => { let resumes=0, made=0;
    const ctx={ get state(){ return state; }, resume(){ resumes++; state='running'; return Promise.resolve(); } };
    const ready = new Function('ctx','mk', 'let audioCtx=ctx, masterGain={}, audioLimiter={}, audioReady=false; const SOUND_LEVEL=.3, SOUND_FADE_IN_S=1.5; const window={AudioContext:function(){ mk(); }};\n'
      + (init ? init[0] : '') + '\ninitAudio(); return audioReady;')(ctx, () => made++);
    return { resumes, made, ready }; };
  const ri = init ? run('interrupted') : {};
  c("R1 PLAY wakes a reopened app's 'interrupted' context (resumed inside the tap, no new context)", !!init && ri.resumes===1 && ri.made===0 && ri.ready===true, JSON.stringify(ri));
  c("R1 ...and still wakes 'suspended', leaves 'running' and 'closed' alone", !!init && run('suspended').resumes===1 && run('running').resumes===0 && run('closed').resumes===0);
  const te = src.match(/window\.ontouchend=window\.ontouchcancel=function\(e\)\{ ([^;]*);/), pu = src.match(/window\.onpointerup=window\.onpointercancel=function\(e\)\{ ([^;]*);/);
  c('R2 a finger LIFTING (touchend, pointerup -- what iOS counts as a tap for audio) retries the resume first', !!te && te[1]==='tryResumeAudio()' && !!pu && pu[1]==='tryResumeAudio()', (te&&te[1])+' / '+(pu&&pu[1]));
  c("R3 no 'suspended'-only resume left anywhere", !/state\s*===\s*'suspended'\)\s*audioCtx\.resume\(\)/.test(src));
  return n;
}
console.log('\n-- reopening the Home Screen app (AUDIO REOPEN) --');
reopenChecks(src, false);
console.log('\n-- negative controls: each defect re-inserted MUST be caught --');
for (const [label, a, b] of [
  ["PLAY wakes only a 'suspended' context again", "if(audioCtx.state!=='running' && audioCtx.state!=='closed'){ const p=audioCtx.resume(); if(p && p.catch) p.catch(function(){}); }", "if(audioCtx.state==='suspended') audioCtx.resume();"],
  ['touch end no longer retries the resume', 'window.ontouchend=window.ontouchcancel=function(e){ tryResumeAudio(); ', 'window.ontouchend=window.ontouchcancel=function(e){ '],
  ['pointer up no longer retries the resume', 'window.onpointerup=window.onpointercancel=function(e){ tryResumeAudio(); ', 'window.onpointerup=window.onpointercancel=function(e){ '],
]) { const mut = src.replace(a, b); const caught = mut !== src && reopenChecks(mut, true) > 0; ck('caught: ' + label, caught); }

console.log('\n'+'='.repeat(50));
console.log(F? '  '+F+' FAILED' : '  ALL AUDIO-LIFECYCLE TESTS PASSED');
console.log('='.repeat(50));
process.exit(F?1:0);
