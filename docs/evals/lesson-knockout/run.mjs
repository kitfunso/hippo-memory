import './local-stdio.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkedRoster,checkerEnv,APPARATUS,DENIED_TOOLS,background,folder,root,read,pins,hash } from './plan.mjs';
import { assertCheckerTools,gradeEnv,guardedRun } from './grading.mjs';
import { join,mkdir,save,inside,copy,freezeBuiltIn,resetBuiltIn,externalCheck,
  entry,createStore,contents,capture,forkStore,files,checkProjectSettings,treeOf,ignoredListing,installedPackages } from './state.mjs';
import { commandLog,findTranscript } from '../../../scripts/token-eval/records.mjs';
import { runCheck,stateCommit,holdPre,FIRST_REF } from '../../../scripts/token-eval/checks.mjs';
import { teachMessage } from '../../../scripts/token-eval/lessons.mjs';
import { STUB_CLAUDE_MD } from '../../../scripts/token-eval/workspace.mjs';
import { openCue,launch } from './delivery.mjs';
import { archivedAudit,callComplete,flagOf,evidence,neutralClean,permissionAudit,sessionInventory } from './evidence.mjs';
import { auditApply } from './path-audit.mjs';
import { runSetupScript } from './setup.mjs';
import { applyFrozen,assertSameTree,continueUnit } from './continuation.mjs';

