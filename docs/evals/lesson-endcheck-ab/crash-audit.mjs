import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GUARD } from '../checker-guard/lesson.mjs';

export const STATUSES=['ran','crash','error'];
export const auditFile=root=>path.join(root,'crash-audit.jsonl');

export function readAudits(file) {
  const audits=new Map();
  if(!fs.existsSync(file)) return audits;
  for(const line of fs.readFileSync(file,'utf8').split('\n').filter(Boolean)) {
    const a=JSON.parse(line),key=a.pair+' '+a.arm;
    assert.ok(STATUSES.includes(a.status),'Unknown crash audit status for '+key);
    assert.ok(!audits.has(key),'Duplicate crash audit record for '+key);
    audits.set(key,a);
  }
  return audits;
}

export function audited(row,pair,arm,audits) {
  if(row===null || row.grader===GUARD) return row;
  assert.equal(row.grader,undefined,'Unknown grader stamp on the '+arm+' row of '+pair);
  const a=audits.get(pair+' '+arm);
  assert.ok(a,'The unguarded '+arm+' row of '+pair+' has no crash audit record');
  return a.status==='ran'?row:null;
}

export function classify(log,grade) {
  fs.rmSync(log,{force:true});
  try {
    grade();
  } catch(error) {
    const text=fs.existsSync(log)?fs.readFileSync(log,'utf8'):'';
    return /exited 2\b/.test(error.message) && /^checker crashed: /m.test(text)?'crash':'error';
  }
  fs.rmSync(log,{force:true});
  return 'ran';
}

export function auditCalls(calls,logOf) {
  for(const [index,grade] of calls.entries()) {
    const log=logOf(index),status=classify(log,()=>grade(log));
    if(status!=='ran') return {calls:calls.length,status,call:index,log};
  }
  return {calls:calls.length,status:'ran'};
}
