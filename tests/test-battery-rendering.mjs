// BATTERY / HEAT, PR B -- GAMEPLAY RENDERING (owner). Real game page in the harness vm; the game canvas is
// replaced by a recording 2D context, so every fill / stroke / stamp and its glow (shadowBlur) is seen.
//   R1 GLOW SPRITES: every particle and trail glow is stamped from a sprite (no blurred circle is drawn
//      live); a sprite is made once per colour, as the shadow alone with the same blur (r*1.8) and colour,
//      scaled to r; the circle itself is still drawn live after its glow, with the same alpha;
//   R2 LAUNCHER: at rest the grip's and the bar's glows are stamped from sprites (made once); during the
//      hit pulse every frame is drawn live with the same glow as before (bar 32+ease*24, grip 18, the
//      underglow 44+ease*30), so it punches in and fades out the same; also live during the grip pulse at
//      the start of a run and while the launcher narrows after a level-up;
//   R3 LITE: no glow anywhere, no sprite; the menu field copy draws no glow either;
//   R4 GRADIENTS: in a steady run no gradient is created per frame (orbs, ball, launcher, nebulae,
//      ceiling, edge light); a growing orb's is made fresh (its size changes); same colour stops;
//   R5 ALLOCATIONS: particles and texts are dropped in place (same array, same survivors, same order);
//      the ball trail keeps 10 points, newest first, reusing the oldest point.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// A recording 2D context: drawing state (with save / restore) and a log of what is painted.
const RECORDER = `
(function(){
  var KEYS=['fillStyle','strokeStyle','globalAlpha','lineWidth','lineCap','shadowColor','shadowOffsetX','shadowOffsetY','font','textAlign','textBaseline','globalCompositeOperation','lineJoin'];
  function Rec(canvas){ this.canvas=canvas; this.log=[]; this.grads=0; this.stack=[]; this._sb=0;
    this.fillStyle='#000';this.strokeStyle='#000';this.globalAlpha=1;this.lineWidth=1;this.lineCap='butt';this.shadowColor='rgba(0,0,0,0)';this.shadowOffsetX=0;this.shadowOffsetY=0;this.font='10px sans-serif';this.textAlign='start';this.textBaseline='alphabetic';this.globalCompositeOperation='source-over';this.lineJoin='miter'; }
  Object.defineProperty(Rec.prototype,'shadowBlur',{configurable:true,get:function(){ return this._sb; },set:function(v){ this._sb=v; }});
  var P=Rec.prototype;
  P.save=function(){ var s={sb:this.shadowBlur}; for(var i=0;i<KEYS.length;i++) s[KEYS[i]]=this[KEYS[i]]; this.stack.push(s); };
  P.restore=function(){ var s=this.stack.pop(); if(!s) return; this.shadowBlur=s.sb; for(var i=0;i<KEYS.length;i++) this[KEYS[i]]=s[KEYS[i]]; };
  P.rec=function(op,extra){ var e={op:op,blur:this.shadowBlur,col:this.shadowColor,alpha:this.globalAlpha,lw:this.lineWidth,fill:this.fillStyle,stroke:this.strokeStyle,ox:this.shadowOffsetX}; if(extra) for(var k in extra) e[k]=extra[k]; this.log.push(e); };
  P.fill=function(){ this.rec('fill'); }; P.stroke=function(){ this.rec('stroke'); };
  P.fillRect=function(){ this.rec('fillRect'); }; P.strokeRect=function(){ this.rec('strokeRect'); };
  P.fillText=function(s){ this.rec('fillText',{s:s}); }; P.strokeText=function(s){ this.rec('strokeText',{s:s}); };
  P.drawImage=function(img,a,b,c,d){ this.rec('drawImage',{img:img,x:a,y:b,w:c,h:d}); };
  function grad(kind,args){ return {kind:kind,args:args,stops:[],addColorStop:function(o,c){ this.stops.push([o,c]); }}; }
  P.createLinearGradient=function(){ this.grads++; return grad('linear',[].slice.call(arguments)); };
  P.createRadialGradient=function(){ this.grads++; return grad('radial',[].slice.call(arguments)); };
  P.createPattern=function(){ return {}; };
  P.measureText=function(s){ return {width:String(s).length*7,actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}; };
  P.getLineDash=function(){ return []; }; P.setLineDash=function(){};
  P.getImageData=function(){ return {data:new Uint8ClampedArray(4)}; }; P.putImageData=function(){};
  ['beginPath','closePath','moveTo','lineTo','arc','arcTo','ellipse','rect','roundRect','quadraticCurveTo','bezierCurveTo','clip','translate','rotate','scale','setTransform','resetTransform','transform','clearRect'].forEach(function(m){ P[m]=function(){}; });
  window.CanvasRenderingContext2D=Rec;
  window.__canvases=[];
  window.__Canvas=function(){ this.width=300; this.height=150; this.style={}; this._x=null; __canvases.push(this); };
  __Canvas.prototype.getContext=function(){ return this._x||(this._x=new Rec(this)); };
  __Canvas.prototype.toDataURL=function(){ return 'data:,'; };
  var ce=document.createElement; document.createElement=function(t){ return t==='canvas' ? new __Canvas() : ce(t); };
  window.__main=new __Canvas(); __canvases.length=0;
})();`;

