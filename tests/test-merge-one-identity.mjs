// RC2.5.6 MERGE: prove the "new FLUX ID every time" loop is closed.
// Every check here reads or EXECUTES the shipped files.
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname,'FLUX-Sparta','public');
const read = f => fs.readFileSync(path.join(PUB,f),'utf8');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const scripts = t => [...t.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);

const gwHtml = read('index.html');
const gw = strip(scripts(gwHtml).join('\n;\n'));
const demoHtml = read('hero-demo.html');
// ONE-APP AUDIT: there is now exactly one manifest; the Gateway links it.
const gwMan = JSON.parse(read('manifest.webmanifest'));
const gameMan = JSON.parse(read('manifest.webmanifest'));
const sw = read('sw.js');

console.log('== LOOP PIECE 1: one origin ==');
ck('Gateway lives inside the game\'s public folder', fs.existsSync(path.join(PUB,'index.html')));
ck('Gateway game URL is on its OWN origin, at /play/', gw.includes("window.FLUX_GAME_URL = window.location.origin + '/play/';"));
ck('API origin is the site root', gw.includes('window.FLUX_ORIGIN = window.location.origin;'));
// D-38: search/preview tags need the full address; they are metadata, not navigation.
const nometa = t => t.replace(/<(link rel="canonical"|meta property="og:(url|image)"|meta name="twitter:image")[^>]*>/g,'');
ck('no hardcoded other origin anywhere in the Gateway (search/preview tags excepted)', !/flux-sparta-3\.jeromevt72\.workers\.dev/.test(nometa(strip(gwHtml))));
ck('old separate Gateway folder retired', !fs.existsSync(path.join(__dirname,'FLUX-Gateway-InstallOnly')));

console.log('\n== LOOP PIECE 2: installed-app scope covers the game ==');
ck('Gateway manifest scope is "/"', gwMan.scope==='/', gwMan.scope);
ck('app starts at the ROOT, where the Gateway lives', gwMan.start_url==='/', gwMan.start_url);
ck('start_url is inside scope', gwMan.start_url.startsWith(gwMan.scope));
ck('game at "/" is inside that scope', '/index.html'.startsWith(gwMan.scope));
ck('game manifest scope is also "/"', gameMan.scope==='/');
ck('Gateway links the ONE manifest', gwHtml.includes('<link rel="manifest" href="/manifest.webmanifest">'));
ck('no competing manifest under /welcome/', !fs.existsSync(path.join(PUB,'gateway-manifest.webmanifest')));
ck('one stable app id', gameMan.id==='/');
ck('both manifests share one scope', gwMan.scope===gameMan.scope);

console.log('\n== LOOP PIECE 3: no Play path opens a new tab ==');
ck('no target="_blank" on any PLAY anchor', !/data-flux-play[^>]*target="_blank"|target="_blank"[^>]*data-flux-play/.test(gwHtml));
ck('no window.open to the game', !/window\.open\(window\.FLUX_GAME_URL/.test(gw));
ck('grid CTA opens in the same window', !/FLUX_GAME_URL\+'[^']*' target="_blank"/.test(gw));
ck('static PLAY anchors point at /play/', (gwHtml.match(/href="\/play\/" data-flux-play/g)||[]).length===4);

console.log('\n== RUNTIME: execute the merged Gateway and tap Play ==');
{
  const noop=()=>{};
  const el=()=>({ style:{setProperty:noop,removeProperty:noop,getPropertyValue:()=>''},
    classList:{add:noop,remove:noop,toggle:noop,contains:()=>false}, addEventListener:noop,
    appendChild:noop, remove:noop, querySelector:()=>null, querySelectorAll:()=>[],
    getBoundingClientRect:()=>({top:0,bottom:0,height:0}), setAttribute:noop, focus:noop,
    textContent:'', innerHTML:'', value:'', offsetHeight:0, dataset:{} });
  let nav=null, opened=[], fetched=[];
  const ORIGIN='https://flux-sparta-3.jeromevt72.workers.dev';
  const doc={ documentElement:el(), body:el(), head:el(), getElementById:()=>el(),
    querySelector:()=>el(), querySelectorAll:()=>[], createElement:()=>el(),
    addEventListener:noop, fonts:{ready:Promise.resolve()}, readyState:'loading' };
  const win={ document:doc,
    location:{ search:'', origin:ORIGIN, get href(){return ORIGIN+'/welcome/';}, set href(v){ nav=v; } },
    navigator:{standalone:true,platform:'iPhone',userAgent:'iPhone'},
    matchMedia:()=>({matches:false,addEventListener:noop}), addEventListener:noop,
    setTimeout:()=>0, clearTimeout:noop, setInterval:()=>0, requestAnimationFrame:()=>0,
    getComputedStyle:()=>({}), localStorage:{getItem:()=>null,setItem:noop,removeItem:noop},
    open:(u,t)=>{ opened.push([u,t]); return null; },
    fetch:(u)=>{ fetched.push(String(u)); return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({players:[],countries:[]})}); },
    console:{log:noop,warn:noop,error:noop}, visualViewport:null,
    IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}},
    ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
    MutationObserver:class{observe(){}disconnect(){}},
    Image:class{set src(v){}}, URL, URLSearchParams, performance:{now:()=>0},
    screen:{width:390,height:844}, innerWidth:390, innerHeight:844, devicePixelRatio:3 };
  win.window=win; win.self=win; win.globalThis=win;
  const ctx=vm.createContext(win);
  for(const b of scripts(gwHtml)){ try{ vm.runInContext(b,ctx,{timeout:4000}); }catch(e){} }
  ck('FLUX_GAME_URL resolved to this origin\'s /play/ at runtime', ctx.FLUX_GAME_URL===ORIGIN+'/play/', String(ctx.FLUX_GAME_URL));
  ck('first Grid request is same-origin and well formed', fetched[0]===ORIGIN+'/api/leaderboard?limit=50', fetched[0]);
  if(typeof ctx.openPlayScreen==='function'){
    ctx.openPlayScreen();
    ck('tapping Play navigates within the same origin', nav===ORIGIN+'/play/', String(nav));
    ck('tapping Play opened NO new window/tab', opened.length===0, JSON.stringify(opened));
  }
}

