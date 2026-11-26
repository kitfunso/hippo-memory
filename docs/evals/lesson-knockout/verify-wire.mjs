import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { makeWireCa,openWire } from './wire.mjs';
import { startScriptedApi } from './scripted-api.mjs';
import { callComplete,cutOffBound,wireLedger } from './evidence.mjs';
import { DENIED_TOOLS,folder,pins } from './plan.mjs';

const CLI='C:/z0-runs/scored/bin/claude.exe';
const TOKEN='sk-ant-oat01-'+'wirecanary'.repeat(8);
const sha=text=>createHash('sha256').update(text).digest('hex');

function launcherKeys() {
  const text=fs.readFileSync(path.join(folder,'launch.ps1'),'utf8');
  const block=/\$private=@\{([\s\S]*?)\}\r?\n/.exec(text)?.[1];
  assert(block,'launch.ps1 has no private environment block');
  return [...block.matchAll(/(\w+)=/g)].map(m=>m[1]);
}

function childEnv(home,port,ca) {
  const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),
    APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),TEMP:path.join(home,'tmp'),TMP:path.join(home,'tmp'),
    HIPPO_HOME:path.join(home,'.hippo'),CLAUDE_CODE_PROJECT_DIR_NAME:'unit',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',GIT_TERMINAL_PROMPT:'0',EVAL_SEED:'1',
    HTTPS_PROXY:'http://127.0.0.1:'+port,NO_PROXY:'127.0.0.1,localhost',NODE_EXTRA_CA_CERTS:path.join(ca,'ca.pem'),
    CLAUDE_CODE_OAUTH_TOKEN:TOKEN};
  const missing=launcherKeys().filter(k=>!(k in env));
  assert.deepEqual(missing,[],'The offline check lacks launcher settings: '+missing.join(', '));
  return env;
}

