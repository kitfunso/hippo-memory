import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { folder,root } from './plan.mjs';
import { inside,copy } from './state.mjs';

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
async function invoke(live,token,env,scored) {
  const argv=scored?[path.join(folder,'worker.ps1'),'-Action','launch']:[path.join(folder,'launch.ps1')];
  const proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    ...argv,'-Live',live,'-TokenVar',token],
    {cwd:path.dirname(live),env,windowsHide:true,stdio:'inherit'});
  const [code]=await once(proc,'exit');
  return code;
}

export async function retryLimited(live,invokeOnce,delay=wait,maxWaits=8*96) {
  const ticket=randomUUID(),checkpoint=inside(path.join(root,'checkpoints',ticket));
  copy(live,checkpoint);
  for(let i=0;;i++) {
    const code=await invokeOnce();
    if(code===0) { fs.rmSync(inside(checkpoint),{recursive:true}); return; }
    if(code!==75) throw Error('Claude Code launcher exited '+code);
    const dest=inside(path.join(root,'limit-archives',ticket+'-'+i));
    copy(live,dest);
    if(i>=maxWaits) throw Error('Subscription wait exhausted; partial unit retained');
    await delay(15*60_000);
    fs.rmSync(inside(live),{recursive:true});
    copy(checkpoint,live);
  }
}
export async function launch(live,token,env,scored=false) {
  const once=()=>invoke(live,token,env,scored);
  if(scored) return retryLimited(live,once);
  const code=await once();
  if(code!==0) throw Error('Smoke launcher exited '+code);
}