function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const start = (opts = {}) => {
    const { store } = makeStore({ fluxPlayerId: 'br-1', fluxCallsign: 'TITAN', fluxProfileComplete: '1', fluxRunsPlayed: '9', fluxColorHintSeen: '1', fluxDifficulty: 'hard', fluxSeason: '1' });
    const g = boot(scriptsOf(html), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    g.ctx.readSafeBottom = () => 34; run('innerWidth=390; innerHeight=844;'); g.ctx.resize();
    run(RECORDER);
    run(`ctx=__main.getContext('2d'); fluxPerfN=1e9; difficulty='hard';`);
    if (opts.lite) run('window.__fluxLite=true; fluxApplyLite();');
    g.ctx.newGame();
    run(`playing=true; paused=false; level=6; speedLevel=6; paddle.w=paddleWidthFor(6); gripPulse=0; paddle.hitFlash=0; juice=.8; fluxMode=0; shake=0;
      targets=targets.filter(function(t){ return !t.bonus && !t.growing; });
      ball.trail=[]; for(var i=0;i<10;i++) ball.trail.push({x:ball.x-i*4,y:ball.y+i*6});
      particles.length=0; burst(W*.3,H*.4,colors[0],14); burst(W*.6,H*.5,colors[1],14); juiceBurst(W*.5,H*.45,colors[2],22);
      for(var q of particles){ q.life=.5; }
      window.__gc=0; var __g0=glowCircle; glowCircle=function(){ __gc++; return __g0.apply(this,arguments); };`);
    const frame = () => { run('ctx.log.length=0; draw();'); };
    const log = () => run('ctx.log');
    return { g, run, frame, log };
  };
  const isSprite = (A) => A.run('(function(){ var s=new Set(); glowSprites.forEach(function(v){ s.add(v.c); }); return s; })()');
  const launcherSprites = (A) => A.run('(function(){ var s=new Set(); launcherGlows.forEach(function(v){ s.add(v.c); }); return s; })()');

  // R1 -------------------------------------------------------------------------------------------
  try {
    const A = start();
    A.frame(); A.run('__canvases.length=0; __gc=0;');
    for (let i = 0; i < 30; i++) A.frame();
    const L = A.log(), sp = isSprite(A), gc = A.run('__gc') / 30, made = A.run('__canvases.length');
    const stamps = L.filter((e) => e.op === 'drawImage' && sp.has(e.img)).length;
    const glowCols = new Set(A.run('particles.map(function(p){ return p.col; }).concat([colors[ball.color]])'));
    const blurredFills = L.filter((e) => e.op === 'fill' && e.blur > 0 && glowCols.has(e.fill)).length;
    ck('R1 every particle and trail glow is stamped from a sprite (one stamp per glow, no blurred circle drawn live)', gc > 40 && stamps === gc && blurredFills === 0, JSON.stringify({ glowsPerFrame: gc, stamps, blurredFills }));
    ck('R1 ...sprites are made once per colour, not per frame (30 frames: no new canvas)', made === 0 && A.run('glowSprites.size') === glowCols.size, JSON.stringify({ made, sprites: A.run('glowSprites.size'), colours: glowCols.size }));
    const A2 = start(); A2.run('glowSprites=new Map(); __canvases.length=0; glowCircle(100,100,8,"#ff4060",.5);');
    const sc = A2.run('__canvases[0]'), sl = A2.run('__canvases[0]._x.log'), st = A2.run('ctx.log');
    const one = sl.length === 1 ? sl[0] : {}; const dpr = A2.run('dpr');
    ck('R1 ...the sprite is the glow alone: same blur (r*1.8 at r=16), same colour, the shape kept off the sprite', sl.length === 1 && one.op === 'fill' && one.blur === 16 * 1.8 && one.col === '#ff4060' && one.ox === -10000 * dpr, JSON.stringify(one).slice(0, 160));
    const im = st.find((e) => e.op === 'drawImage'), circ = st.find((e) => e.op === 'fill');
    const half = A2.run('glowSprites.get("#ff4060").half');
    ck('R1 ...stamped scaled to r (8/16), centred, at the glow alpha; then the circle, live, same alpha', im && im.img === sc && Math.abs(im.w - half) < 1e-9 && Math.abs(im.x - (100 - half / 2)) < 1e-9 && im.alpha === .5 && circ && circ.fill === '#ff4060' && circ.alpha === .5 && circ.blur === 0 && st.indexOf(im) < st.indexOf(circ), JSON.stringify({ w: im && im.w, half, a: im && im.alpha }));
    ck('R1 ...the sprite is big enough for its blur (margin at least 1.6 x blur past the circle)', half >= 16 + 16 * 1.8 * 1.6, String(half));
  } catch (e) { ck('R1 section ran', false, String(e.stack || e).slice(0, 300)); }

  // R2 -------------------------------------------------------------------------------------------
  try {
    const A = start();
    const bar = (L) => { return L.filter((e) => e.op === 'stroke' && typeof e.stroke === 'object' && e.stroke && e.stroke.kind === 'linear'); };
    A.frame(); A.run('__canvases.length=0;');
    for (let i = 0; i < 20; i++) A.frame();
    let L = A.log(); const ls = launcherSprites(A);
    const st = L.filter((e) => e.op === 'drawImage' && ls.has(e.img));
    const gripStem = L.filter((e) => e.op === 'stroke' && e.lw === 8);
    const under = L.filter((e) => e.op === 'stroke' && typeof e.stroke === 'string' && e.blur >= 44);
    ck('R2 at rest: the grip and bar glows are 2 sprite stamps; the grip and the bar are drawn with no live blur', st.length === 2 && gripStem.length === 1 && gripStem[0].blur === 0 && bar(L, A).length === 1 && bar(L, A)[0].blur === 0 && A.run('__canvases.length') === 0, JSON.stringify({ stamps: st.length, grip: gripStem.map((e) => e.blur), bar: bar(L, A).map((e) => e.blur) }));
    ck('R2 ...the underglow is still drawn live (blur 44)', under.length === 1 && under[0].blur === 44, JSON.stringify(under.map((e) => e.blur)));
    // hit pulse: punch in, fade out
    const seq = [1, .9, .7, .5, .3, .15, .05, .01], got = [];
    for (const hf of seq) {
      A.run('paddle.hitFlash=' + hf + ';'); A.frame(); L = A.log();
      const ease = hf * hf * (3 - 2 * hf);
      const b = bar(L, A), gs = L.filter((e) => e.op === 'stroke' && e.lw === 8), u = L.filter((e) => e.op === 'stroke' && typeof e.stroke === 'string' && e.blur >= 44);
      const stamps = L.filter((e) => e.op === 'drawImage' && ls.has(e.img)).length;
      got.push(stamps === 0 && b.length === 1 && Math.abs(b[0].blur - (32 + ease * 24)) < 1e-9 && gs.length === 1 && gs[0].blur === 18 && u.length === 1 && Math.abs(u[0].blur - (44 + ease * 30)) < 1e-9);
    }
    ck('R2 hit pulse: every frame live with the same glow (bar 32+ease*24, grip 18, underglow 44+ease*30), no stamp', got.every(Boolean), got.join(','));
    A.run('paddle.hitFlash=0; gripPulse=.8;'); A.frame(); L = A.log();
    ck('R2 grip pulse at the start of a run: drawn live (no stamp, grip glow 18, bar 32)', L.filter((e) => e.op === 'drawImage' && ls.has(e.img)).length === 0 && L.filter((e) => e.op === 'stroke' && e.lw === 8)[0].blur === 18 && bar(L, A)[0].blur === 32, '');
    A.run('gripPulse=0; level=7;'); A.frame(); L = A.log();
    ck('R2 while the launcher narrows after a level-up: drawn live (no sprite made per frame)', L.filter((e) => e.op === 'drawImage' && ls.has(e.img)).length === 0 && bar(L, A)[0].blur === 32, '');
  } catch (e) { ck('R2 section ran', false, String(e.stack || e).slice(0, 300)); }

  // R3 -------------------------------------------------------------------------------------------
  try {
    const A = start({ lite: true });
    A.run('__canvases.length=0;');
    for (let i = 0; i < 5; i++) A.frame();
    const L = A.log();
    ck('R3 LITE: no glow drawn, no sprite made or stamped', L.every((e) => !(e.blur > 0)) && L.filter((e) => e.op === 'drawImage').length === 0 && A.run('glowSprites.size + launcherGlows.size') === 0, JSON.stringify({ blurred: L.filter((e) => e.blur > 0).length, stamps: L.filter((e) => e.op === 'drawImage').length }));
    A.run('endGame(); playing=false; fieldCopy=null; fieldCopyKey=null;'); A.frame();
    const fc = A.run('fieldCopy && fieldCopy._x'); const fl = fc ? fc.log : [];
    ck('R3 LITE: the menu field copy draws no glow either', !!fc && fl.length > 0 && fl.every((e) => !(e.blur > 0)), JSON.stringify({ ops: fl.length, blurred: fl.filter((e) => e.blur > 0).length }));
  } catch (e) { ck('R3 section ran', false, String(e.stack || e).slice(0, 300)); }

  // R4 -------------------------------------------------------------------------------------------
  try {
    const A = start();
    A.frame(); A.run('ctx.grads=0;');
    for (let i = 0; i < 30; i++) A.frame();
    const n = A.run('ctx.grads');
    ck('R4 steady run: no gradient created per frame (orbs, ball, launcher, nebulae, ceiling, edge light)', n === 0, String(n));
    const g = A.run('(function(){ var c=colors[0], r=targets[0].r, g=orbGradient(c,r); return { a:g.args, s:g.stops, want:[[0,shadeHex(c,.18)],[.5,c],[1,shadeHex(c,-.30)]], r:r }; })()');
    ck('R4 ...an orb gradient has the same stops as before, around its centre (0,-r)-(0,r)', JSON.stringify(g.s) === JSON.stringify(g.want) && JSON.stringify(g.a) === JSON.stringify([0, -g.r, 0, g.r]), JSON.stringify(g.s));
    A.run('targets.push({x:W/2,y:H*.3,r:14,maxR:34,color:0,spin:0,vx:0,vy:0,phase:0,age:1,growing:true,matured:false,danger:false}); ctx.grads=0;');
    for (let i = 0; i < 5; i++) A.frame();
    ck('R4 ...a growing orb (its size changes) gets a fresh gradient each frame', A.run('ctx.grads') === 5, String(A.run('ctx.grads')));
  } catch (e) { ck('R4 section ran', false, String(e.stack || e).slice(0, 300)); }

  // R5 -------------------------------------------------------------------------------------------
  try {
    const A = start();
    A.run('for(var q of particles){ q.life=Math.random(); } texts.length=0; popup(100,100,"A","#fff"); popup(100,100,"B","#fff"); texts[0].life=.01;');
    const r = A.run(`(function(){
      var pa=particles, ta=texts, want=particles.map(function(p){ return {x:p.x,y:p.y,vx:p.vx,vy:p.vy,life:p.life,col:p.col}; });
      var dt=1/60; want.forEach(function(p){ p.x+=p.vx*dt*60; p.y+=p.vy*dt*60; p.vy+=.08*dt*60; p.life-=dt*1.8; }); want=want.filter(function(p){ return p.life>0; });
      var t0=ball.trail[9], t1=ball.trail[0], bx=ball.x, by=ball.y;
      update(dt);
      var got=particles.map(function(p){ return {x:p.x,y:p.y,vx:p.vx,vy:p.vy,life:p.life,col:p.col}; });
      return { same:particles===pa && texts===ta, eq:JSON.stringify(got)===JSON.stringify(want), n:got.length, texts:texts.map(function(t){ return t.s; }).join(''),
        trail:ball.trail.length, newest:ball.trail[0]===t0 && ball.trail[1]===t1, pos:ball.trail[0].x===bx && ball.trail[0].y===by };
    })()`);
    ck('R5 particles and texts dropped in place: same arrays, same survivors in the same order, same motion', r.same && r.eq && r.n > 0 && r.texts === 'B', JSON.stringify(r));
    ck('R5 the ball trail keeps 10 points, newest first (where the ball was this frame), reusing the oldest point', r.trail === 10 && r.newest && r.pos, JSON.stringify(r));
  } catch (e) { ck('R5 section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const t0 = Date.now();
const res = suite(GAME_HTML);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
function control(label, expect, mut) {
  const h = mut(GAME_HTML);
  if (h === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(h, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
control('particle glow drawn live (blurred) again', 'R1 every particle', rep(' const g=glowSprite(col), k=r/GLOW_REF;\n ctx.save();ctx.globalAlpha=alpha;\n ctx.drawImage(g.c,x-g.half*k,y-g.half*k,g.half*2*k,g.half*2*k);', ' ctx.save();ctx.globalAlpha=alpha;ctx.shadowBlur=r*1.8;ctx.shadowColor=col;'));
control('glow sprite made every time', 'R1 ...sprites are made once', rep(' let s=glowSprites.get(col); if(s) return s;', ' let s;'));
control('glow sprite with a different blur', 'R1 ...the sprite is the glow alone', rep('x.shadowBlur=R*1.8;x.shadowColor=col;', 'x.shadowBlur=R*1.2;x.shadowColor=col;'));
control('glow sprite too small for its blur (rings at the edge)', 'R1 ...the sprite is big enough', rep('half=R+R*1.8*1.6+2,', 'half=R+R*1.8*1.6/dpr+2,'));
control('hit pulse stamped from the resting sprite', 'R2 hit pulse', rep(' const restGlow=ease===0 && ', ' const restGlow='));
control('grip pulse stamped', 'R2 grip pulse', rep(' && !(gripPulse>0) && !(speedLevel<level)', ' && !(speedLevel<level)'));
control('a launcher sprite made every frame while it narrows', 'R2 while the launcher narrows', rep(' && !(speedLevel<level) && !window.__fluxLite;', ' && !window.__fluxLite;'));
control('Lite glow left on in the menu field copy', 'R3 LITE: the menu field copy', rep("   if(window.__fluxLite) fluxLockGlow(fc);", ''));
control('orb gradient made every frame again', 'R4 steady run', rep(' const key=col+\'|\'+r; let g=fresh?null:orbGrads.get(key); if(g) return g;', ' const key=col+\'|\'+r; let g=null;'));
control('a growing orb taking a stale cached gradient', 'R4 ...a growing orb', rep("     blockOrb(t.x,t.y,t.r,colors[t.color],true);", "     blockOrb(t.x,t.y,t.r,colors[t.color]);"));
control('particles filtered into a new array again', 'R5 particles', rep('particles.length=n;}', 'particles.length=n;particles=particles.slice();}'));
control('a new trail point every frame', 'R5 the ball trail', rep('const q=ball.trail.length>=10?ball.trail.pop():{};', 'if(ball.trail.length>=10)ball.trail.pop();const q={};'));
const total = res.F + NC;
console.log('\n' + (total ? 'BATTERY RENDERING FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'BATTERY RENDERING PASSED: all checks and all negative controls') + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(total ? 1 : 0);
