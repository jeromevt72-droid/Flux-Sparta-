// Shared harness: boots REAL shipped page scripts in a vm with a universal DOM
// stand-in. It does not reimplement any FLUX logic -- it only supplies the
// browser surface so the real code can run.
import vm from 'vm';
export function universal(){
  const handler = {
    get(t,k){
      if (k === Symbol.toPrimitive) return (h)=> h==='number' ? 0 : '';
      if (k === Symbol.iterator) return function*(){};
      if (k === 'then') return undefined;                       // not a thenable
      if (k === 'length') return 0;
      if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k==='className' || k==='id') return t[k] ?? '';
      if (k in t) return t[k];
      return P;
    },
    set(t,k,v){ t[k]=v; return true; },
    apply(){ return P; },
    construct(){ return P; },
    has(){ return true; }
  };
  const P = new Proxy(function(){}, handler);
  return P;
}
export function makeStore(init={}){
  const mem = Object.assign(Object.create(null), init);
  const api = {
    getItem:k=> (k in mem) ? mem[k] : null, setItem:(k,v)=>{ mem[k]=String(v); },
    removeItem:k=>{ delete mem[k]; }, clear:()=>{ for(const k in mem) delete mem[k]; },
    key:i=>Object.keys(mem)[i]||null
  };
  const store = new Proxy(api, {
    get:(t,k)=> k==='length' ? Object.keys(mem).length : (k in t ? t[k] : mem[k]),
    set:(t,k,v)=>{ mem[k]=String(v); return true; },
    deleteProperty:(t,k)=>{ delete mem[k]; return true; },
    has:(t,k)=> k in mem || k in t, ownKeys:()=>Reflect.ownKeys(mem),
    getOwnPropertyDescriptor:(t,k)=> k in mem ? {value:mem[k],enumerable:true,configurable:true} : undefined
  });
  return { store, mem };
}
export function boot(scripts, { origin, path='/', search='', store, fetchImpl, standalone=true, uuid }){
  const U = universal();
  const listeners = {};
  const nav = { to:null, opened:[] };
  const els = {};
  const byId = (id)=> (els[id] = els[id] || universal());
  const doc = new Proxy({ hidden:false, visibilityState:'visible', readyState:'complete',
    referrer:'', cookie:'' }, {
    get:(t,k)=> (k in t) ? t[k] : (k==='addEventListener' ? (e,f)=>{(listeners['doc:'+e]=listeners['doc:'+e]||[]).push(f);}
                              : k==='getElementById' ? byId : U),
    set:(t,k,v)=>{ t[k]=v; return true; }
  });
  const loc = { origin, pathname:path, search, hash:'', host:origin.replace(/^https?:\/\//,''),
    get href(){ return origin+path; }, set href(v){ nav.to=String(v); },
    assign:(v)=>{ nav.to=String(v); }, replace:(v)=>{ nav.to=String(v); }, reload:()=>{ nav.reload=true; } };
  const win = {
    document:doc, location:loc, localStorage:store, sessionStorage:store,
    navigator:{ standalone, onLine:true, platform:'iPhone', userAgent:'iPhone',
                serviceWorker:{ register:()=>Promise.resolve({ addEventListener:()=>{}, waiting:null }),
                                addEventListener:()=>{}, ready:Promise.resolve({}), controller:null },
                vibrate:()=>true, maxTouchPoints:5 },
    crypto:{ randomUUID: uuid || (()=> 'uuid-'+Math.random().toString(16).slice(2)), subtle: globalThis.crypto.subtle },
    TextEncoder, TextDecoder,
    fetch: fetchImpl || (()=>Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({}) })),
    matchMedia:()=>({ matches:false, addEventListener:()=>{}, addListener:()=>{} }),
    addEventListener:(e,f)=>{ (listeners[e]=listeners[e]||[]).push(f); },
    removeEventListener:()=>{}, dispatchEvent:()=>true,
    setTimeout:()=>0, clearTimeout:()=>{}, setInterval:()=>0, clearInterval:()=>{},
    requestAnimationFrame:()=>0, cancelAnimationFrame:()=>{},
    getComputedStyle:()=>U, open:(u,t)=>{ nav.opened.push([String(u),t]); return null; },
    history:{ replaceState:()=>{}, pushState:()=>{} },
    performance:{ now:()=>0 }, screen:{ width:390, height:844 },
    innerWidth:390, innerHeight:844, devicePixelRatio:3, visualViewport:null,
    AudioContext:function(){ return U; }, webkitAudioContext:function(){ return U; },
    IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}},
    ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
    MutationObserver:class{observe(){}disconnect(){}},
    Image:function(){ return U; }, URL, URLSearchParams, AbortController,
    Response:class{ constructor(b,i){ this._b=b; this.status=(i&&i.status)||200; this.ok=this.status<400; } json(){ return Promise.resolve(JSON.parse(this._b||'{}')); } },
    console:{ log(){}, warn(){}, error(){} }, alert(){}, confirm(){ return true; },
    Math, Date, JSON, Promise, Set, Map, Array, Object, String, Number, Boolean, Symbol, Error, Proxy, Reflect, isFinite, isNaN, parseInt, parseFloat
  };
  win.window = win; win.self = win; win.globalThis = win; win.parent = win; win.top = win;
  const ctx = vm.createContext(win);
  const errors = [];
  for (const s of scripts){ try { vm.runInContext(s, ctx, { timeout:5000 }); } catch(e){ errors.push(String(e).slice(0,120)); } }
  return { ctx, win, listeners, nav, errors, els,
    fire:(e)=>{ for(const f of (listeners[e]||[])) { try{ f({ persisted:false }); }catch(x){} } } };
}
