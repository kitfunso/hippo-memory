import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GUARD } from '../checker-guard/lesson.mjs';
import { armBinding,auditCalls,audited,auditFile,boundIntent,classify,readAudits } from './crash-audit.mjs';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ab-audit-'));
const write=(name,rows)=>{
  fs.writeFileSync(path.join(dir,name),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  return path.join(dir,name);
};
try {
  assert.equal(readAudits(auditFile(dir)).size,0);
  const bind={dir:'slot',id:'session'},row=(first,extra={})=>({first,listings:[{}],...extra});
  const record=(pair,arm,status,extra={})=>({pair,arm,status,dir:'slot',id:'session',calls:2,...extra});
  const audits=readAudits(write('crash-audit.jsonl',[record('p','ON','crash'),record('p','OFF','ran'),record('q','OFF','error'),
    record('s','ON','unverifiable',{id:undefined,reason:'no transcript'}),record('g','ON','ran',{grader:'crash-guard-1'})]));
  assert.equal(audited(row('pass'),'p','ON',audits,bind),null);
  assert.deepEqual(audited(row('fail'),'p','OFF',audits,bind),row('fail'));
  assert.equal(audited(row('pass'),'q','OFF',audits,bind),null);
  assert.equal(audited(row('pass'),'s','ON',audits,bind),null);
  assert.deepEqual(audited(row('fail',{grader:'crash-guard-1'}),'g','ON',audits,bind),row('fail',{grader:'crash-guard-1'}));
  assert.deepEqual(audited(row('fail',{grader:GUARD}),'r','ON',audits,bind),row('fail',{grader:GUARD}));
  assert.equal(audited(null,'r','ON',audits,bind),null);
  assert.throws(()=>audited(row('pass'),'r','ON',audits,bind),/no crash audit record/);
  assert.throws(()=>audited(row('pass',{grader:'crash-guard-0'}),'p','ON',audits,bind),/Unknown grader stamp/);
  assert.throws(()=>audited(row('pass',{grader:'crash-guard-1'}),'p','OFF',audits,bind),/does not match/);
  assert.throws(()=>audited(row('pass'),'p','OFF',audits,{...bind,dir:'other'}),/does not match/);
  assert.throws(()=>audited(row('pass'),'p','OFF',audits,{...bind,id:'other'}),/does not match/);
  assert.throws(()=>audited(row('pass',{listings:[]}),'p','OFF',audits,bind),/does not match/);
  assert.throws(()=>readAudits(write('dup.jsonl',[record('p','ON','ran'),record('p','ON','ran')])),/Duplicate/);
  assert.throws(()=>readAudits(write('bad.jsonl',[record('p','ON','pass')])),/Unknown crash audit status/);
  const base=path.join(dir,'pair');
  fs.mkdirSync(base);
  const put=(name,value)=>fs.writeFileSync(path.join(base,name),JSON.stringify(value));
  put('ON.json',{row:null,dir:'slot-b'});
  put('ON-0.json',{id:'a',dir:'slot-a'});
  put('ON-1.json',{id:'b',dir:'slot-b'});
  put('ON-1.returned.json',{limited:false,at:1,dir:'slot-b'});
  put('ON-x.json',{id:'c',dir:'slot-b'});
  put('OFF-0.json',{id:'d',dir:'slot-b'});
  assert.deepEqual(armBinding(base,'ON'),{dir:'slot-b',id:'b'});
  assert.equal(boundIntent(base,'ON','slot-b').name,'ON-1.json');
  put('ON-2.json',{id:'e',dir:'slot-b'});
  assert.equal(boundIntent(base,'ON','slot-b'),null);
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
