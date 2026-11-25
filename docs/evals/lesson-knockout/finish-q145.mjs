import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { git } from '../../../scripts/token-eval/exec.mjs';
import { runCheck,PRE_REF,FIRST_REF } from '../../../scripts/token-eval/checks.mjs';
import { commandLog,sessionFiles } from '../../../scripts/token-eval/records.mjs';
import { checkedRoster,root,pins,read,hash } from './plan.mjs';
import { join,inside,files,contents,verifyFork,save } from './state.mjs';
import { evidence } from './evidence.mjs';
import { auditApply } from './path-audit.mjs';

const id='q145-f1',sessions=['3e8bb39b-3f7a-4b54-a151-5b1d3afa168e','762c8935-fc20-472d-8342-aa0dba9acad5',
  '79c45e85-14bb-456a-9a11-dad8a6a92a21'],session=sessions[2],request='req_011ChPxru7jpZ5nj6yiJcwM4';
const unit=inside(join(root,'unit',id)),ev=inside(join(unit,'evidence')),dest=inside(join(ev,'apply-2'));
const live=inside(join(root,'active/live')),operator=inside(join(root,'active/operator')),work=inside(join(live,'work'));

function checkState(u) {
  assert.equal(u.id,id); assert.deepEqual(u.order,['Tp','T','N']); assert.equal(u.cls,'unlabelled');
  const entries=['teach','apply-0','apply-1',...sessions.map(s=>'intent-'+s+'.json')];
  assert.deepEqual(fs.readdirSync(ev).sort(),entries.sort(),'Unexpected unit evidence');
  assert(!fs.existsSync(join(live,'operator')) && !fs.existsSync(join(live,'grade.json')),'Occupied archive path');
  for(const [i,s] of sessions.entries()) {
    const op=i===2?operator:inside(join(ev,'apply-'+i,'operator'));
    assert.deepEqual(read(join(ev,'intent-'+s+'.json')),{session:s});
    assert.deepEqual(read(join(op,'owner.json')),{unit:id,task:u.apply.id});
    const r=read(join(op,'apply.json')),call=read(join(op,'call.json'));
    assert(r.session===s && !r.isError && r.exit===0 && r.subtype==='success' && r.models.includes(pins.modelOpus));
    assert(call.session===s && call.id==='apply' && !call.resume && !call.smoke && call.prompt===u.apply.prompt);
    if(i<2) assert(fs.statSync(join(ev,'apply-'+i,'grade.json')).isFile(),'Missing sealed receipt');
  }
  for(const name of fs.readdirSync(join(root,'limit-archives'))) {
    const call=inside(join(root,'limit-archives',name,'operator/call.json'));
    assert(!fs.existsSync(call) || read(call).session!==session,'Unexpected cut-off attempt');
  }
}

function checkStore(scratch,freeze) {
  const pre=inside(join(unit,'pre')),snap=inside(join(unit,'snapshot')),manifest=read(join(pre,'manifest.json'));
  assert.equal(hash(JSON.stringify(manifest)),freeze.preHash);
  assert.equal(hash(JSON.stringify(files(snap))),freeze.snapshotHash);
  for(const part of ['home','repo']) assert.deepEqual(files(inside(join(pre,part))),manifest[part]);
  for(const [name,src] of [['source',snap],['base',join(pre,'store')],['arm',join(work,'.hippo')]])
    fs.cpSync(inside(src),join(scratch,name),{recursive:true,verbatimSymlinks:true});
  const source=contents(join(scratch,'source')),arm=join(scratch,'arm'),notes=contents(arm);
  const background=source.filter(r=>r.sourceSessionId!==freeze.teachId);
  const targets=source.filter(r=>r.sourceSessionId===freeze.teachId).map(r=>r.id).sort();
  assert.deepEqual(targets,[...freeze.targetRows].sort());
  assert.deepEqual(contents(join(scratch,'base')),background);
  assert.deepEqual(notes.filter(r=>!targets.includes(r.id)),background);
  return {notes,...verifyFork(source,arm,freeze.teachId,'N')};
}

function seal(scratch) {
  const units=checkedRoster(),u=units[0],freeze=read(join(unit,'freeze.json'));
  assert.deepEqual(read(join(unit,'design.json')),{unit:u,mode:'unit',roster:hash(JSON.stringify(units)),
    model:pins.modelOpus,effort:pins.effort});
  checkState(u);
  const {notes,targetCount,storeVerified}=checkStore(scratch,freeze);
  const projects=inside(join(live,'home/.claude/projects')),transcript=inside(join(projects,'unit',session+'.jsonl'));
  const audit=evidence(join(operator,'bodies/apply'),read(join(operator,'apply.json')),notes,u.lesson,{...u.apply,work},transcript);
  assert(audit.complete && audit.hookSeen && !audit.targetText && audit.transcriptResponse===request,'Unexpected request evidence');
  const pathAudit=auditApply([live],session,live);
  assert.equal(pathAudit.hits.length,0,'Unexpected protected path');
  const preCommit=git(['rev-parse',PRE_REF],work).trim(),postCommit=git(['rev-parse',FIRST_REF],work).trim();
  assert.equal(preCommit,'c7f531b99b4eb6ec28c56ce7012e40c1f60c7fd8');
  assert.equal(postCommit,'bd81c421da7c9529ceea04268c699d859a54671e');
  const commands=commandLog(sessionFiles(projects,session));
  const env={...process.env,GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'};
  for(const k of Object.keys(env)) if(/token|secret|key|proxy|^CLAUDE|^ANTHROPIC|^HIPPO|^AWS|^Z0_/i.test(k)) delete env[k];
  const verdict=runCheck(u.lesson,{work,env,preCommit,postCommit,commands,scratch});
  save(join(scratch,'receipt'),{id,repo:u.repo,arm:'N',session,teachId:freeze.teachId,mode:'unit',verdict,flagged:null,
    resetHash:freeze.preHash,snapshotHash:freeze.snapshotHash,targetCount,storeVerified,pathAudit,...audit});
}

function publish(scratch) {
  const staged=join(scratch,'receipt'),receipt=inside(join(live,'grade.json')),records=inside(join(live,'operator'));
  fs.renameSync(operator,records);
  try {
    fs.renameSync(staged,receipt);
    try { fs.renameSync(live,dest); } catch(error) { fs.renameSync(receipt,staged); throw error; }
  } catch(error) { fs.renameSync(records,operator); throw error; }
}

export async function finishQ145() {
  const lock=net.createServer(socket=>socket.end());
  await new Promise((ok,fail)=>lock.once('error',fail).listen('\\\\.\\pipe\\lesson-knockout-collector',ok));
  try {
    const scratch=fs.mkdtempSync(join(tmpdir(),'q145-receipt-'));
    try { seal(scratch); publish(scratch); } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
  } finally { lock.close(); }
  console.log('Archived q145-f1 N with its sealed receipt.');
}
