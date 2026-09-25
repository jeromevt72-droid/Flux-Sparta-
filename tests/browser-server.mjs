// Test-only: serves FLUX-Sparta/public and routes /api/* into the REAL worker.js
// with an in-memory Durable Object. Not part of the deployed application.
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'FLUX-Sparta', 'public');
const { default: worker, LeaderboardDO } = await import(pathToFileURL(path.join(__dirname, 'FLUX-Sparta', 'worker.js')).href);

class FakeStorage { constructor(){ this.map=new Map(); }
  async get(k){ return this.map.has(k)?structuredClone(this.map.get(k)):undefined; }
  async put(a,v){ if(typeof a==='object'){ for(const [k,val] of Object.entries(a)) this.map.set(k,structuredClone(val)); } else this.map.set(a,structuredClone(v)); } }
class FakeState { constructor(){ this.storage=new FakeStorage(); } async blockConcurrencyWhile(fn){ return fn(); } }
const obj = new LeaderboardDO(new FakeState()); let chain = Promise.resolve();
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.webmanifest':'application/manifest+json', '.png':'image/png', '.webp':'image/webp', '.json':'application/json', '.txt':'text/plain; charset=utf-8', '.xml':'application/xml', '.jpg':'image/jpeg' };
export const env = {
  LEADERBOARD_DO: { idFromName:(n)=>n, get:()=>({ fetch(url, init){ const run=()=>obj.fetch(new Request(url, init)); const r=chain.then(run,run); chain=r.then(()=>{},()=>{}); return r; } }) },
  ADMIN_TOKEN: 'test-admin', STORE_OPEN: 'false', SITE_URL: 'http://localhost',
  ASSETS: { async fetch(req){
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(PUB, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      const dir = f; if (fs.existsSync(path.join(dir,'index.html'))) return new Response(null,{status:301,headers:{Location:p+'/'}});
      return new Response('Not found', { status: 404 });
    }
    return new Response(fs.readFileSync(f), { status: 200, headers: { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' } });
  } },
};
export function start(port){
  const srv = http.createServer(async (req, res) => {
    const chunks=[]; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request('http://localhost:'+port+req.url, { method:req.method, headers:req.headers, body: (req.method==='GET'||req.method==='HEAD')?undefined:body }), env);
    const h = {}; r.headers.forEach((v,k)=>{ h[k]=v; });
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise(ok => srv.listen(port, () => ok(srv)));
}
