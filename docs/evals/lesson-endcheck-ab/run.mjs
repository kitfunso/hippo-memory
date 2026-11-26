import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { holdPre,runCheck,stateCommit } from '../../../scripts/token-eval/checks.mjs';
import { commandLog,findTranscript,sessionFiles } from '../../../scripts/token-eval/records.mjs';
import { assertNoAncestorInstructions } from '../../../scripts/token-eval/homes.mjs';
import { cleanPath } from '../../../scripts/token-eval/arms.mjs';
import net from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { binary,boxCheck,corpus,digest,dist,freeze,json,loadPlan,read,revision,root,slice } from './paths.mjs';
import { checkout,install,poetryCache,privateEnv,pythonTemp,run,runSetup,seed } from './prepare.mjs';
import { schedule } from './design.mjs';
import { GUARD,guardedRun } from '../checker-guard/lesson.mjs';
import { AUDITED_GRADERS,armBinding,auditCalls,audited,auditFile,boundIntent,readAudits } from './crash-audit.mjs';
import { boxCheckSha,pins,verifyBoxCheck } from './pins.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const FIRST_GRADE_REF='refs/z0/hold/grade-first';
const COLLECTOR_LOCK='\\\\.\\pipe\\lesson-endcheck-ab-collector';
const modes=['check','probe','smoke','qualify','pair','full','audit'];
const [mode,token='Z0_SUB_TOKEN',key] = process.argv.slice(2);
assert.ok(modes.includes(mode),'usage: node run.mjs check|probe|smoke|qualify|pair|full|audit [TokenVar] [pair key]');
assert.match(token,/^Z0_SUB_TOKEN(?:_[123])?$/);
if(['smoke','qualify'].includes(mode)) assert.equal(token,'Z0_SUB_TOKEN');
const plan=loadPlan();
const byId=new Map(plan.units.map(u=>[u.id,u]));
const smoke=plan.units.find(u=>u.family==='q173-f3' && u.seed===2);
const {END_CHECK_LEAD}=await dist('api/end-check.js');

function toolEnv(u,dir,initial=true) {
  const env=privateEnv(dir);
  const cmd=". 'C:/eval-authors/s3x-env.ps1'\nGet-S3xTool '"+u.toolchain+"' | ConvertTo-Json -Compress";
  const tc=JSON.parse(run('powershell.exe',['-NoProfile','-Command',cmd],dir,env));
  const sub=s=>s.replaceAll('{work}',dir);
  for (const [k,v] of Object.entries(tc.env)) env[k]=sub(v);
  if(env.GRADLE_USER_HOME) {
    const properties=path.join(env.GRADLE_USER_HOME,'gradle.properties');
    env.GRADLE_USER_HOME=path.join(dir,'cache','gradle');
    fs.mkdirSync(env.GRADLE_USER_HOME,{recursive:true});
    if(initial && fs.existsSync(properties)) fs.copyFileSync(properties,path.join(env.GRADLE_USER_HOME,'gradle.properties'));
  }
  const pk=Object.keys(env).find(k=>k.toUpperCase()==='PATH');
  const combined=[tc.path && sub(tc.path),env[pk],tc.tail && sub(tc.tail)].filter(Boolean).join(path.delimiter);
  env[pk]=[path.join(dir,'bin'),cleanPath(combined,{env,cwd:dir}).value].join(path.delimiter);
  env.EVAL_SEED=String(u.seed);
  if(u.toolchain==='python') {
    env.POETRY_CACHE_DIR=poetryCache(dir);
    env.TEMP=env.TMP=pythonTemp(dir);
    for(const d of [env.POETRY_CACHE_DIR,env.TEMP]) fs.mkdirSync(d,{recursive:true});
  }
  if(initial && u.toolchain==='python') run('python',['-m','venv',path.join(dir,'venv')],dir,env);
  return env;
}
const armCmd=({id,token,slot,arm,seedHash,prompt,intent})=>run('powershell.exe',
  ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'claude.ps1'),'-Mode','apply',
    '-SessionId',id,'-Settings',slot.settings,'-PromptFile',prompt,'-TokenVar',token,
    '-Arm',arm,'-SeedHash',seedHash,'-Intent',intent],slot.work,slot.env);

function lastAssistantTurn(transcript) {
  const seen=new Set();
  let last=-1;
  for(const [index,row] of transcript.entries()) {
    const message=row.message;
    if(row.type!=='assistant' || message?.role!=='assistant' || row.isApiErrorMessage || row.isSidechain) continue;
    if(!message.id || seen.has(message.id) || message.model==='<synthetic>') continue;
    seen.add(message.id);
    last=index;
  }
  return last;
}

