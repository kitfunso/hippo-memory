import './local-stdio.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { git } from '../../../scripts/token-eval/exec.mjs';
import { runCheck,PRE_REF,FIRST_REF } from '../../../scripts/token-eval/checks.mjs';
import { commandLog,sessionFiles } from '../../../scripts/token-eval/records.mjs';
import { teachMessage } from '../../../scripts/token-eval/lessons.mjs';
import { checkedRoster,checkerEnv,GRADER,root,read,hash } from './plan.mjs';
import { join,inside } from './state.mjs';
import { flagOf } from './evidence.mjs';
import { complete } from './collect.mjs';

const sealedWithWorkingEnv={'q145-f1':2};
const userText=row=>{
  const c=row.message?.content;
  return typeof c==='string' ? c : Array.isArray(c) ? c.filter(b=>b.type==='text').map(b=>b.text).join('\n') : '';
};
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});

export function beforeFeedback(files,feedback) {
  assert.equal(files.length,1,'Teach session has more than its main transcript');
  const bytes=fs.readFileSync(files[0]),cuts=[];
  let offset=0;
  for(const line of bytes.toString('utf8').split('\n')) {
    const row=line.trim() ? JSON.parse(line) : null;
    if(row?.type==='user' && row.message?.role==='user' && userText(row).trim()===feedback.trim()) cuts.push(offset);
    offset+=Buffer.byteLength(line)+1;
  }
  assert.equal(cuts.length,1,'Expected one teaching follow-up row');
  return [{file:files[0],fromBytes:0,toBytes:cuts[0]}];
}

function check(u,stage,session,segments) {
  const work=inside(join(stage,'work')),scratch=fs.mkdtempSync(join(tmpdir(),'knockout-regrade-'));
  try {
    const preCommit=git(['rev-parse','--verify',PRE_REF],work).trim(),postCommit=git(['rev-parse','--verify',FIRST_REF],work).trim();
    const commands=commandLog(segments ?? sessionFiles(inside(join(stage,'home/.claude/projects')),session));
    const verdict=runCheck(u.lesson,{work,env:checkerEnv({TEMP:scratch,TMP:scratch}),preCommit,postCommit,commands,scratch});
    return {verdict,commands};
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
}

function regradeUnit(u,dir) {
  assert.equal(hash(fs.readFileSync(u.lesson.checkPath)),u.checkerHash,'Checker changed since the roster froze');
  const freeze=read(join(dir,'freeze.json')),teach=inside(join(dir,'evidence','teach'));
  const projects=inside(join(teach,'home/.claude/projects'));
  const segments=beforeFeedback(sessionFiles(projects,freeze.teachId),teachMessage(u.lesson,freeze.form));
  const first=check(u,teach,freeze.teachId,segments);
  const form=first.verdict==='fail' ? 'correction' : 'confirmation';
  write(join(dir,'regrade-teach.json'),{grader:GRADER,id:u.id,teachId:freeze.teachId,verdict:first.verdict,form,
    recordedForm:freeze.form,commands:first.commands.length});
  for(const [i,arm] of u.order.entries()) {
    const stage=inside(join(dir,'evidence','apply-'+i)),receipt=read(join(stage,'grade.json'));
    assert(receipt.id===u.id && receipt.arm===arm && receipt.session,'Unexpected receipt '+stage);
    const {verdict,commands}=check(u,stage,receipt.session);
    if(sealedWithWorkingEnv[u.id]===i) assert.equal(verdict,receipt.verdict,'Regrade did not reproduce the sealed receipt');
    write(join(stage,'regrade.json'),{grader:GRADER,id:u.id,arm,session:receipt.session,verdict,
      flagged:flagOf(u,verdict,commands),checkerHash:u.checkerHash});
  }
  return form===freeze.form;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const units=checkedRoster(),unitRoot=inside(join(root,'unit'));
  for(const u of units) {
    const dir=join(unitRoot,u.id);
    if(!fs.existsSync(dir) || !complete(dir,u)) continue;
    const receipts=u.order.map((_,i)=>read(join(dir,'evidence','apply-'+i,'grade.json')));
    if(receipts.every(r=>r.grader===GRADER)) continue;
    assert(receipts.every(r=>r.grader===undefined),'Mixed grader receipts in '+u.id);
    if(fs.existsSync(join(dir,'regrade-teach.json'))) { console.log(u.id+' already regraded'); continue; }
    const matches=regradeUnit(u,dir);
    console.log(u.id+' teach form '+(matches?'matches':'DIFFERS')+'; '+u.order.length+' applies regraded');
  }
}
