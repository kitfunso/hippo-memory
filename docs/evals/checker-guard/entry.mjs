import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [check,...args]=process.argv.slice(2);
const guard=fileURLToPath(new URL('./guard.cjs',import.meta.url));
const {CHECK_LOG:log,...env}=process.env;
const note=text=>{ if(log) fs.appendFileSync(log,text); };
const forward=(fd,data)=>{
  for(let offset=0;offset<data.length;) {
    try { offset+=fs.writeSync(fd,data,offset); } catch(error) { if(error.code!=='EAGAIN') throw error; }
  }
};
const r=spawnSync(process.execPath,['--require',guard,check,...args],
  {env,stdio:['inherit','pipe','pipe'],maxBuffer:1<<26,timeout:115_000,windowsHide:true});
for(const [name,fd,data] of [['stdout',1,r.stdout],['stderr',2,r.stderr]]) {
  if(!data?.length) continue;
  note('--- checker '+name+'\n');
  note(data);
  forward(fd,data);
}
if(r.error || r.status===null) {
  note('checker did not finish: '+(r.error?.message ?? 'signal '+r.signal)+'\n');
  process.exit(2);
}
process.exit(r.status);