function checks(u,work,env,dir,id,pre) {
  const projects=path.join(env.CLAUDE_CONFIG_DIR,'projects');
  const file=findTranscript(projects,id);
  assert.ok(file,'missing apply transcript');
  const files=sessionFiles(projects,id);
  const grade=(post,commands)=>guardedRun(runCheck,u.lesson,{work,env:{...graderEnv(env),CHECK_LOG:path.join(dir,'checker.log')},
    preCommit:pre,postCommit:post,commands,scratch:dir});
  const firstPost=stateCommit(work,pre),firstCommands=commandLog(files);
  holdPre(work,firstPost,FIRST_GRADE_REF);
  fs.writeFileSync(path.join(dir,'first-commands.json'),JSON.stringify(firstCommands)+'\n');
  const first=grade(firstPost,firstCommands);
  const events=fs.existsSync(env.LESSON_EVENTS)?fs.readFileSync(env.LESSON_EVENTS,'utf8').trim().split('\n').map(JSON.parse):[];
  const transcript=fs.readFileSync(file,'utf8').trimEnd().split('\n').map(JSON.parse);
  const summaries=transcript.filter(x=>x.subtype==='stop_hook_summary');
  const dispatches=summaries.flatMap(x=>x.hookInfos??[]).filter(h=>h.command==='hippo end-check');
  assert.ok(summaries.every(x=>!x.hookErrors?.length),'Stop summary reported errors');
  assert.equal(dispatches.length,events.length,'Stop dispatch and shim event counts differ');
  const failedHooks=transcript.map(x=>x.attachment).filter(h=>h?.hookEvent && /error|cancel|timeout/.test(h.type??''));
  const routine=h=>h.hookEvent!=='Stop' && (h.timedOut===true || h.type==='hook_timeout');
  const nonStopTimeouts=failedHooks.filter(routine).length;
  if(failedHooks.length) json(path.join(dir,'hook-faults.json'),failedHooks.map(h=>({
    event:h.hookEvent,type:h.type,exit:h.exitCode,timedOut:h.timedOut,durationMs:h.durationMs})));
  if(failedHooks.some(h=>!routine(h))) throw new Error('Unclassified hook failure; see hook-faults.json');
  const actual=transcript.flatMap(({attachment},index)=>{
    if(attachment?.hookEvent!=='Stop' || attachment.type!=='hook_additional_context') return [];
    const text=[attachment.content].flat().join('\n');
    return text.includes(END_CHECK_LEAD)?[{text,index}]:[];
  });
  const listings=events.filter(e=>e.response).map(e=>{
    const text=JSON.parse(e.response).hookSpecificOutput.additionalContext;
    const lines=text.split('\n').filter(s=>/^\d+\. /.test(s));
    const norm=s=>s.replace(/\s+/g,' ').trim();
    const target=lines.filter(s=>norm(s).includes(norm(u.lesson.rule).slice(0,40))||s.includes(u.lesson.keyPhrase));
    return {text,target:target.length,other:lines.length-target.length,atStop:grade(e.post,e.commands)};
  });
  assert.deepEqual(listings.map(x=>x.text),actual.map(x=>x.text),'emitted and delivered reminders differ');
  const lastTurn=lastAssistantTurn(transcript);
  const productionTimeouts=events.filter(e=>e.outcome==='production_timeout').length;
  return {first,firstPost,grader:GUARD,stops:events.length,productionTimeouts,nonStopTimeouts,
    listings:listings.map(({text,...rest},i)=>({...rest,continued:lastTurn>actual[i].index}))};
}

