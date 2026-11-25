import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GUARD,guardState } from '../checker-guard/lesson.mjs';

export const STATUSES=['ran','crash','error'];
export const auditFile=root=>path.join(root,'crash-audit.jsonl');
export const AUDITED_GRADERS=[undefined,'crash-guard-1'];

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
  assert.ok(AUDITED_GRADERS.includes(row.grader),'Unknown grader stamp on the '+arm+' row of '+pair);
  const a=audits.get(pair+' '+arm);
  assert.ok(a,'The unguarded '+arm+' row of '+pair+' has no crash audit record');
  return a.status==='ran'?row:null;
}

export function classify(grade) {
  try {
    grade();
  } catch(error) {
    return guardState(error);
  }
  return 'ran';
}

export function auditCalls(calls) {
  for(const [index,grade] of calls.entries()) {
    const status=classify(grade);
    if(status!=='ran') return {calls:calls.length,status,call:index};
  }
  return {calls:calls.length,status:'ran'};
}
