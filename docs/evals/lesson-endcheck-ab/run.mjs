import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCheck,stateCommit } from '../../../scripts/token-eval/checks.mjs';
import { commandLog,findTranscript,sessionFiles } from '../../../scripts/token-eval/records.mjs';
import { assertNoAncestorInstructions } from '../../../scripts/token-eval/homes.mjs';
import { restoreInstructions } from '../../../scripts/token-eval/workspace.mjs';
import { binary,corpus,digest,dist,freeze,json,loadPlan,read,root,slice } from './paths.mjs';
import { blob,checkout,install,privateEnv,run,seed } from './prepare.mjs';
import { schedule } from './design.mjs';
import { pins } from './pins.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const modes=['check','probe','smoke','pair','full'];
const [mode,token='Z0_SUB_TOKEN',key] = process.argv.slice(2);
assert.ok(modes.includes(mode),'usage: node run.mjs check|probe|smoke|pair|full [TokenVar] [pair key]');
assert.match(token,/^Z0_SUB_TOKEN(?:_[123])?$/);
if(mode==='smoke') assert.equal(token,'Z0_SUB_TOKEN');
const plan=loadPlan();
const byId=new Map(plan.units.map(u=>[u.id,u]));
const smoke=plan.units.find(u=>u.family==='q173-f3' && u.seed===2);
const {END_CHECK_LEAD}=await dist('api/end-check.js');

function toolEnv(u,dir) {
  const env=privateEnv(dir);
  const cmd=". 'C:/eval-authors/s3x-env.ps1'\nGet-S3xTool '"+u.toolchain+"' | ConvertTo-Json -Compress";
  const tc=JSON.parse(run('powershell.exe',['-NoProfile','-Command',cmd],dir,env));
  const sub=s=>s.replaceAll('{work}',dir);
  for (const [k,v] of Object.entries(tc.env)) env[k]=sub(v);
  const pk=Object.keys(env).find(k=>k.toUpperCase()==='PATH');
  if(tc.path) env[pk]=sub(tc.path)+';'+env[pk];
  if(tc.tail) env[pk]+=';'+sub(tc.tail);
  env.EVAL_SEED=String(u.seed);
  if(u.toolchain==='python') run('python',['-m','venv',path.join(dir,'venv')],dir,env);
  return env;
}
const armCmd=(id,arm,tokenName,settings,work,env,prompt)=>run('powershell.exe',
  ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'claude.ps1'),'-Mode','apply',
    '-SessionId',id,'-Settings',settings,'-PromptFile',prompt,'-TokenVar',tokenName],work,env);

function checks(u,work,env,dir,id,pre) {
  const projects=path.join(env.CLAUDE_CONFIG_DIR,'projects');
  const file=findTranscript(projects,id);
  assert.ok(file,'missing apply transcript');
  const files=sessionFiles(projects,id);
  const grade=(post,commands)=>runCheck(u.lesson,{work,env:graderEnv(env),preCommit:pre,postCommit:post,commands,scratch:dir});
  const first=grade(stateCommit(work,pre),commandLog(files));
  const events=fs.existsSync(env.LESSON_EVENTS)?fs.readFileSync(env.LESSON_EVENTS,'utf8').trim().split('\n').map(JSON.parse):[];
  const transcript=fs.readFileSync(file,'utf8').trimEnd().split('\n').map(JSON.parse);
  const failedHooks=transcript.map(x=>x.attachment).filter(h=>h?.hookEvent && /error|cancel|timeout/.test(h.type??''));
  if(failedHooks.length) {
    json(path.join(dir,'hook-faults.json'),failedHooks.map(h=>({event:h.hookEvent,type:h.type,exit:h.exitCode})));
    throw new Error('Claude Code hook failure; see hook-faults.json');
  }
  const actual=transcript
    .filter(x=>x.attachment?.hookEvent==='Stop').flatMap(x=>[x.attachment.content].flat())
    .filter(s=>typeof s==='string' && s.includes(END_CHECK_LEAD));
  const listings=events.filter(e=>e.response).map(e=>{
    const text=JSON.parse(e.response).hookSpecificOutput.additionalContext;
    const lines=text.split('\n').filter(s=>/^\d+\. /.test(s));
    const norm=s=>s.replace(/\s+/g,' ').trim();
    const target=lines.filter(s=>norm(s).includes(norm(u.lesson.rule).slice(0,40))||s.includes(u.lesson.keyPhrase));
    return {text,target:target.length,other:lines.length-target.length,atStop:grade(e.post,e.commands)};
  });
  assert.deepEqual(listings.map(x=>x.text),actual,'emitted and delivered reminders differ');
  return {first,stops:events.length,listings:listings.map(({text,...rest})=>rest)};
}