async function prepareSlot(u,dir,template,arm) {
  const env=toolEnv(u,dir);
  const work=checkout(u,dir,env,template);
  env.LESSON_WORK=work;
  env.LESSON_EVENTS=path.join(dir,'stops.jsonl');
  if(u.task.setup) runSetup(u.task.setup,work,env);
  const settings=install(dir,work,env,arm);
  const base=run('git',['rev-parse','HEAD'],work,env).trim();
  env.LESSON_PRE=stateCommit(work,base);
  holdPre(work,env.LESSON_PRE);
  const normalized=JSON.stringify(read(settings)).replaceAll(JSON.stringify(dir).slice(1,-1),'%slot%');
  const common=JSON.parse(normalized);
  delete common.hooks.Stop;
  return {env,work,settings,common,preTree:run('git',['rev-parse',env.LESSON_PRE+'^{tree}'],work,env).trim()};
}
function graderEnv(env) {
  return {...env,NODE_OPTIONS:'--require "'+path.join(here,'file-stdio.cjs').replaceAll('\\','/')+'"'};
}
const limitWaitMs=15*60_000, maxWaits=8*96;
function qualifies(result) {
  return result.revision===revision && result.rows.ON?.listings.some(l=>l.target>0 && l.continued===true);
}
const qualificationPrompt='Create Qualification.kt in the repository root using Write, containing only class Qualification. Finish immediately after that edit without running commands.';
function boxGate(slot) {
  verifyBoxCheck();
  const output=run(slot.env.CLAUDE_CODE_GIT_BASH_PATH,[boxCheck],slot.work,slot.env);
  console.log(output.trim());
}
function record(file,value) {
  const tmp=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{flag:'wx'});
  try { fs.linkSync(tmp,file); } finally { fs.unlinkSync(tmp); }
}
function assess(u,dir,env,id,arm) {
  const row=checks(u,env.LESSON_WORK,env,dir,id,env.LESSON_PRE);
  assert.equal(row.stops>0,arm==='ON','Stop instrumentation missing or unexpected');
  return row;
}
function auditArm(top,pair,u,base,arm) {
  const completed=path.join(base,arm+'.json'),{row,dir}=read(completed),intent=boundIntent(base,arm,dir);
  const record={pair,arm,dir,grader:row.grader,id:intent?.id,pre:intent?.pre};
  const refuse=reason=>({...record,status:'unverifiable',reason});
  if(!intent) return refuse('no single intent for the graded slot');
  const returnedFile=path.join(base,intent.name.slice(0,-'.json'.length)+'.returned.json');
  if(!fs.existsSync(returnedFile)) return refuse('no confirmed return');
  const returned=read(returnedFile);
  if(returned.limited!==false || !Number.isFinite(returned.at)) return refuse('the return record is not a finished session');
  const {id,pre}=intent,work=path.join(dir,'work');
  const env={...toolEnv(u,dir,false),LESSON_WORK:work,LESSON_PRE:pre,LESSON_EVENTS:path.join(dir,'stops.jsonl')};
  const projects=path.join(env.CLAUDE_CONFIG_DIR,'projects');
  if(!findTranscript(projects,id)) return refuse('no transcript');
  const files=sessionFiles(projects,id),hasEvents=fs.existsSync(env.LESSON_EVENTS),returnWritten=fs.statSync(returnedFile).mtimeMs;
  if([...files,...(hasEvents?[env.LESSON_EVENTS]:[])].some(f=>fs.statSync(f).mtimeMs>returnWritten))
    return refuse('an input changed after the return');
  const events=hasEvents?fs.readFileSync(env.LESSON_EVENTS,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
  const listed=events.filter(e=>e.response);
  if(events.length!==row.stops || listed.length!==row.listings.length) return refuse('the stop events differ from the row');
  const git=(...args)=>run('git',args,work,env).trim();
  const isCommit=sha=>{ try { return git('cat-file','-t',sha)==='commit'; } catch(error) { return false; } };
  if(!listed.every(e=>isCommit(e.post))) return refuse('a stop commit is missing');
  let unreachable;
  try {
    unreachable=git('fsck','--connectivity-only','--unreachable','--no-reflogs').split('\n').map(l=>l.trim().split(' '))
      .filter(f=>f[0]==='unreachable' && f[1]==='commit').map(f=>f[2]);
  } catch(error) { return refuse('git fsck failed: '+error.message.split('\n')[0]); }
  const low=Math.floor(returned.at/1000),high=Math.floor(fs.statSync(completed).mtimeMs/1000),posts=new Set(events.map(e=>e.post));
  const firsts=(unreachable.length?git('log','--no-walk=unsorted','--format=%H %T %P %ct %s',...unreachable).split('\n'):[])
    .map(l=>l.trim().split(' ')).filter(f=>f.length===5 && f[2]===pre && f[4]==='snapshot' &&
      Number(f[3])>=low && Number(f[3])<=high && !posts.has(f[0]));
  const trees=new Set(firsts.map(f=>f[1]));
  if(trees.size!==1) return refuse(trees.size?'more than one first-grade tree':'no first-grade commit');
  const [[firstCommit,firstTree]]=firsts;
  if(git('rev-parse',stateCommit(work,pre)+'^{tree}')!==firstTree) return refuse('the work tree changed after grading');
  const graded=[{post:firstCommit,commands:commandLog(files)},...listed.map(e=>({post:e.post,commands:e.commands}))];
  const scratch=path.join(top,'crash-audit',pair,arm);
  fs.mkdirSync(scratch,{recursive:true});
  const {CHECK_LOG,...blind}=graderEnv(env);
  const calls=graded.map(({post,commands})=>()=>guardedRun(runCheck,u.lesson,
    {work,env:blind,preCommit:pre,postCommit:post,commands,scratch}));
  return {...record,firstCommit,firstTree,posts:listed.map(e=>e.post),...auditCalls(calls)};
}
const alive=pid=>{
  try { process.kill(pid,0); return true; } catch(error) { return error.code==='EPERM'; }
};
async function auditArms({top=root,pairs=schedule,units=byId,lock=COLLECTOR_LOCK}={}) {
  for(const p of pairs) assert.ok(fs.existsSync(path.join(top,'trial',p.key,'result.json')),'The schedule is not closed at '+p.key);
  const pidFile=path.join(top,'trim-loop.pid');
  const trimPid=fs.existsSync(pidFile)?Number(fs.readFileSync(pidFile,'utf8').replace(/[^0-9]/g,'')):0;
  assert.ok(!trimPid || !alive(trimPid),'Stop the trim loop (pid '+trimPid+') before the crash audit');
  const server=net.createServer(s=>s.end());
  await new Promise((ok,fail)=>server.once('error',fail).listen(lock,ok));
  try {
    const file=auditFile(top),audits=readAudits(file);
    let added=0;
    for(const p of pairs) {
      const base=path.join(top,'trial',p.key);
      for(const [arm,row] of Object.entries(read(path.join(base,'result.json')).rows)) {
        if(row===null || row.grader===GUARD || audits.has(p.key+' '+arm)) continue;
        assert.ok(AUDITED_GRADERS.includes(row.grader),'Unknown grader stamp on the '+arm+' row of '+p.key);
        fs.appendFileSync(file,JSON.stringify({...auditArm(top,p.key,units.get(p.id),base,arm),at:new Date().toISOString()})+'\n');
        added++;
      }
    }
    return added;
  } finally {
    server.close();
  }
}
async function checkAudit(d,graded,crashing,odd) {
  const top=path.join(d,'audit-root'),key='audit-pair',base=path.join(top,'trial',key),rows={};
  const pairs=[{key,id:smoke.id}],units=new Map([[smoke.id,smoke]]),lock=COLLECTOR_LOCK+'-check-'+randomUUID();
  for(const [arm,g] of Object.entries(graded)) {
    run('git',['update-ref','-d',FIRST_GRADE_REF],g.work,g.env);
    json(path.join(base,arm+'-0.json'),{id:g.sessionId,pre:g.env.LESSON_PRE,dir:g.dir});
    const returnedFile=path.join(base,arm+'-0.returned.json');
    json(returnedFile,{limited:false,at:g.returnedAt-2});
    fs.utimesSync(returnedFile,new Date(),g.returnedAt/1000);
    fs.utimesSync(findTranscript(path.join(g.env.CLAUDE_CONFIG_DIR,'projects'),g.sessionId),new Date(),(g.returnedAt-1)/1000);
    json(path.join(base,arm+'-1.json'),{id:randomUUID(),pre:g.env.LESSON_PRE,dir:path.join(base,'retry-x')});
    rows[arm]={...g.row,grader:undefined};
    const completed=path.join(base,arm+'.json');
    json(completed,{row:rows[arm],dir:g.dir});
    fs.utimesSync(completed,new Date(),new Date(g.gradedAt));
  }
  await wait(1500);
  const audit=(arm,u=smoke)=>auditArm(top,key,u,base,arm);
  const tree=(g,commit)=>run('git',['rev-parse',commit+'^{tree}'],g.work,g.env).trim();
  for(const [arm,g] of Object.entries(graded)) {
    const a=audit(arm);
    assert.deepEqual([a.status,a.id,a.calls,a.firstTree],['ran',g.sessionId,1+g.row.listings.length,tree(g,g.row.firstPost)],arm+' '+(a.reason??''));
  }
  const on=graded.ON;
  assert.ok(on.row.listings.length>0);
  const refused=pattern=>{
    const a=audit('ON');
    assert.equal(a.status,'unverifiable');
    assert.match(a.reason,pattern);
  };
  const extra=path.join(on.work,'after-grade.txt');
  fs.writeFileSync(extra,'changed after grading');
  refused(/work tree changed/);
  fs.unlinkSync(extra);
  const events=on.env.LESSON_EVENTS,text=fs.readFileSync(events,'utf8'),{atime,mtime}=fs.statSync(events);
  const restore=()=>{ fs.writeFileSync(events,text); fs.utimesSync(events,atime,mtime); };
  fs.writeFileSync(events,text.split('\n').filter(Boolean).slice(0,-1).map(l=>l+'\n').join(''));
  fs.utimesSync(events,atime,mtime);
  refused(/stop events differ/);
  restore();
  fs.utimesSync(events,atime,new Date(on.returnedAt+60_000));
  refused(/changed after the return/);
  restore();
  const returned=path.join(base,'ON-0.returned.json');
  fs.renameSync(returned,returned+'.away');
  refused(/no confirmed return/);
  fs.renameSync(returned+'.away',returned);
  const crashed=audit('ON',crashing);
  assert.deepEqual([crashed.status,crashed.call],['crash',0]);
  assert.equal(audit('ON',odd).status,'error');
  assert.equal(audit('ON').status,'ran');
  assert.deepEqual(fs.readdirSync(path.join(top,'crash-audit',key,'ON')).filter(n=>/log|status|mark/i.test(n)),[],
    'The audit kept a log or a guard record');
  await assert.rejects(auditArms({top,pairs,units,lock}),/not closed/);
  json(path.join(base,'result.json'),{revision,pair:key,id:smoke.id,seedHash:'0'.repeat(64),rows,missing:{}});
  const pidFile=path.join(top,'trim-loop.pid');
  fs.writeFileSync(pidFile,String(process.pid));
  await assert.rejects(auditArms({top,pairs,units,lock}),/trim loop/);
  fs.unlinkSync(pidFile);
  const holder=net.createServer(s=>s.end());
  await new Promise(ok=>holder.listen(lock,ok));
  await assert.rejects(auditArms({top,pairs,units,lock}),/EADDRINUSE/);
  await new Promise(ok=>holder.close(ok));
  assert.equal(await auditArms({top,pairs,units,lock}),2);
  assert.equal(await auditArms({top,pairs,units,lock}),0);
  const audits=readAudits(auditFile(top));
  for(const arm of ['OFF','ON']) {
    const binding=armBinding(base,arm);
    assert.equal(audits.get(key+' '+arm).status,'ran');
    assert.deepEqual(audited(rows[arm],key,arm,audits,binding),rows[arm]);
    assert.throws(()=>audited(rows[arm],key,arm,audits,{...binding,dir:'elsewhere'}),/does not match/);
    assert.throws(()=>audited(rows[arm],key,arm,audits,{...binding,id:'other'}),/does not match/);
  }
  console.log('Crash audit passed: original first-grade commit, input refusals, crash and error classes, closure, lock and analysis binding');
}
async function collectArm({pair,u,base,arm,template,slot,seedHash,promptText},
  {launch=armCmd,gate=boxGate,prepare=prepareSlot,grade=assess,sleep=wait}={}) {
  const completed=path.join(base,arm+'.json');
  if(fs.existsSync(completed)) return read(completed);
  const missing=(reason,dir)=>{
    record(completed,{row:null,reason,dir});
    return read(completed);
  };
  for(let attempt=0;;attempt++) {
    const journal=path.join(base,arm+'-'+attempt);
    const intent=journal+'.json',status=journal+'.returned.json';
    if(!fs.existsSync(intent)) {
      if(attempt) {
        const dir=fs.mkdtempSync(path.join(base,'retry-'));
        const fresh=await prepare(u,dir,template,arm);
        assert.equal(fresh.preTree,slot.preTree);
        assert.deepEqual(fresh.common,slot.common);
        slot={...fresh,dir};
      }
      const id=randomUUID(),prompt=path.join(slot.dir,'prompt.txt');
      freeze(prompt,promptText);
      gate(slot);
      let reply;
      try { reply=launch({id,token,slot,prompt,arm,seedHash,intent}).trim(); }
      catch(e) {
        throw new Error('Schedule paused at '+pair+' '+arm+' ('+
          (fs.existsSync(intent)?'dispatch unconfirmed':'did not start')+', launcher '+(e.status??e.code??e.name)+')');
      }
      assert.ok(reply==='LIMITED' || reply===id,'unrecognised launcher reply');
      record(status,{limited:reply==='LIMITED',at:Date.now()});
    }
    const {id,dir,pre,tokenVar}=read(intent);
    if(!fs.existsSync(status)) return missing('dispatch without confirmed return',dir);
    const returned=read(status);
    if(returned.limited) {
      if(['smoke','qualify'].includes(pair) || attempt>=maxWaits) return missing('limit wait budget exhausted',dir);
      assert.equal(token,tokenVar,'resume the limited arm with its assigned token variable');
      const remaining=Math.max(0,returned.at+limitWaitMs-Date.now());
      console.log(pair+' '+arm+' subscription limited; waiting before fresh attempt '+(attempt+2));
      await sleep(remaining);
      continue;
    }
    const work=path.join(dir,'work');
    const env=dir===slot.dir?slot.env:{...toolEnv(u,dir,false),LESSON_WORK:work,LESSON_PRE:pre,LESSON_EVENTS:path.join(dir,'stops.jsonl')};
    let row;
    try { row=grade(u,dir,env,id,arm); }
    catch(e) { return missing('assessment: '+e.name+' '+e.message.split('\n')[0],dir); }
    record(completed,{row,dir});
    return read(completed);
  }
}
async function execute(pair,u,base,arms,promptText=u.task.prompt) {
  const result=path.join(base,'result.json');
  if(fs.existsSync(result)) return read(result);
  fs.mkdirSync(base,{recursive:true});
  const prep=fs.mkdtempSync(path.join(base,'prep-'));
  const template=path.join(prep,'template');
  const seedHash=await seed(u,template);
  const prepared=[];
  for(const [i,arm] of arms.entries()) {
    const dir=path.join(prep,'s'+(i+1));
    fs.mkdirSync(dir);
    const slot=await prepareSlot(u,dir,template,arm);
    prepared.push({...slot,dir,arm});
  }
  if(prepared.length===2) {
    assert.deepEqual(prepared[0].common,prepared[1].common,'non-Stop settings differ');
    assert.equal(prepared[0].preTree,prepared[1].preTree,'prepared workspaces differ');
  }
  const baseline=path.join(base,'baseline.json');
  const identity={revision,pair,id:u.id,seedHash,preTree:prepared[0].preTree,common:prepared[0].common};
  if(fs.existsSync(baseline)) assert.deepEqual(read(baseline),identity,'baseline changed on recovery');
  else record(baseline,identity);
  const rows={},missing={};
  for(const slot of prepared) {
    const {row,reason}=await collectArm({pair,u,base,arm:slot.arm,template,slot,seedHash,promptText});
    rows[slot.arm]=row;
    if(reason) missing[slot.arm]=reason;
  }
  record(result,{revision,pair,id:u.id,seedHash,rows,missing});
  console.log(pair+(Object.keys(missing).length?' closed with missing evidence':' complete'));
  return read(result);
}

async function hashFile(f) {
  const h=createHash('sha256');
  for await (const chunk of fs.createReadStream(f)) h.update(chunk);
  return h.digest('hex');
}
assertNoAncestorInstructions(root);
const checkRoot=['probe','check'].includes(mode) && process.env.LESSON_CHECK_ROOT
  ? path.resolve(process.env.LESSON_CHECK_ROOT) : root;
process.env.TEMP=process.env.TMP=path.join(checkRoot,'tmp');
fs.mkdirSync(process.env.TEMP,{recursive:true});
assert.deepEqual(pins(),{
  sliceJs:'67dd3ff715de52ac73b33675cd7e2be778d378b906205d8099880b78082dabfa',
  sliceCli:'80d9131341a74d45fdfabb7812abebd803b602f0c13151d54d6c80da791fd8cb',
  checkerTree:'b1d0fd269223f89acf3c1975c648edc6e3e507f69fe0ab3f2e9a45a796a35dbd',
  runner:'8e155d5ea4dcbffaa299c4fefea8c6b49a2ce663e620ef6064c415758c516de6',
  tools:'4837370c0932bfbe9197f174eb19fdec2ddc7ceaf2ffea545dcad6df9a7951c9',
  boxCheck:boxCheckSha,
  round3:'824d752205057f81f6e3f00df41552925b4848cce1ea6e860928dbdec101194c'
});
assert.equal(await hashFile(binary),'5064e6e0572dca86257363ca04d48653eef20ef27f1bd04b504ed7199ed3fd13');
assert.equal(run('git',['rev-parse','HEAD'],slice,process.env).trim(),'70eb87c0fdabdcc96754c80ccb4f975df87213ca');
assert.equal(digest(fs.readFileSync(path.join(corpus,'plan.json'))),'fdc2911c1d908c101327348a56d1c302141ae8cdaa9c1056ed0d9dfd3d7c5471');
if(!['check','audit'].includes(mode)) {
  const dir=path.join(checkRoot,'shell-probe');
  const env=mode==='probe'?toolEnv(smoke,dir):privateEnv(dir);
  const js="const r=require('node:child_process').spawnSync(process.env.CLAUDE_CODE_GIT_BASH_PATH,['--noprofile','--norc','-c','exit 0']);if(r.status!==0){console.error('Git Bash unavailable: '+(r.error?.code??r.status));process.exit(1)}";
  run(process.execPath,['-e',js],dir,env);
}
if(mode==='probe') {
  const work=path.join(checkRoot,'shell-probe');
  boxGate({work,env:toolEnv(smoke,work)});
  console.log('Git Bash and Z0 box gate passed; no model call');
} else if(mode==='audit') {
  const added=await auditArms();
  console.log('Crash audit added '+added+' arm records; '+readAudits(auditFile(root)).size+' in '+auditFile(root));
} else if(mode==='check') {
  const d=fs.mkdtempSync(path.join(checkRoot,'offline-'));
  const {checkRecovery,checkTimeout,checkProfile,checkSetup}=await import('./offline.mjs');
  await checkRecovery(d,collectArm);
  checkTimeout(d);
  checkProfile(d);
  checkSetup(d);
  const template=path.join(d,'template');
  const stamp=await seed(smoke,template);
  const arms=[],graded={};
  const crash=path.join(d,'crash.mjs'),odd=path.join(d,'odd.mjs');
  fs.writeFileSync(crash,"await Promise.reject(new Error('fixture crash'));"+'\n');
  fs.writeFileSync(odd,'process.exit(7);'+'\n');
  const lessonAt=checkPath=>({...smoke,lesson:{...smoke.lesson,checkPath}});
  for(const arm of ['OFF','ON']) {
    const dir=path.join(d,arm);
    fs.mkdirSync(dir);
    const slot=await prepareSlot(smoke,dir,template,arm);
    arms.push(slot);
    const {env,work}=slot;
    assert.deepEqual(fs.readdirSync(path.join(work,'.git','objects','pack')).filter(n=>n.endsWith('.pack')),['pack-base.pack'],
      'The slot pack must stay where pack-objects wrote it');
    const rule=smoke.history.flatMap(h=>h.rules).find(r=>r.detector);
    const {hippo}=await import('./prepare.mjs');
    const rules=run(process.execPath,[hippo,'session-rules'],work,env,{input:'{}'});
    assert.ok(rules.includes(rule.content),'seed did not reach the real session-start reader');
    const sessionId=randomUUID();
    const t=path.join(env.CLAUDE_CONFIG_DIR,'projects','fixture',sessionId+'.jsonl');
    const message=(type,content)=>JSON.stringify({type,message:{role:type,content,id:randomUUID()}});
    fs.writeFileSync(path.join(work,'Example.kt'),'class Example {}\n');
    const edit=message('assistant',[{type:'tool_use',id:'w',name:'Write',input:{file_path:'Example.kt',content:'class Example {}'}}]);
    freeze(t,[message('user','Fix the example'),edit,
      message('user',[{type:'tool_result',tool_use_id:'w',content:'done'}])].join('\n')+'\n');
    const output=run(process.execPath,[hippo,'end-check'],work,env,{input:JSON.stringify({transcript_path:t})});
    assert.ok(output.includes('spotlessApply'),'real Stop missed seeded detector');
    if(arm==='ON'){
      const nested=path.join(work,'subdir');
      fs.mkdirSync(nested);
      const emitted=run('cmd.exe',['/d','/c','hippo','end-check'],nested,env,
        {input:JSON.stringify({session_id:sessionId,transcript_path:t})});
      assert.equal(emitted,output);
      const {post}=JSON.parse(fs.readFileSync(env.LESSON_EVENTS,'utf8'));
      assert.equal(run('git',['rev-parse','refs/z0/hold/stop/'+post],work,env).trim(),post);
      fs.appendFileSync(t,JSON.stringify({subtype:'stop_hook_summary',hookInfos:[{command:'hippo end-check'}],hookErrors:[]})+'\n');
      assert.throws(()=>checks(smoke,work,env,dir,sessionId,env.LESSON_PRE),/emitted and delivered/);
      fs.appendFileSync(t,JSON.stringify({attachment:{type:'hook_additional_context',hookEvent:'Stop',
        content:[JSON.parse(emitted).hookSpecificOutput.additionalContext]}})+'\n');
      fs.appendFileSync(t,edit+'\n'+JSON.stringify({type:'assistant',
        message:{role:'assistant',model:'<synthetic>',id:randomUUID(),content:[]}})+'\n');
      const stopped=assess(smoke,dir,env,sessionId,arm);
      assert.ok(stopped.listings.some(l=>l.target>0 && l.continued===false));
      assert.equal(qualifies({revision,rows:{ON:stopped}}),false);
    }
    fs.appendFileSync(t,JSON.stringify({attachment:{hookEvent:'UserPromptSubmit',type:'hook_cancelled',timedOut:true}})+'\n'
      +message('assistant',[{type:'tool_use',id:'g',name:'Bash',input:{command:'./gradlew spotlessApply'}}])+'\n');
    const returnClock=path.join(process.env.TEMP,'return-'+randomUUID());
    fs.writeFileSync(returnClock,'');
    const returnedAt=fs.statSync(returnClock).mtimeMs;
    fs.unlinkSync(returnClock);
    const row=assess(smoke,dir,env,sessionId,arm);
    graded[arm]={row,returnedAt,gradedAt:Date.now(),sessionId,dir,env,work};
    assert.equal(row.first,'pass');
    assert.equal(row.nonStopTimeouts,1);
    assert.equal(row.grader,GUARD);
    assert.equal(run('git',['rev-parse',FIRST_GRADE_REF],work,env).trim(),row.firstPost);
    assert.deepEqual(read(path.join(dir,'first-commands.json')),commandLog(sessionFiles(path.join(env.CLAUDE_CONFIG_DIR,'projects'),sessionId)));
    assert.ok(!fs.existsSync(path.join(dir,'checker-status.json')),'The guard record stayed in the slot');
    if(arm==='OFF') {
      assert.throws(()=>checks(lessonAt(crash),work,env,dir,sessionId,env.LESSON_PRE),/exited 2/);
      assert.match(fs.readFileSync(path.join(dir,'checker.log'),'utf8'),/checker crashed: Error: fixture crash/);
    }
    if(arm==='ON') {
      assert.ok(row.listings.some(l=>l.target>0 && l.atStop==='fail'));
      assert.ok(qualifies({revision,rows:{ON:row}}));
    }
    assert.equal(run('git',['rev-parse','refs/z0/pre'],work,env).trim(),env.LESSON_PRE);
    console.log(arm+' seed, retained timeout and final grade passed');
  }
  assert.deepEqual(arms[0].common,arms[1].common);
  assert.equal(arms[0].preTree,arms[1].preTree);
  await checkAudit(d,graded,lessonAt(crash),lessonAt(odd));
  console.log('same baseline '+stamp);
} else {
  // A named pipe releases on process exit and serialises recovery across operator restarts.
  const lock=net.createServer(s=>s.end());
  await new Promise((ok,fail)=>lock.once('error',fail).listen(COLLECTOR_LOCK,ok));
  try {
  if(mode==='smoke') {
  const smokeDir=path.join(root,'smoke');
  assert.ok(!fs.existsSync(smokeDir) || key==='new-attempt','Preserve the historical smoke; use new-attempt for an authorised smoke');
  // Keep the original smoke evidence when a later operator has a new launch authorisation.
  const dest=fs.existsSync(smokeDir) && key==='new-attempt' ? fs.mkdtempSync(path.join(root,'smoke-retry-')) : null;
  assert.ok(qualifies(await execute('smoke',smoke,dest?path.join(dest,'attempt'):smokeDir,['ON'])),
    'Smoke did not show continuation after a delivered target listing');
  } else if(mode==='qualify') {
    assert.ok(qualifies(await execute('qualify',smoke,path.join(root,'qualification-'+revision),['ON'],qualificationPrompt)),
      'Qualification did not show continuation after a delivered target listing');
  } else {
  const smokeRoots=[path.join(root,'smoke'),...fs.readdirSync(root).filter(n=>/^smoke-retry-[\w-]+$/.test(n)).map(n=>path.join(root,n,'attempt'))];
  smokeRoots.push(path.join(root,'qualification-'+revision));
  assert.ok(smokeRoots.some(d=>{
    const f=path.join(d,'result.json');
    if(!fs.existsSync(f)) return false;
    return qualifies(read(f));
  }),
    'A completed live control must show continuation after a delivered target listing');
  const todo=mode==='full'?schedule:schedule.filter(p=>p.key===key);
  assert.ok(todo.length,'unknown pair');
  for(const p of todo) await execute(p.key,byId.get(p.id),path.join(root,'trial',p.key),p.order);
  }
  } finally { lock.close(); }
}

