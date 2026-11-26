import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD='crash-guard-2';
const {CHECK_LOG:log,CHECK_STATUS:status,CHECK_DEADLINE_MS:deadline,...env}=process.env;
const record=(state,extra={})=>fs.writeFileSync(status,JSON.stringify({guard:GUARD,state,...extra})+'\n');
const fail=error=>{
  fs.writeSync(2,'checker wrapper failed: '+(error?.stack ?? String(error))+'\n');
  try {
    if(status) record('wrapper-error');
  } finally {
    process.exit(2);
  }
};
process.on('uncaughtException',fail);
process.on('unhandledRejection',fail);

if(!status) throw Error('CHECK_STATUS is not set');
const limit=Number(deadline ?? 120_000);
if(!Number.isInteger(limit) || limit<=0) throw Error('Invalid CHECK_DEADLINE_MS '+deadline);
const [check,...args]=process.argv.slice(2);
const guard=fileURLToPath(new URL('./guard.cjs',import.meta.url));
const mark=status+'.mark';
fs.rmSync(mark,{force:true});
const note=text=>{ if(log) fs.appendFileSync(log,text); };
const forward=(fd,data)=>{
  for(let offset=0;offset<data.length;) {
    try { offset+=fs.writeSync(fd,data,offset); } catch(error) { if(error.code!=='EAGAIN') throw error; }
  }
};
const r=spawnSync(process.execPath,['--require',guard,check,...args],
  {env:{...env,CHECK_GUARD_MARK:mark},stdio:['inherit','pipe','pipe'],maxBuffer:1<<26,timeout:limit,windowsHide:true});
for(const [name,fd,data] of [['stdout',1,r.stdout],['stderr',2,r.stderr]]) {
  if(!data?.length) continue;
  note('--- checker '+name+'\n');
  note(data);
  forward(fd,data);
}
const seen=fs.existsSync(mark) ? fs.readFileSync(mark,'utf8') : null;
fs.rmSync(mark,{force:true});
const outcome=r.error?.code==='ETIMEDOUT' ? ['timeout',{limitMs:limit}] :
  r.error ? ['error',{message:r.error.message}] :
  r.status===null ? ['signal',{signal:r.signal}] :
  seen==='crash' ? ['crash',{code:r.status}] :
  seen==='started' ? ['exit',{code:r.status}] : ['unguarded',{code:r.status}];
if(outcome[0]!=='exit') note('checker did not finish: '+outcome[0]+'\n');
record(...outcome);
process.exit(outcome[0]==='exit' ? r.status : 2);
