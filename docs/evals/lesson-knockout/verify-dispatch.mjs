import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openDispatchLog } from './delivery.mjs';
import { dispatched } from './evidence.mjs';
import { DISPATCH_LOG,pins } from './plan.mjs';

const CLI='C:/z0-runs/scored/bin/claude.exe';

async function offlineApi() {
  let requests=0;
  const server=http.createServer(async (req,res)=>{
    for await(const chunk of req) if(!chunk) break;
    requests++;
    res.writeHead(400,{'Content-Type':'application/json'});
    res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'offline dispatch check'}}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,requests:()=>requests,
    close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}

async function runOffline(base,sid) {
  const bodies=path.join(base,'bodies'),home=path.join(base,'home');
  fs.mkdirSync(path.join(home,'tmp'),{recursive:true});
  const api=await offlineApi(),log=await openDispatchLog(bodies);
  try {
    const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,HOME:home,USERPROFILE:home,
      TEMP:path.join(home,'tmp'),TMP:path.join(home,'tmp'),APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),
      CLAUDE_CONFIG_DIR:path.join(home,'.claude'),ANTHROPIC_BASE_URL:api.url,ANTHROPIC_API_KEY:'offline-dispatch-check',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',OTEL_LOG_RAW_API_BODIES:'file:'+bodies,...log.env};
    const cli=spawn(CLI,['-p','--output-format','json','--max-turns','1','--model',pins.modelOpus,'--session-id',sid],
      {cwd:base,env,windowsHide:true,stdio:['pipe','ignore','ignore']});
    cli.stdin.end('Reply OK.');
    await once(cli,'exit');
  } finally {
    await log.close();
    await api.close();
  }
  return {bodies,requests:api.requests()};
}

function mutated(bodies,name,change) {
  const copy=path.join(path.dirname(bodies),'mutant-'+name);
  fs.cpSync(bodies,copy,{recursive:true});
  change(copy);
  return copy;
}

export async function checkDispatchCapture(base) {
  const sid=randomUUID();
  const {bodies,requests}=await runOffline(base,sid);
  const names=fs.readdirSync(bodies).filter(n=>n.endsWith('.request.json')).sort();
  const result=dispatched(bodies,sid);
  assert(result.ok && names.length>0 && result.sources.size===requests,
    'The pinned CLI dispatch log does not match its body files: '+JSON.stringify({names:names.length,requests,events:result.sources.size}));
  assert.equal(dispatched(bodies,randomUUID()).ok,false,'Dispatch events of one session passed for another');
  const lines=fs.readFileSync(path.join(bodies,DISPATCH_LOG),'utf8').trim().split(/\r?\n/);
  for(const [name,change] of [
    ['lost-write',dir=>fs.unlinkSync(path.join(dir,names[0]))],
    ['truncated',dir=>fs.truncateSync(path.join(dir,names[0]),fs.statSync(path.join(dir,names[0])).size-1)],
    ['undispatched',dir=>fs.writeFileSync(path.join(dir,DISPATCH_LOG),lines.slice(1).join('\n'))],
    ['extra-body',dir=>fs.copyFileSync(path.join(dir,names[0]),path.join(dir,'extra.request.json'))],
    ['rejected-export',dir=>fs.appendFileSync(path.join(dir,DISPATCH_LOG),'\n'+JSON.stringify({'event.name':'export_error',error:'x'}))],
    ['no-log',dir=>fs.unlinkSync(path.join(dir,DISPATCH_LOG))]]) {
    assert.equal(dispatched(mutated(bodies,name,change),sid).ok,false,'A '+name+' capture of the pinned CLI passed');
  }
  return {requests,bodies:names.length};
}