export async function checkWireOffline(base) {
  fs.rmSync(base,{recursive:true,force:true});
  const home=path.join(base,'home'),work=path.join(base,'work'),settings=path.join(base,'settings.json');
  for(const d of ['tmp','roaming','local','.claude']) fs.mkdirSync(path.join(home,d),{recursive:true});
  fs.mkdirSync(work,{recursive:true});
  fs.writeFileSync(path.join(work,'a.txt'),'alpha');
  fs.writeFileSync(settings,JSON.stringify({hooks:{},permissions:{deny:DENIED_TOOLS},sandbox:{enabled:false}}));
  const ca=makeWireCa(path.join(base,'ca'),2),api=await startScriptedApi(ca),outcomes={};
  const projects=path.join(home,'.claude','projects');
  async function run(name,prompt,{resume,killAfter=180000,prepare}={}) {
    const dir=path.join(base,'wire',name),session=resume ?? randomUUID();
    fs.mkdirSync(dir,{recursive:true});
    prepare?.(dir);
    const wire=await openWire(dir,{ca,upstream:api.upstream}),before=api.seen.length;
    const argv=['-p','--output-format','json','--setting-sources','','--strict-mcp-config','--settings',settings,
      '--model',pins.modelOpus,'--effort',pins.effort,'--permission-mode','bypassPermissions',resume?'--resume':'--session-id',session];
    const cli=spawn(CLI,argv,{cwd:work,env:childEnv(home,wire.port,ca),windowsHide:true,stdio:['pipe','pipe','ignore']});
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
    const seen=api.seen.slice(before);
    outcomes[name]={state,seen,dir,session,result,complete:callComplete(dir,result,prompt,transcript),
      cut:cutOffBound(dir,projects,session,prompt),ledger:wireLedger(dir)};
    return session;
  }
  try {
    const sid=await run('tool','CASE:tool Read a.txt and reply.');
    await run('resume','CASE:resume Reply done.',{resume:sid});
    await run('retry','CASE:retry Reply done.');
    await run('limit','CASE:limit Reply done.');
    await run('gzip','CASE:gzip Reply done.');
    await run('midstream','CASE:midstream Reply done.');
    await run('stall','CASE:stall Reply done.',{killAfter:15000});
    await run('diskfull','CASE:final Reply done.',{killAfter:20000,prepare:dir=>fs.mkdirSync(path.join(dir,'00003.request.json'))});
    const [open,write]=[fs.openSync,fs.writeSync],replies=new Set();
    fs.openSync=(file,...a)=>{ const fd=open(file,...a); if(String(file).endsWith('.response')) replies.add(fd); return fd; };
    fs.writeSync=(fd,...a)=>{ if(replies.has(fd)) throw Object.assign(Error('ENOSPC: no space left on device, write'),{code:'ENOSPC'}); return write(fd,...a); };
    try { await run('replyfull','CASE:final Reply done.',{killAfter:20000}); } finally { [fs.openSync,fs.writeSync]=[open,write]; }
  } finally { await api.close(); }
  const generate=o=>o.ledger.exchanges.filter(x=>x.route==='generate');
  for(const name of ['tool','resume','retry','gzip','midstream'])
    assert(outcomes[name].state.ok && outcomes[name].complete.complete,'The wire did not match the transcript for '+name);
  assert.equal(generate(outcomes.tool).filter(x=>x.complete).length,2,'The tool turn did not reach the wire');
  for(const name of ['retry','midstream']) assert.equal(generate(outcomes[name]).filter(x=>!x.complete).length,1,'The '+name+' retry left no failed exchange');
  assert(outcomes.limit.state.ok && !outcomes.limit.complete.complete && outcomes.limit.cut.bound,'The 429 was not bound to its error turn');
  assert(outcomes.stall.state.ok && !outcomes.stall.complete.complete && !outcomes.stall.cut.bound,'A stalled call passed');
  assert.deepEqual(generate(outcomes.stall).map(x=>x.ended),['client-closed'],'The stalled stream was not recorded as abandoned');
  assert(!outcomes.diskfull.state.ok && !outcomes.diskfull.ledger.ok,'A failed body write left a valid wire');
  assert(!outcomes.diskfull.seen.some(s=>s.kind!=='other'),'A request the wire could not save reached the upstream');
  const replyRows=fs.readFileSync(path.join(outcomes.replyfull.dir,'wire.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert(!outcomes.replyfull.state.ok && !outcomes.replyfull.ledger.ok && replyRows.some(r=>r.kind==='fault' && r.stage==='response-file'),
    'A failed reply write did not latch the wire');
  assert(!outcomes.replyfull.complete.complete,'A call whose reply the wire could not save passed');
  const forwarded=Object.values(outcomes).flatMap(o=>o.ledger.ok ? o.seen : []);
  for(const o of Object.values(outcomes).filter(o=>o.ledger.ok)) {
    assert.deepEqual(o.ledger.hosts,[],'An offline call opened a tunnel to another host');
    const rows=fs.readFileSync(path.join(o.dir,'wire.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
    const sent=new Map(rows.filter(r=>r.kind==='request').map(r=>[r.seq,r.sha256]));
    for(const r of rows.filter(r=>r.kind==='response')) {
      const upstream=o.seen.find(s=>s.requestId===r.requestId);
      assert(upstream && upstream.sha256===sent.get(r.seq),'The upstream received other bytes than the wire saved');
    }
  }
  assert(forwarded.length>0 && forwarded.every(s=>s.authSha256===sha('Bearer '+TOKEN)),'The credential did not reach the upstream unchanged');
  assert(forwarded.some(s=>s.metadata),'The canary request carried no metadata');
  const retained=fs.readdirSync(path.join(base,'wire'),{recursive:true}).map(f=>path.join(base,'wire',f)).filter(f=>fs.statSync(f).isFile());
  for(const file of retained) {
    const text=fs.readFileSync(file,'latin1');
    assert(!text.includes(TOKEN.slice(13)) && !text.includes('"metadata"') && !/device_id|account_uuid/.test(text),
      'A retained wire file holds the credential or identity fields: '+path.relative(base,file));
  }
  return {cases:Object.keys(outcomes).length,requests:forwarded.length,files:retained.length};
}

if(import.meta.main) {
  const out=path.resolve(process.argv[2] ?? path.join(process.env.TEMP,'knockout-wire-offline'));
  console.log(JSON.stringify(await checkWireOffline(out)));
}
