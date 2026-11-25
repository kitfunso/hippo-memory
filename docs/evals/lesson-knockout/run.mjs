import './local-stdio.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { roster,background,folder,root,read,pins,hash,checkTaskPins } from './plan.mjs';
import { join,mkdir,save,inside,copy,freezeBuiltIn,resetBuiltIn,externalCheck,
  entry,createStore,contents,capture,forkStore,files } from './state.mjs';
import { commandLog,findTranscript,sessionFiles } from '../../../scripts/token-eval/records.mjs';
import { runCheck,stateCommit } from '../../../scripts/token-eval/checks.mjs';
import { teachMessage } from '../../../scripts/token-eval/lessons.mjs';
import { STUB_CLAUDE_MD } from '../../../scripts/token-eval/workspace.mjs';
import { openCue,launch } from './delivery.mjs';
import { normalize,evidence } from './evidence.mjs';

const [mode,id,token='Z0_SUB_TOKEN']=process.argv.slice(2);
assert(['smoke','unit'].includes(mode),'Usage: run.mjs smoke|unit FAMILY [TOKEN_VAR]');
const smoke=mode==='smoke', units=roster(), u=units.find(v=>v.id===id);
assert(u && (!smoke || u.id===units[0].id),'Family outside fixed roster or smoke selection');
assert(/^Z0_SUB_TOKEN(?:_[123])?$/.test(token) && (!smoke || token==='Z0_SUB_TOKEN'));
checkTaskPins();
assert.equal(hash(JSON.stringify(units)),'7b3e3078f73cd6c11a2a6e50aabad48728016f5aae6f28a2db50daa1db8a2e42','Roster drift');
const unit=inside(join(root,mode,u.id)),live=join(unit,'live'),work=join(live,'work');
const pre=join(unit,'pre'),baseStore=join(pre,'store'),snap=join(unit,'snapshot'),store=join(work,'.hippo');
const checkEnv={...process.env};
for (const key of Object.keys(checkEnv)) if (/token|secret|key|proxy|^CLAUDE|^ANTHROPIC|^HIPPO|^AWS|^Z0_/i.test(key)) delete checkEnv[key];
Object.assign(checkEnv,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',
  NODE_OPTIONS:'--require "'+join(folder,'local-stdio.cjs')+'"',
  TEMP:join(unit,'tmp'),TMP:join(unit,'tmp'),HOME:join(live,'home'),USERPROFILE:join(live,'home')});
