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
  assert.deepEqual(audited({first:'fail',grader:'crash-guard-1'},'p','OFF',audits),{first:'fail',grader:'crash-guard-1'});
  assert.equal(audited({first:'pass',grader:'crash-guard-1'},'p','ON',audits),null);
  assert.throws(()=>audited({first:'pass',grader:'crash-guard-1'},'r','ON',audits),/no crash audit record/);
  const fault=guard=>()=>{ const error=Error('checker for lesson x exited 2'); error.guard=guard; throw error; };
  assert.equal(classify(()=>'fail'),'ran');
  assert.equal(classify(fault({guard:GUARD,state:'crash',code:2})),'crash');
  for(const state of ['timeout','signal','error','wrapper-error','exit'])
    assert.equal(classify(fault({guard:GUARD,state})),'error',state);
  assert.equal(classify(fault({guard:'crash-guard-1',state:'crash'})),'error');
  assert.equal(classify(fault(null)),'error');
  assert.equal(classify(()=>{ throw Error('checker crashed: imitation'); }),'error');
  const seen=[];
  const call=(i,crash)=>()=>{ seen.push(i); if(crash) fault({guard:GUARD,state:'crash'})(); return 'pass'; };
  assert.deepEqual(auditCalls([call(0),call(1)]),{calls:2,status:'ran'});
  assert.deepEqual(auditCalls([call(2),call(3,true),call(4)]),{calls:3,status:'crash',call:1});
  assert.deepEqual(seen,[0,1,2,3]);
} finally {
  fs.rmSync(dir,{recursive:true,force:true});
}
console.log('Passed crash audit records, the missing rule for unguarded rows, blind classification and first-failure stop.');
