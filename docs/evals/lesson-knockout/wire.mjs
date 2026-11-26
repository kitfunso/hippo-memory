import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash,randomBytes } from 'node:crypto';

export const API_HOST='api.anthropic.com';
export const WIRE_LOG='wire.jsonl';
export const API_UPSTREAM=Object.freeze({host:API_HOST,port:443});
export const ROUTES=new Map([['GET /api/claude_code/settings','settings'],['GET /api/claude_code/policy_limits','policy'],
  ['POST /v1/messages?beta=true','generate'],['POST /v1/messages/count_tokens?beta=true','count']]);
export const MODEL_ROUTES=new Set(['generate','count']);
export const ANTHROPIC_HOST=/(?:^|\.)(?:anthropic\.com|claude\.ai|claude\.com)$/i;
const OPENSSL='C:/Program Files/Git/mingw64/bin/openssl.exe';
const HOP=new Set(['connection','proxy-connection','keep-alive','transfer-encoding','upgrade','te','trailer','proxy-authorization','host']);
const PROXY_ONLY=new Set(['proxy-connection','proxy-authorization']);
const ALPN=['http/1.1'];
const MAX_BODY=64*1024*1024;
const sha=b=>createHash('sha256').update(b).digest('hex');
const forward=headers=>Object.fromEntries(Object.entries(headers).filter(([k])=>!HOP.has(k.toLowerCase())));
const passOn=raw=>raw.flatMap((v,i)=>i%2 || PROXY_ONLY.has(v.toLowerCase()) ? [] : [v,raw[i+1]]);
const apiHost=req=>req.rawHeaders.filter((v,i)=>!(i%2) && v.toLowerCase()==='host').length===1 && /^api\.anthropic\.com(?::443)?$/i.test(req.headers.host ?? '');
const waitEither=(res,a,b)=>new Promise(resolve=>{ const done=()=>{ res.off(a,done); res.off(b,done); resolve(); }; res.once(a,done); res.once(b,done); });
const flushed=res=>res.writableFinished || res.destroyed ? Promise.resolve() : waitEither(res,'finish','close');
const label=v=>v===undefined ? null : typeof v==='string' && /^[a-z0-9_.:-]{1,128}$/i.test(v) ? v : 'invalid';
const listed=v=>v===undefined ? null : typeof v==='string' && /^[a-z0-9_.,: -]{0,1024}$/i.test(v) ? v : 'invalid';
const codeOf=e=>String(typeof e==='string' ? e : e?.code ?? e?.name ?? 'error').replace(/[^a-z0-9_.-]/gi,'').slice(0,48) || 'error';
const pause=ms=>new Promise(r=>setTimeout(r,ms).unref());
export const wireName=(n,suffix)=>String(n).padStart(5,'0')+suffix;
export const hostOf=h=>String(h??'').toLowerCase().replace(/^\[|\]$/g,'').replace(/\.+$/,'');
export function authority(text) {
  const m=/^(?:\[([0-9a-f:.]+)\]|([a-z0-9][a-z0-9.-]*)):(\d{1,5})$/i.exec(String(text));
  const port=m ? Number(m[3]) : 0,host=m ? hostOf(m[1]??m[2]) : '';
  if(!m || port<1 || port>65535 || !host || (m[1]!==undefined && !net.isIPv6(m[1]))) return null;
  return {host,port};
}

