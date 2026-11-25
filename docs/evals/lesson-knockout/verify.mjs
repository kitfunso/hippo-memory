import './local-stdio.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APPARATUS,checkerEnv,folder,root,checkTaskPins,roster,hash,read,pins } from './plan.mjs';
import { join,mkdir,entry,createStore,contents,forkStore,freezeBuiltIn,resetBuiltIn,stateRoot,copy,files,treeIds } from './state.mjs';
import { auditApply } from './path-audit.mjs';
import { archivedAudit,evidence,mainPairs,permissionAudit } from './evidence.mjs';
import { assertCheckerTools,checkerModules,gradeEnv,guardedLesson } from './grading.mjs';
import { runCheck,stateCommit } from '../../../scripts/token-eval/checks.mjs';
import { teachMessage } from '../../../scripts/token-eval/lessons.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openCue,retryLimited } from './delivery.mjs';
import { runSetupScript } from './setup.mjs';
import { continueUnit } from './continuation.mjs';
import { collectRemaining } from './collect.mjs';

checkTaskPins();
const rosterHash=hash(JSON.stringify(roster()));
assert.equal(rosterHash,'7b3e3078f73cd6c11a2a6e50aabad48728016f5aae6f28a2db50daa1db8a2e42');
const dir=stateRoot,teach=join(dir,'teach'),pre=join(dir,'pre');
function put(base,file,text) {
  const target=join(base,file); mkdir(join(target,'..')); fs.writeFileSync(target,text);
}
const paths=['work/CLAUDE.local.md','work/pkg/.claude/CLAUDE.md','work/pkg/CLAUDE.md','work/.claude/rules/r.md',
  'home/.claude/CLAUDE.md','home/.claude/projects/unit/memory/MEMORY.md','home/.claude/projects/other/memory/topic.md'];
for(const p of paths) put(teach,p,'Before');
mkdir(join(teach,'home/tmp'));
fs.symlinkSync(join(teach,'work'),join(teach,'home/tmp/tool-link'),'junction');
put(teach,'work/.claude/settings.json','{}');
assert.throws(()=>freezeBuiltIn(teach,join(dir,'bad-pre')),/Uncontrolled project settings/);
fs.unlinkSync(join(teach,'work/.claude/settings.json'));
const manifest=freezeBuiltIn(teach,pre);
for(const p of paths) put(teach,p,'After');
put(teach,'home/.claude/projects/unit/new.jsonl','Teach conversation');
const apply=join(dir,'apply');
put(apply,'work/CLAUDE.local.md','Changed base');
put(apply,'work/pkg/.claude/rules/extra.md','Extra');
put(dir,'setup-probe.ps1',`param([string]$Live)
$ErrorActionPreference='Stop'
$roaming=[Environment]::GetFolderPath('ApplicationData','Create')
& $env:ComSpec /d /c 'echo setup>"%USERPROFILE%\\setup-marker.txt"'
if ($LASTEXITCODE) { throw 'Setup child failed' }
$paths=@($env:USERPROFILE,$env:HOME,$PWD.Path,$env:APPDATA,$roaming,$env:LOCALAPPDATA,
  [Environment]::GetFolderPath('LocalApplicationData'),$env:TEMP,$env:TMP,$env:PSModuleAnalysisCachePath)
[IO.File]::WriteAllText((Join-Path $Live 'work/setup-paths.json'),(ConvertTo-Json $paths))
`);
const profile=join(apply,'home');
runSetupScript(apply,{...process.env,HOME:profile,USERPROFILE:profile},join(dir,'setup-probe.ps1'));
assert.equal(resetBuiltIn(apply,pre,manifest),hash(JSON.stringify(manifest)));
assert.deepEqual(fs.readdirSync(apply).sort(),['home','setup-home','work']);
const setupHome=join(apply,'setup-home');
assert.deepEqual(read(join(apply,'work/setup-paths.json')),
  ['','','','AppData/Roaming','AppData/Roaming','AppData/Local','AppData/Local','tmp','tmp','AppData/Local/ModuleAnalysisCache']
    .map(p=>join(setupHome,p)));
