// SMOOTH CHAINS (preventive): a big chain clear spreads its work; nothing looks, sounds or plays differently.
// The REAL shipped page in the harness, with a counting fake Web Audio.
//   S1 at most 8 new sounds start in a frame; extra ones are skipped, never delayed; a normal frame (a
//      fusion, a paddle hit, an orb pass) starts every sound as before; the next frame starts sounds again;
//   S2 one pre-made noise buffer (1 s, made once) instead of a new buffer per hit; each noise plays a random
//      slice of the same length as before, with the old buffer's linear fade (a gain ramp to 0 over dur)
//      ahead of the same band-pass filter and the same exponential gain;
//   S3 at most 160 new particles and 4 new popups appear in a frame; a single event (a lightning burst,
//      the game-over collapse) appears whole as before; a chain's extra ones appear over the next frames,
//      in order, same place and colour, none lost; a new run clears what waited;
//   S4 play and scoring unchanged: the same chain with the same random numbers gives main's score, combo,
//      ball and orbs, frame by frame.
// Ends with negative controls: each defect re-inserted MUST be caught.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const GAME_HTML = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
let MAIN_HTML = null; try { MAIN_HTML = execFileSync('git', ['show', 'origin/main:public/play/index.html'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) {}
const ORIGIN = 'https://flux.example';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/* A counting Web Audio stand-in. */
function fakeAudio() {
  const log = { buffers: [], sources: [], oscillators: 0, ramps: [], chains: [] };
  const param = (owner, name) => ({ value: 0, setValueAtTime(v, t) { log.ramps.push([owner, name, 'set', v, t]); }, linearRampToValueAtTime(v, t) { log.ramps.push([owner, name, 'lin', v, t]); }, exponentialRampToValueAtTime(v, t) { log.ramps.push([owner, name, 'exp', v, t]); } });
  let id = 0;
  const node = (kind, extra = {}) => { const n = Object.assign({ kind, id: ++id, out: [], connect(o) { this.out.push(o); return o; }, disconnect() {} }, extra); return n; };
  class AC {
    constructor() { this.state = 'running'; this.currentTime = 10; this.sampleRate = 48000; this.destination = node('dest'); }
    resume() { return Promise.resolve(); }
    createGain() { const n = node('gain'); n.gain = param(n, 'gain'); return n; }
    createOscillator() { const n = node('osc', { type: 'sine', start() { log.oscillators++; }, stop() {} }); n.frequency = param(n, 'freq'); return n; }
    createBiquadFilter() { const n = node('filter', { type: '' }); n.frequency = { value: 0 }; n.Q = { value: 0 }; return n; }
    createDynamicsCompressor() { const n = node('comp'); for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = { value: 0 }; return n; }
    createBuffer(ch, len, rate) { const data = new Float32Array(len); const b = { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, getChannelData: () => data }; log.buffers.push(b); return b; }
    createBufferSource() { const n = node('src', { buffer: null, start(when, offset, dur) { log.sources.push({ n, when, offset, dur }); }, stop() {} }); return n; }
    createMediaStreamDestination() { return node('msd', { stream: {} }); }
  }
  return { AC, log };
}

async function suite(gameHtml, quiet) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const keep = { fluxSeason: '1', fluxPlayerId: 'p-sm-1', fluxCallsign: 'TITAN', fluxCountry: 'PH', fluxProfileComplete: '1', fluxRunsPlayed: '9', fluxWelcomeDone: '1', fluxDifficulty: 'hard', fluxLite: '0',
    fluxEntitlementsV1: JSON.stringify({ v: 1, source: 'server', playerId: 'p-sm-1', skus: [], verifiedAt: Date.now() }),
    fluxLbCache: JSON.stringify({ at: Date.now(), data: { top: [], countries: [], boards: { easy: [], medium: [], hard: [] } } }) };
  const B = (html) => {
    const { store } = makeStore(Object.assign({}, keep));
    const g = boot(scriptsOf(html), { origin: ORIGIN, path: '/play/', store, standalone: false, fetchImpl: () => Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })) });
    g.ctx.Blob = Blob; g.win.navigator.sendBeacon = () => true;
    const timers = []; g.win.setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
    const fa = fakeAudio(); g.win.AudioContext = fa.AC;
    const run = (c) => vm.runInContext(c, g.ctx);
    return { g, run, timers, fa };
  };
  try {
    /* S1 */
    if (!quiet) console.log('== S1 sounds: at most 8 new ones a frame, extra ones skipped (never delayed) ==');
    const a = B(gameHtml); a.run('initAudio(); fxFrame && fxFrame();');
    const started = () => a.fa.log.oscillators + a.fa.log.sources.length;
    a.timers.length = 0; let s0 = started();
    a.run('playFusion(3)');
    ck('S1 one fusion starts its 2 sounds at once and schedules its 3rd (45 ms later) exactly as before', started() - s0 === 2 && a.timers.filter((t) => t.ms === 45).length === 1, (started() - s0) + ' started, timers ' + a.timers.map((t) => t.ms).join(','));
    a.run('fxFrame(); playPaddleHit(.8); playFusion(5); playOrbHit(12);'); s0 = started(); a.run('fxFrame();');
    a.run('playPaddleHit(.8); playFusion(5); playOrbHit(12);');
    ck('S1 a busy normal frame (paddle hit + fusion + orb pass: 6 sounds) starts every one of them', started() - s0 === 6, String(started() - s0));
    a.run('fxFrame();'); a.timers.length = 0; s0 = started();
    a.run('for(let i=0;i<10;i++) playFusion(3+i);');   // a 10-orb chain in one frame: 20 sounds at once
    const chainStarted = started() - s0, chainTimers = a.timers.map((t) => t.ms);
    ck('S1 a 10-fusion chain in one frame starts 8 sounds; the other 12 are skipped, not delayed (only the game\'s own 10 follow-up tones are scheduled)', chainStarted === 8 && chainTimers.length === 10 && chainTimers.every((m) => m === 45), chainStarted + ' started, timers ' + chainTimers.join(','));
    a.run('fxFrame();'); s0 = started(); a.run('playFusion(4)');
    ck('S1 the next frame starts sounds again', started() - s0 === 2, String(started() - s0));
    /* S2 */
    if (!quiet) console.log('== S2 one pre-made noise buffer ==');
    const nb = a.fa.log.buffers.length;
    for (let i = 0; i < 50; i++) a.run('fxFrame(); noise(' + [.025, .045, .075, .15, .28][i % 5] + ', .05, 900);');
    const srcs = a.fa.log.sources.slice(-50);
    ck('S2 50 hits use ONE noise buffer, made once (1 s, at the context\'s rate): no new buffer per hit', a.fa.log.buffers.length === 1 && nb <= 1 && a.fa.log.buffers[0].length === 48000 && srcs.every((x) => x.n.buffer === a.fa.log.buffers[0]), 'buffers ' + a.fa.log.buffers.length);
    ck('S2 each hit plays a random slice as long as before (dur + 10 ms), inside the buffer', srcs.every((x, i) => Math.abs(x.dur - ([.025, .045, .075, .15, .28][i % 5] + .01)) < 1e-9 && x.offset >= 0 && x.offset + x.dur <= 1 + 1e-9) && new Set(srcs.map((x) => x.offset)).size > 40, srcs.slice(0, 2).map((x) => x.offset.toFixed(3) + '/' + x.dur).join(' '));
    const last = srcs[srcs.length - 1].n, fade = last.out[0], filt = fade && fade.out[0], gain = filt && filt.out[0];
    const rampsOf = (n) => a.fa.log.ramps.filter((r) => r[0] === n).map((r) => r.slice(2));
    ck('S2 same shape as before: the old linear fade (1 → 0 over dur) ahead of the same band-pass filter (Q .7) and the same exponential gain (→ .0001 at dur)',
      fade && fade.kind === 'gain' && JSON.stringify(rampsOf(fade)) === JSON.stringify([['set', 1, 10], ['lin', 0, 10.28]]) && filt.kind === 'filter' && filt.type === 'bandpass' && filt.Q.value === .7 && filt.frequency.value === 900 &&
      gain.kind === 'gain' && JSON.stringify(rampsOf(gain)) === JSON.stringify([['set', .05, 10], ['exp', .0001, 10.28]]), JSON.stringify([rampsOf(fade), rampsOf(gain)]));
    /* S3 */
    if (!quiet) console.log('== S3 particles and popups: big chains spread over a few frames ==');
    const c = B(gameHtml); c.g.ctx.newGame(); c.run('juice=0; particles.length=0; texts.length=0; fxFrame();');
    c.run('burst(100,100,"#fff",68)');
    ck('S3 a single big event (a lightning burst, 68 particles) appears whole in its frame, as before', c.run('particles.length') === 68);
    c.run('fxFrame(); particles.length=0;');
    c.run('for(let i=0;i<10;i++){ burst(10*i,20*i,"#c"+i,48); popup(10*i,20*i,"+"+(100+i),"#c"+i); if(i%3===2) popup(10*i,20*i,"CLEARED •15","#ff8fae"); }');   // a 10-orb chain: 480 particles, 13 popups
    const f0 = [c.run('particles.length'), c.run('texts.length')];
    c.run('fxFrame()'); const f1 = [c.run('particles.length'), c.run('texts.length')];
    c.run('fxFrame()'); const f2 = [c.run('particles.length'), c.run('texts.length')];
    c.run('fxFrame()'); const f3 = [c.run('particles.length'), c.run('texts.length')];
    const order = c.run('JSON.stringify(particles.map(function(p){ return p.col; }))'), txt = c.run('JSON.stringify(texts.map(function(t){ return t.s; }))');
    ck('S3 a 10-orb chain: 160 particles and 4 popups in its frame, the rest over the next frames (160 / 4 more each), none lost',
      JSON.stringify([f0, f1, f2, f3]) === JSON.stringify([[160, 4], [320, 8], [480, 12], [480, 13]]), JSON.stringify([f0, f1, f2, f3]));
    const cols = JSON.parse(order), want = []; for (let i = 0; i < 10; i++) for (let k = 0; k < 48; k++) want.push('#c' + i);
    const wantTxt = []; for (let i = 0; i < 10; i++) { wantTxt.push('+' + (100 + i)); if (i % 3 === 2) wantTxt.push('CLEARED •15'); }
    ck('S3 ...in order, at the same place and colour (each made at the same moment as before)', JSON.stringify(cols) === JSON.stringify(want) && JSON.stringify(JSON.parse(txt)) === JSON.stringify(wantTxt) && c.run('particles[300].x') === 60 && c.run('particles[300].y') === 120);
    c.run('for(let i=0;i<10;i++) burst(0,0,"#fff",48);'); c.g.ctx.newGame();
    ck('S3 a new run clears what was waiting', c.run('fxParticleWait.length') === 0 && c.run('fxPopupWait.length') === 0);
    c.run('fxFrame(); particles.length=0; juice=0;'); c.run('level=3; score=5000; endGame();');
    ck('S3 the game-over collapse (70 particles) appears whole in its frame', c.run('particles.length') >= 70, String(c.run('particles.length')));
    ck('S3 the frame loop refills the budgets once per frame, before the frame\'s own events', /\n fxFrame\(\);[^\n]*\n if\(playing && !paused\) update\(dt\);/.test(gameHtml));
    /* S4 */
    if (!quiet) console.log('== S4 play and scoring unchanged (same chain, same random numbers, main vs this build) ==');
    if (MAIN_HTML) {
      const play = (html) => {
        const realRandom = Math.random; let seed = 12345; Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        try {
          const x = B(html); x.g.ctx.newGame(); x.run('juice=.8; level=9; score=150000; combo=10;');
          const states = []; let ts = 1000;
          for (let fr = 0; fr < 90; fr++) {
            if (fr % 30 === 5) x.run('(function(){ const n=coloursInPlay(); let c=ball.color; for(let k=0;k<10;k++){ targets.push({x:ball.x,y:ball.y,r:20,color:c,spin:0,vx:0,vy:0,phase:0,age:1,danger:k%3===2}); c=(c+1)%n; } })()');
            ts += 16; x.run('misses=0;'); x.g.ctx.loop(ts);
            states.push(x.run('JSON.stringify([score,combo,Math.round(ball.x*1000),Math.round(ball.y*1000),ball.color,targets.length,targets.map(function(t){ return [Math.round(t.x),Math.round(t.y),t.color]; })])'));
          }
          return states;
        } finally { Math.random = realRandom; }
      };
      const m = play(MAIN_HTML), n = play(gameHtml);
      const firstDiff = m.findIndex((v, i) => v !== n[i]);
      ck('S4 three 10-orb chains at 150,000 on Hard, 90 frames: score, combo, ball and every orb equal main\'s on every frame', firstDiff === -1 && JSON.parse(n[89])[0] > 150000, firstDiff === -1 ? 'score ' + JSON.parse(n[89])[0] : 'frame ' + firstDiff + ': ' + m[firstDiff].slice(0, 80) + ' vs ' + n[firstDiff].slice(0, 80));
    }
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
await control('no sound cap', 'S1', rep('function fxSoundSlot(){ if(fxSoundsLeft<=0) return false; fxSoundsLeft--; return true; }', 'function fxSoundSlot(){ return true; }'));
await control('extra sounds delayed to a later frame instead of skipped', 'S1', rep("  if(!fxSoundSlot()) return;   // SMOOTH CHAINS: the frame's sound budget is spent\n", "  if(!fxSoundSlot()){ const a=arguments; setTimeout(function(){ tone.apply(null,a); },16); return; }\n"));
await control('a new noise buffer per hit again', 'S2', rep('  if(fxNoiseBuf && fxNoiseBuf.sampleRate===audioCtx.sampleRate) return fxNoiseBuf;\n', ''));
await control('the old fade lost', 'S2', rep('fade.gain.linearRampToValueAtTime(0,now+dur);', ''));
await control('no particle cap', 'S3', rep('function fxParticle(p){ if(fxParticlesLeft>0){', 'function fxParticle(p){ if(true){'));
await control('extra particles dropped instead of spread', 'S3', rep('else if(fxParticleWait.length<FX_WAIT_MAX) fxParticleWait.push(p); }', '}'));
await control('no popup cap', 'S3', rep('function fxPopup(t){ if(fxPopupsLeft>0){', 'function fxPopup(t){ if(true){'));
await control('a cap so low a single event is split', 'S3', rep('FX_PARTICLES_PER_FRAME=160', 'FX_PARTICLES_PER_FRAME=40'));
await control('budgets never refilled by the frame loop', 'S3', rep(' fxFrame();   // SMOOTH CHAINS:', ' // SMOOTH CHAINS:'));
await control('waiting particles re-randomised when they appear (random numbers out of step)', 'S4', rep('for(let i=0;i<k;i++) particles.push(fxParticleWait[i]);', 'for(let i=0;i<k;i++){ fxParticleWait[i].vx=rand(-5,5); particles.push(fxParticleWait[i]); }'));
const total = res.F + NC;
console.log('\n' + (total ? 'SMOOTH CHAINS FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'SMOOTH CHAINS PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
