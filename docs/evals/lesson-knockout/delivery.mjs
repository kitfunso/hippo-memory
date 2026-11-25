import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { folder } from './plan.mjs';

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
export async function launch(live,token,env) {
  const proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(folder,'launch.ps1'),'-Live',live,'-TokenVar',token],
    {cwd:path.dirname(live),env,windowsHide:true,stdio:'inherit'});
  const [code]=await once(proc,'exit');
  if(code!==0) throw Error('Claude Code launcher exited '+code);
}
