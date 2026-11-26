import './local-stdio.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APPARATUS,checkerEnv,folder,root,checkTaskPins,roster,hash,read,pins } from './plan.mjs';
import { join,mkdir,entry,createStore,contents,forkStore,freezeBuiltIn,resetBuiltIn,stateRoot,copy,files,treeOf,ignoredListing,installedPackages } from './state.mjs';
import { auditApply } from './path-audit.mjs';
import { archivedAudit,evidence,mainPairs,messageHash,permissionAudit,shapeOf,sourceKind } from './evidence.mjs';
import { assertCheckerTools,checkerModules,gradeEnv,guardedRun } from './grading.mjs';
import { CHECK_MS,GUARD,seal } from '../checker-guard/lesson.mjs';
import { runCheck,stateCommit } from '../../../scripts/token-eval/checks.mjs';
import { teachMessage } from '../../../scripts/token-eval/lessons.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launch,openCue,retryLimited } from './delivery.mjs';
import { runSetupScript } from './setup.mjs';
import { assertSameTree,continueUnit } from './continuation.mjs';
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
const promptRow={type:'user',timestamp:'2026-11-25T10:00:00.000Z',message:{role:'user',content:task.prompt}};
let apiCount=0;
const apiFor=(body,querySource='sdk',extra={})=>{
  const b=typeof body==='string'?JSON.parse(body):body;
  return {type:'api-request',sessionId:sid,id:'api-'+apiCount++,querySource,shapeHash:shapeOf(b),keep:0,tail:b.messages.map(messageHash),...extra};
};
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
  const series=join(dir,'final-request'),trace=join(series,'projects/unit',sid+'.jsonl');
  const result={session:sid,subtype:'success',isError:false,exit:0};
  const rows=['one','two'].map(id=>({session_id:sid,query_source:'sdk',request_id:id,message_id:'msg-'+id,message_uuid:'row-'+id,
    request_file:id+'.request.json',response_file:id+'.response.json'}));
  const final={type:'assistant',uuid:'row-two',sessionId:sid,requestId:'two',message:{id:'msg-two',type:'message',
    role:'assistant',stop_reason:'end_turn',usage:{output_tokens:3},content:[txt('Finished.')]}};
  const check=()=>evidence(series,result,[],lesson,task,trace);
  const firstTurn={...final,uuid:'row-one',requestId:'one',message:{...final.message,id:'msg-one',stop_reason:'tool_use'}};
  const sent=[{system:[txt('base')],messages:[user]},{system:[txt(lesson.rule)],messages:[user]}];
  const apis=sent.map(b=>apiFor(b));
  const lines=(...turns)=>put(series,'projects/unit/'+sid+'.jsonl',[promptRow,...apis,...turns].map(r=>JSON.stringify(r)).join('\n'));
  const transcript=last=>lines(firstTurn,last);
  for(const [i,row] of rows.entries()) put(series,row.request_file,JSON.stringify(sent[i]));
  put(series,'index.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
  put(series,rows[0].response_file,'{"id":"msg-one"}');
  put(series,rows[1].response_file,'');
  assert.equal(check().complete,false);
  for(const changed of [{requestId:'other'},{sessionId:'other'},{uuid:'other'},
    {message:{...final.message,stop_reason:'max_tokens'}},{message:{...final.message,id:'other'}}]) {
    transcript({...final,...changed});
    assert.equal(check().complete,false);
  }
  lines(final);
  assert.equal(check().complete,false);
  transcript(final);
  const verified=check();
  assert(verified.complete && verified.targetText && verified.requests===2 && verified.transcriptResponse==='two');
  put(series,rows[1].response_file,'{"id":"msg-two"}');
  lines({...final,uuid:'row-one',requestId:'one',message:{...final.message,id:'msg-one'}});
  put(series,rows[0].response_file,'');
  assert.equal(check().complete,false);
  lines(final);
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
  const series=join(dir,'series'),trace=join(series,'projects/unit',sid+'.jsonl');
  const result={session:sid,subtype:'success',isError:false,exit:0};
  const turn=(id,stop='tool_use')=>({type:'assistant',uuid:'row-'+id,sessionId:sid,requestId:id,message:{id:'msg-'+id,
    type:'message',role:'assistant',stop_reason:stop,usage:{output_tokens:3},content:[txt(id)]}});
  const row=(id,source='sdk',file=id)=>({session_id:sid,query_source:source,request_id:id,message_id:'msg-'+id,
    message_uuid:'row-'+id,request_file:file+'.request.json',response_file:id+'.response.json'});
  const body=text=>JSON.stringify({system:[txt(text)],messages:[user]});
  const turns=[turn('one'),turn('one'),turn('two'),turn('three','end_turn')];
  const apiOf=(r,bodies={})=>apiFor(bodies[r.request_file] ?? body('base'),r.query_source);
  const transcript=rows=>put(series,'projects/unit/'+sid+'.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
  const write=(rows,bodies={},trail=turns,api=rows.filter(r=>sourceKind(r.query_source)!=='auxiliary'),lead=promptRow)=>{
    fs.rmSync(series,{recursive:true,force:true});
    transcript([lead,...api.map(r=>apiOf(r,bodies)),...trail]);
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
  write([side,...main],{},turns,[side,...main]);
  assert.equal(check().complete,false,'An auxiliary source with a replay row passed; the pinned CLI writes none');
  write([side,...main]);
  put(series,side.response_file,JSON.stringify({id:'other'}));
  assert.equal(check().complete,false,'An auxiliary response for another message passed');
  write(main,{},turns,[main[0],...main]);
  assert.equal(check().complete,false,'A replay row without a request body passed');
  put(series,'retry.request.json',body('base'));
  const retried=check();
  assert(retried.complete && retried.unanswered===1 && retried.requests===4 && !retried.targetText,'A retried request without a response failed');
  put(series,'retry.request.json',body(lesson.rule));
  assert(check().targetText,'An unanswered request body was not audited');
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
  const explore=row('explore','agent:builtin:Explore');
  write([explore,...main]);
  assert(check().complete,'A mixed-case side source with its api-request row failed');
  write([explore,...main],{},turns,main);
  assert.equal(check().complete,false,'An index source without an api-request row passed');
  write(main,{},turns,[...main,explore]);
  assert.equal(check().complete,false,'An api-request row without an index row passed');
  write([{...explore,query_source:'Agent:builtin:Explore'},...main],{},turns,[explore,...main]);
  assert.equal(check().complete,false,'A source in another case passed');
  const subagent=(rows,project='unit')=>put(series,path.join('projects',project,sid,'subagents','agent-a.jsonl'),
    rows.map(r=>JSON.stringify(r)).join('\n'));
  const later={timestamp:'2026-11-25T10:00:05.000Z'};
  write([explore,...main],{},turns,main);
  subagent([{...apiOf(explore),...later}]);
  assert(check().complete,'A subagent api-request row was not counted');
  write([explore,...main],{},turns,main);
  subagent([{...apiOf(explore),...later}],'other');
  assert(check().complete,'A subagent transcript in another project folder was not counted');
  write(main);
  subagent([apiOf(explore)]);
  assert.equal(check().complete,false,'A subagent api-request row without a timestamp passed');
  write(main,{},turns,main,{...promptRow,timestamp:undefined});
  assert.equal(check().complete,false,'A prompt row without a timestamp passed');
  write(main);
  put(series,'projects/other/'+sid+'.jsonl',JSON.stringify(promptRow));
  assert.equal(check().complete,false,'A second main transcript of the session passed');
  write(['one','two','three'].map(id=>row(id,'repl_main_thread')));
  assert(check().complete && check().sideRequests===0,'A repl_main_thread main turn failed');
  const own=(id,thinking)=>JSON.stringify({system:[txt('base')],messages:[user,
    msg('assistant',...(thinking===undefined?[]:[{type:'thinking',thinking,signature:'s'}]),txt('turn '+id))]});
  const distinct=Object.fromEntries(main.map(r=>[r.request_file,own(r.request_id)]));
  const retry={...main[1],request_file:'retry-two.request.json'};
  write(main,distinct,turns,[main[0],main[1],main[1],main[2]]);
  put(series,retry.request_file,distinct['two.request.json']);
  assert(check().complete && check().unanswered===1,'A retried request with its own body failed');
  fs.unlinkSync(join(series,retry.request_file));
  put(series,'title.request.json',JSON.stringify({system:[txt('Generate a title')],messages:[user]}));
  assert.equal(check().complete,false,'An unrelated unanswered body covered a missing request body');
  put(series,retry.request_file,own('other'));
  assert.equal(check().complete,false,'A body of other messages covered a missing request body');
  const replay=bodies=>main.map(r=>apiFor(bodies[r.request_file]));
  write(main,{...distinct,'two.request.json':own('changed')},turns,[]);
  transcript([promptRow,...replay(distinct),...turns]);
  assert.equal(check().complete,false,'An indexed body that differs from its replay row passed');
  write(main,{...distinct,'two.request.json':own('two','<REDACTED>')},turns,[]);
  transcript([promptRow,...replay({...distinct,'two.request.json':own('two','')}),...turns]);
  assert(check().complete,'A body with the redacted empty thinking text failed');
  transcript([promptRow,...replay({...distinct,'two.request.json':own('two','real text')}),...turns]);
  assert.equal(check().complete,false,'A redacted body matched non-empty thinking text');
  const chained=replay(distinct);
  chained[1]={...chained[1],base:chained[0].id,keep:1,tail:chained[1].tail.slice(1)};
  chained[2]={...chained[2],base:chained[1].id,keep:1,tail:chained[2].tail.slice(1)};
  write(main,distinct,turns,[]);
  transcript([promptRow,...chained,...turns]);
  assert(check().complete,'A replay row with kept messages from its base failed');
  transcript([promptRow,chained[1],chained[2],...turns]);
  assert.equal(check().complete,false,'A replay row with a missing base passed');
  transcript([promptRow,chained[0],{...chained[1],keep:3},chained[2],...turns]);
  assert.equal(check().complete,false,'A replay row that keeps more messages than its base passed');
}
function checkArchives() {
  const base=join(dir,'archives'),prompt=task.prompt;
  const clean=JSON.stringify({system:[txt('base')],messages:[user]});
  const leaked=JSON.stringify({system:[txt(lesson.rule)],messages:[user]});
  const turn={type:'assistant',sessionId:sid,requestId:'r1',message:{id:'m1'}};
  const limit={type:'assistant',sessionId:sid,isApiErrorMessage:true,message:{id:'s1',model:'<synthetic>',content:[txt("You've hit your weekly limit")]}};
  const row={session_id:sid,query_source:'sdk',request_id:'r1',message_id:'m1',request_file:'a.request.json',response_file:'r1.response.json'};
  const api=apiFor(clean),leakedApi=apiFor(leaked);
  const zero={input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0};
  const cut={session:sid,call:'apply',promptSha256:hash(prompt),json:true,subtype:'success',isError:true,turns:1,usage:zero,
    models:[],exit:1,apparatus:APPARATUS,cutOff:true,permissionDenials:[]};
  const attempt=(name,{turns=[],bodies={},rows,record=cut,mode='bypassPermissions',transcript=true,lead=prompt,before=[],subagent,elsewhere=false,id='apply'}={})=>{
    const live=join(base,name,'live'),operator=join(base,name,'operator'),project=join(live,'home/.claude/projects/unit');
    const calls=join(operator,'bodies',id);
    mkdir(live);
    const lines=[...before,{type:'user',permissionMode:mode,timestamp:'2026-11-25T10:00:02.000Z',message:{role:'user',content:lead}},...turns];
    if(transcript) put(project,sid+'.jsonl',lines.map(r=>JSON.stringify(r)).join('\n'));
    if(subagent) put(join(live,'home/.claude/projects',elsewhere?'other':'unit',sid,'subagents'),'agent-a.jsonl',subagent.map(r=>JSON.stringify(r)).join('\n'));
    for(const r of rows??[]) put(calls,r.response_file,JSON.stringify({id:r.message_id}));
    for(const [file,content] of Object.entries(bodies)) put(calls,file,content);
    if(rows) put(calls,'index.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
    if(record) put(operator,id+'.json',JSON.stringify(record));
    return live;
  };
  const audit=(lives,id='apply')=>archivedAudit(lives,id,sid,prompt,lesson,task);
  const passes=(live,name,target=false,id)=>assert.deepEqual(
    Object.values(audit([live],id)).slice(1),[0,target,true],name);
  const first={turns:[api,limit],bodies:{'a.request.json':clean}};
  const later={turns:[api,turn,api,limit],bodies:{'a.request.json':clean,'b.request.json':clean},rows:[row]};
  const firstLive=attempt('limit-first',first),laterLive=attempt('limit-later',later);
  assert.deepEqual(audit([firstLive,laterLive]),{archivedAttempts:2,archivedUnauditable:0,archivedTargetText:false,archivedPermissions:true});
  passes(attempt('limit-leak',{...later,turns:[api,turn,leakedApi,limit],bodies:{'a.request.json':clean,'b.request.json':leaked}}),'limit-leak',true);
  passes(attempt('extra-body',{...later,turns:[api,turn,limit]}),'extra-body');
  passes(attempt('extra-leak',{...later,turns:[api,turn,limit],bodies:{'a.request.json':clean,'b.request.json':leaked}}),'extra-leak',true);
  const teachRows=[{type:'user',permissionMode:'default',timestamp:'2026-11-25T10:00:00.000Z',message:{role:'user',content:'Teach first'}},
    {...api,timestamp:'2026-11-25T10:00:01.000Z'},{...turn,requestId:'t1',message:{id:'tm1'}}];
  const explore={...api,querySource:'agent:builtin:Explore'};
  const resumed={...later,id:'feedback',record:{...cut,call:'feedback'},before:teachRows,
    subagent:[{...explore,timestamp:'2026-11-25T10:00:01.000Z'}]};
  passes(attempt('resumed',resumed),'Teach rows leaked into the resumed feedback audit',false,'feedback');
  assert.equal(audit([attempt('resumed-sub',{...resumed,subagent:[{...explore,timestamp:'2026-11-25T10:00:03.000Z'}]})],'feedback')
    .archivedUnauditable,1,'A subagent request after the feedback prompt was not counted');
  const twice=attempt('twice',first);
  put(join(twice,'home/.claude/projects/other'),sid+'.jsonl',JSON.stringify({type:'user',message:{role:'user',content:prompt}}));
  assert.throws(()=>auditApply([twice],sid,twice),/Missing apply transcript/,'A second main transcript passed the path audit');
  assert.equal(audit([twice]).archivedUnauditable,1,'A second main transcript passed the archive audit');
  const silent=attempt('silent',{...first,transcript:false});
  assert.throws(()=>auditApply([silent,laterLive],sid,laterLive),/Missing apply transcript/);
  assert.equal(auditApply([firstLive,laterLive],sid,laterLive).transcripts,2);
  for(const [name,spec] of [
    ['withheld',{...later,bodies:{'a.request.json':clean,'b.request.json':JSON.stringify({not_recorded:true})}}],
    ['api-only',{turns:[api,limit]}],['empty',{}],
    ['foreign',{...later,rows:[{...row,session_id:'other'}]}],
    ['foreign-api',{...later,turns:[api,turn,{...api,sessionId:'other'},limit]}],
    ['untranscribed',{...later,transcript:false}],
    ['subagent-only',{...first,transcript:false,subagent:[{...api,timestamp:'2026-11-25T10:00:03.000Z'}]}],
    ['subagent-elsewhere',{...first,elsewhere:true,subagent:[{...api,querySource:'agent:builtin:Explore',timestamp:'2026-11-25T10:00:03.000Z'}]}],
    ['no-api-row',{...later,turns:[turn,limit]}],
    ['unmatched-source',{...later,turns:[{...api,querySource:'compact'},turn,api,limit]}],
    ['unrelated-body',{...later,turns:[api,turn,leakedApi,limit],
      bodies:{'a.request.json':clean,'t.request.json':JSON.stringify({system:[txt('Generate a title')],messages:[user]})}}],
    ['other-body',{...later,turns:[api,turn,leakedApi,limit]}],
    ['untimed-lead',{...later,lead:'Unrelated lead',before:[{type:'user',permissionMode:'bypassPermissions',message:{role:'user',content:prompt}}]}],
    ['unbodied-row',{...later,turns:[api,turn,api,{...turn,requestId:'r2',message:{id:'m2'}},limit],
      rows:[row,{...row,request_id:'r2',message_id:'m2',request_file:'c.request.json',response_file:'r2.response.json'}]}],
    ['unindexed-turn',{...later,rows:[]}],
    ['wrong-response',{...later,bodies:{...later.bodies,'r1.response.json':JSON.stringify({id:'other'})}}],
    ['no-record',{...later,record:null}],['other-call',{...later,record:{...cut,call:'teach'}}],
    ['other-session',{...later,record:{...cut,session:'other'}}],['not-cut-off',{...later,record:{...cut,cutOff:false}}],
    ['other-prompt',{...later,record:{...cut,promptSha256:hash('Another prompt')}}],
    ['other-apparatus',{...later,record:{...cut,apparatus:APPARATUS-1}}],
    ['other-lead',{...later,lead:'Another prompt'}]]) {
    const r=audit([attempt(name,spec)]);
    assert(r.archivedUnauditable===1 && r.archivedTargetText===false,name);
  }
  for(const [name,spec] of [['default',{...later,mode:'default'}],
    ['no-prompt-mode',{...later,mode:null,turns:[{...api,permissionMode:'bypassPermissions'},turn,api,limit]}],
    ['denied',{...later,record:{...cut,permissionDenials:[{tool:'Write',id:'x'}]}}],
    ['malformed',{...later,record:{...cut,permissionDenials:null}}],
    ['partial',{...later,record:{...cut,permissionDenials:[{tool:'Edit'}]}}],
    ['no-json',{...later,record:{session:sid,call:'apply',promptSha256:hash(prompt),json:false,exit:1,apparatus:APPARATUS,cutOff:true,permissionDenials:null}}],
    ['lead',{...later,lead:'Another prompt'}],['unrecorded',{...later,record:null}],['untranscribed',{...later,transcript:false}]]) {
    assert.equal(audit([attempt('perm-'+name,spec)]).archivedPermissions,false,name);
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
    return {preTree:treeOf(git,stateCommit(work,git('rev-parse','HEAD'))),ignoredSetup:ignoredListing(git)};
  };
  const a=make('a',{'setup.txt':'one','build/x':'1'}),b=make('b',{'setup.txt':'two','build/x':'1'});
  const c=make('c',{'setup.txt':'one'}),d=make('d',{'setup.txt':'one','build/x':'1'});
  assert(/^[0-9a-f]{40}$/.test(a.preTree) && /^[0-9a-f]{64}$/.test(a.ignoredSetup));
  assert(a.preTree!==b.preTree && a.ignoredSetup===b.ignoredSetup,'Different setup files must change the tree');
  assert(a.preTree===c.preTree && a.ignoredSetup!==c.ignoredSetup,'Ignored setup output must change the listing');
  assert.deepEqual(a,d);
  assert.deepEqual(a,make('e',{'setup.txt':'one','build/x':'2'}),'Ignored build contents are listed by path only');
  const gate=join(dir,'tree-gate');
  put(gate,'evidence/apply-0/grade.json',JSON.stringify(a));
  assertSameTree(gate,0,b);
  assertSameTree(gate,1,a);
  assert.throws(()=>assertSameTree(gate,1,b),/differs from arm 0/);
  assert.throws(()=>assertSameTree(gate,1,c),/differs from arm 0/);
  assert.throws(()=>assertSameTree(gate,1,{...a,installedSetup:'x'}),/differs from arm 0/);
  const arm=fs.readFileSync(join(folder,'run.mjs'),'utf8').split('async function applyArm')[1];
  assert(arm.includes('const gate=()=>assertSameTree(unit,index,{preTree,ignoredSetup,installedSetup});') &&
    arm.includes("session(u.apply,u.apply.prompt,sid,'apply',false,gate)"),'The apply session does not carry the tree gate');
  assert(/gate\?\.\(\);\s*fs\.writeFileSync\(path\.join\(live,'call\.json'\)/.test(fs.readFileSync(join(folder,'delivery.mjs'),'utf8')),
    'The smoke launch does not run the gate before it dispatches');
  const installed=name=>{
    const live=join(dir,'installed',name);
    put(live,'work/node_modules/a/package.json','{"name":"a","version":"1.0.0"}');
    put(live,'work/node_modules/@s/b/package.json','{"name":"@s/b","version":"2.0.0"}');
    put(live,'work/node_modules/a/node_modules/c/package.json','{"name":"c","version":"3.0.0"}');
    put(live,'venv/Lib/site-packages/pytest-8.0.0.dist-info/METADATA','Name: pytest');
    put(live,'work/obj/project.assets.json','{"libraries":{"N/1.0.0":{}}}');
    put(live,'work/build/out.txt','built at 1');
    put(live,'cache/node_modules/d/package.json','{"version":"1"}');
    put(live,'home/node_modules/e/package.json','{"version":"1"}');
    return live;
  };
  const fingerprint=installedPackages(installed('same'));
  assert(/^[0-9a-f]{64}$/.test(fingerprint) && installedPackages(installed('same-2'))===fingerprint);
  for(const [name,file,text] of [['nested','work/node_modules/a/node_modules/c/package.json','{"name":"c","version":"3.0.1"}'],
    ['scoped','work/node_modules/@s/b/package.json','{"name":"@s/b","version":"2.1.0"}'],
    ['assets','work/obj/project.assets.json','{"libraries":{"N/1.0.1":{}}}']]) {
    const live=installed(name);
    put(live,file,text);
    assert.notEqual(installedPackages(live),fingerprint,name+' version change was not fingerprinted');
  }
  const pip=installed('pip'),site=join(pip,'venv/Lib/site-packages');
  fs.renameSync(join(site,'pytest-8.0.0.dist-info'),join(site,'pytest-8.0.1.dist-info'));
  assert.notEqual(installedPackages(pip),fingerprint,'A Python version change was not fingerprinted');
  for(const [name,file] of [['build','work/build/out.txt'],['cache','cache/node_modules/d/package.json'],['home','home/node_modules/e/package.json'],
    ['metadata','venv/Lib/site-packages/pytest-8.0.0.dist-info/METADATA']]) {
    const live=installed(name);
    put(live,file,'{"changed":true}');
    assert.equal(installedPackages(live),fingerprint,name+' changed the fingerprint');
  }
  const formatted=installed('formatted');
  put(formatted,'work/node_modules/a/package.json','{\n  "version": "1.0.0",\n  "name": "a",\n  "_resolved": "file:///C:/elsewhere"\n}');
  assert.equal(installedPackages(formatted),fingerprint,'Manifest formatting or metadata changed the fingerprint');
  const linkTo=(name,target)=>{
    const live=installed(name);
    put(target,'package.json','{"name":"z","version":"9"}');
    fs.symlinkSync(target,join(live,'work/node_modules/z'),'junction');
    return live;
  };
  const outside=join(dir,'installed','outside'),linked=linkTo('linked',outside),linkedPrint=installedPackages(linked);
  assert.notEqual(linkedPrint,fingerprint,'A linked package folder was not fingerprinted');
  put(outside,'package.json','{"name":"z","version":"10"}');
  assert.equal(installedPackages(linked),linkedPrint,'A linked package folder was followed');
  assert.notEqual(installedPackages(linkTo('relinked',join(dir,'installed','other'))),linkedPrint,'A changed link target was not fingerprinted');
  const inStore=name=>installedPackages(linkTo(name,join(dir,'installed',name,'work/node_modules/.pnpm/z@9/node_modules/z')));
  assert.equal(inStore('store-a'),inStore('store-b'),'An in-store link differed across equal arms');
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
  write(row('Teach','default'),row('Feedback','bypassPermissions'));
  assert(permissionAudit(trace,'Feedback',[]).ok,'Earlier teach turns leaked into the resumed feedback check');
  assert(!permissionAudit(trace,'Teach',[]).ok,'A later mode change escaped the teach check');
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
  const statuses=[];
  const spied=(lesson,options)=>{ statuses.push(options.env.CHECK_STATUS); return runCheck(lesson,options); };
  const grade=(name,source,options={})=>{
    put(base,name,source);
    return guardedRun(spied,{id:name,checkPath:join(base,name),check:{}},
      {work,env:graded,preCommit:head,postCommit:head,commands:[],scratch:join(base,'scratch'),...options});
  };
  const stateOf=fn=>{ try { fn(); } catch(error) { return error.guard?.state ?? error.name; } return 'returned'; };
  assert.equal(grade('rule.mjs',"console.log('broken: rule');process.exit(1);"),'fail');
  assert.match(fs.readFileSync(log,'utf8'),/broken: rule/);
  assert(statuses.length===1 && !fs.existsSync(path.dirname(statuses[0])),'The guard record stayed on disk');
  assert(path.relative(base,statuses[0]).startsWith('..'),'The guard record sits inside the checker scratch');
  const forge=mark=>"import fs from 'node:fs';import path from 'node:path';const s=path.dirname(process.env.CHECK_COMMANDS);"+
    "for(const n of ['checker-status.json','status.json']){fs.writeFileSync(path.join(s,n),JSON.stringify({guard:'crash-guard-2',state:'exit',code:0}));"+
    "fs.writeFileSync(path.join(s,n+'.mark'),'"+mark+"');}";
  assert.equal(grade('forge-exit.mjs',forge('crash')+"process.exit(1);"),'fail','A scratch file changed the verdict');
  assert.equal(stateOf(()=>grade('forge-crash.mjs',forge('started')+"throw new Error('real crash');")),'crash','A scratch file hid a crash');
  assert.equal(stateOf(()=>grade('preload.mjs',"process.exit(1);",{env:{...graded,NODE_OPTIONS:'--require='+join(base,'absent.cjs')}})),
    'GuardError','A wrapper that never started gave a verdict');
  put(base,'inner-fails.cjs',"if(process.env.CHECK_GUARD_FD) throw new Error('preload failed');");
  assert.equal(stateOf(()=>grade('inner.mjs',"process.exit(1);",{env:{...graded,NODE_OPTIONS:'--require='+join(base,'inner-fails.cjs')}})),
    'unguarded','A checker that never reached the guard gave a verdict');
  assert.equal(stateOf(()=>grade('git.mjs',"import {execFileSync} from 'node:child_process';"+
    "execFileSync('git',['rev-parse','--verify','refs/absent']);process.exit(0);")),'crash');
  assert.throws(()=>grade('async.mjs',"await Promise.reject(new Error('lost'));"),/exited 2/);
  assert.match(fs.readFileSync(log,'utf8'),/checker crashed/);
  assert.equal(grade('spoof.mjs',"process.stderr.write('checker crashed: not really\\n');process.exit(['CHECK_GUARD_FD','CHECK_STATUS_KEY','CHECK_STATUS'].every(k=>process.env[k]===undefined)?1:0);"),'fail','The checker saw the guard channel or the status key');
  assert.equal(grade('direct.mjs',"import fs from 'node:fs';fs.writeSync(1,'direct-out\\n');fs.writeSync(2,'direct-err\\n');process.exit(0);"),'pass');
  assert.match(fs.readFileSync(log,'utf8'),/direct-out[\s\S]*direct-err/);
  put(base,'throw-child.cjs',"throw new Error('forked child');");
  assert.equal(grade('children.mjs',"import {spawnSync,fork} from 'node:child_process';"+
    "const spawned=spawnSync(process.execPath,['-e','throw new Error(1)']);"+
    "fork("+JSON.stringify(join(base,'throw-child.cjs'))+",{stdio:'ignore'}).on('exit',code=>"+
    "process.exit(spawned.status===1 && code===1 ? 0 : 1));"),'pass','The crash guard reached a child node process');
  const started=Date.now();
  assert.equal(grade('grandchild.mjs',"import {spawn,spawnSync} from 'node:child_process';"+
    "const r=spawnSync(process.execPath,['-e',\"try{require('fs').writeSync(3,'crash')}catch(e){process.exit(e.code==='EBADF'?7:8)}\"],{stdio:'inherit'});"+
    "spawn(process.execPath,['-e','setTimeout(()=>{},9000)'],{detached:true,stdio:'ignore'}).unref();"+
    "process.exit(r.status===7?1:0);",{deadlineMs:6000}),'fail','A grandchild wrote to the guard channel');
  assert(Date.now()-started<6000,'A detached grandchild held the guard channel open');
  const stub={id:'stub',checkPath:join(base,'rule.mjs'),check:{}},exit={guard:GUARD,state:'exit',code:0};
  const writes=sealer=>(lesson,options)=>{
    fs.writeFileSync(options.env.CHECK_STATUS,JSON.stringify({...exit,...sealer(options.env.CHECK_STATUS_KEY)}));
    return 'pass';
  };
  let earlier;
  assert.equal(guardedRun(writes(key=>{ earlier=key; return {seal:seal(key,exit)}; }),stub,{env:graded}),'pass','A sealed guard record failed');
  assert.throws(()=>guardedRun(writes(()=>({})),stub,{env:graded}),/without a matching guard record/,'An unsealed guard record passed');
  assert.throws(()=>guardedRun(writes(()=>({seal:seal(earlier,exit)})),stub,{env:graded}),
    /without a matching guard record/,'A guard record sealed with the key of an earlier call passed');
  const logDir=join(base,'log-is-a-folder');
  mkdir(logDir);
  assert.equal(stateOf(()=>grade('noisy.mjs',"console.log('x');process.exit(1);",{env:{...graded,CHECK_LOG:logDir}})),'wrapper-error');
  assert.throws(()=>guardedRun(()=>'pass',{id:'stub',checkPath:join(base,'rule.mjs'),check:{}},{env:graded}),
    /without a matching guard record/);
  assert.throws(()=>guardedRun(()=>'pass',{id:'stub',checkPath:join(base,'rule.mjs'),check:{}},{env:graded,status:join(base,'s.json')}),
    /keeps its status record private/);
  let deadline;
  assert.throws(()=>guardedRun((lesson,options)=>{ deadline=[options.timeoutMs,options.env.CHECK_DEADLINE_MS]; return 'pass'; },
    {id:'stub',checkPath:join(base,'rule.mjs'),check:{}},{env:graded}),/without a matching guard record/);
  assert.deepEqual([CHECK_MS,deadline],[120_000,[125_000,'120000']],'Production checker deadlines changed');
  assert.equal(grade('quick.mjs',"setTimeout(()=>process.exit(0),200);",{deadlineMs:3000}),'pass');
  assert.equal(stateOf(()=>grade('slow.mjs',"setTimeout(()=>process.exit(0),6000);",{deadlineMs:1500})),'timeout');
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
  assert.throws(()=>assertCheckerTools(fake,pyEnv),/cannot run python -m no_such_module_q1/);
  assert.throws(()=>assertCheckerTools(fake,env),/outside a Python toolchain/);
  const pkg=join(base,'pkg');
  put(pkg,'brokenmod_q1/__init__.py','raise ImportError("broken on import")');
  const found=execFileSync(system,['-c','import importlib.util as u;print(u.find_spec("brokenmod_q1") is not None)'],{cwd:pkg,env,encoding:'utf8'});
  assert.equal(found.trim(),'True','The broken package must be discoverable, as the old probe accepted it');
  put(base,'mods.mjs',"run(['-m', 'brokenmod_q1']);");
  assert.throws(()=>assertCheckerTools(fake,{...pyEnv,PYTHONPATH:pkg}),/cannot run python -m brokenmod_q1/);
  put(base,'mods.mjs',"run(['-m', 'pip']);");
  const shadow=join(base,'shadow');
  put(shadow,'pip.py','raise SystemExit(9)');
  const back=process.cwd();
  process.chdir(shadow);
  try { assert.deepEqual(assertCheckerTools(fake,pyEnv),['pip'],'A module in the current folder shadowed the probe'); }
  finally { process.chdir(back); }
  assert.throws(()=>assertCheckerTools(fake,{...env,CHECK_PYTHON:join(base,'other','python.exe')}),/is not CHECK_PYTHON/);
  assert.throws(()=>assertCheckerTools(fake,{...pyEnv,PATH:join(base,'empty-path')}),/is not CHECK_PYTHON/);
  assert.deepEqual(assertCheckerTools(roster()[1],env),[]);
}
checkGrading();
console.log('Passed task grading environment, checker crash exit, checker log and checker module probe.');
checkFinalResponse();
console.log('Passed final response transcript match, request coverage, leak scan and rejection cases.');
checkRequestSeries();
console.log('Passed ordered main requests, duplicate and reordered pairs, side requests by recorded source and their body audit.');
checkArchives();
console.log('Passed cut-off attempt audit: saved 429 shapes, resumed feedback boundary, unanswered bodies, leaks, unauditable records and permission evidence.');
checkTrees();
console.log('Passed work tree, ignored setup listing, installed package versions and the apply tree gate.');
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
let dispatched=0,boxed=0;
await assert.rejects(retryLimited(state,fork,()=>{dispatched++;return 0;},()=>{boxed++;return ready;},
  {gate:()=>{throw Error('Apply work tree differs from arm 0');},delay:unexpectedWait}),/differs from arm 0/);
assert.deepEqual([dispatched,boxed],[0,0],'A failed tree gate let the apply session start');
const order=[];
await retryLimited(state,fork,()=>{order.push('dispatch');return 0;},()=>ready,{gate:()=>order.push('gate'),delay:unexpectedWait});
assert.deepEqual(order,['gate','dispatch'],'The tree gate ran after dispatch');
const gateBefore=unitState();
let gateIntents=0;
await assert.rejects(launch(state,'NO_TOKEN_VAR',{},{...fork,smoke:false},{gate:()=>{throw Error('Rejected by the tree gate');},
  onFirstCall:()=>{gateIntents++;}}),/Rejected by the tree gate/);
assert.deepEqual([gateIntents,unitState()],[0,gateBefore],'The scored launch path did work before its gate');
assert(fs.readFileSync(join(folder,'run.mjs'),'utf8').split('async function session(')[1].split('\n}\n')[0]
  .includes('await launch(live,token,checkEnv,call,{gate,onFirstCall});'),'The session does not pass its gate to the scored launch');
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
put(fixture,'home/.claude/projects/other/'+sid+'/subagents/agent-other.jsonl',row(tool('far','Read',{file_path:checker})));
const planted=auditApply([fixture],sid,live);
assert.equal(planted.transcripts,3);
assert.deepEqual(planted.hits.map(h=>[h.tool,h.path]),[['Read',checker],['Read',sibling],['Bash',checker]]
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
assert.equal(retryAudit.hits.filter(h=>h.attempt===1).length,3);
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
      savedNotes(p),roster()[0].lesson,{prompt:read(join(p,'call.json')).prompt},savedTranscript(p,'probe.json'));
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
function teachFixture(dest,u,{apparatus=APPARATUS,mode='bypassPermissions',cutOff=false,record={}}={}) {
  const prompts=[u.teach.prompt,teachMessage(u.lesson,frozen.form)];
  const rows=prompts.map((content,i)=>
    ({type:'user',permissionMode:i ? mode : 'bypassPermissions',message:{role:'user',content}}));
  put(dest,'evidence/teach/home/.claude/projects/unit/'+sid+'.jsonl',rows.map(r=>JSON.stringify(r)).join('\n'));
  for(const [i,id] of ['teach','feedback'].entries())
    json(dest,'evidence/teach/operator/'+id+'.json',{session:sid,call:id,promptSha256:hash(prompts[i]),json:true,exit:0,
      isError:false,apparatus,cutOff,permissionDenials:[],...record});
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
for(const change of [{apparatus:2},{mode:'default'},{cutOff:true},{record:{json:false}},{record:{call:'other'}},
  {record:{promptSha256:hash('other')}}]) {
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
  [{cutOff:true},/Invalid frozen teach receipt/],[{record:{json:false}},/Invalid frozen teach receipt/],
  [{record:{promptSha256:hash('other')}},/Invalid frozen teach receipt/]]) {
  teachFixture(join(unitRoot,third.id),third,change);
  assert.throws(()=>collect(()=>assert.fail('Unexpected relaunch')),pattern);
}
teachFixture(join(unitRoot,third.id),third);
const teachReceipt=read(join(teachDir,'teach.json')),feedbackReceipt=read(join(teachDir,'feedback.json'));
for(const [file,value] of [['feedback.json',teachReceipt],['teach.json',feedbackReceipt]]) {
  teachFixture(join(unitRoot,third.id),third);
  json(teachDir,file,value);
  assert.throws(()=>collect(()=>assert.fail('Unexpected relaunch')),/Invalid frozen teach receipt/,'Swapped '+file);
}
teachFixture(join(unitRoot,third.id),third);
fs.unlinkSync(join(teachDir,'feedback.json'));
assert.throws(()=>collect(()=>assert.fail('Unexpected relaunch')),/Missing frozen teach receipt: feedback/);
teachFixture(join(unitRoot,third.id),third);
collect(()=>assert.fail('Completed unit relaunched'));
console.log('Passed roster order, complete skips, teach receipt checks, continuation routing and first-failure stop with a fake launcher.');
