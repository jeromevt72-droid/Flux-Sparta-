let log=[], F=0;
const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':'')); if(!c)F++;};
const ORIGIN='https://flux-gateway.example';
const GAME='https://flux-sparta-3.jeromevt72.workers.dev';

// ---- demo iframe ----
let rafTicks=0, aiTicks=0, restarts=0;
const demo={ __heroSuspended:false, __heroAudioOn:false, gain:0.52, ctx:'running', last:0,
  fluxHeroSuspend(s){ demo.__heroSuspended=!!s; if(!s) demo.last=1234; },
  fluxHeroAudio(on){ demo.__heroAudioOn=!!on; demo.gain=on?0.52:0; demo.ctx=on?'running':'suspended'; },
  recv(e){ if(e.origin!==ORIGIN){ log.push('rejected'); return; }
    const d=e.data; if(!d) return;
    if(d.type==='flux-hero-audio') demo.fluxHeroAudio(!!d.on);
    else if(d.type==='flux-hero-suspend') demo.fluxHeroSuspend(!!d.suspend); },
  loop(){ if(demo.__heroSuspended){ return; } rafTicks++; },
  ai(){ if(demo.__heroSuspended) return; aiTicks++; },
  restart(){ if(demo.__heroSuspended) return; restarts++; } };

// ---- gateway ----
let pillVisible=true;
const gw={ __gwSoundOn:false,
  post:m=>demo.recv({data:m,origin:ORIGIN}),
  setAudio(on){ gw.post({type:'flux-hero-audio',on}); },
  setSusp(s){ gw.post({type:'flux-hero-suspend',suspend:s}); },
  open(){ pillVisible=true; gw.setAudio(false); gw.setSusp(true); },
  close(){ gw.setSusp(false); gw.setAudio(gw.__gwSoundOn===true); },
  fromGame(e){ if(e.origin!==GAME) return;
    const t=e.data&&e.data.type;
    if(t==='flux-playing') pillVisible=false;
    else if(t==='flux-gameover') pillVisible=true;
    else if(t==='flux-menu') pillVisible=true; } };

console.log('-- D-01: demo does no work while the game is open --');
for(let i=0;i<10;i++){demo.loop();demo.ai();} demo.restart();
const base={rafTicks,aiTicks,restarts};
gw.open();
for(let i=0;i<60;i++){demo.loop();demo.ai();} demo.restart();
ck('render loop stopped', rafTicks===base.rafTicks, rafTicks+' vs '+base.rafTicks);
ck('paddle-AI interval stopped', aiTicks===base.aiTicks);
ck('17s auto-restart stopped', restarts===base.restarts);
ck('demo audio silenced', demo.gain===0);
ck('AudioContext suspended', demo.ctx==='suspended');

console.log('\n-- D-01: resume restores it, with a re-anchored clock --');
gw.__gwSoundOn=true; gw.close();
for(let i=0;i<5;i++){demo.loop();demo.ai();}
ck('render loop resumed', rafTicks===base.rafTicks+5);
ck('clock re-anchored (no dt jump)', demo.last===1234);
ck('audio restored to toggle state', demo.gain===0.52);

console.log('\n-- D-01: resume respects a MUTED toggle --');
gw.open(); gw.__gwSoundOn=false; gw.close();
ck('stays muted', demo.gain===0);
ck('but still resumes gameplay', demo.__heroSuspended===false);

console.log('\n-- §9 security regression: hostile origin --');
const g0=demo.gain, s0=demo.__heroSuspended;
demo.recv({data:{type:'flux-hero-suspend',suspend:true},origin:'https://evil.example'});
demo.recv({data:{type:'flux-hero-audio',on:true},origin:'https://evil.example'});
ck('hostile suspend ignored', demo.__heroSuspended===s0);
ck('hostile audio ignored', demo.gain===g0);
ck('rejections logged', log.filter(x=>x==='rejected').length===2);

console.log('\n-- §9 malformed messages --');
let threw=false;
[null,undefined,'str',42,{},{type:'flux-hero-suspend'},{type:'unknown'},[]].forEach(d=>{
  try{ demo.recv({data:d,origin:ORIGIN}); }catch(e){ threw=true; }});
ck('no crash on malformed', !threw);
ck('missing "suspend" treated as false', demo.__heroSuspended===false);

console.log('\n-- D-08: pill lifecycle across every exit path --');
gw.fromGame({data:{type:'flux-playing'},origin:GAME});
ck('pill hidden during run', pillVisible===false);
gw.fromGame({data:{type:'flux-gameover'},origin:GAME});
ck('returns on game over', pillVisible===true);
gw.fromGame({data:{type:'flux-playing'},origin:GAME});
gw.fromGame({data:{type:'flux-menu'},origin:GAME});
ck('returns on QUIT (the D-08 bug)', pillVisible===true);
gw.fromGame({data:{type:'flux-playing'},origin:GAME});
gw.fromGame({data:{type:'flux-menu'},origin:'https://evil.example'});
ck('hostile flux-menu ignored', pillVisible===false);
gw.open();
ck('reopening overlay shows pill', pillVisible===true);

console.log('\n'+'='.repeat(46));
console.log(F? '  '+F+' FAILED' : '  ALL D-01 / D-08 TESTS PASSED');
console.log('='.repeat(46));
process.exit(F?1:0);