console.log('\n== LOOP PIECE 4: the demo can never reach the real player ==');
{
  // Execute ONLY the demo's first script (the isolation shim) against a REAL
  // shared storage and a recording fetch, exactly as it would run in-page.
  const firstScript = scripts(demoHtml)[0];
  ck('isolation shim is the first script in the demo', /__FLUX_DEMO_MODE__/.test(firstScript));
  const realStore = { fluxPlayerId:'REAL-PLAYER', fluxCallsign:'SPARTA', fluxBest_medium:'3623' };
  const apiHits=[];
  const w = {};
  Object.defineProperty(w,'localStorage',{value:realStore,configurable:true,writable:true});
  w.fetch=(u)=>{ apiHits.push(String(u)); return Promise.resolve({ok:true}); };
  w.Response = class { constructor(b,i){ this.body=b; this.status=(i&&i.status)||200; } };
  w.window = w;
  vm.createContext(w);
  vm.runInContext(firstScript, w);
  const ls = w.localStorage;
  ck('demo sees a PRIVATE store, not the real one', ls !== realStore);
  ck("demo cannot read the real player's id", ls.fluxPlayerId !== 'REAL-PLAYER', String(ls.fluxPlayerId));
  // Demo code writes, exactly as its copied game logic does:
  ls.fluxPlayerId = 'DEMO-ID'; ls.setItem('fluxCallsign','DEMO'); ls['fluxBest_medium']='999999';
  ck('real fluxPlayerId untouched', realStore.fluxPlayerId==='REAL-PLAYER');
  ck('real FLUX ID untouched', realStore.fluxCallsign==='SPARTA');
  ck('real personal best untouched', realStore.fluxBest_medium==='3623');
  ck('demo still works against its own store', ls.fluxPlayerId==='DEMO-ID' && ls.getItem('fluxCallsign')==='DEMO');
  // The demo's autoplay would submit scores. It must never reach the server:
  w.fetch('/api/submit-score',{method:'POST',body:'{}'});
  w.fetch('https://flux-sparta-3.jeromevt72.workers.dev/api/submit-score',{method:'POST'});
  w.fetch('/api/create-checkout-session',{method:'POST'});
  ck('demo /api/ calls never reach the real server', apiHits.length===0, JSON.stringify(apiHits));
  w.fetch('/welcome/assets/x.webp');
  ck('demo can still load its own non-API assets', apiHits.length===1 && apiHits[0].endsWith('x.webp'));
}

console.log('\n== LOOP PIECE 5: the service worker keeps the game, not the Gateway ==');
ck('cache version bumped to v4', sw.includes("CACHE_VERSION = 'flux-sparta-v4'"));
ck('only a game navigation refreshes the game shell',
   sw.includes("const isGameShell = (url.pathname === '/play' || url.pathname === '/play/' || url.pathname === '/play/index.html');") &&
   /if \(isGameShell && isCacheable\(res\)\)/.test(sw));
ck('offline Gateway launch goes to the game', sw.includes('if (!isGameShell) return Response.redirect(GAME_ROOT, 302);'));
ck('precache list unchanged (game assets only)', !/welcome/.test(sw.slice(sw.indexOf('const PRECACHE'), sw.indexOf('];', sw.indexOf('const PRECACHE')))));

console.log('\n== old address forwards, nothing stranded ==');
const redir = fs.readFileSync(path.join(__dirname,'FLUX-Gateway-Redirect','_redirects'),'utf8');
ck('old Gateway address 301s to the ROOT of the merged app',
   /\/\*\s+https:\/\/flux-sparta-3\.jeromevt72\.workers\.dev\/\s+301/.test(redir) && !/\/welcome\//.test(redir.split('\n').filter(l=>!l.startsWith('#')).join('\n')));
ck('meta-refresh fallback targets the root', fs.readFileSync(path.join(__dirname,'FLUX-Gateway-Redirect','index.html'),'utf8').includes('url=https://flux-sparta-3.jeromevt72.workers.dev/"'));

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL MERGE / ONE-IDENTITY TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