export function makeWireCa(dir,days=60) {
  fs.mkdirSync(dir,{recursive:true});
  const run=args=>{
    const r=spawnSync(OPENSSL,args,{cwd:dir,encoding:'utf8',windowsHide:true});
    if(r.status!==0) throw Error('openssl '+args[0]+' failed: '+(r.stderr||r.error));
  };
  try {
    fs.writeFileSync(path.join(dir,'leaf.cnf'),'subjectAltName=DNS:'+API_HOST+'\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
    run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days',String(days),'-subj','/CN=knockout wire ca',
      '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
    run(['req','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN='+API_HOST]);
    run(['x509','-req','-in','leaf.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','leaf.pem','-days',String(days),'-extfile','leaf.cnf']);
  } finally {
    for(const f of ['ca.key','ca.srl','leaf.csr','leaf.cnf']) fs.rmSync(path.join(dir,f),{force:true});
  }
  return dir;
}

function savedBody(raw,route) {
  let body;
  try { body=JSON.parse(raw.toString('utf8')); } catch { return null; }
  if(!body || typeof body!=='object' || Array.isArray(body)) return null;
  if(!Array.isArray(body.messages)) return null;
  if(typeof body.model!=='string') return null;
  if(route==='generate' && !body.system) return null;
  const clean={model:body.model,messages:body.messages};
  if(body.system!==undefined) clean.system=body.system;
  if(body.stream!==undefined) clean.stream=body.stream;
  return Buffer.from(JSON.stringify(clean));
}
function writeAll(fd,chunk) {
  for(let at=0;at<chunk.length;) {
    const n=fs.writeSync(fd,chunk,at,chunk.length-at);
    if(!(n>0)) throw Object.assign(Error('Short write'),{code:'ESHORT'});
    at+=n;
  }
}
function upstreamRequest(upstream,agent,method,pathname,headers,body,signal) {
  return new Promise((resolve,reject)=>{
    const req=https.request({host:upstream.host,port:upstream.port,servername:API_HOST,ca:upstream.ca,method,path:pathname,agent,signal,headers},resolve);
    req.on('error',reject);
    if(body.length) req.end(body); else req.end();
  });
}

export async function openWire(dir,{ca,upstream=API_UPSTREAM,port=0,token=randomBytes(16).toString('hex'),connect=net.connect}) {
  fs.mkdirSync(dir,{recursive:true});
  const auth=token ? 'Basic '+Buffer.from('wire:'+token).toString('base64') : null;
  const log=path.join(dir,WIRE_LOG),open=new Map(),sockets=new Set(),agents=new Map();
  const agentOf=socket=>{
    if(!agents.has(socket)) {
      const a=new https.Agent({keepAlive:true,maxSockets:1,ALPNProtocols:socket.alpnProtocol ? [socket.alpnProtocol] : undefined});
      agents.set(socket,a);
      socket.once('close',()=>{ agents.delete(socket); a.destroy(); });
    }
    return agents.get(socket);
  };
  let seq=0,failure=null,closing=false,sealed=false;
  const row=r=>{
    if(sealed) return false;
    try { fs.appendFileSync(log,JSON.stringify(r)+'\n'); return true; }
    catch(e) { failure??='log: '+codeOf(e); return false; }
  };
  const fault=(n,stage,e)=>{ failure??=stage+': '+codeOf(e); row({kind:'fault',seq:n,stage,error:codeOf(e)}); };
  const secure=tls.createSecureContext({key:fs.readFileSync(path.join(ca,'leaf.key')),cert:fs.readFileSync(path.join(ca,'leaf.pem'))});
  const refuse=(res,code)=>{ if(!res.headersSent) res.writeHead(code); res.end(); };
  const exchange=async (req,res)=>{
    const route=ROUTES.get(req.method+' '+req.url) ?? 'other';
    if(closing || failure) { row({kind:'refused',method:req.method,route,reason:closing?'closing':'failed'}); req.resume(); return refuse(res,503); }
    const n=++seq,abort=new AbortController();
    let done,fd=null,ended='complete',gone=false,up=null;
    open.set(n,new Promise(r=>{done=r;}));
    res.on('close',()=>{ if(!res.writableFinished) { gone=true; abort.abort(); up?.destroy(); } });
    try {
      const chunks=[];
      let size=0;
      for await(const c of req) { size+=c.length; if(size>MAX_BODY) throw Object.assign(Error('Oversized request'),{code:'EBIG'}); chunks.push(c); }
      if(!apiHost(req)) { fault(n,'host','unexpected'); return refuse(res,502); }
      if(req.rawTrailers.length) { fault(n,'trailers','request'); return refuse(res,502); }
      const raw=Buffer.concat(chunks),model=MODEL_ROUTES.has(route),saved=model?savedBody(raw,route):null;
      if(model && !saved) { fault(n,'body','unsanitizable'); return refuse(res,502); }
      const file=model?wireName(n,'.request.json'):null;
      if(file) fs.writeFileSync(path.join(dir,file),saved);
      if(!row({kind:'request',seq:n,method:req.method,route,cls:label(req.headers['x-claude-code-request-class']),
        aux:label(req.headers['x-claude-code-auxiliary-type']),beta:listed(req.headers['anthropic-beta']),
        version:label(req.headers['anthropic-version']),bytes:raw.length,sha256:sha(raw),file,savedSha256:saved&&sha(saved)}))
        throw Object.assign(Error('log'),{code:'ELOG'});
      try { up=await upstreamRequest(upstream,agentOf(req.socket),req.method,req.url,passOn(req.rawHeaders),raw,abort.signal); }
      catch(e) { row({kind:'end',seq:n,ended:gone?'client-closed':'upstream-error',error:codeOf(e)}); return refuse(res,502); }
      const out=model?wireName(n,'.response'):null,hash=createHash('sha256');
      if(out) fd=fs.openSync(path.join(dir,out),'w');
      if(!row({kind:'response',seq:n,status:up.statusCode,requestId:label(up.headers['request-id']),encoding:label(up.headers['content-encoding']),
        contentType:String(up.headers['content-type']??'').slice(0,128) || null,file:out})) throw Object.assign(Error('log'),{code:'ELOG'});
      let bytes=0;
      if(gone) up.destroy();
      else {
        res.writeHead(up.statusCode,forward(up.headers));
        try {
          for await(const c of up) {
            if(fd!==null) try { writeAll(fd,c); } catch(e) { fault(n,'response-file',e); ended='fault'; res.destroy(); break; }
            hash.update(c); bytes+=c.length;
            if(gone) break;
            if(!res.write(c) && !res.destroyed && !gone) await waitEither(res,'drain','close');
          }
        } catch { if(!gone) { ended='upstream-error'; res.destroy(); } }
      }
      if(ended==='complete' && !gone && up.rawTrailers.length) { fault(n,'trailers','response'); ended='fault'; res.destroy(); }
      if(ended==='fault') up.destroy();
      else if(gone) ended='client-closed';
      else if(ended==='complete') { res.end(); await flushed(res); if(!res.writableFinished) ended='client-closed'; }
      row({kind:'end',seq:n,ended,bytes,sha256:hash.digest('hex')});
    } catch(e) { fault(n,'exchange',e); if(!res.headersSent) refuse(res,502); else res.destroy(); }
    finally {
      if(fd!==null) try { fs.closeSync(fd); } catch(e) { fault(n,'close-file',e); }
      open.delete(n); done();
    }
  };
  const inner=http.createServer((req,res)=>{ exchange(req,res); });
  const track=s=>{ sockets.add(s); s.on('close',()=>sockets.delete(s)); };
  const proxy=http.createServer((req,res)=>{
    let host=null;
    try { host=hostOf(new URL(req.url).hostname); } catch {}
    row({kind:'refused',method:req.method,route:'plain',host,reason:'plain'});
    req.resume();
    refuse(res,502);
  });
  proxy.on('connection',track);
  proxy.on('clientError',(e,socket)=>socket.destroy());
  proxy.on('connect',(req,socket,head)=>{
    socket.on('error',()=>{});
    if(auth && req.headers['proxy-authorization']!==auth) {
      row({kind:'refused',method:'CONNECT',route:'tunnel',reason:'proxy-auth'});
      return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    }
    if(closing) { row({kind:'refused',method:'CONNECT',route:'tunnel',reason:'closing'}); return socket.destroy(); }
    const target=authority(req.url);
    if(!target) { row({kind:'refused',method:'CONNECT',route:'tunnel',reason:'authority'}); return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); }
    if(target.host===API_HOST && target.port===443) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const t=new tls.TLSSocket(socket,{isServer:true,secureContext:secure,ALPNProtocols:ALPN});
      if(head?.length) t.unshift(head);
      t.on('error',()=>{});
      track(t);
      inner.emit('connection',t);
      return;
    }
    if(ANTHROPIC_HOST.test(target.host)) {
      row({kind:'refused',method:'CONNECT',route:'tunnel',host:target.host,port:target.port,reason:'anthropic-host'});
      return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
    row({kind:'tunnel',host:target.host,port:target.port});
    let out;
    try { out=connect(target.port,target.host); }
    catch { return socket.destroy(); }
    out.on('connect',()=>{ socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if(head?.length) out.write(head); out.pipe(socket); socket.pipe(out); });
    out.on('error',()=>socket.destroy());
    track(out);
  });
  proxy.listen(port,'127.0.0.1');
  await once(proxy,'listening');
  return {port:proxy.address().port,token,dir,
    close:async (grace=30_000)=>{
      closing=true;
      proxy.close();
      await Promise.race([Promise.allSettled([...open.values()]),pause(grace)]);
      const left=open.size;
      if(left) fault(null,'close','open-exchanges');
      const shut=[...sockets].map(s=>once(s,'close').catch(()=>{}));
      for(const s of sockets) s.destroy();
      for(const a of agents.values()) a.destroy();
      await Promise.race([Promise.allSettled([...shut,...open.values()]),pause(5000)]);
      const acknowledged=row({kind:'closed',open:left,exchanges:seq});
      sealed=true;
      return {ok:!failure && left===0 && acknowledged && sockets.size===0,failure,open:left,exchanges:seq};
    }};
}

if(import.meta.main) {
  const [command,dir]=process.argv.slice(2);
  if(command!=='ca' || !dir) throw Error('Usage: node wire.mjs ca DIR');
  if(fs.existsSync(dir)) throw Error('Wire CA folder exists: '+dir);
  makeWireCa(dir);
  console.log(JSON.stringify({ca:path.join(dir,'ca.pem')}));
}
