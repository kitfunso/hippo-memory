import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GUARD } from '../checker-guard/lesson.mjs';
import { auditCalls,audited,auditFile,classify,readAudits } from './crash-audit.mjs';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ab-audit-'));
const write=(name,rows)=>{
  fs.writeFileSync(path.join(dir,name),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  return path.join(dir,name);
};
try {
  assert.equal(readAudits(auditFile(dir)).size,0);
  const audits=readAudits(write('crash-audit.jsonl',[{pair:'p',arm:'ON',status:'crash'},{pair:'p',arm:'OFF',status:'ran'},
    {pair:'q',arm:'OFF',status:'error'}]));
  assert.equal(audited({first:'pass'},'p','ON',audits),null);
  assert.deepEqual(audited({first:'fail'},'p','OFF',audits),{first:'fail'});
  assert.equal(audited({first:'pass'},'q','OFF',audits),null);
  assert.deepEqual(audited({first:'fail',grader:GUARD},'r','ON',audits),{first:'fail',grader:GUARD});
  assert.equal(audited(null,'r','ON',audits),null);
  assert.throws(()=>audited({first:'pass'},'r','ON',audits),/no crash audit record/);
  assert.throws(()=>audited({first:'pass',grader:'crash-guard-0'},'p','ON',audits),/Unknown grader stamp/);
  assert.throws(()=>readAudits(write('dup.jsonl',[{pair:'p',arm:'ON',status:'ran'},{pair:'p',arm:'ON',status:'ran'}])),/Duplicate/);
  assert.throws(()=>readAudits(write('bad.jsonl',[{pair:'p',arm:'ON',status:'pass'}])),/Unknown crash audit status/);
  const log=path.join(dir,'call.log');
  assert.equal(classify(log,()=>{ fs.writeFileSync(log,'verdict text'); return 'fail'; }),'ran');
  assert.ok(!fs.existsSync(log),'A log of a call that ran stayed on disk');
  assert.equal(classify(log,()=>{ fs.writeFileSync(log,'checker crashed: Error: x\n'); throw Error('checker for lesson x exited 2'); }),'crash');
  assert.equal(classify(log,()=>{ fs.writeFileSync(log,'checker did not finish: signal\n'); throw Error('checker for lesson x exited 2'); }),'error');
  assert.equal(classify(log,()=>{ fs.writeFileSync(log,'checker crashed: Error: x\n'); throw Error('checker for lesson x exited 7'); }),'error');
  assert.equal(classify(log,()=>{ throw Error('checker for lesson x exited 2'); }),'error');
  const seen=[];
  const call=result=>log=>{ seen.push(log); if(result) { fs.writeFileSync(log,'checker crashed: y\n'); throw Error('exited 2'); } return 'pass'; };
  assert.deepEqual(auditCalls([call(false),call(false)],i=>path.join(dir,'c'+i+'.log')),{calls:2,status:'ran'});
  const crashed=auditCalls([call(false),call(true),call(false)],i=>path.join(dir,'d'+i+'.log'));
  assert.deepEqual(crashed,{calls:3,status:'crash',call:1,log:path.join(dir,'d1.log')});
  assert.deepEqual(seen.slice(-2),[path.join(dir,'d0.log'),path.join(dir,'d1.log')]);
} finally {
  fs.rmSync(dir,{recursive:true,force:true});
}
console.log('Passed crash audit records, the missing rule for unguarded rows, blind classification and first-failure stop.');
