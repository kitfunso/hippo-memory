import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GUARD,guardState } from '../checker-guard/lesson.mjs';
import { read } from './paths.mjs';

export const STATUSES=['ran','crash','error','unverifiable'];
export const auditFile=root=>path.join(root,'crash-audit.jsonl');
export const AUDITED_GRADERS=[undefined,'crash-guard-1'];
export const GUARDED_GRADERS=['crash-guard-2',GUARD];

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

export function boundIntent(base,arm,dir) {
  const isIntent=name=>{
    const index=name.startsWith(arm+'-') && name.endsWith('.json') ? name.slice(arm.length+1,-'.json'.length) : '';
    return index!=='' && String(Number(index))===index;
  };
  const found=fs.readdirSync(base).filter(isIntent).map(name=>({name,...read(path.join(base,name))})).filter(i=>i.dir===dir);
  return found.length===1?found[0]:null;
}

export function armBinding(base,arm) {
  const {dir}=read(path.join(base,arm+'.json'));
  return {dir,id:boundIntent(base,arm,dir)?.id};
}

export function audited(row,pair,arm,audits,binding) {
  if(row===null || GUARDED_GRADERS.includes(row.grader)) return row;
  assert.ok(AUDITED_GRADERS.includes(row.grader),'Unknown grader stamp on the '+arm+' row of '+pair);
  const a=audits.get(pair+' '+arm);
  assert.ok(a,'The unguarded '+arm+' row of '+pair+' has no crash audit record');
  const ran=a.status==='ran';
  assert.ok(a.dir===binding.dir && a.grader===row.grader && (!ran || (a.id===binding.id && a.calls===1+row.listings.length)),
    'The crash audit record for the '+arm+' row of '+pair+' does not match that row');
  return ran?row:null;
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
