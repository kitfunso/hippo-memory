import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { makeWireCa,openWire } from './wire.mjs';
import { startScriptedApi } from './scripted-api.mjs';
import { callComplete,cutOffBound,evidence,wireLedger } from './evidence.mjs';
import { DENIED_TOOLS,WIRE_CA,folder,pins,read,root,roster } from './plan.mjs';
import { launch } from './delivery.mjs';

const CLI='C:/z0-runs/scored/bin/claude.exe';
const TOKEN='sk-ant-oat01-'+'wirecanary'.repeat(8);
const PARITY_MASK=/^(?:x-claude-code-session-id|x-claude-code-prompt-id|x-client-request-id|x-claude-code-prev-tool-durations|content-length)$/i;
const sha=text=>createHash('sha256').update(text).digest('hex');
const wireRows=dir=>fs.readFileSync(path.join(dir,'wire.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

const LAUNCHER_PRIVATE=Object.freeze({HOME:'$Live/home',USERPROFILE:'$Live/home',CLAUDE_CONFIG_DIR:'$Live/home/.claude',
  APPDATA:'$Live/home/roaming',LOCALAPPDATA:'$Live/home/local',TEMP:'$Live/home/tmp',TMP:'$Live/home/tmp',HIPPO_HOME:'$Live/home/.hippo',
  CLAUDE_CODE_PROJECT_DIR_NAME:'unit',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'0',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
  CLAUDE_CODE_GATEWAY_HINT_HEADERS:'1',DISABLE_AUTOUPDATER:'1',GIT_TERMINAL_PROMPT:'0',EVAL_SEED:'1'});
const WIRE_KEYS=['HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'];
const NETWORK=/proxy|^ANTHROPIC_|^CLAUDE_CODE_USE_|^OTEL_|^NODE_TLS|^SSL_CERT|^REQUESTS_CA|^CURL_CA/i;

function launcherPrivate() {
  const text=fs.readFileSync(path.join(folder,'launch.ps1'),'utf8');
  const block=/\$private=@\{([\s\S]*?)\}\r?\n/.exec(text)?.[1];
  assert(block,'launch.ps1 has no private environment block');
  return Object.fromEntries([...block.matchAll(/(\w+)=(?:'([^']*)'|"([^"]*)")/g)].map(m=>[m[1],m[2] ?? m[3]]));
}

function childEnv(home,port,ca,token) {
  const own=Object.fromEntries(Object.entries(LAUNCHER_PRIVATE).map(([k,v])=>[k,v.replace('$Live/home',home)]));
  const proxy=token ? 'http://wire:'+token+'@127.0.0.1:'+port : 'http://127.0.0.1:'+port;
  return {SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,...own,
    HTTPS_PROXY:proxy,NO_PROXY:'127.0.0.1,localhost',NODE_EXTRA_CA_CERTS:path.join(ca,'ca.pem'),CLAUDE_CODE_OAUTH_TOKEN:TOKEN};
}

function loose(raw,encoding) {
  try {
    if(encoding==='gzip') return zlib.gunzipSync(raw,{finishFlush:zlib.constants.Z_SYNC_FLUSH});
    if(encoding==='deflate') return zlib.inflateSync(raw,{finishFlush:zlib.constants.Z_SYNC_FLUSH});
    if(encoding==='br') return zlib.brotliDecompressSync(raw,{finishFlush:zlib.constants.BROTLI_OPERATION_FLUSH});
  } catch {}
  return null;
}
export function retainedClean(base) {
  const wire=path.join(base,'wire'),files=[];
  for(const name of fs.readdirSync(wire)) {
    const dir=path.join(wire,name),encodings=new Map(wireRows(dir).filter(r=>r.kind==='response' && r.file).map(r=>[r.file,r.encoding]));
    for(const f of fs.readdirSync(dir,{withFileTypes:true})) if(f.isFile()) files.push([path.join(dir,f.name),encodings.get(f.name) ?? null]);
  }
  for(const [file,encoding] of files) {
    const raw=fs.readFileSync(file),texts=[raw.toString('latin1')];
    if(encoding && encoding!=='identity' && raw.length) {
      const text=loose(raw,encoding);
      assert(text,'A retained compressed reply does not decode: '+path.relative(base,file));
      texts.push(text.toString('latin1'));
    }
    for(const text of texts) assert(!text.includes(TOKEN.slice(13)) && !text.includes('"metadata"') && !/device_id|account_uuid|user_id/.test(text),
      'A retained wire file holds the credential or identity fields: '+path.relative(base,file));
  }
  return files.length;
}
function checkRetainedScan(parent) {
  const base=fs.mkdtempSync(path.join(parent,'scan-')),dir=path.join(base,'wire','cut');
  fs.mkdirSync(dir,{recursive:true});
  const rows=[{kind:'response',seq:1,file:'00001.response',encoding:'gzip'}].map(r=>JSON.stringify(r)).join('\n')+'\n';
  fs.writeFileSync(path.join(dir,'wire.jsonl'),rows);
  const cut=text=>zlib.gzipSync(text).subarray(0,-8);
  fs.writeFileSync(path.join(dir,'00001.response'),cut('data: {"type":"text","text":"clean"}\n\n'.repeat(50)));
  assert.equal(retainedClean(base),2,'The retained scan skipped a wire file');
  fs.writeFileSync(path.join(dir,'00001.response'),cut('data: {"metadata":{"user_id":"x"}}\n\n'.repeat(50)));
  assert.throws(()=>retainedClean(base),/holds the credential or identity fields/,'The scan missed identity data in an interrupted gzip reply');
  fs.writeFileSync(path.join(dir,'00001.response'),cut('clean\n'.repeat(50)));
  fs.writeFileSync(path.join(dir,'stray.json'),'{"metadata":{}}');
  assert.throws(()=>retainedClean(base),/stray\.json/,'The scan missed a wire file that no row names');
}

async function openTunnel(upstream) {
  const sockets=new Set(),server=http.createServer((req,res)=>{ res.writeHead(405); res.end(); });
  server.on('connect',(req,client,head)=>{
    const up=net.connect(upstream.port,upstream.host,()=>{ client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if(head.length) up.write(head); up.pipe(client); client.pipe(up); });
    for(const s of [client,up]) { sockets.add(s); s.on('close',()=>sockets.delete(s)); s.on('error',()=>{}); }
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {port:server.address().port,close:async()=>{ for(const s of sockets) s.destroy(); server.close(); return {ok:true}; }};
}

function parity(o) {
  const first=new Map(),masked=h=>h.map((v,i)=>i%2 && PARITY_MASK.test(h[i-1]) ? '*' : v);
  return {offers:o.offers,
    connections:o.seen.map(x=>[x.method,first.get(x.socket) ?? first.set(x.socket,first.size+1).get(x.socket),x.protocol]),
    requests:[...o.seen].sort((a,b)=>a.path<b.path ? -1 : a.path>b.path ? 1 : 0).map(x=>[x.method,x.path,x.stream,masked(x.headers)])};
}

export async function checkWireOffline(parent) {
  fs.mkdirSync(parent,{recursive:true});
  assert.deepEqual(launcherPrivate(),LAUNCHER_PRIVATE,'The launcher settings differ from the pinned list');
  checkRetainedScan(parent);
  const base=fs.mkdtempSync(path.join(parent,'run-'));
  const work=path.join(base,'work'),settings=path.join(base,'settings.json');
  const fresh=name=>{ const h=path.join(base,name); for(const d of ['tmp','roaming','local','.claude']) fs.mkdirSync(path.join(h,d),{recursive:true}); return h; };
  const home=fresh('home');
  fs.mkdirSync(work,{recursive:true});
  fs.writeFileSync(path.join(work,'a.txt'),'alpha');
  fs.writeFileSync(settings,JSON.stringify({hooks:{},permissions:{deny:DENIED_TOOLS},sandbox:{enabled:false}}));
  const ca=makeWireCa(path.join(base,'ca'),2),api=await startScriptedApi(ca),outcomes={};
  async function run(name,prompt,{resume,killAfter=180000,prepare,home:h=home,direct=false}={}) {
    const dir=path.join(base,direct ? 'direct' : 'wire',name),session=resume ?? randomUUID(),projects=path.join(h,'.claude','projects');
    fs.mkdirSync(dir,{recursive:true});
    prepare?.(dir);
    const wire=direct ? await openTunnel(api.upstream) : await openWire(dir,{ca,upstream:api.upstream}),before=api.seen.length,offered=api.offers.length;
    const argv=['-p','--output-format','json','--setting-sources','','--strict-mcp-config','--settings',settings,
      '--model',pins.modelOpus,'--effort',pins.effort,'--permission-mode','bypassPermissions',resume?'--resume':'--session-id',session];
    const cli=spawn(CLI,argv,{cwd:work,env:childEnv(h,wire.port,ca,wire.token),windowsHide:true,stdio:['pipe','pipe','ignore']});
    let out='';
    cli.stdout.on('data',d=>out+=d);
    cli.stdin.end(prompt);
    const timer=setTimeout(()=>cli.kill(),killAfter);
    const [code]=await once(cli,'exit');
    clearTimeout(timer);
    const state=await wire.close(5000);
    let parsed=null;
    try { parsed=JSON.parse(out); } catch {}
    const transcript=path.join(projects,'unit',session+'.jsonl');
    const result={session,exit:code,isError:parsed?.is_error ?? true,subtype:parsed?.subtype ?? null};
    const seen=api.seen.slice(before),offers=api.offers.slice(offered);
    outcomes[name]={state,seen,offers,dir,session,result,transcript,...(direct ? {} : {complete:callComplete(dir,result,prompt,transcript),
      cut:cutOffBound(dir,projects,session,prompt),ledger:wireLedger(dir)})};
    return session;
  }
  const replyFds=()=>{
    const [open,write]=[fs.openSync,fs.writeSync],fds=new Set();
    fs.openSync=(file,...a)=>{ const fd=open(file,...a); if(String(file).endsWith('.response')) fds.add(fd); return fd; };
    return {fds,write,restore:()=>{ [fs.openSync,fs.writeSync]=[open,write]; }};
  };
  try {
    await run('parity-direct','CASE:tool Read a.txt and reply.',{home:fresh('home-direct'),direct:true});
    await run('parity-wire','CASE:tool Read a.txt and reply.',{home:fresh('home-wire')});
    const sid=await run('tool','CASE:tool Read a.txt and reply.');
    await run('resume','CASE:resume Reply done.',{resume:sid});
    await run('retry','CASE:retry Reply done.');
    await run('limit','CASE:limit Reply done.');
    await run('gzip','CASE:gzip Reply done.');
    await run('midstream','CASE:midstream Reply done.');
    await run('busy','CASE:busy Reply done.');
    await run('exhaust','CASE:exhaust Reply done.',{killAfter:300000});
    await run('reset','CASE:reset Reply done.');
    await run('plain','CASE:plain Reply done.');
    await run('toolong','CASE:toolong Reply done.');
    await run('compact','CASE:bigctx Read a.txt and reply.');
    await run('stall','CASE:stall Reply done.',{killAfter:15000});
    await run('diskfull','CASE:final Reply done.',{killAfter:20000,prepare:dir=>fs.mkdirSync(path.join(dir,'00003.request.json'))});
    let patch=replyFds();
    fs.writeSync=(fd,...a)=>{ if(patch.fds.has(fd)) throw Object.assign(Error('ENOSPC: no space left on device, write'),{code:'ENOSPC'}); return patch.write(fd,...a); };
    try { await run('replyfull','CASE:final Reply done.',{killAfter:20000}); } finally { patch.restore(); }
    patch=replyFds();
    let short=0;
    fs.writeSync=(fd,buf,offset,length,...a)=>{
      if(!patch.fds.has(fd) || typeof offset!=='number') return patch.write(fd,buf,offset,length,...a);
      short++;
      return patch.write(fd,buf,offset,Math.min(length,7),...a);
    };
    try { await run('shortwrite','CASE:final Reply done.',{killAfter:20000}); } finally { patch.restore(); }
    assert(short>1,'The short write patch never ran');
  } finally { await api.close(); }
  assert.deepEqual(outcomes['parity-wire'].seen.map(x=>x.kind).filter(k=>k!=='other'),['tool','final'],'The parity run did not take a tool turn');
  assert(outcomes['parity-wire'].offers.length>0,'The parity run recorded no protocol offer');
  assert.deepEqual(parity(outcomes['parity-wire']),parity(outcomes['parity-direct']),
    'The wire changed the request headers, header order, protocol offers or connection reuse that the API sees');
  const main=o=>o.ledger.exchanges.filter(x=>x.route==='generate' && x.cls==='main');
  for(const name of ['tool','resume','retry','gzip','midstream','busy','reset','plain','compact','shortwrite'])
    assert(outcomes[name].state.ok && outcomes[name].complete.complete,'The wire did not match the transcript for '+name);
  assert.equal(main(outcomes.tool).filter(x=>x.complete).length,2,'The tool turn did not reach the wire');
  for(const name of ['retry','midstream','busy','reset','plain'])
    assert.equal(main(outcomes[name]).filter(x=>!x.complete).length,1,'The '+name+' retry left no failed exchange');
  assert.deepEqual(main(outcomes.busy).map(x=>x.limit),['rate_limit_error',null],'The 429 retry was not recorded as a limit');
  assert.deepEqual(main(outcomes.reset).map(x=>x.ended),['upstream-error','complete'],'The TCP reset was not recorded');
  assert.deepEqual(main(outcomes.plain).map(x=>[x.reply.sse,x.body.stream===true,x.complete]),[[false,true,false],[false,false,true]],
    'The plain reply was not bound to its non-streaming request');
  const aux=outcomes.compact.ledger.exchanges.filter(x=>x.route==='generate' && x.cls!=='main');
  assert.deepEqual(aux.map(x=>[x.cls,x.complete]),[['compaction',true]],'The compaction request was not classed apart');
  assert(fs.readFileSync(outcomes.compact.transcript,'utf8').includes('"compact_boundary"'),'The compaction case did not compact');
  assert(outcomes.limit.state.ok && !outcomes.limit.complete.complete && outcomes.limit.cut.bound,'The 429 was not bound to its error turn');
  const exhausted=main(outcomes.exhaust);
  assert(outcomes.exhaust.state.ok && !outcomes.exhaust.complete.complete && outcomes.exhaust.cut.bound && exhausted.length>2 &&
    exhausted.every(x=>x.limit==='overloaded_error'),'The exhausted 529 retries were not bound to the error turn');
  assert(outcomes.toolong.state.ok && !outcomes.toolong.complete.complete && !outcomes.toolong.cut.bound,'A 400 error was bound as a cut-off');
  assert(outcomes.stall.state.ok && !outcomes.stall.complete.complete && !outcomes.stall.cut.bound,'A stalled call passed');
  assert.deepEqual(main(outcomes.stall).map(x=>x.ended),['client-closed'],'The stalled stream was not recorded as abandoned');
  assert(!outcomes.diskfull.state.ok && !outcomes.diskfull.ledger.ok,'A failed body write left a valid wire');
  assert(!outcomes.diskfull.seen.some(s=>s.kind!=='other'),'A request the wire could not save reached the upstream');
  assert(!outcomes.replyfull.state.ok && !outcomes.replyfull.ledger.ok &&
    wireRows(outcomes.replyfull.dir).some(r=>r.kind==='fault' && r.stage==='response-file' && r.error==='ENOSPC'),'A failed reply write did not latch the wire');
  assert(!outcomes.replyfull.complete.complete,'A call whose reply the wire could not save passed');
  const forwarded=Object.values(outcomes).flatMap(o=>o.ledger?.ok ? o.seen : []);
  for(const o of Object.values(outcomes).filter(o=>o.ledger?.ok)) {
    assert.deepEqual(o.ledger.hosts,[],'An offline call opened a tunnel to another host');
    const rows=wireRows(o.dir),sent=new Map(rows.filter(r=>r.kind==='request').map(r=>[r.seq,r]));
    for(const r of rows.filter(r=>r.kind==='response')) {
      const upstream=o.seen.find(s=>s.requestId===r.requestId);
      assert(upstream && upstream.sha256===sent.get(r.seq).sha256,'The upstream received other bytes than the wire saved');
      assert.equal(sent.get(r.seq).cls,upstream.requestClass,'The wire class differs from the header the upstream saw');
    }
    for(const r of sent.values()) if(r.route==='generate') assert(r.beta && r.beta!=='invalid' && r.version,'A model request lost its beta or version header');
  }
  assert(forwarded.length>0 && forwarded.every(s=>s.authSha256===sha('Bearer '+TOKEN)),'The credential did not reach the upstream unchanged');
  assert(forwarded.some(s=>s.metadata),'The canary request carried no metadata');
  return {cases:Object.keys(outcomes).length,requests:forwarded.length,files:retainedClean(base)};
}

const PROBE=`const fs=require('fs'),crypto=require('crypto');
const [out,want,keys]=process.argv.slice(2),e=process.env,t=e.CLAUDE_CODE_OAUTH_TOKEN;
fs.writeFileSync(out,JSON.stringify({settings:Object.fromEntries(keys.split(',').filter(k=>e[k]!==undefined).map(k=>[k,e[k]])),
  network:Object.keys(e).filter(k=>${NETWORK}.test(k)).sort(),leaked:['ANTHROPIC_BASE_URL','Z0_LAUNCH_SENTINEL','Z0_WIRE_DUMMY'].filter(k=>e[k]!==undefined),
  token:t===undefined ? 'absent' : crypto.createHash('sha256').update(t).digest('hex')===want ? 'dummy' : 'other'}));
`;

export async function checkLauncher() {
  assert.deepEqual(launcherPrivate(),LAUNCHER_PRIVATE,'The launcher settings differ from the pinned list');
  const parent=fs.mkdtempSync(path.join(root,'verify-launch-'));
  const api=await startScriptedApi(WIRE_CA);
  try {
    const probe=path.join(parent,'env-probe.cjs'),seenEnv=path.join(parent,'child-env.json'),keys=[...Object.keys(LAUNCHER_PRIVATE),...WIRE_KEYS];
    fs.writeFileSync(probe,PROBE);
    const hookFor=out=>({UserPromptSubmit:[{hooks:[{type:'command',command:['node',probe,out,sha(TOKEN),keys.join(',')].map(a=>a.replaceAll('\\','/')).join(' ')}]}]});
    const hook=hookFor(seenEnv);
    const parentEnv={...process.env,Z0_WIRE_DUMMY:TOKEN,HTTPS_PROXY:'http://127.0.0.1:9',ANTHROPIC_BASE_URL:'http://127.0.0.1:9',Z0_LAUNCH_SENTINEL:'parent'};
    let wireInfo=null;
    const record=async dir=>{ const w=await openWire(dir,{ca:WIRE_CA,upstream:api.upstream}); wireInfo=w; return w; };
    const prepare=(name,hooks={})=>{
      const live=path.join(parent,name);
      for(const d of ['home/tmp','home/roaming','home/local','home/.claude/projects/unit/memory','work']) fs.mkdirSync(path.join(live,d),{recursive:true});
      fs.writeFileSync(path.join(live,'settings.json'),JSON.stringify({hooks,permissions:{deny:DENIED_TOOLS},sandbox:{enabled:false}}));
      return live;
    };
    const callOf=(prompt,extra={})=>({id:'probe',session:randomUUID(),smoke:true,diagnostic:true,prompt,model:pins.modelOpus,effort:pins.effort,
      toolchain:roster()[0].toolchain,...extra});
    const CRED_MISSING=/Missing subscription credential or unexpected credential type/;
    const checkEarlyRefusal=async (name,call,env,wantErr)=>{
      const earlyEnv=path.join(parent,name+'-env.json'),live=prepare(name,hookFor(earlyEnv)),before=api.seen.length;
      let errText='';
      await assert.rejects(launch(live,'Z0_WIRE_DUMMY',env,call,{record,onStderr:s=>{ errText+=s; }}),/Claude Code launcher exited 1/,'The launcher did not refuse the '+name+' call');
      assert(wantErr.test(errText) && !CRED_MISSING.test(errText),'An unrelated early refusal matched the credential-read failure reason: '+name);
      assert(api.seen.length===before && !fs.existsSync(earlyEnv) && !fs.existsSync(path.join(live,call.id+'.json')),
        'The launcher started Claude Code for the '+name+' call');
    };
    await checkEarlyRefusal('wrong-mode',callOf('Reply OK.',{diagnostic:false}),parentEnv,/The dummy credential runs only a diagnostic smoke/);
    const live=prepare('live',hook),call=callOf('Reply OK.'),beforeLive=api.seen.length;
    let liveErr='';
    try { await launch(live,'Z0_WIRE_DUMMY',parentEnv,call,{record,onStderr:s=>{ liveErr+=s; }}); }
    catch(e) {
      if(api.seen.length===beforeLive && !fs.existsSync(seenEnv) && CRED_MISSING.test(liveErr))
        assert.fail('Launcher lost the dummy credential before starting child: '+e.message);
      throw e;
    }
    assert(!fs.readFileSync(seenEnv,'utf8').includes(TOKEN.slice(13)),'The probe wrote the credential to disk');
    const seen=read(seenEnv),want=Object.fromEntries(Object.entries(LAUNCHER_PRIVATE).map(([k,v])=>[k,v.replaceAll('$Live',live)]));
    assert.deepEqual(Object.keys(seen).sort(),['leaked','network','settings','token'],'The probe wrote unexpected fields to disk');
    assert.deepEqual(Object.keys(seen.settings).sort(),[...Object.keys(LAUNCHER_PRIVATE),...WIRE_KEYS].sort(),'The probe wrote unexpected settings to disk');
    for(const [k,v] of Object.entries(want))
      assert(k in seen.settings && (/[\\/]/.test(v) ? same(seen.settings[k],v) : seen.settings[k]===v),'The child did not get launcher setting '+k);
    assert.deepEqual(WIRE_KEYS.map(k=>seen.settings[k]),['http://wire:'+wireInfo.token+'@127.0.0.1:'+wireInfo.port,'127.0.0.1,localhost',WIRE_CA+'/ca.pem'],'The child did not get the wire settings');
    assert.deepEqual(seen.leaked,[],'The parent environment reached the child');
    assert.deepEqual(seen.network,['HTTPS_PROXY','NO_PROXY'],'The child got other network settings: '+seen.network.join(', '));
    assert(['absent','dummy'].includes(seen.token),'The child got another credential');
    const generate=api.seen.filter(s=>s.path.startsWith('/v1/messages'));
    assert(generate.length===1 && generate[0].requestClass==='main' && generate[0].authSha256===sha('Bearer '+TOKEN),
      'The launched call did not reach the upstream with the dummy credential and a class header');
    const result=evidence(path.join(live,'wire','probe'),read(path.join(live,'probe.json')),[],{rule:'none',keyPhrase:'none'},{prompt:call.prompt},
      path.join(live,'home/.claude/projects/unit',call.session+'.jsonl'));
    assert(result.complete && result.requests===1,'The launched call did not match its wire record');
    await checkEarlyRefusal('wrong-canary',callOf('Reply OK.'),{...parentEnv,Z0_WIRE_DUMMY:'sk-ant-oat01-notacanary'},/Unexpected dummy credential/);
    const decided=async (name,prompt)=>{
      const live=prepare(name),call=callOf(prompt);
      let error=null;
      try { await launch(live,'Z0_WIRE_DUMMY',parentEnv,call,{record}); } catch(e) { error=e.message; }
      const main=wireLedger(path.join(live,'wire','probe')).exchanges.filter(x=>x.route==='generate' && x.cls==='main');
      const rec=read(path.join(live,'probe.json'));
      return {error,stopped:rec.stopped,subtype:rec.subtype,limits:main.map(x=>x.limit)};
    };
    const busy=await decided('busy','CASE:busy Reply done.');
    assert.deepEqual([busy.error,busy.stopped,busy.limits],[null,false,['rate_limit_error',null]],'A retried 429 was not a success');
    const limit=await decided('limit','CASE:limit Reply done.');
    assert(limit.stopped && /Smoke cut off by a usage limit/.test(limit.error),'A 429 usage limit was not a cut-off: '+limit.error);
    const wording=await decided('wording','CASE:wording Reply done.');
    assert(wording.stopped && /stopped without a usage limit/.test(wording.error),'A 400 with limit wording was taken as a cut-off: '+wording.error);
    const exhaust=await decided('exhaust','CASE:exhaust Reply done.');
    assert(exhaust.stopped && /Smoke cut off by a usage limit/.test(exhaust.error) && exhaust.limits.length>2 && exhaust.limits.every(l=>l==='overloaded_error'),
      'Exhausted 529 retries were not a cut-off: '+exhaust.error);
    const capped=await decided('capped','CASE:tool Read a.txt and reply.');
    assert.deepEqual([capped.error,capped.stopped,capped.subtype],[null,false,'error_max_turns'],'A smoke that stopped at its turn cap was taken as a stop or did not hit max turns: '+JSON.stringify(capped));
    return {requests:api.seen.length,keys:Object.keys(want).length,decisions:5};
  } finally {
    await api.close();
    fs.rmSync(parent,{recursive:true,force:true});
  }
}

if(import.meta.main) {
  const out=path.resolve(process.argv[2] ?? path.join(process.env.TEMP,'knockout-wire-offline'));
  console.log(JSON.stringify({offline:await checkWireOffline(out),launcher:await checkLauncher()}));
}
