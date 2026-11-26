import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GUARD,seal } from './lesson.mjs';

const {CHECK_LOG:log,CHECK_STATUS:status,CHECK_STATUS_KEY:key,CHECK_DEADLINE_MS:deadline,...env}=process.env;
delete process.env.CHECK_STATUS_KEY;
const record=(state,extra={})=>{
  const body={guard:GUARD,state,...extra};
  fs.writeFileSync(status,JSON.stringify({...body,seal:seal(key,body)})+'\n');
};
const fail=error=>{
  fs.writeSync(2,'checker wrapper failed: '+(error?.stack ?? String(error))+'\n');
  try {
    if(status && key) record('wrapper-error');
  } finally {
    process.exit(2);
  }
};
process.on('uncaughtException',fail);
process.on('unhandledRejection',fail);

if(!status || !key) throw Error('CHECK_STATUS and CHECK_STATUS_KEY must be set');
const limit=Number(deadline ?? 120_000);
if(!Number.isInteger(limit) || limit<=0) throw Error('Invalid CHECK_DEADLINE_MS '+deadline);
const [check,...args]=process.argv.slice(2);
const guard=fileURLToPath(new URL('./guard.cjs',import.meta.url));
const note=text=>{ if(log) fs.appendFileSync(log,text); };
const forward=(fd,data)=>{
  for(let offset=0;offset<data.length;) {
    try { offset+=fs.writeSync(fd,data,offset); } catch(error) { if(error.code!=='EAGAIN') throw error; }
  }
};
const nonce=randomBytes(16).toString('hex'),started='started '+nonce+'\n';
const r=spawnSync(process.execPath,['--require',guard,check,...args],
  {env:{...env,CHECK_GUARD_FD:'3',CHECK_GUARD_NONCE:nonce},stdio:['inherit','pipe','pipe','pipe'],maxBuffer:1<<26,timeout:limit,windowsHide:true});
for(const [name,fd,data] of [['stdout',1,r.stdout],['stderr',2,r.stderr]]) {
  if(!data?.length) continue;
  note('--- checker '+name+'\n');
  note(data);
  forward(fd,data);
}
const seen=r.output?.[3]?.toString('utf8') ?? '';
const outcome=r.error?.code==='ETIMEDOUT' ? ['timeout',{limitMs:limit}] :
  r.error ? ['error',{message:r.error.message}] :
  r.status===null ? ['signal',{signal:r.signal}] :
  seen===started+'crash '+nonce+'\n' && r.status===2 ? ['crash',{code:r.status}] :
  seen===started ? ['exit',{code:r.status}] : ['unguarded',{code:r.status}];
if(outcome[0]!=='exit') note('checker did not finish: '+outcome[0]+'\n');
record(...outcome);
process.exit(outcome[0]==='exit' ? r.status : 2);