const [mode,id,token='Z0_SUB_TOKEN',attempt]=process.argv.slice(2);
assert(['smoke','unit'].includes(mode),'Usage: run.mjs smoke|unit FAMILY [TOKEN_VAR]');
const smoke=mode==='smoke', units=checkedRoster(), u=units.find(v=>v.id===id);
const reuse=smoke && attempt==='frozen-apply';
const continuing=!smoke && attempt==='frozen-apply';
assert(!attempt || reuse || continuing,'Unknown attempt');
assert(u && (!smoke || u.id===units[0].id),'Family outside fixed roster or smoke selection');
assert(/^Z0_SUB_TOKEN(?:_[123])?$/.test(token) && (!smoke || token==='Z0_SUB_TOKEN'));
const original=inside(join(root,mode,u.id));
const unit=reuse?inside(join(original,'coding-check')):original;
const live=smoke?join(unit,'live'):inside(join(root,'active/live')),work=join(live,'work');
const records=smoke?live:inside(join(root,'active/operator'));
const pre=join(original,'pre'),baseStore=join(pre,'store'),snap=join(original,'snapshot'),store=join(work,'.hippo');
if(reuse) {
  const prior=fs.readdirSync(original,{recursive:true}).filter(f=>f.endsWith('.request.json')).length;
  assert(prior+4<=20,'Insufficient remaining smoke calls');
  const receipts=arm=>read(join(original,'command-check',arm,'delivery.json'));
  assert(['T','N'].every(arm=>receipts(arm).complete && receipts(arm).requests===1),'Missing command diagnostics');
  assert(['T','N'].some(arm=>!receipts(arm).hookSeen || receipts(arm).targetText!==(arm==='T')),
    'Installed command passed; select that transport before coding');
  for(const arm of ['T','N']) {
    const r=read(join(original,'delivery-check',arm,'delivery.json'));
    assert(r.complete && r.hookSeen && r.targetText===(arm==='T'),'HTTP qualification missing');
  }
}
const checkEnv=checkerEnv({TEMP:join(unit,'tmp'),TMP:join(unit,'tmp'),HOME:join(live,'home'),USERPROFILE:join(live,'home')});
const git=(...args)=>execFileSync('git',['-c','core.longpaths=true','-c','maintenance.auto=false',...args],
  {cwd:work,env:checkEnv,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const binary='C:/z0-runs/scored/bin/claude.exe';
assert(execFileSync(binary,['--version'],{encoding:'utf8'}).trim().startsWith(pins.claudeVersion+' '),'CLI version drift');
externalCheck(work);
if(!smoke) {
  const lock=net.createServer(socket=>socket.end());
  await new Promise((ok,fail)=>lock.once('error',fail).listen('\\\\.\\pipe\\lesson-knockout-collector',ok));
  lock.unref();
  for(const name of ['unit','checkpoints','limit-archives']) mkdir(inside(join(root,name)));
}
const design={unit:u,mode,roster:hash(JSON.stringify(units)),model:pins.modelOpus,effort:pins.effort};
if(!continuing) {
  if(!smoke) assert(!fs.existsSync(live) && !fs.existsSync(records),'Another unit has active collection state');
  mkdir(path.dirname(unit)); fs.mkdirSync(unit); mkdir(checkEnv.TEMP);
  mkdir(inside(path.dirname(live)));
  save(join(unit,'design.json'),design);
  mkdir(join(unit,'evidence'));
}
process.env.TMP=process.env.TEMP=checkEnv.TEMP;
function checkout(task) {
  fs.mkdirSync(live); mkdir(work);
  if(!smoke) {
    fs.mkdirSync(records);
    save(join(records,'owner.json'),{unit:u.id,task:task.id});
  }
  git('init','-q'); git('config','core.autocrlf','false');
  execFileSync('python',[join(folder,'checkout.py'),u.source,task.baseRef],{cwd:work,env:checkEnv,stdio:'inherit'});
  assert.equal(git('rev-parse','HEAD'),task.baseRef);
  fs.appendFileSync(join(work,'.git/info/exclude'),'\n.hippo/\n');
  fs.writeFileSync(join(work,'CLAUDE.md'),STUB_CLAUDE_MD);
}
function prepare(task) {
  checkProjectSettings(work);
  if(!smoke) {
    save(join(records,'setup.json'),{toolchain:u.toolchain,setup:task.setup,constraintHash:pins['sha256:pip-constraint']});
    runSetupScript(live,checkEnv,join(folder,'prepare.ps1'));
  }
  const ignored=ignoredListing(git),installed=installedPackages(live);
  if(!smoke) {
    checkProjectSettings(work);
    assertCheckerTools(u,graderEnv());
  }
  return {ignored,installed};
}
const graderEnv=()=>gradeEnv(checkEnv,u,live,join(records,'grade','checker.log'));
async function session(task,prompt,session,id,resume=false,gate) {
  const call={id,session,resume,prompt,smoke,model:pins.modelOpus,effort:pins.effort,toolchain:u.toolchain,apparatus:APPARATUS};
  if(reuse) call.frozenSmoke=true;
  checkProjectSettings(work);
  const onFirstCall=!smoke && id==='apply' ? ()=>save(join(unit,'evidence','intent-'+session+'.json'),{session}) : undefined;
  const archives=await launch(live,token,checkEnv,call,{gate,onFirstCall});
  const projects=join(live,'home/.claude/projects');
  const transcript=findTranscript(projects,session);
  assert(transcript,'Missing CLI transcript for '+task.id);
  const result=read(join(records,id+'.json'));
  assert(result.session===session && result.call===id && result.promptSha256===hash(prompt) && result.json===true,
    'Call record does not match '+id);
  const wire=callComplete(join(records,'wire',id),result,prompt,transcript,{maxTurns:smoke});
  assert(wire.complete,'Wire record does not match the call '+id+': '+(wire.w.reason ?? 'unmatched model turns'));
  const archived=archivedAudit(archives,id,session,prompt,u.lesson,{...task,work});
  if(!smoke) {
    const permissions=permissionAudit(transcript,prompt,result.permissionDenials);
    assert(permissions.ok && result.apparatus===APPARATUS && result.stopped===false && archived.archivedPermissions,
      'Session permission check failed for '+id+': '+JSON.stringify({...permissions,archivedPermissions:archived.archivedPermissions}));
  }
  assert(result.models.includes(pins.modelOpus),'Missing pinned model in result');
  return {transcript,archived,archives,commands:commandLog(sessionInventory(projects,session).files),result};
}
function settings(hook) {
  save(join(live,'settings.json'),{autoMemoryEnabled:true,autoMemoryDirectory:join(live,'home/.claude/projects/unit/memory'),
    disableAllHooks:false,hooks:hook ? {UserPromptSubmit:[{hooks:[hook]}]} : {},
    permissions:{deny:DENIED_TOOLS},sandbox:{enabled:false}});
}
function grade(before,commands) {
  const post=stateCommit(work,before);
  holdPre(work,post,FIRST_REF);
  const env=graderEnv();
  assertCheckerTools(u,env);
  return guardedRun(runCheck,u.lesson,{work,env,preCommit:before,postCommit:post,commands,scratch:join(records,'grade')});
}
function archive(name) {
  const dest=inside(join(unit,'evidence',name));
  fs.renameSync(inside(live),dest);
  if(!smoke) fs.renameSync(records,inside(join(dest,'operator')));
  return dest;
}
async function teach() {
  checkout(u.teach);
  for (const dir of ['home/tmp','home/local','home/roaming','home/.claude/projects/unit/memory']) mkdir(join(live,dir));
  const bg=background(u);
  assert.equal(bg.length,20);
  fs.writeFileSync(join(live,'home/.claude/projects/unit/memory/MEMORY.md'),'Notes retained from other projects:\n'+bg[0]+'\n');
  const expected=freezeBuiltIn(live,pre); save(join(pre,'manifest.json'),expected);
  prepare(u.teach);
  createStore(baseStore,bg.map(text=>entry(text,null,'background')));
  copy(baseStore,store);
  settings(false);
  const teachId=randomUUID(), before=stateCommit(work,u.teach.baseRef);
  holdPre(work,before);
  const first=await session(u.teach,u.teach.prompt,teachId,'teach');
  const form=grade(before,first.commands)==='fail' ? 'correction' : 'confirmation';
  const feedback=teachMessage(u.lesson,form);
  const taught=await session(u.teach,feedback,teachId,'feedback',true);
  const learned=capture(taught.transcript,feedback,join(live,'home'),expected,teachId);
  const baseline=contents(baseStore);
  assert.deepEqual(contents(store),baseline,'Unexpected direct write during isolated teach');
  createStore(snap,[...baseline,...learned]);
  const snapshotHash=hash(JSON.stringify(files(snap)));
  save(join(unit,'freeze.json'),{teachId,form,snapshotHash,targetRows:learned.map(e=>e.id),preHash:hash(JSON.stringify(expected)),
    apparatus:APPARATUS});
  archive('teach');
}
const smokeChecks=[];
async function applyArm(arm,index,{expected,teachId,snapshotHash,preHash}) {
  checkout(u.apply);
  const {ignored:ignoredSetup,installed:installedSetup}=prepare(u.apply);
  const resetHash=resetBuiltIn(live,pre,expected);
  for(const d of ['tmp','roaming','local']) mkdir(join(live,'home',d));
  assert.equal(hash(JSON.stringify(files(snap))),snapshotHash,'Frozen snapshot changed');
  const fork=forkStore(snap,baseStore,store,teachId,arm);
  const notes=contents(store);
  const before=stateCommit(work,u.apply.baseRef), sid=randomUUID(), preTree=treeOf(git,before);
  holdPre(work,before);
  const cue=await openCue(work,sid); settings(cue.hook);
  const gate=()=>assertSameTree(unit,index,{preTree,ignoredSetup,installedSetup});
  const {commands,result,archives,archived,transcript}=await session(u.apply,u.apply.prompt,sid,'apply',false,gate).finally(cue.close);
  const pathAudit=auditApply([...archives,live],sid,live);
  const verdict=grade(before,commands);
  const audit=evidence(join(records,'wire','apply'),result,notes,u.lesson,{...u.apply,work},transcript);
  const flagged=flagOf(u,verdict,commands);
  const receipt={id:u.id,repo:u.repo,arm,session:sid,teachId,mode,verdict,flagged,apparatus:APPARATUS,preTree,ignoredSetup,installedSetup,
    resetHash,snapshotHash,targetCount:fork.targetCount,storeVerified:fork.storeVerified,pathAudit,...archived,...audit};
  const dest=archive('apply-'+index);
  smokeChecks.push(audit.complete && audit.hookSeen && (arm!=='N' || (!audit.targetText && !audit.ambiguous)));
  if(!smoke && !(audit.complete && (arm!=='N' || neutralClean(receipt)))) {
    save(join(dest,'rejected.json'),receipt);
    throw Error('Apply request evidence failed: '+arm+' '+JSON.stringify({complete:audit.complete,targetText:audit.targetText,
      ambiguous:audit.ambiguous,archivedTargetText:archived.archivedTargetText,archivedUnauditable:archived.archivedUnauditable}));
  }
  save(join(dest,'grade.json'),receipt);
}
if(continuing) await continueUnit(design,applyArm);
else {
  if(!reuse) await teach();
  await applyFrozen(original,u.order.filter(a=>!smoke || a!=='Tp'),applyArm);
}
if(smoke) assert(smokeChecks.every(Boolean),'Task smoke failed its request or delivery gate; evidence retained');
console.log(mode+' complete '+u.id);