assert.equal(fs.readFileSync(join(apply,'setup-home/setup-marker.txt'),'utf8').trim(),'setup');
assert.throws(()=>resetBuiltIn(apply,pre,manifest),/Occupied destination/);
console.log('Passed Windows setup before apply home reset.');
for(const p of paths) assert.equal(fs.readFileSync(join(apply,p),'utf8'),'Before');
assert(!fs.existsSync(join(apply,'work/pkg/.claude/rules/extra.md')));
assert(!fs.existsSync(join(apply,'home/.claude/projects/unit/new.jsonl')));
const base=join(dir,'base'),snap=join(dir,'snap'),sid='test-provenance-id';
createStore(base,[entry('Preserve this background note.',null,'background')]);
createStore(snap,[...contents(base),...['capture','note-written','error','summary','cue'].map(s=>entry('Different text for '+s,sid,s))]);
for(const arm of ['T','Tp','N']) {
  const dst=join(dir,arm),r=forkStore(snap,base,dst,sid,arm);
  assert.equal(r.targetCount,5);
  assert.deepEqual(contents(dst).filter(e=>e.source==='background'),contents(base));
}
assert.equal(forkStore(base,base,join(dir,'empty'),sid,'N').targetCount,0);
assert(!fs.existsSync(join(pre,'home/tmp/tool-link')));
const auditDir=join(dir,'requests'),lesson={rule:'Run the special check.',keyPhrase:'check-it'};
mkdir(auditDir);
const task={prompt:'Investigate check-it',keyPhraseAllowed:true};
const msg=(role,...content)=>({role,content}),txt=text=>({type:'text',text});
function audited(messages,system=['base'],testTask=task) {
  fs.writeFileSync(join(auditDir,'r.request.json'),JSON.stringify({messages,system:system.map(txt)}));
  fs.writeFileSync(join(auditDir,'a.json'),'{"id":"m"}');
  fs.writeFileSync(join(auditDir,'index.jsonl'),JSON.stringify({query_source:'sdk',request_file:'r.request.json',response_file:'a.json',message_id:'m',session_id:sid}));
  return evidence(auditDir,{session:sid},[{content:'background'}],lesson,testTask);
}
const user=msg('user',txt(task.prompt)),answer=msg('assistant',txt('check-it'));
const tool=(id,name,input)=>({type:'tool_use',id,name,input});
const result=(id,text)=>msg('user',{type:'tool_result',tool_use_id:id,content:[txt(text)]});
function toolLeak(name,input) {
  return audited([user,msg('assistant',tool('id',name,input)),result('id','check-it')]).targetText;
}
assert(!audited([user,answer]).targetText);
assert(audited([user],['base'],{...task,keyPhraseAllowed:false}).targetText);
assert(audited([user],['Run the special check.']).targetText);
assert(!toolLeak('Bash',{command:'check-it'}));
assert(!toolLeak('Read',{file_path:'src/example.js'}));
assert(!toolLeak('Read',{file_path:root+'/active/live/work/src/example.js'}));
assert(!toolLeak('Bash',{command:'echo .claude/CLAUDE.md'}));
assert(toolLeak('Read',{file_path:root+'/unit/fake/snapshot/notes.md'}));
assert(toolLeak('Read',{file_path:'../settings.json'}));
assert(toolLeak('Bash',{command:'cat .claude/CLAUDE.md'}));
const cueText='UserPromptSubmit hook additional context: Project notes\n- background';
assert(audited([user,msg('system',txt(cueText))]).hookSeen);
assert(!audited([user,answer,result('id',cueText)]).hookSeen);
assert(audited([user,msg('system',txt('UserPromptSubmit hook additional context: check-it'))]).targetText);
function checkFinalResponse() {
  const series=join(dir,'final-request'),trace=join(series,sid+'.jsonl');
  const result={session:sid,subtype:'success',isError:false,exit:0};
  const rows=['one','two'].map(id=>({session_id:sid,query_source:'sdk',request_id:id,message_id:'msg-'+id,message_uuid:'row-'+id,
    request_file:id+'.request.json',response_file:id+'.response.json'}));
  const final={type:'assistant',uuid:'row-two',sessionId:sid,requestId:'two',message:{id:'msg-two',type:'message',
    role:'assistant',stop_reason:'end_turn',usage:{output_tokens:3},content:[txt('Finished.')]}};
  const check=()=>evidence(series,result,[],lesson,task,trace);
  const firstTurn={...final,uuid:'row-one',requestId:'one',message:{...final.message,id:'msg-one',stop_reason:'tool_use'}};
  const transcript=last=>put(series,sid+'.jsonl',[firstTurn,last].map(r=>JSON.stringify(r)).join('\n'));
  for(const row of rows) put(series,row.request_file,JSON.stringify({system:[txt('base')],messages:[user]}));
  put(series,rows[1].request_file,JSON.stringify({system:[txt(lesson.rule)],messages:[user]}));
  put(series,'index.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
  put(series,rows[0].response_file,'{"id":"msg-one"}');
  put(series,rows[1].response_file,'');
  assert.equal(check().complete,false);
  for(const changed of [{requestId:'other'},{sessionId:'other'},{uuid:'other'},
    {message:{...final.message,stop_reason:'max_tokens'}},{message:{...final.message,id:'other'}}]) {
    transcript({...final,...changed});
    assert.equal(check().complete,false);
  }
  put(series,sid+'.jsonl',JSON.stringify(final));
  assert.equal(check().complete,false);
  transcript(final);
  const verified=check();
  assert(verified.complete && verified.targetText && verified.requests===2 && verified.transcriptResponse==='two');
  put(series,rows[1].response_file,'{"id":"msg-two"}');
  put(series,sid+'.jsonl',JSON.stringify({...final,uuid:'row-one',requestId:'one',message:{...final.message,id:'msg-one'}}));
  put(series,rows[0].response_file,'');
  assert.equal(check().complete,false);
  put(series,sid+'.jsonl',JSON.stringify(final));
  put(series,rows[0].response_file,'{"id":"msg-one"}');
  put(series,rows[1].response_file,' ');
  assert.throws(check,SyntaxError);
  put(series,rows[1].response_file,'{"id":"msg-two"}');
  assert.equal(check().complete,false);
  transcript(final);
  assert.equal(check().complete,true);
  put(series,'index.jsonl',JSON.stringify(rows[0]));
  fs.unlinkSync(join(series,rows[1].request_file)); fs.unlinkSync(join(series,rows[1].response_file));
  assert.equal(check().complete,false);
}
function checkRequestSeries() {
  const series=join(dir,'series'),trace=join(series,sid+'.jsonl');
  const result={session:sid,subtype:'success',isError:false,exit:0};
  const turn=(id,stop='tool_use')=>({type:'assistant',uuid:'row-'+id,sessionId:sid,requestId:id,message:{id:'msg-'+id,
    type:'message',role:'assistant',stop_reason:stop,usage:{output_tokens:3},content:[txt(id)]}});
  const row=(id,source='sdk',file=id)=>({session_id:sid,query_source:source,request_id:id,message_id:'msg-'+id,
    message_uuid:'row-'+id,request_file:file+'.request.json',response_file:id+'.response.json'});
  const body=text=>JSON.stringify({system:[txt(text)],messages:[user]});
  const turns=[turn('one'),turn('one'),turn('two'),turn('three','end_turn')];
  const write=(rows,bodies={},trail=turns)=>{
    fs.rmSync(series,{recursive:true,force:true});
    put(series,sid+'.jsonl',trail.map(r=>JSON.stringify(r)).join('\n'));
    for(const r of rows) {
      put(series,r.request_file,bodies[r.request_file] ?? body('base'));
      put(series,r.response_file,JSON.stringify({id:r.message_id}));
    }
    put(series,'index.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
  };
  const check=()=>evidence(series,result,[],lesson,task,trace);
  const main=['one','two','three'].map(id=>row(id));
  write(main);
  assert(check().complete && check().sideRequests===0,'Split rows of one response must reconcile');
  assert.deepEqual(mainPairs(trace),['one\nmsg-one','two\nmsg-two','three\nmsg-three']);
  write([row('one'),row('one','sdk','one-copy'),row('three')]);
  assert.equal(check().complete,false,'A duplicated pair replaced a missing turn');
  write([row('two'),row('one'),row('three')]);
  assert.equal(check().complete,false,'A reordered first request passed');
  const side=row('title','generate_session_title');
  write([side,...main],{'one.request.json':body(cueText)});
  const withSide=check();
  assert(withSide.complete && withSide.sideRequests===1 && withSide.requests===4 && !withSide.targetText);
  assert(withSide.hookSeen,'The hook check must read the first main request, not side traffic');
  write([main[0],side,main[1],main[2]],{'title.request.json':body(lesson.rule)});
  assert(check().complete && check().targetText,'Side request bodies must be audited');
  write([main[0],{...side,query_source:undefined},main[1],main[2]]);
  assert.equal(check().complete,false,'A request without provenance passed');
  write([main[0],side,main[1],main[2]],{'title.request.json':JSON.stringify({not_recorded:true})});
  assert.equal(check().complete,false,'A withheld side body passed');
  write([main[0],{...side,session_id:'other'},main[1],main[2]]);
  assert.equal(check().complete,false,'A request from another session passed');
  write(main,{},[turn('one'),turn('two'),turn('one'),turn('three','end_turn')]);
  assert.equal(mainPairs(trace),null);
  assert.equal(check().complete,false,'A transcript with a repeated response passed');
}
function checkArchives() {
  const base=join(dir,'archives'),prompt=task.prompt;
  const clean=JSON.stringify({system:[txt('base')],messages:[user]});
  const leaked=JSON.stringify({system:[txt(lesson.rule)],messages:[user]});
  const turn={type:'assistant',requestId:'r1',message:{id:'m1'}};
  const row={session_id:sid,query_source:'sdk',request_id:'r1',message_id:'m1',request_file:'a.request.json',response_file:'r1.response.json'};
  const attempt=(name,{turns=[],bodies={},rows,record,mode='bypassPermissions',transcript=true}={})=>{
    const live=join(base,name,'live'),operator=join(base,name,'operator');
    mkdir(live);
    const lines=[{type:'user',permissionMode:mode,message:{role:'user',content:prompt}},...turns];
    if(transcript) put(join(live,'home/.claude/projects/unit'),sid+'.jsonl',lines.map(r=>JSON.stringify(r)).join('\n'));
    for(const [file,content] of Object.entries(bodies)) put(join(operator,'bodies/apply'),file,content);
    if(rows) put(join(operator,'bodies/apply'),'index.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
    if(record) put(operator,'apply.json',JSON.stringify(record));
    return live;
  };
  const audit=(...lives)=>archivedAudit(lives,'apply',sid,lesson,task);
  const refused=attempt('refused'),silent=attempt('silent',{transcript:false});
  const sent=attempt('sent',{turns:[turn],bodies:{'a.request.json':clean},rows:[row],record:{permissionDenials:[]}});
  assert.deepEqual(audit(refused,silent,sent),{archivedAttempts:3,archivedRefused:2,archivedUnauditable:0,
    archivedTargetText:false,archivedPermissions:true});
  assert.equal(audit(attempt('leak',{turns:[turn],bodies:{'a.request.json':leaked},rows:[row]})).archivedTargetText,true);
  assert.equal(audit(attempt('rejected',{bodies:{'a.request.json':leaked}})).archivedTargetText,true);
  for(const [name,spec] of [['withheld',{turns:[turn],bodies:{'a.request.json':JSON.stringify({not_recorded:true})},rows:[row]}],
    ['lost',{turns:[turn]}],['unindexed',{turns:[turn],bodies:{'a.request.json':clean},rows:[]}],
    ['foreign',{turns:[turn],bodies:{'a.request.json':clean},rows:[{...row,session_id:'other'}]}],
    ['untranscribed',{bodies:{'a.request.json':clean},rows:[row],transcript:false}]]) {
    const r=audit(attempt(name,spec));
    assert(r.archivedUnauditable===1 && r.archivedTargetText===false,name);
  }
  for(const [name,spec] of [['default',{mode:'default'}],['denied',{record:{permissionDenials:[{tool:'Write',id:'x'}]}}],
    ['malformed',{record:{permissionDenials:null}}],['partial',{record:{permissionDenials:[{tool:'Edit'}]}}]]) {
    assert.equal(audit(attempt(name,spec)).archivedPermissions,false,name);
  }
}
function checkTrees() {
  const env=checkerEnv({TEMP:dir,TMP:dir});
  const make=(name,extra)=>{
    const work=join(dir,'trees',name);mkdir(work);
    const git=(...args)=>execFileSync('git',['-c','user.name=t','-c','user.email=t@t',...args],{cwd:work,env,encoding:'utf8'}).trim();
    git('init','-q'); put(work,'.gitignore','build/\n'); put(work,'src.txt','base');
    git('add','.'); git('commit','-q','-m','base');
    for(const [file,text] of Object.entries(extra)) put(work,file,text);
    return treeIds(git,stateCommit(work,git('rev-parse','HEAD')));
  };
  const a=make('a',{'setup.txt':'one','build/x':'1'}),b=make('b',{'setup.txt':'two','build/x':'1'});
  const c=make('c',{'setup.txt':'one'}),d=make('d',{'setup.txt':'one','build/x':'1'});
  assert(/^[0-9a-f]{40}$/.test(a.preTree) && /^[0-9a-f]{64}$/.test(a.ignoredSetup));
  assert(a.preTree!==b.preTree && a.ignoredSetup===b.ignoredSetup,'Different setup files must change the tree');
  assert(a.preTree===c.preTree && a.ignoredSetup!==c.ignoredSetup,'Ignored setup output must change the listing');
  assert.deepEqual(a,d);
}
function checkPermissions() {
  const folderPath=join(dir,'permissions'),trace=join(folderPath,'t.jsonl');
  const row=(prompt,mode)=>({type:'user',permissionMode:mode,message:{role:'user',content:prompt}});
  const write=(...rows)=>put(folderPath,'t.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
  write(row('Teach','bypassPermissions'),row('Feedback','bypassPermissions'));
  assert(permissionAudit(trace,'Feedback',[]).ok);
  assert(permissionAudit(trace,'Feedback',[{tool:'WebFetch',id:'w'},{tool:'Agent',id:'a'}]).ok);
  for(const tool of ['Edit','Write','Bash','PowerShell','Read']) assert(!permissionAudit(trace,'Feedback',[{tool,id:'x'}]).ok);
  assert(!permissionAudit(trace,'Feedback',undefined).ok);
  for(const bad of [[null],[{tool:'Edit'}],[{tool:'WebFetch',id:''}],[{id:'x'}],{tool:'Edit',id:'x'}])
    assert(!permissionAudit(trace,'Feedback',bad).ok,JSON.stringify(bad));
  assert(!permissionAudit(trace,'Another prompt',[]).ok);
  write(row('Teach','bypassPermissions'),row('Feedback','default'));
  assert(!permissionAudit(trace,'Feedback',[]).ok);
  write(row('Teach','bypassPermissions'),{type:'user',message:{role:'user',content:[txt('Feedback')]}});
  assert(!permissionAudit(trace,'Feedback',[]).ok);
}
checkPermissions();
console.log('Passed prompt permission mode, structured denials and deliberate deny list.');
function checkGrading() {
  const base=join(dir,'grading'),work=join(base,'work'),live=join(base,'live');
  mkdir(work);
  const env=checkerEnv({TEMP:base,TMP:base});
  const git=(...args)=>execFileSync('git',['-c','user.name=t','-c','user.email=t@t',...args],{cwd:work,env,encoding:'utf8'}).trim();
  git('init','-q'); put(work,'a.txt','a'); git('add','a.txt'); git('commit','-q','-m','a');
  const head=git('rev-parse','HEAD'),log=join(base,'checker.log'),graded=gradeEnv(env,{toolchain:'npm'},live,log);
  const grade=(name,source)=>{
    put(base,name,source);
    return runCheck(guardedLesson({id:name,checkPath:join(base,name),check:{}}),
      {work,env:graded,preCommit:head,postCommit:head,commands:[],scratch:join(base,'scratch')});
  };
  assert.equal(grade('rule.mjs',"console.log('broken: rule');process.exit(1);"),'fail');
  assert.match(fs.readFileSync(log,'utf8'),/broken: rule/);
  assert.throws(()=>grade('git.mjs',"import {execFileSync} from 'node:child_process';"+
    "execFileSync('git',['rev-parse','--verify','refs/absent']);process.exit(0);"),/exited 2/);
  assert.throws(()=>grade('async.mjs',"await Promise.reject(new Error('lost'));"),/exited 2/);
  assert.match(fs.readFileSync(log,'utf8'),/checker crashed/);
  assert.equal(grade('direct.mjs',"import fs from 'node:fs';fs.writeSync(1,'direct-out\\n');fs.writeSync(2,'direct-err\\n');process.exit(0);"),'pass');
  assert.match(fs.readFileSync(log,'utf8'),/direct-out[\s\S]*direct-err/);
  put(base,'throw-child.cjs',"throw new Error('forked child');");
  assert.equal(grade('children.mjs',"import {spawnSync,fork} from 'node:child_process';"+
    "const spawned=spawnSync(process.execPath,['-e','throw new Error(1)']);"+
    "fork("+JSON.stringify(join(base,'throw-child.cjs'))+",{stdio:'ignore'}).on('exit',code=>"+
    "process.exit(spawned.status===1 && code===1 ? 0 : 1));"),'pass','The crash guard reached a child node process');
  const python=gradeEnv(env,{toolchain:'python'},live,log),scripts=join(live,'venv','Scripts');
  const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
  assert(same(python.CHECK_PYTHON,join(scripts,'python.exe')));
  assert(same(python.PATH.split(';')[0],scripts),'Task venv is not first on the grading PATH');
  const q256=roster().find(u=>u.id==='q256-f5'),q145=roster().find(u=>u.id==='q145-f2');
  assert.deepEqual(checkerModules(q256.lesson.checkPath),['coverage','pytest']);
  assert.deepEqual(checkerModules(q145.lesson.checkPath),['ruff','mypy','pytest']);
  const system=execFileSync('python',['-c','import sys;print(sys.executable)'],{env,encoding:'utf8'}).trim();
  const pyEnv={...env,CHECK_PYTHON:system},fake={id:'fake',lesson:{checkPath:join(base,'mods.mjs')}};
  put(base,'mods.mjs',"run(['-m', 'pip']);run([\"-m\", \"no_such_module_q1\"]);");
  assert.throws(()=>assertCheckerTools(fake,pyEnv,base),/cannot run python -m no_such_module_q1/);
  assert.throws(()=>assertCheckerTools(fake,env,base),/outside a Python toolchain/);
  const pkg=join(base,'pkg');
  put(pkg,'brokenmod_q1/__init__.py','raise ImportError("broken on import")');
  const found=execFileSync(system,['-c','import importlib.util as u;print(u.find_spec("brokenmod_q1") is not None)'],{cwd:pkg,env,encoding:'utf8'});
  assert.equal(found.trim(),'True','The broken package must be discoverable, as the old probe accepted it');
  put(base,'mods.mjs',"run(['-m', 'brokenmod_q1']);");
  assert.throws(()=>assertCheckerTools(fake,pyEnv,pkg),/cannot run python -m brokenmod_q1/);
  put(base,'mods.mjs',"run(['-m', 'pip']);");
  assert.deepEqual(assertCheckerTools(fake,pyEnv,base),['pip']);
  assert.throws(()=>assertCheckerTools(fake,{...env,CHECK_PYTHON:join(base,'other','python.exe')},base),/is not CHECK_PYTHON/);
  assert.deepEqual(assertCheckerTools(roster()[1],env,base),[]);
}
checkGrading();
console.log('Passed task grading environment, checker crash exit, checker log and checker module probe.');
checkFinalResponse();
console.log('Passed final response transcript match, request coverage, leak scan and rejection cases.');
checkRequestSeries();
console.log('Passed ordered main requests, duplicate and reordered pairs, side requests by recorded source and their body audit.');
checkArchives();
console.log('Passed cut-off attempt audit: refusals, inspectable bodies, withheld or lost bodies, leaks and permission evidence.');
checkTrees();
console.log('Passed work tree and ignored setup listing with different setup files.');
const state=join(dir,'retry');mkdir(state);put(state,'pre','original');
const records=join(dir,'operator');mkdir(records);
for(const name of ['checkpoints','limit-archives']) mkdir(join(dir,name));
const ready={status:0,stdout:'bare launch ms: 63 63 63 63 63 63 63; median 63 (limit 150)\n'};
const refused={status:1,stdout:'bare launch ms: 411 91 391 84 366 74 688; median 366 (limit 150)\n'};
const feedback={id:'feedback',session:'teach-session',resume:true,prompt:'Teaching turn'};
const fork={id:'apply',session:'fork-session',resume:false,prompt:'Apply task'};
const unitState=()=>[files(state),files(records),...['checkpoints','limit-archives'].map(n=>fs.readdirSync(join(dir,n)))];
put(records,'call.json',JSON.stringify({id:'teach',session:feedback.session}));
put(records,'teach.json',JSON.stringify({session:feedback.session}));
for(const call of [feedback,fork]) {
  const before=unitState();
  const checks=[refused,refused,ready];
  let pauses=0,calls=0,intents=0;
  const archives=await retryLimited(state,call,()=>{
    assert.equal(checks.length,0);
    assert.equal(intents,1);
    assert.deepEqual(read(join(records,'call.json')),call);
    put(records,call.id+'.json',JSON.stringify({session:call.session}));
    calls++;
    return 0;
  },()=>checks.shift(),{maxWaits:0,onFirstCall:()=>{intents++},delay:ms=>{
    assert.equal(ms,300000);
    assert.equal(calls,0);
    assert.equal(intents,0);
    assert.deepEqual(unitState(),before);
    pauses++;
  }});
  assert.deepEqual([pauses,calls,archives],[2,1,[]]);
  assert.equal(read(join(records,call.id+'.json')).session,call.session);
  if(call===feedback) { fs.renameSync(records,join(dir,'collected-teach')); mkdir(records); }
}
const unexpectedWait=()=>assert.fail('Unexpected wait');
await assert.rejects(retryLimited(state,fork,()=>assert.fail('Unexpected dispatch'),
  ()=>({status:1,stdout:'script error'}),{delay:unexpectedWait}),/box-check.sh failed/);
let attempts=0;
const checks=[ready,refused,ready],delays=[];
await retryLimited(state,feedback,async()=>{
  assert.equal(fs.readFileSync(join(state,'pre'),'utf8'),'original');
  assert(!fs.existsSync(join(state,'partial')));
  assert.deepEqual(read(join(records,'call.json')),feedback);
  if(attempts++===0){put(state,'partial','cut off');put(state,'pre','changed');put(records,'call.json','cut off');return 75;}
  return 0;
},()=>checks.shift(),{maxWaits:1,delay:ms=>{
  if(ms===300000) {
    assert.deepEqual(read(join(records,'call.json')),fork);
    assert.equal(attempts,1);
  }
  delays.push(ms);
}});
assert.equal(attempts,2);assert.deepEqual(delays,[900000,300000]);assert.equal(checks.length,0);
await assert.rejects(retryLimited(state,fork,()=>1,()=>ready,{delay:unexpectedWait}),/exited 1/);
await assert.rejects(retryLimited(state,fork,()=>75,()=>ready,{delay:unexpectedWait,maxWaits:0}),/wait exhausted/);
console.log('Passed box refusals before teach resume, fork apply and subscription retry.');
const unit=join(root,'smoke',roster()[0].id);
const live=join(root,'active/live'),project='home/.claude/projects/unit';
const sibling=join(root,'unit/sibling/snapshot/hippo.db'),checker=roster()[0].lesson.checkPath;
const row=(...blocks)=>JSON.stringify({type:'assistant',cwd:join(live,'work'),message:{content:blocks}});
const fixture=join(dir,'transcript-test');
put(fixture,join(project,sid+'.jsonl'),row(tool('ok','Glob',{pattern:'src/**/*.js'}),
  tool('cache','Write',{file_path:'../cache/work.tmp'}),
  tool('ps','PowerShell',{command:'Get-Content ../home/tmp/tool.log'}),
  tool('dist','Read',{file_path:join(process.env.KNOCKOUT_SLICE_ROOT,'dist/index.js')})));
put(fixture,join(project,sid,'subagents/agent-test.jsonl'),row(tool('read','Read',{file_path:sibling}),
  tool('cat','Bash',{command:'cat "'+checker+'"'})));
const planted=auditApply([fixture],sid,live);
assert.equal(planted.transcripts,2);
assert.deepEqual(planted.hits.map(h=>[h.tool,h.path]),[['Read',sibling],['Bash',checker]]
  .map(([name,p])=>[name,p.replaceAll('\\','/').toLowerCase()]));
const cutoff=join(dir,'cutoff');
put(cutoff,join(project,sid+'.jsonl'),row(
  tool('ps','PowerShell',{command:'Get-Content ..\\..\\operator\\setup.json'}),
  tool('glob','Glob',{path:'C:/z0-runs/r4',pattern:'*.json'}),
  tool('grep','Grep',{path:folder,pattern:'needle'}),
  tool('edit','Edit',{file_path:'/c/z0-runs/r4/tasks/example'}),
  tool('write','Write',{file_path:sibling})));
const retryAudit=auditApply([cutoff,fixture],sid,live);
assert.deepEqual(new Set(retryAudit.hits.filter(h=>h.attempt===0).map(h=>h.tool)),
  new Set(['PowerShell','Glob','Grep','Edit','Write']));
assert.equal(retryAudit.hits.filter(h=>h.attempt===1).length,2);
let smokeApplies=0;
function checkPaths(receipt,id,originalLive) {
  const audit=auditApply([receipt],read(join(receipt,id+'.json')).session,originalLive);
  assert.deepEqual(audit.hits,[],receipt);
  if(id==='apply') smokeApplies++;
}
for(const base of [unit,join(unit,'coding-check')]) {
  for(const index of [0,1]) checkPaths(join(base,'evidence','apply-'+index),'apply',join(base,'live'));
}
for(const name of ['delivery-check','command-check']) {
  for(const arm of ['T','N']) checkPaths(join(unit,name,arm),'probe',join(unit,name,'live'));
}
const savedTranscript=(p,file)=>join(p,'home/.claude/projects/unit',read(join(p,file)).session+'.jsonl');
function savedNotes(receipt) {
  const dst=fs.mkdtempSync(join(dir,'smoke-store-'));
  copy(join(receipt,'work/.hippo'),join(dst,'store'));
  return contents(join(dst,'store'));
}
if(fs.existsSync(join(unit,'delivery-check/N/delivery.json'))) {
  for(const arm of ['T','N']) {
    const p=join(unit,'delivery-check',arm), result=evidence(join(p,'bodies/probe'),read(join(p,'probe.json')),
      savedNotes(p),roster()[0].lesson,{},savedTranscript(p,'probe.json'));
    assert(result.complete && result.hookSeen && result.targetText===(arm==='T'));
  }
}
for(const arm of ['T','N']){
  const p=join(unit,'command-check',arm), receipt=read(join(p,'delivery.json'));
  const emitted=read(join(p,'command-output.json')).hookSpecificOutput.additionalContext.trim();
  const bodies=join(p,'bodies/probe'),index=JSON.parse(fs.readFileSync(join(bodies,'index.jsonl'),'utf8').trim());
  const body=read(join(bodies,index.request_file));
  assert(body.messages.some(m=>Array.isArray(m.content) && m.content.some(b=>b.text?.includes(emitted))));
  assert.equal(receipt.commandExit,0);assert.equal(receipt.hookSeen,false);
}
for(const arm of ['T','N']) {
  const u=roster()[0],receipt=fs.readdirSync(join(unit,'coding-check/evidence')).map(n=>join(unit,'coding-check/evidence',n))
    .find(p=>read(join(p,'grade.json')).arm===arm);
  const r=evidence(join(receipt,'bodies/apply'),read(join(receipt,'apply.json')),savedNotes(receipt),
    u.lesson,{...u.apply,work:join(unit,'coding-check/live/work')},savedTranscript(receipt,'apply.json'));
  assert(r.complete && r.hookSeen && r.targetText===(arm==='T'));
}
const work=join(dir,'loopback');mkdir(work);
createStore(join(work,'.hippo'),Array.from({length:20},(_,i)=>entry('Fixture '+i,null,'background')));
const cue=await openCue(work,sid),event={cwd:work,session_id:sid,hook_event_name:'UserPromptSubmit'};
try {
  const response=await fetch(cue.hook.url,{method:'POST',body:JSON.stringify(event)});
  const body=await response.json();
  assert.equal(body.hookSpecificOutput.additionalContext,'Project notes\n'+contents(join(work,'.hippo')).map(e=>'- '+e.content).join('\n'));
} finally { await cue.close(); }
console.log('Passed task pins, state forks, settings, cache link, delivery sources, retry rollback, saved coding and diagnostic receipts, and HTTP hook.');
console.log('Path audit passed: '+smokeApplies+' clean smoke applies, four clean probes, both planted tool inputs flagged.');

const [first,second,third]=roster().slice(0,3),unitRoot=join(dir,'unit'),partial=join(unitRoot,first.id);
const active=join(dir,'active'),design={unit:first,mode:'unit',roster:rosterHash};
const frozen={preHash:hash(JSON.stringify(manifest)),snapshotHash:hash(JSON.stringify(files(snap))),teachId:sid,targetRows:[],
  apparatus:APPARATUS,form:'correction'};
const json=(base,file,value)=>put(base,file,JSON.stringify(value));
function teachFixture(dest,u,{apparatus=APPARATUS,mode='bypassPermissions',cutOff=false}={}) {
  const rows=[u.teach.prompt,teachMessage(u.lesson,frozen.form)].map((content,i)=>
    ({type:'user',permissionMode:i ? mode : 'bypassPermissions',message:{role:'user',content}}));
  put(dest,'evidence/teach/home/.claude/projects/unit/'+sid+'.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
  for(const id of ['teach','feedback'])
    json(dest,'evidence/teach/operator/'+id+'.json',{session:sid,exit:0,isError:false,apparatus,cutOff,permissionDenials:[]});
}
json(partial,'design.json',design);
copy(pre,join(partial,'pre')); json(partial,'pre/manifest.json',manifest);
copy(base,join(partial,'pre/store'));
copy(snap,join(partial,'snapshot'));
teachFixture(partial,first);
put(active,'live/work/.git/HEAD',first.apply.baseRef+'\n');
json(active,'operator/setup.json',{toolchain:first.toolchain,setup:first.apply.setup,constraintHash:pins['sha256:pip-constraint']});
put(active,'live/cache/raw.bin',Buffer.from([0,255,10]));
const interrupted=files(active);
async function refuse(pattern) {
  await assert.rejects(()=>continueUnit(design,()=>assert.fail('Unexpected apply')),pattern);
  assert.deepEqual(fs.readdirSync(partial).filter(n=>n.startsWith('interrupted-')),[]);
}
await refuse(/freeze\.json/);
json(partial,'freeze.json',{...frozen,preHash:'changed'}); await refuse(/manifest changed/);
json(partial,'freeze.json',{...frozen,snapshotHash:'changed'}); await refuse(/snapshot changed/);
json(partial,'freeze.json',{...frozen,apparatus:APPARATUS-1}); await refuse(/another apparatus/);
json(partial,'freeze.json',frozen);
for(const change of [{apparatus:2},{mode:'default'},{cutOff:true}]) {
  teachFixture(partial,first,change); await refuse(/Invalid frozen teach receipt/);
}
teachFixture(partial,first);
put(partial,'pre/home/extra','changed'); await refuse(/Pre-teach home changed/); fs.unlinkSync(join(partial,'pre/home/extra'));
put(partial,'pre/repo/extra','changed'); await refuse(/Pre-teach repo changed/); fs.unlinkSync(join(partial,'pre/repo/extra'));
for(const [base,file,pattern] of [
  [active,'operator/call.json',/operator evidence/],[partial,'evidence/apply-0/grade.json',/evidence or intent/],
  [partial,'evidence/intent-test.json',/evidence or intent/],
  [active,'live/home/.claude/projects/unit/apply.jsonl',/transcript already exists/],
  [active,'operator/owner.json',/Different active task/],
]) {
  json(base,file,{});
  await refuse(pattern);
  fs.unlinkSync(join(base,file));
  if(file.startsWith('evidence/apply-')) fs.rmdirSync(join(base,'evidence/apply-0'));
}
const retryCall='limit-archives/unit-cutoff/operator/call.json';
put(dir,'limit-archives/unit-cutoff/live/work/.git/shallow',first.apply.baseRef);
json(dir,retryCall,{id:'apply',prompt:first.apply.prompt});
await refuse(/Archived apply/);
fs.unlinkSync(join(dir,retryCall));
const beforeResume=files(partial),applied=[];
await continueUnit(design,async(arm,index,saved)=>{
  assert.equal(saved.snapshotHash,frozen.snapshotHash); assert.deepEqual(saved.expected,manifest);
  assert.equal(index,applied.length); applied.push(arm);
  assert.deepEqual(fs.readdirSync(active),[]);
});
assert.deepEqual(applied,['Tp','T','N']);
const archives=fs.readdirSync(partial).filter(n=>n.startsWith('interrupted-'));
assert.equal(archives.length,1);
assert.deepEqual(files(join(partial,archives[0])),interrupted);
for(const [name,digest] of Object.entries(beforeResume)) assert.equal(hash(fs.readFileSync(join(partial,name))),digest);
console.log('Passed frozen continuation, intact archive, refusal checks and apply order.');

function finishFixture(u) {
  const dest=join(unitRoot,u.id);
  json(dest,'freeze.json',frozen);
  teachFixture(dest,u);
  for(const [i,arm] of u.order.entries()) json(dest,'evidence/apply-'+i+'/grade.json',{
    id:u.id,repo:u.repo,arm,mode:'unit',verdict:'fail',session:u.id+'-'+arm,teachId:sid,apparatus:APPARATUS,
    preTree:'a'.repeat(40),ignoredSetup:'b'.repeat(64),sideRequests:0,archivedAttempts:0,archivedRefused:0,
    archivedUnauditable:0,archivedTargetText:false,archivedPermissions:true,
    snapshotHash:frozen.snapshotHash,resetHash:frozen.preHash,targetCount:0,storeVerified:true,
    complete:true,requests:1,hookSeen:false,targetText:false,pathAudit:{transcripts:1,hits:[]}
  });
}
finishFixture(first);
mkdir(join(unitRoot,second.id));
const calls=[],tokenVar='Z0_SUB_TOKEN_2',scheduled=[first,second,third];
const collect=launch=>collectRemaining(scheduled,unitRoot,tokenVar,launch);
const attempted=[];
assert.throws(()=>collect(id=>{attempted.push(id); throw Error('Fake launcher failed')}),/Fake launcher failed/);
assert.deepEqual(attempted,[second.id]);
assert.throws(()=>collect(()=>{}),/without complete evidence/);
collect((id,token,resume)=>{
  calls.push([id,token,resume]);
  finishFixture(scheduled.find(u=>u.id===id));
});
assert.deepEqual(calls,[[second.id,tokenVar,true],[third.id,tokenVar,false]]);
collect(()=>assert.fail('Completed unit relaunched'));
const neutral=third.order.indexOf('N');
for(const [i,change,pattern] of [[0,{preTree:'c'.repeat(40)},/different work trees/],
  [2,{ignoredSetup:'c'.repeat(64)},/different work trees/],[1,{preTree:'tree'},/Invalid scored receipt/],
  [neutral,{archivedTargetText:true},/Invalid scored receipt/],[neutral,{archivedUnauditable:1},/Invalid scored receipt/],
  [neutral,{targetText:true},/Invalid scored receipt/],[0,{archivedPermissions:false},/Invalid scored receipt/],
  [1,{apparatus:2},/Invalid scored receipt/],[1,{apparatus:undefined},/Invalid scored receipt/]]) {
  const file='evidence/apply-'+i+'/grade.json',saved=read(join(unitRoot,third.id,file));
  json(join(unitRoot,third.id),file,{...saved,...change});
  assert.throws(()=>collect(()=>assert.fail('Unexpected relaunch')),pattern);
  json(join(unitRoot,third.id),file,saved);
}
const teachDir=join(unitRoot,third.id,'evidence/teach/operator');
for(const [change,pattern] of [[{apparatus:2},/Invalid frozen teach receipt/],[{mode:'default'},/Invalid frozen teach receipt/],
  [{cutOff:true},/Invalid frozen teach receipt/]]) {
  teachFixture(join(unitRoot,third.id),third,change);
  assert.throws(()=>collect(()=>assert.fail('Unexpected relaunch')),pattern);
}
teachFixture(join(unitRoot,third.id),third);
fs.unlinkSync(join(teachDir,'feedback.json'));
assert.throws(()=>collect(()=>assert.fail('Unexpected relaunch')),/Missing frozen teach receipt: feedback/);
teachFixture(join(unitRoot,third.id),third);
collect(()=>assert.fail('Completed unit relaunched'));
console.log('Passed roster order, complete skips, teach receipt checks, continuation routing and first-failure stop with a fake launcher.');
