import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn,spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { folder,hash } from './plan.mjs';
import { inside,copy,stateRoot } from './state.mjs';

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
async function invoke(live,token,env,boxChecked=false) {
  const proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(folder,'launch.ps1'),'-Live',live,'-TokenVar',token,...(boxChecked?['-BoxChecked']:[])],
    {cwd:path.dirname(live),env,windowsHide:true,stdio:'inherit'});
  const [code]=await once(proc,'exit');
  return code;
}

function runBoxCheck(live,env) {
  const script='C:/z0-runs/s7/box-check.sh';
  if(hash(fs.readFileSync(script))!=='4548084ad76f9eecc834a5eba5401dd1b32e0a91baec52fe2e9915c1c831cfb0')
    throw Error('box-check.sh differs from the registered script');
  return spawnSync('C:/Program Files/Git/bin/bash.exe',[script],{
    cwd:path.dirname(live),env,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','inherit']});
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

export async function retryLimited(live,call,invokeOnce,checkBox,{delay=wait,maxWaits=8*96,gate,onFirstCall}={}) {
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
    fs.writeFileSync(path.join(records,'call.json'),JSON.stringify(call));
    const code=await invokeOnce();
    if(code===0) { fs.rmSync(inside(checkpoint),{recursive:true}); return archives; }
    if(code!==75) throw Error('Claude Code launcher exited '+code);
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
export async function launch(live,token,env,call,{gate,onFirstCall}={}) {
  if(!call.smoke) return retryLimited(live,call,()=>invoke(live,token,env,true),()=>runBoxCheck(live,env),{gate,onFirstCall});
  gate?.();
  fs.writeFileSync(path.join(live,'call.json'),JSON.stringify(call));
  const code=await invoke(live,token,env);
  if(code!==0) throw Error('Smoke launcher exited '+code);
  return [];
}
