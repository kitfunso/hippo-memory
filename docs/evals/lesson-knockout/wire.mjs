import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const API_HOST='api.anthropic.com';
export const WIRE_LOG='wire.jsonl';
export const API_UPSTREAM=Object.freeze({host:API_HOST,port:443});
const OPENSSL='C:/Program Files/Git/mingw64/bin/openssl.exe';
const HOP=new Set(['connection','proxy-connection','keep-alive','transfer-encoding','upgrade','te','trailer','proxy-authorization','host']);
const MAX_BODY=64*1024*1024;
const sha=b=>createHash('sha256').update(b).digest('hex');
const forward=headers=>Object.fromEntries(Object.entries(headers).filter(([k])=>!HOP.has(k.toLowerCase())));
const kept=p=>/^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(p);
export const wireName=(n,suffix)=>String(n).padStart(5,'0')+suffix;

export function makeWireCa(dir,days=60) {
  fs.mkdirSync(dir,{recursive:true});
  const run=args=>{
    const r=spawnSync(OPENSSL,args,{cwd:dir,encoding:'utf8',windowsHide:true});
    if(r.status!==0) throw Error('openssl '+args[0]+' failed: '+(r.stderr||r.error));
  };
  fs.writeFileSync(path.join(dir,'leaf.cnf'),'subjectAltName=DNS:'+API_HOST+'\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days',String(days),'-subj','/CN=knockout wire ca',
    '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  run(['req','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN='+API_HOST]);
  run(['x509','-req','-in','leaf.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','leaf.pem','-days',String(days),'-extfile','leaf.cnf']);
  for(const f of ['ca.key','ca.srl','leaf.csr','leaf.cnf']) fs.rmSync(path.join(dir,f),{force:true});
  return dir;
}

function savedBody(raw) {
  try {
    const body=JSON.parse(raw.toString('utf8'));
    if(body && typeof body==='object' && !Array.isArray(body)) { delete body.metadata; return Buffer.from(JSON.stringify(body)); }
  } catch {}
  return raw;
}
function upstreamRequest(upstream,agent,method,pathname,headers,body) {
  return new Promise((resolve,reject)=>{
    const req=https.request({host:upstream.host,port:upstream.port,servername:API_HOST,ca:upstream.ca,method,path:pathname,agent,
      headers:{...headers,host:API_HOST,'content-length':String(body.length)}},resolve);
    req.on('error',reject);
    req.end(body);
  });
}

export async function openWire(dir,{ca,upstream=API_UPSTREAM}) {
  fs.mkdirSync(dir,{recursive:true});
  const log=path.join(dir,WIRE_LOG),open=new Map(),sockets=new Set();
  const agent=new https.Agent({keepAlive:true});
  let seq=0,failure=null,closing=false,sealed=false;
  const row=r=>{
    if(sealed) return false;
    try { fs.appendFileSync(log,JSON.stringify(r)+'\n'); return true; }
    catch(e) { failure??='log: '+e.message; return false; }
  };
  const fault=(n,stage,e)=>{ failure??=stage+': '+(e?.message??e); row({kind:'fault',seq:n,stage,error:String(e?.message??e)}); };
  const secure=tls.createSecureContext({key:fs.readFileSync(path.join(ca,'leaf.key')),cert:fs.readFileSync(path.join(ca,'leaf.pem'))});
  const refuse=(res,code)=>{ if(!res.headersSent) res.writeHead(code); res.end(); };
  const exchange=async (req,res)=>{
    if(closing || failure) { row({kind:'refused',method:req.method,path:req.url,reason:closing?'closing':'failed'}); req.resume(); return refuse(res,503); }
    const n=++seq;
    let done,fd=null,ended='complete';
    open.set(n,new Promise(r=>{done=r;}));
    try {
      const chunks=[];
      let size=0;
      for await(const c of req) { size+=c.length; if(size>MAX_BODY) throw Error('Oversized request'); chunks.push(c); }
      const raw=Buffer.concat(chunks),file=kept(req.url)?wireName(n,'.request.json'):null,saved=file?savedBody(raw):null;
      if(file) fs.writeFileSync(path.join(dir,file),saved);
      if(!row({kind:'request',seq:n,method:req.method,path:req.url,bytes:raw.length,sha256:sha(raw),file,savedSha256:saved&&sha(saved)}))
        throw Error(failure);
      let up;
      try { up=await upstreamRequest(upstream,agent,req.method,req.url,forward(req.headers),raw); }
      catch(e) { row({kind:'end',seq:n,ended:'upstream-error',error:e.message}); return refuse(res,502); }
      const out=kept(req.url)?wireName(n,'.response'):null,hash=createHash('sha256');
      if(out) fd=fs.openSync(path.join(dir,out),'w');
      if(!row({kind:'response',seq:n,status:up.statusCode,requestId:up.headers['request-id']??null,
        encoding:up.headers['content-encoding']??null,contentType:up.headers['content-type']??null,file:out})) throw Error(failure);
      let gone=false;
      res.on('close',()=>{ if(!res.writableFinished) { gone=true; up.destroy(); } });
      res.writeHead(up.statusCode,forward(up.headers));
      let bytes=0;
      try {
        for await(const c of up) {
          if(fd!==null) try { fs.writeSync(fd,c); } catch(e) { fault(n,'response-file',e); ended='fault'; res.destroy(); break; }
          hash.update(c); bytes+=c.length;
          if(gone) break;
          if(!res.write(c)) await Promise.race([once(res,'drain'),once(res,'close')]);
        }
      } catch(e) { if(!gone) { ended='upstream-error'; res.destroy(); } }
      if(ended==='fault') up.destroy();
      else if(gone) ended='client-closed';
      else if(ended==='complete') res.end();
      row({kind:'end',seq:n,ended,bytes,sha256:hash.digest('hex')});
    } catch(e) { fault(n,'exchange',e); if(!res.headersSent) refuse(res,502); else res.destroy(); }
    finally {
      if(fd!==null) try { fs.closeSync(fd); } catch(e) { fault(n,'close-file',e); }
      open.delete(n); done();
    }
  };
  const inner=http.createServer((req,res)=>{ exchange(req,res); });
  const track=s=>{ sockets.add(s); s.on('close',()=>sockets.delete(s)); };
  const proxy=http.createServer((req,res)=>{ row({kind:'refused',method:req.method,path:String(req.url),reason:'plain'}); refuse(res,502); });
  proxy.on('connection',track);
  proxy.on('connect',(req,socket,head)=>{
    const [host,portText]=String(req.url).split(':'),port=Number(portText);
    socket.on('error',()=>{});
    if(closing) { row({kind:'refused',method:'CONNECT',path:String(req.url),reason:'closing'}); return socket.destroy(); }
    if(host===API_HOST && port===443) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const t=new tls.TLSSocket(socket,{isServer:true,secureContext:secure,ALPNProtocols:['http/1.1']});
      if(head?.length) t.unshift(head);
      t.on('error',()=>{});
      track(t);
      inner.emit('connection',t);
      return;
    }
    row({kind:'tunnel',host,port});
    const out=net.connect(port,host,()=>{ socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if(head?.length) out.write(head); out.pipe(socket); socket.pipe(out); });
    out.on('error',()=>socket.destroy());
    track(out);
  });
  proxy.listen(0,'127.0.0.1');
  await once(proxy,'listening');
  return {port:proxy.address().port,dir,
    close:async (grace=30_000)=>{
      closing=true;
      proxy.close();
      await Promise.race([Promise.allSettled([...open.values()]),new Promise(r=>setTimeout(r,grace).unref())]);
      const left=open.size;
      if(left) fault(null,'close',left+' open exchange(s)');
      for(const s of sockets) s.destroy();
      agent.destroy();
      const acknowledged=row({kind:'closed',open:left,exchanges:seq});
      sealed=true;
      return {ok:!failure && left===0 && acknowledged,failure,open:left,exchanges:seq};
    }};
}

if(import.meta.main) {
  const [command,dir]=process.argv.slice(2);
  if(command!=='ca' || !dir) throw Error('Usage: node wire.mjs ca DIR');
  if(fs.existsSync(dir)) throw Error('Wire CA folder exists: '+dir);
  makeWireCa(dir);
  console.log(JSON.stringify({ca:path.join(dir,'ca.pem')}));
}
