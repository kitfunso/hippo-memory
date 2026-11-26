import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GUARD } from '../checker-guard/lesson.mjs';
import { summarize } from './analyze.mjs';
import { schedule } from './design.mjs';
import { loadPlan } from './paths.mjs';
import { armBinding,auditCalls,audited,auditFile,boundIntent,classify,readAudits,replayed } from './crash-audit.mjs';

const INFRA_CODES=new Set(['EBUSY','EPERM','ENOSPC','ENOMEM','EMFILE','EADDRINUSE','ENOENT']);
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
  assert.equal(GUARD,'crash-guard-3','The guard stamp changed without a new audit rule');
  assert.deepEqual(audited(row('fail',{grader:'crash-guard-3'}),'r','ON',audits,bind),row('fail',{grader:'crash-guard-3'}));
  assert.deepEqual(audited(row('fail',{grader:'crash-guard-2'}),'r','ON',audits,bind),row('fail',{grader:'crash-guard-2'}),
    'The rows the running A/B collector stamps crash-guard-2 changed meaning');
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
  assert.equal(classify(fault({guard:'crash-guard-3',state:'crash',code:2})),'crash');
  for(const state of ['timeout','signal','error','wrapper-error','exit'])
    assert.equal(classify(fault({guard:'crash-guard-3',state})),'error',state);
  assert.equal(classify(fault({guard:'crash-guard-1',state:'crash'})),'error');
  assert.equal(classify(fault({forged:{guard:'crash-guard-3',state:'crash'}})),'error');
  assert.equal(classify(fault(null)),'error');
  assert.equal(classify(()=>{ throw Error('checker crashed: imitation'); }),'error');
  const seen=[];
  const call=(i,crash)=>()=>{ seen.push(i); if(crash) fault({guard:'crash-guard-3',state:'crash'})(); return 'pass'; };
  assert.deepEqual(auditCalls([call(0),call(1)]),{calls:2,status:'ran'});
  assert.deepEqual(auditCalls([call(2),call(3,true),call(4)]),{calls:3,status:'crash',call:1});
  assert.deepEqual(seen,[0,1,2,3]);
  const units=new Map(loadPlan().units.map(u=>[u.id,u]));
  const clean={first:'pass',stops:0,productionTimeouts:0,nonStopTimeouts:0,listings:[]};
  const pairs=schedule.map(p=>({p,u:units.get(p.id)}));
  const plain=pairs.map(({p,u},i)=>({p,u,off:{...clean,first:u.historicalPass?'pass':'fail'},on:{...clean,stops:1,productionTimeouts:i===0?1:0}}));
  const stamped=plain.map(({p,u,off,on})=>({p,u,off:audited({...off,grader:'crash-guard-2'},p.key,'OFF',new Map(),bind),
    on:audited({...on,grader:'crash-guard-3'},p.key,'ON',new Map(),bind)}));
  assert(stamped.every(r=>r.off.grader==='crash-guard-2' && r.on.grader==='crash-guard-3'),'A guarded row was dropped at selection');
  const lines=summarize(stamped);
  assert.deepEqual(lines,summarize(plain),'Guard 2 and guard 3 rows changed the analysis');
  assert.match(lines[0],new RegExp('^CLOSED pairs='+schedule.length+'/'+schedule.length+'$'));
  assert.match(lines.at(-1),/ missing_OFF=0 missing_ON=0$/);
  assert.throws(()=>audited({...clean,grader:'crash-guard-4'},schedule[0].key,'ON',new Map(),bind),/Unknown grader stamp/);
  assert.deepEqual([null,{grader:'crash-guard-2'},{grader:'crash-guard-3'},{grader:GUARD},{},{grader:'crash-guard-1'}].map(r=>replayed(r,'p','ON')),
    [false,false,false,false,true,true],'Replay selection read a grader stamp wrongly');
  assert.throws(()=>replayed({grader:'crash-guard-4'},'p','OFF'),/Unknown grader stamp on the OFF row of p/);
  assert(fs.readFileSync(fileURLToPath(new URL('./run.mjs',import.meta.url)),'utf8').includes('if(!replayed(row,p.key,arm) ||'),
    'The replay pass does not select rows by the shared stamp rule');
  const analyzer=fileURLToPath(new URL('./analyze.mjs',import.meta.url)),alias=path.join(dir,'alias');
  fs.symlinkSync(path.dirname(analyzer),alias,'junction');
  try {
    for(const entry of [path.join(alias,'analyze.mjs'),analyzer.replace(/lesson-endcheck-ab/,'LESSON-ENDCHECK-AB')]) {
      const out=execFileSync(process.execPath,[entry,'--fixture'],{encoding:'utf8'});
      assert.match(out,new RegExp('^CLOSED pairs='+schedule.length+'/'+schedule.length+'$','m'),'The analysis did not run from '+entry);
    }
  } finally { fs.unlinkSync(alias); }
  const spy=path.join(dir,'probe-spy.cjs'),adapter=fileURLToPath(new URL('./file-stdio.cjs',import.meta.url));
  fs.writeFileSync(spy,"const cp=require('node:child_process'),o=cp.spawnSync;cp.spawnSync=(f,a,opt={})=>{"+
    "if(f==='git')process.stdout.write(JSON.stringify(Object.keys(opt.env??process.env).sort()));return o(f,a,opt);};"+
    "require("+JSON.stringify(adapter)+");");
  const {LESSON_STDIO:parentMode,...unset}=process.env;
  const probed=env=>execFileSync(process.execPath,['--require',spy,'-e',''],{env,encoding:'utf8'});
  assert.deepEqual(JSON.parse(probed({...unset,CHECK_STATUS_KEY:'secret',CHECK_STATUS:'status'})),['PATH','SystemRoot'],
    'The stdio mode probe saw more than SystemRoot and PATH');
  assert.equal(probed({...unset,LESSON_STDIO:'file'}),'','A child with a stdio mode probed again');
} catch(e) {
  const msg=String(e?.message ?? e).split(/\r?\n/)[0].trim();
  if(INFRA_CODES.has(e?.code)) console.error('VERIFY_INFRA: '+e.code+': '+msg);
  else console.error('VERIFY_FAIL: '+msg);
  console.error(e);
  process.exitCode=1;
} finally {
  fs.rmSync(dir,{recursive:true,force:true});
}
if(!process.exitCode) console.log('Passed crash audit records, the missing rule for unguarded rows, blind classification, first-failure stop, guard 2 and 3 rows through the analysis and the stdio mode probe.');
