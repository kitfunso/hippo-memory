import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID,X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { spawn,spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { WIRE_CA,folder,hash,wireEnv } from './plan.mjs';
import { openWire } from './wire.mjs';
import { inside,copy,stateRoot } from './state.mjs';
import { cutOffBound,cutOffPermissions } from './evidence.mjs';
import { operatorEnv } from './setup.mjs';

export const STOPPED=75;
export const limitBound=(records,live,call)=>
  cutOffBound(path.join(records,'wire',call.id),path.join(live,'home/.claude/projects'),call.session,call.prompt).bound;
export function cutOff(code,records,live,call,bound=limitBound,permissions=cutOffPermissions) {
  if(code===0) return false;
  if(code!==STOPPED) throw Error('Claude Code launcher exited '+code);
  if(!bound(records,live,call)) throw Error('Claude Code stopped without a usage limit on the wire and in the transcript: '+call.id);
  if(!call.smoke && !permissions(records,live,call)) throw Error('Claude Code stopped without valid permission evidence: '+call.id);
  return true;
}

export async function openCue(work,sid) {
  const route='/'+randomUUID();
  const server=http.createServer(async (req,res)=>{
    try {
      if(req.url!==route || req.method!=='POST' || req.headers.authorization) throw Error('Unexpected request');
      let raw='';
      for await(const chunk of req) { raw+=chunk; if(raw.length>1024*1024) throw Error('Oversized hook'); }
      const e=JSON.parse(raw);
      if(e.session_id!==sid || e.hook_event_name!=='UserPromptSubmit' || path.resolve(e.cwd)!==work) throw Error('Wrong event');
      const db=new DatabaseSync(path.join(work,'.hippo/hippo.db'),{readOnly:true});
      let rows;
      try { rows=db.prepare('SELECT content FROM memories ORDER BY id COLLATE NOCASE').all(); } finally { db.close(); }
      if(rows.length<20) throw Error('Incomplete store');
      const additionalContext='Project notes\n'+rows.map(r=>'- '+r.content).join('\n');
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext}}));
    } catch { res.writeHead(400); res.end('Invalid hook event'); }
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {hook:{type:'http',url:'http://127.0.0.1:'+server.address().port+route,timeout:5},
    close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
export function openCallWire(dir,ca=WIRE_CA) {
  const leaf=path.join(ca,'leaf.pem');
  if(!fs.existsSync(leaf)) throw Error('Missing wire CA; run node wire.mjs ca '+ca);
  if(Date.parse(new X509Certificate(fs.readFileSync(leaf)).validTo)<Date.now()+86_400_000) throw Error('Wire certificate expires within a day');
  return openWire(dir,{ca});
}
async function recorded(records,call,invokeOnce,record) {
  const dir=path.join(records,'wire',call.id);
  if(fs.existsSync(dir)) throw Error('Stale wire record for '+call.id);
  const wire=await record(dir);
  let code,error;
  try {
    fs.writeFileSync(path.join(records,'call.json'),JSON.stringify({...call,wireEnv:wireEnv(wire.port,wire.token)}));
    code=await invokeOnce();
  } catch(e) { error=e; }
  const state=await wire.close();
  if(error) throw error;
  if(!state.ok) throw Error('Wire record failed for '+call.id+': '+JSON.stringify(state));
  return code;
}
async function invoke(live,token,env,boxChecked=false,onStderr) {
  const proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(folder,'launch.ps1'),'-Live',live,'-TokenVar',token,...(boxChecked?['-BoxChecked']:[])],
    {cwd:path.dirname(live),env:operatorEnv(env,live),windowsHide:true,stdio:['inherit','inherit',onStderr ? 'pipe' : 'inherit']});
  if(onStderr) proc.stderr.on('data',d=>{ process.stderr.write(d); onStderr(String(d)); });
  const [code]=await once(proc,onStderr ? 'close' : 'exit');
  return code;
}

function runBoxCheck(live,env) {
  const script='C:/z0-runs/s7/box-check.sh';
  if(hash(fs.readFileSync(script))!=='4548084ad76f9eecc834a5eba5401dd1b32e0a91baec52fe2e9915c1c831cfb0')
    throw Error('box-check.sh differs from the registered script');
  return spawnSync('C:/Program Files/Git/bin/bash.exe',[script],{
    cwd:path.dirname(live),env:operatorEnv(env,live),windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','inherit']});
}

async function waitForBox(checkBox,delay) {
  for (;;) {
    const {status,stdout,error}=checkBox();
    if(error) throw error;
    if(stdout) process.stdout.write(stdout);
    if(status===0) return;
    const median=/; median (\d+) \(limit 150\)$/.exec(stdout?.trimEnd());
    if(status!==1 || !median || Number(median[1])<=150) throw Error('box-check.sh failed (exit '+status+')');
    await delay(5*60_000);
  }
}

export async function retryLimited(live,call,invokeOnce,checkBox,{delay=wait,maxWaits=8*96,gate,onFirstCall,record=openCallWire,bound=limitBound,permissions=cutOffPermissions}={}) {
  gate?.();
  const ticket=randomUUID(),checkpoint=inside(path.join(stateRoot,'checkpoints',ticket));
  const archives=[];
  const records=inside(path.join(path.dirname(live),'operator'));
  const locations=[['live',live],['operator',records]];
  const snapshot=dest=>{
    fs.mkdirSync(dest);
    for(const [name,src] of locations) copy(src,path.join(dest,name));
  };
  for(let i=0;;i++) {
    await waitForBox(checkBox,delay);
    if(i===0) {
      snapshot(checkpoint);
      onFirstCall?.();
    }
    const code=await recorded(records,call,invokeOnce,record);
    if(!cutOff(code,records,live,call,bound,permissions)) { fs.rmSync(inside(checkpoint),{recursive:true}); return archives; }
    const dest=inside(path.join(stateRoot,'limit-archives',ticket+'-'+i));
    snapshot(dest);
    archives.push(path.join(dest,'live'));
    if(i>=maxWaits) throw Error('Subscription wait exhausted; partial unit retained');
    await delay(15*60_000);
    for(const [name,dst] of locations) {
      fs.rmSync(inside(dst),{recursive:true});
      copy(path.join(checkpoint,name),dst);
    }
  }
}
export async function launch(live,token,env,call,{gate,onFirstCall,dispatch,
  checkBox=()=>runBoxCheck(live,env),record=openCallWire,onStderr}={}) {
  if(!call.smoke) return retryLimited(live,call,dispatch ?? (()=>invoke(live,token,env,true,onStderr)),checkBox,{gate,onFirstCall,record});
  gate?.();
  const code=await recorded(live,call,()=>invoke(live,token,env,false,onStderr),record);
  if(cutOff(code,live,live,call)) throw Error('Smoke cut off by a usage limit: '+call.id);
  return [];
}