const git=(...args)=>execFileSync('git',['-c','core.longpaths=true','-c','maintenance.auto=false',...args],
  {cwd:work,env:checkEnv,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const binary='C:/z0-runs/scored/bin/claude.exe';
assert(execFileSync(binary,['--version'],{encoding:'utf8'}).trim().startsWith(pins.claudeVersion+' '),'CLI version drift');
externalCheck(work);
mkdir(path.dirname(unit)); fs.mkdirSync(unit); mkdir(checkEnv.TEMP);
process.env.TMP=process.env.TEMP=checkEnv.TEMP;
save(join(unit,'design.json'),{unit:u,mode,roster:hash(JSON.stringify(units)),model:pins.modelOpus,effort:pins.effort});
function checkout(task) {
  fs.mkdirSync(live); mkdir(work);
  git('init','-q'); git('config','core.autocrlf','false');
  execFileSync('python',[join(folder,'checkout.py'),u.source,task.baseRef],{cwd:work,env:checkEnv,stdio:'inherit'});
  assert.equal(git('rev-parse','HEAD'),task.baseRef);
  fs.appendFileSync(join(work,'.git/info/exclude'),'\n.hippo/\n');
  fs.writeFileSync(join(work,'CLAUDE.md'),STUB_CLAUDE_MD);
}
function prepare(task) {
  if(smoke) return;
  save(join(live,'setup.json'),{toolchain:u.toolchain,setup:task.setup,constraintHash:pins['sha256:pip-constraint']});
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    join(folder,'prepare.ps1'),'-Live',live],{cwd:live,env:checkEnv,stdio:'inherit'});
}
async function session(task,prompt,session,id,resume=false) {
  const call={id,session,resume,prompt,smoke,model:pins.modelOpus,effort:pins.effort,toolchain:u.toolchain};
  fs.writeFileSync(join(live,'call.json'),JSON.stringify(call));
  await launch(live,token,checkEnv);
  const projects=join(live,'home/.claude/projects');
  const transcript=findTranscript(projects,session);
  assert(transcript,'Missing CLI transcript for '+task.id);
  const result=read(join(live,id+'.json'));
  assert(result.models.includes(pins.modelOpus),'Missing pinned model in result');
  return {transcript,commands:commandLog(sessionFiles(projects,session)),result};
}
function settings(hook) {
  save(join(live,'settings.json'),{autoMemoryEnabled:true,autoMemoryDirectory:join(live,'home/.claude/projects/unit/memory'),
    disableAllHooks:false,hooks:hook ? {UserPromptSubmit:[{hooks:[hook]}]} : {},
    permissions:{deny:['WebFetch','WebSearch','Agent','Task']},
    sandbox:{enabled:!smoke,failIfUnavailable:true,allowUnsandboxedCommands:false,
      network:{allowedDomains:[]},filesystem:{denyRead:[pre,snap,join(unit,'evidence'),root+'/unit/*/evidence']}}});
}
function grade(task,before,commands) {
  const post=stateCommit(work,task.baseRef);
  return runCheck(u.lesson,{work,env:checkEnv,preCommit:before,postCommit:post,commands,scratch:join(live,'grade')});
}
const archive=name=>fs.renameSync(inside(live),inside(join(unit,'evidence',name)));
mkdir(join(unit,'evidence'));
checkout(u.teach);
for (const dir of ['home/tmp','home/local','home/roaming','home/.claude/projects/unit/memory']) mkdir(join(live,dir));
const bg=background(u);
assert.equal(bg.length,20);
fs.writeFileSync(join(live,'home/.claude/projects/unit/memory/MEMORY.md'),'Notes retained from other projects:\n'+bg[0]+'\n');
prepare(u.teach);
const expected=freezeBuiltIn(live,pre); save(join(pre,'manifest.json'),expected);
createStore(baseStore,bg.map(text=>entry(text,null,'background')));
copy(baseStore,store);
settings(false);
const teachId=randomUUID(), before=stateCommit(work,u.teach.baseRef);
const first=await session(u.teach,u.teach.prompt,teachId,'teach');
const form=grade(u.teach,before,first.commands)==='pass' ? 'confirmation' : 'correction';
const feedback=teachMessage(u.lesson,form);
const taught=await session(u.teach,feedback,teachId,'feedback',true);
const learned=capture(taught.transcript,feedback,join(live,'home'),expected,teachId);
const baseline=contents(baseStore);
assert.deepEqual(contents(store),baseline,'Unexpected direct write during isolated teach');
createStore(snap,[...baseline,...learned]);
const snapshotHash=hash(JSON.stringify(files(snap)));
save(join(unit,'freeze.json'),{teachId,form,snapshotHash,targetRows:learned.map(e=>e.id),preHash:hash(JSON.stringify(expected))});
archive('teach');
const smokeChecks=[];
for (const [index,arm] of u.order.filter(a=>!smoke || a!=='Tp').entries()) {
  checkout(u.apply);
  // Dependency setup may populate a home, so run it before the exact pre-teach restore.
  if(!smoke) {
    for(const d of ['tmp','roaming','local']) mkdir(join(live,'home',d));
    prepare(u.apply);
    fs.renameSync(inside(join(live,'home')),inside(join(unit,'evidence','setup-home-'+index)));
  }
  const resetHash=resetBuiltIn(live,pre,expected);
  assert.equal(hash(JSON.stringify(files(snap))),snapshotHash,'Frozen snapshot changed');
  const fork=forkStore(snap,baseStore,store,teachId,arm);
  const notes=contents(store);
  const before=stateCommit(work,u.apply.baseRef), sid=randomUUID();
  const cue=await openCue(work,sid); settings(cue.hook);
  const {commands,result}=await session(u.apply,u.apply.prompt,sid,'apply').finally(cue.close);
  const verdict=grade(u.apply,before,commands), audit=evidence(join(live,'bodies/apply'),result,notes,u.lesson);
  const flagged=verdict==='fail' && u.cls==='variant' && commands.some(c=>normalize(c).includes(normalize(u.lesson.keyPhrase)));
  save(join(live,'grade.json'),{id:u.id,repo:u.repo,arm,session:sid,teachId,mode,verdict,flagged,
    resetHash,snapshotHash,targetCount:fork.targetCount,storeVerified:fork.storeVerified,...audit});
  archive('apply-'+index);
  smokeChecks.push(audit.complete && audit.hookSeen && (arm!=='N' || !audit.targetText));
}
if(smoke) assert(smokeChecks.every(Boolean),'Task smoke failed its request or delivery gate; evidence retained');
console.log(mode+' complete '+u.id);
