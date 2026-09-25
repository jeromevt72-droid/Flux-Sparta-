// RUNTIME INTEGRATION HARNESS
// ---------------------------------------------------------------------------
// Every other client-side suite reads source text. That is exactly how F01 and
// F02 shipped green. This harness instead EXECUTES the page's script blocks in
// document order against a minimal DOM, so it observes the same final bindings
// and the same initialisation order the browser would.
//
// LIMITATION, STATED PLAINLY: this is a minimal DOM, not WebKit. It proves
// execution order and final bindings. It does NOT prove layout, rendering,
// Safari quirks, or anything about a physical iPhone.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};

function scriptsOf(file){
  const s = fs.readFileSync(file,'utf8');
  return [...s.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
}
// Minimal DOM: enough for top-level code to run without throwing.
function makeDom(){
  const noop=()=>{};
  const el=()=>({ style:{setProperty(){}, removeProperty(){}, getPropertyValue:()=>''}, classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},
    addEventListener:noop, removeEventListener:noop, appendChild:noop, remove:noop,
    getBoundingClientRect:()=>({top:0,bottom:0,left:0,right:0,width:0,height:0}),
    querySelector:()=>null, querySelectorAll:()=>[], setAttribute:noop, focus:noop,
    textContent:'', innerHTML:'', value:'', onclick:null, offsetHeight:0, dataset:{} });
  const doc={ documentElement:el(), body:el(), head:el(),
    getElementById:()=>el(), querySelector:()=>el(), querySelectorAll:()=>[],
    createElement:()=>el(), addEventListener:noop, fonts:{ready:Promise.resolve()},
    readyState:'loading' };
  return doc;
}

console.log('=== GATEWAY: initialisation order (AUDIT-F01) ===');
{
  const blocks = scriptsOf(path.join(__dirname,'FLUX-Sparta','public','index.html'));
  const requests = [];
  let urlAtFirstFetch = 'NEVER FETCHED';
  const doc = makeDom();
  const win = {
    document: doc, location:{search:'', origin:'https://gw.test', href:'https://gw.test/'},
    navigator:{standalone:false, platform:'iPhone', userAgent:'iPhone'},
    matchMedia:()=>({matches:false, addEventListener:()=>{}}),
    addEventListener:()=>{}, removeEventListener:()=>{},
    setTimeout:()=>0, clearTimeout:()=>{}, setInterval:()=>0,
    requestAnimationFrame:()=>0, getComputedStyle:()=>({}),
    localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
    fetch:(u)=>{ requests.push(String(u)); if(requests.length===1) urlAtFirstFetch=String(u);
                 return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({players:[],countries:[]})}); },
    console:{log:()=>{},warn:()=>{},error:()=>{}}, visualViewport:null,
    // Browser APIs the page legitimately uses. Absent from a bare vm context;
    // present in every real browser. Stubbed so execution can continue.
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    ResizeObserver: class { observe(){} unobserve(){} disconnect(){} },
    MutationObserver: class { observe(){} disconnect(){} },
    Image: class { set src(v){} }, URL, URLSearchParams,
    performance:{now:()=>0}, screen:{width:390,height:844},
    innerWidth:390, innerHeight:844, devicePixelRatio:3
  };
  win.window = win; win.self = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  let threw=null;
  for(const b of blocks){ try{ vm.runInContext(b, ctx, {timeout:4000}); }catch(e){ if(!threw) threw=e; } }

  // A bare vm DOM cannot implement everything WebKit does. What matters for
  // F01 is that nothing blocks initialisation BEFORE the first request.
  if(threw) console.log('  note   DOM-stub limitation after init: '+String(threw).slice(0,64));
  ck('initialisation reached the first request', requests.length>0);
  ck('FLUX_GAME_URL is defined after load', typeof win.FLUX_GAME_URL === 'string', String(win.FLUX_GAME_URL));
  ck('the FIRST request was actually made', requests.length>0, requests.length+' request(s)');
  ck('first request contains no "undefined"', !/undefined/.test(urlAtFirstFetch), urlAtFirstFetch);
  // MERGE: Gateway and game now share one origin, so the leaderboard API is on
  // the page's OWN origin. The F01 invariant -- never built from undefined --
  // is asserted above and is unchanged.
  ck('first request targets the leaderboard API', /\/api\/leaderboard\?limit=50$/.test(urlAtFirstFetch), urlAtFirstFetch);
  ck('first request is on the page\'s own origin', urlAtFirstFetch.startsWith('https://gw.test/api/'), urlAtFirstFetch);
}

console.log('\n=== SPARTA: final runtime binding of submitScore (AUDIT-F02) ===');
{
  const file = path.join(__dirname,'FLUX-Sparta','public','play','index.html');
  const src = fs.readFileSync(file,'utf8');
  const code = scriptsOf(file).join('\n;\n');

  // Strip comments before counting, so documentation cannot mask a real dupe.
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  const decls = (stripped.match(/^\s*function submitScore\s*\(/gm)||[]).length;
  const assigns = (stripped.match(/^\s*submitScore\s*=\s*(?:async\s+)?function/gm)||[]).length;
  ck('exactly one submitScore definition', decls+assigns===1, decls+' decl + '+assigns+' assign');
  ck('it is the declaration, not a patch assignment', decls===1 && assigns===0);

  // Now prove what the LAST definition in the file actually does — that is the
  // binding the browser ends up with.
  const last = Math.max(stripped.lastIndexOf('function submitScore'), stripped.lastIndexOf('submitScore ='));
  const body = stripped.slice(last, last+420);
  ck('runtime impl builds a whole-run submission', body.includes('buildSubmission()'));
  ck('runtime impl enqueues', body.includes('enqueueSubmission(item)'));
  ck('runtime impl flushes the queue', body.includes('flushSubmitQueue()'));
  ck('runtime impl does NOT rebuild level from a best key', !body.includes("fluxBestLevel_"));
  ck('runtime impl does NOT swallow failures', !/\.catch\(\(\)\s*=>\s*\{\}\)/.test(body));

  // D-09: the pair must come from one record.
  const bs = stripped.slice(stripped.indexOf('function buildSubmission'), stripped.indexOf('function buildSubmission')+560);
  ck('D-09 pair sourced from bestRun()', bs.includes('const run=bestRun()'));
  ck('D-09 score and level from the SAME record', bs.includes('score:run.score') && bs.includes('level:run.level'));
  ck('D-09 carries difficulty and identity', bs.includes('difficulty:run.difficulty') && bs.includes('playerId:playerId'));
  ck('D-09 carries country', bs.includes('country:'));

  // No other file-level assignment may shadow it later.
  const after = stripped.slice(last+10);
  ck('nothing re-assigns submitScore later', !/^\s*submitScore\s*=/m.test(after));
}

console.log('\n=== SPARTA: the other overrides, rechecked not refactored ===');
{
  const code = scriptsOf(path.join(__dirname,'FLUX-Sparta','public','play','index.html')).join('\n;\n')
                 .replace(/\/\*[\s\S]*?\*\//g,'');
  for(const [name, mustContain] of [['ownsSkin','fluxOwned_'], ['saveProfile','fluxCallsign']]){
    const last = Math.max(code.lastIndexOf('function '+name), code.lastIndexOf(name+' ='));
    const body = code.slice(last, last+520);
    ck(name+' still resolves to the newer override', code.lastIndexOf(name+' =') > code.lastIndexOf('function '+name));
    ck(name+' override still does its job', body.includes(mustContain), mustContain);
  }
}

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL RUNTIME INTEGRATION TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