async function prepareSlot(u,dir,template,arm) {
  const env=toolEnv(u,dir);
  const work=checkout(u,dir,env,template);
  env.LESSON_EVENTS=path.join(dir,'stops.jsonl');
  if(u.task.setup) run('cmd.exe',['/d','/c',u.task.setup],work,env,{timeout:1800000});
  restoreInstructions(work,new Map(u.files.filter(f=>f.surface==='instructions').map(f=>[f.path.slice(5),blob(f)])));
  const settings=install(dir,work,env,arm);
  const base=run('git',['rev-parse','HEAD'],work,env).trim();
  env.LESSON_PRE=stateCommit(work,base);
  const normalized=JSON.stringify(read(settings)).replaceAll(JSON.stringify(dir).slice(1,-1),'%slot%');
  const common=JSON.parse(normalized);
  delete common.hooks.Stop;
  return {env,work,settings,common,preTree:run('git',['rev-parse',env.LESSON_PRE+'^{tree}'],work,env).trim()};
}
function graderEnv(env) {
  return {...env,NODE_OPTIONS:'--require "'+path.join(here,'file-stdio.cjs')+'"'};
}
async function execute(pair,u,base,arms) {
  const result=path.join(base,'result.json');
  if(fs.existsSync(result)) return;
  fs.mkdirSync(path.dirname(base),{recursive:true});
  fs.mkdirSync(base); // A partial or concurrent launch cannot spend again.
  const template=path.join(base,'template');
  const seedHash=await seed(u,template);
  const prepared=[];
  for(const [i,arm] of arms.entries()) {
    const dir=path.join(base,'s'+(i+1));
    fs.mkdirSync(dir);
    const slot=await prepareSlot(u,dir,template,arm);
    prepared.push({...slot,dir,arm});
  }
  if(prepared.length===2) {
    assert.deepEqual(prepared[0].common,prepared[1].common,'non-Stop settings differ');
    assert.equal(prepared[0].preTree,prepared[1].preTree,'prepared workspaces differ');
  }
  const rows={};
  for(const {dir,work,settings,arm,env} of prepared) {
    const id=randomUUID(), prompt=path.join(dir,'prompt.txt');
    freeze(prompt,u.task.prompt);
    json(path.join(dir,'launch.json'),{id,pair,arm,seedHash,tokenVar:token});
    armCmd(id,arm,token,settings,work,env,prompt);
    rows[arm]=checks(u,work,env,dir,id,env.LESSON_PRE);
    assert.equal(rows[arm].stops>0,arm==='ON','Stop instrumentation missing or unexpected');
    json(path.join(dir,'grade.json'),rows[arm]);
  }
  json(result,{pair,id:u.id,seedHash,rows});
  console.log(pair+' complete');
}

async function hashFile(f) {
  const h=createHash('sha256');
  for await (const chunk of fs.createReadStream(f)) h.update(chunk);
  return h.digest('hex');
}
assertNoAncestorInstructions(root);
process.env.TEMP=process.env.TMP=path.join(root,'tmp');
fs.mkdirSync(process.env.TEMP,{recursive:true});
assert.deepEqual(pins(),{
  sliceJs:'67dd3ff715de52ac73b33675cd7e2be778d378b906205d8099880b78082dabfa',
  sliceCli:'80d9131341a74d45fdfabb7812abebd803b602f0c13151d54d6c80da791fd8cb',
  checkerTree:'b1d0fd269223f89acf3c1975c648edc6e3e507f69fe0ab3f2e9a45a796a35dbd',
  runner:'8e155d5ea4dcbffaa299c4fefea8c6b49a2ce663e620ef6064c415758c516de6',
  tools:'4837370c0932bfbe9197f174eb19fdec2ddc7ceaf2ffea545dcad6df9a7951c9',
  round3:'824d752205057f81f6e3f00df41552925b4848cce1ea6e860928dbdec101194c'
});
assert.equal(await hashFile(binary),'5064e6e0572dca86257363ca04d48653eef20ef27f1bd04b504ed7199ed3fd13');
assert.equal(run('git',['rev-parse','HEAD'],slice,process.env).trim(),'70eb87c0fdabdcc96754c80ccb4f975df87213ca');
assert.equal(digest(fs.readFileSync(path.join(corpus,'plan.json'))),'fdc2911c1d908c101327348a56d1c302141ae8cdaa9c1056ed0d9dfd3d7c5471');
if(mode!=='check') {
  const dir=path.join(root,'shell-probe');
  const env=privateEnv(dir);
  const js="const r=require('node:child_process').spawnSync(process.env.CLAUDE_CODE_GIT_BASH_PATH,['--noprofile','--norc','-c','exit 0']);if(r.status!==0){console.error('Git Bash unavailable: '+(r.error?.code??r.status));process.exit(1)}";
  run(process.execPath,['-e',js],dir,env);
}
if(mode==='probe') {
  console.log('Git Bash launch passed; no model call');
} else if(mode==='check') {
  const d=fs.mkdtempSync(path.join(root,'offline-'));
  const template=path.join(d,'template');
  const stamp=await seed(smoke,template);
  const arms=[];
  for(const arm of ['OFF','ON']) {
    const dir=path.join(d,arm);
    fs.mkdirSync(dir);
    const slot=await prepareSlot(smoke,dir,template,arm);
    arms.push(slot);
    const {env,work}=slot;
    const rule=smoke.history.flatMap(h=>h.rules).find(r=>r.detector);
    const {hippo}=await import('./prepare.mjs');
    const rules=run(process.execPath,[hippo,'session-rules'],work,env,{input:'{}'});
    assert.ok(rules.includes(rule.content),'seed did not reach the real session-start reader');
    const sessionId=randomUUID();
    const t=path.join(env.CLAUDE_CONFIG_DIR,'projects','fixture',sessionId+'.jsonl');
    const message=(type,content)=>JSON.stringify({type,message:{role:type,content}});
    freeze(t,[message('user','Fix the example'),message('assistant',[{type:'tool_use',id:'w',name:'Write',input:{file_path:'Example.java',content:'class Example {}'}}]),
      message('user',[{type:'tool_result',tool_use_id:'w',content:'done'}])].join('\n')+'\n');
    const output=run(process.execPath,[hippo,'end-check'],work,env,{input:JSON.stringify({transcript_path:t})});
    assert.ok(output.includes('spotlessApply'),'real Stop missed seeded detector');
    if(arm==='ON'){
      const emitted=run('cmd.exe',['/d','/c','hippo','end-check'],work,env,
        {input:JSON.stringify({session_id:sessionId,transcript_path:t})});
      assert.equal(emitted,output);
      assert.ok(JSON.parse(fs.readFileSync(env.LESSON_EVENTS,'utf8')).post);
    }
    const knownFail=runCheck(smoke.lesson,{work,env:graderEnv(env),preCommit:env.LESSON_PRE,postCommit:env.LESSON_PRE,commands:[],scratch:dir});
    console.log(arm+' installed; seed visible; fixture listed target; no-edit checker='+knownFail);
  }
  assert.deepEqual(arms[0].common,arms[1].common);
  assert.equal(arms[0].preTree,arms[1].preTree);
  console.log('same baseline '+stamp);
} else if(mode==='smoke') {
  const smokeDir=path.join(root,'smoke');
  // Keep the original smoke evidence when a later operator has a new launch authorisation.
  const dest=fs.existsSync(smokeDir) && key==='new-attempt' ? fs.mkdtempSync(path.join(root,'smoke-retry-')) : null;
  await execute('smoke',smoke,dest?path.join(dest,'attempt'):smokeDir,['ON']);
} else {
  const smokeRoots=[path.join(root,'smoke'),...fs.readdirSync(root).filter(n=>/^smoke-retry-[\w-]+$/.test(n)).map(n=>path.join(root,n,'attempt'))];
  assert.ok(smokeRoots.some(d=>{const f=path.join(d,'result.json');return fs.existsSync(f)&&read(f).rows.ON.stops>0;}),
    'A completed live smoke with working hooks is required before scored launches');
  const todo=mode==='full'?schedule:schedule.filter(p=>p.key===key);
  assert.ok(todo.length,'unknown pair');
  for(const p of todo) await execute(p.key,byId.get(p.id),path.join(root,'trial',p.key),p.order);
}

