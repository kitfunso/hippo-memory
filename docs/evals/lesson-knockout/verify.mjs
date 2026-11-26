import './local-stdio.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { setTimeout as wait } from 'node:timers/promises';
import { APPARATUS,checkerEnv,folder,root,checkTaskPins,roster,hash,read,pins } from './plan.mjs';
import { join,mkdir,entry,createStore,contents,forkStore,freezeBuiltIn,resetBuiltIn,stateRoot,copy,files,treeOf,ignoredListing,installedPackages } from './state.mjs';
import { auditApply } from './path-audit.mjs';
import { archivedAudit,bodyAudit,callComplete,evidence,mainPairs,permissionAudit,sessionInventory,wireLedger } from './evidence.mjs';
import { makeWireCa,openWire,wireName } from './wire.mjs';
import { sse } from './scripted-api.mjs';
import { checkWireOffline } from './verify-wire.mjs';
import { commandLog } from '../../../scripts/token-eval/records.mjs';
import { assertCheckerTools,checkerModules,gradeEnv,guardedRun } from './grading.mjs';
import { CHECK_MS,GUARD,seal } from '../checker-guard/lesson.mjs';
import { runCheck,stateCommit } from '../../../scripts/token-eval/checks.mjs';
import { teachMessage } from '../../../scripts/token-eval/lessons.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launch,openCallWire,openCue,retryLimited } from './delivery.mjs';
import net from 'node:net';
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
const task={prompt:'Investigate check-it',keyPhraseAllowed:true};
const msg=(role,...content)=>({role,content}),txt=text=>({type:'text',text});
const user=msg('user',txt(task.prompt)),answer=msg('assistant',txt('check-it'));
const ROUTE_PATHS={generate:'/v1/messages?beta=true',count:'/v1/messages/count_tokens?beta=true',
  settings:'/api/claude_code/settings',policy:'/api/claude_code/policy_limits'};
const plainBody=text=>JSON.stringify({system:[txt(text)],messages:[user]});
const streamed=(id,stop='end_turn')=>sse(pins.modelOpus,id,[{type:'text',text:'ok'}],stop);
const sseEvent=(type,data)=>'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
const brokenStream=id=>sseEvent('message_start',{message:{id}})+sseEvent('error',{error:{type:'overloaded_error',message:'fixture'}});
const failure=(type,status)=>({status,reply:JSON.stringify({type:'error',error:{type,message:'fixture'}})});
function wireRecord(base,exchanges,{extra=[],closed={}}={}) {
  fs.rmSync(base,{recursive:true,force:true}); mkdir(base);
  const rows=[];
  exchanges.forEach((x,i)=>{
    const n=i+1,route=x.route??'generate',model=route==='generate' || route==='count';
    const raw=Buffer.from(x.body ?? (model ? plainBody('base') : ''));
    const file=model ? wireName(n,'.request.json') : null;
    if(file) fs.writeFileSync(join(base,file),raw);
    rows.push({kind:'request',seq:n,method:x.method ?? (model?'POST':'GET'),path:x.path ?? ROUTE_PATHS[route],bytes:raw.length,
      sha256:hash(raw),file,savedSha256:file && hash(raw)});
    if(x.status===null) { rows.push({kind:'end',seq:n,ended:'upstream-error',error:'fixture'}); return; }
    const out=Buffer.from(x.reply ?? (route==='generate' ? streamed(x.id,x.stop) : route==='count' ? '{"input_tokens":10}' : '{}'));
    const saved=model ? wireName(n,'.response') : null;
    if(saved) fs.writeFileSync(join(base,saved),out);
    rows.push({kind:'response',seq:n,status:x.status ?? 200,requestId:x.requestId ?? null,encoding:x.encoding ?? null,
      contentType:x.contentType ?? (route==='generate' && x.reply===undefined ? 'text/event-stream' : 'application/json'),file:saved});
    rows.push({kind:'end',seq:n,ended:x.ended ?? 'complete',bytes:out.length,sha256:hash(out)});
  });
  rows.push(...extra);
  if(closed) rows.push({kind:'closed',open:0,exchanges:exchanges.length,...closed});
  fs.writeFileSync(join(base,'wire.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
}
function audited(messages,system=['base'],testTask=task) {
  wireRecord(auditDir,[{body:JSON.stringify({messages,system:system.map(txt)}),requestId:'r',id:'m'}]);
  return evidence(auditDir,{session:sid},[{content:'background'}],lesson,testTask);
}
const promptRow={type:'user',timestamp:'2026-11-25T10:00:00.000Z',message:{role:'user',content:task.prompt}};
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
function checkCallWire() {
  const series=join(dir,'final-request'),wire=join(series,'wire'),trace=join(series,'projects/unit',sid+'.jsonl');
  const done={session:sid,subtype:'success',isError:false,exit:0};
  const final={type:'assistant',uuid:'row-two',sessionId:sid,requestId:'two',message:{id:'msg-two',type:'message',
    role:'assistant',stop_reason:'end_turn',usage:{output_tokens:3},content:[txt('Finished.')]}};
  const firstTurn={...final,uuid:'row-one',requestId:'one',message:{...final.message,id:'msg-one',stop_reason:'tool_use'}};
  const lines=(...turns)=>put(series,'projects/unit/'+sid+'.jsonl',[promptRow,...turns].map(r=>JSON.stringify(r)).join('\n'));
  const one={requestId:'one',id:'msg-one',stop:'tool_use'},two={requestId:'two',id:'msg-two',body:plainBody(lesson.rule)};
  const check=(r=done)=>evidence(wire,r,[],lesson,task,trace);
  const passes=(exchanges,why,options)=>{ wireRecord(wire,exchanges,options); const r=check(); assert(r.complete,why); return r; };
  const fails=(exchanges,why,options)=>{ wireRecord(wire,exchanges,options); assert.equal(check().complete,false,why); };
  lines(firstTurn,final);
  const verified=passes([one,two],'A matched two-turn call failed');
  assert(verified.targetText && verified.requests===2 && verified.sideRequests===0 && verified.retries===0);
  for(const changed of [{requestId:'other'},{sessionId:'other'},{message:{...final.message,stop_reason:'max_tokens'}},
    {message:{...final.message,id:'other'}},{message:{...final.message,content:[txt(' ')]}}]) {
    lines(firstTurn,{...final,...changed});
    assert.equal(check().complete,false,'A changed final turn passed: '+JSON.stringify(changed));
  }
  lines(final);
  assert.equal(check().complete,false,'A transcript without its first turn passed');
  lines(firstTurn,final);
  for(const r of [{...done,subtype:'error_during_execution'},{...done,isError:true},{...done,exit:1},{...done,session:'other'}])
    assert.equal(check(r).complete,false,'A failed call result passed: '+JSON.stringify(r));
  fails([one,two,{requestId:'three',id:'msg-three'}],'An extra complete reply without a transcript turn passed');
  fails([one,two,{requestId:'three',...failure('overloaded_error',529)}],'A trailing failed request passed as a success');
  const unstopped=streamed('msg-two').replace(/event: message_stop\ndata: [^\n]*\n\n$/,'');
  assert(!unstopped.includes('message_stop'));
  fails([one,{...two,reply:unstopped,contentType:'text/event-stream'}],'A reply without message_stop passed');
  fails([one,{...two,reply:streamed('msg-two')+sseEvent('error',{error:{type:'overloaded_error'}}),contentType:'text/event-stream'}],
    'A reply with an error event passed');
  fails([one,{...two,ended:'client-closed'}],'A reply the client abandoned passed');
  fails([one,{...two,ended:'upstream-error'}],'A reply that broke upstream passed');
  fails([one,{...two,status:201}],'A reply with another status passed');
  for(const [name,change] of [['changed reply',d=>fs.appendFileSync(join(d,'00002.response'),' ')],
    ['changed request',d=>fs.appendFileSync(join(d,'00001.request.json'),' ')],
    ['lost request',d=>fs.unlinkSync(join(d,'00002.request.json'))],
    ['lost reply',d=>fs.unlinkSync(join(d,'00001.response'))]]) {
    wireRecord(wire,[one,two]); change(wire);
    assert.equal(check().complete,false,'A wire record with a '+name+' passed');
  }
  fails([one,two],'An open wire passed',{closed:false});
  fails([one,two],'A wire with an open exchange passed',{closed:{open:1}});
  fails([one,two],'A wire with a lost exchange passed',{closed:{exchanges:3}});
  fails([one,two],'A wire fault passed',{extra:[{kind:'fault',seq:2,stage:'exchange',error:'disk full'}]});
  fails([one,two],'A refused late request passed',{extra:[{kind:'refused',method:'POST',path:'/v1/messages?beta=true',reason:'closing'}]});
  fails([one,two],'An unknown wire row passed',{extra:[{kind:'other'}]});
  fails([one,two],'A repeated end row passed',{extra:[{kind:'end',seq:1,ended:'complete',bytes:0,sha256:hash('')}]});
  fails([one,two],'A tunnel to an Anthropic host passed',{extra:[{kind:'tunnel',host:'api.anthropic.com',port:8443}]});
  fails([one,two],'A tunnel to claude.ai passed',{extra:[{kind:'tunnel',host:'claude.ai',port:443}]});
  passes([one,two],'A refused plain request poisoned the wire',{extra:[{kind:'refused',method:'GET',path:'http://other/',reason:'plain'}]});
  const tunnelled=passes([one,two],'A tunnel to another host failed',{extra:[{kind:'tunnel',host:'statsig.example',port:443}]});
  assert.deepEqual(tunnelled.wireHosts,['statsig.example']);
  fails([one,{...two,path:'/v1/complete'}],'An unknown model route passed');
  fails([{route:'settings',path:'/api/oauth/profile'},one,two],'An unknown side route passed');
  fails([one,{...two,body:'not json'}],'An undecodable request passed');
  fails([one,{...two,body:JSON.stringify({messages:[user]})}],'A request without a system prompt passed');
  const side=passes([{route:'settings'},{route:'policy'},one,{route:'count',body:plainBody(lesson.rule)},{...two,body:plainBody('base')}],
    'Settings, policy and count requests broke the match');
  assert(side.sideRequests===3 && side.requests===2 && side.targetText,'A count body was not audited');
  passes([one,{route:'count',status:500,reply:'{"type":"error"}'},two],'A failed count reply stopped the call');
  passes([one,{...two,reply:zlib.gzipSync(streamed('msg-two')),encoding:'gzip',contentType:'text/event-stream'}],'A gzip reply failed');
  fails([one,{...two,reply:Buffer.from('not gzip'),encoding:'gzip',contentType:'text/event-stream'}],'An undecodable reply passed');
  fails([one,{...two,reply:streamed('msg-two'),encoding:'compress',contentType:'text/event-stream'}],'An unknown encoding passed');
  for(const [reply,encoding] of [[Buffer.from('not gzip'),'gzip'],[streamed('msg-two'),'compress']]) {
    wireRecord(wire,[one,{...two,reply,encoding,contentType:'text/event-stream'}]);
    assert.equal(wireLedger(wire).ok,false,'A complete reply that does not decode passed the ledger: '+encoding);
  }
  fails([one,{...two,reply:streamed('msg-two')+'event: content_block_delta\ndata: {broken\n\n',contentType:'text/event-stream'}],
    'A reply with an unparsed event passed');
  const retried=passes([one,{status:null},two],'An upstream error before a retry broke the match');
  assert.equal(retried.retries,1);
  lines(firstTurn);
  wireRecord(wire,[one]);
  const capped={...done,subtype:'error_max_turns',isError:true};
  assert(callComplete(wire,capped,task.prompt,trace,{maxTurns:true}).complete,'A smoke call at its turn cap failed');
  assert.equal(callComplete(wire,capped,task.prompt,trace).complete,false,'A scored call at its turn cap passed');
}
function checkRequestSeries() {
  const series=join(dir,'series'),wire=join(series,'wire'),trace=join(series,'projects/unit',sid+'.jsonl');
  const done={session:sid,subtype:'success',isError:false,exit:0};
  const turn=(id,stop='tool_use')=>({type:'assistant',uuid:'row-'+id,sessionId:sid,requestId:id,message:{id:'msg-'+id,
    type:'message',role:'assistant',stop_reason:stop,usage:{output_tokens:3},content:[txt(id)]}});
  const turns=[turn('one'),turn('one'),turn('two'),turn('three','end_turn')];
  const write=(exchanges,trail=turns,lead=[promptRow])=>{
    fs.rmSync(series,{recursive:true,force:true});
    put(series,'projects/unit/'+sid+'.jsonl',[...lead,...trail].map(r=>JSON.stringify(r)).join('\n'));
    wireRecord(wire,exchanges);
  };
  const check=()=>evidence(wire,done,[],lesson,task,trace);
  const fails=why=>assert.equal(check().complete,false,why);
  const main=['one','two','three'].map(id=>({requestId:id,id:'msg-'+id,stop:id==='three'?'end_turn':'tool_use'}));
  write(main);
  assert(check().complete && check().requests===3,'Split rows of one response must reconcile');
  assert.deepEqual(mainPairs(trace),['one\nmsg-one','two\nmsg-two','three\nmsg-three']);
  write([main[0],main[0],main[2]]);
  fails('A duplicated reply replaced a missing turn');
  write([main[1],main[0],main[2]]);
  fails('A reordered first request passed');
  write([{requestId:'retry',...failure('overloaded_error',529),body:plainBody(lesson.rule)},...main]);
  const retried=check();
  assert(retried.complete && retried.retries===1 && retried.targetText,'A 529 retry broke the match or skipped its body audit');
  write([main[0],{requestId:'broken',reply:brokenStream('msg-broken'),contentType:'text/event-stream'},main[1],main[2]]);
  assert(check().complete,'A stream that broke after message_start and was retried failed');
  write([main[0],{requestId:'two',id:'msg-two',ended:'client-closed'},main[1],main[2]]);
  assert(check().complete,'An abandoned partial reply before its retry failed');
  const hooked=[{...main[0],body:plainBody(cueText)},main[1],main[2]];
  write([{route:'count',body:plainBody('base')},...hooked]);
  assert(check().hookSeen && check().sideRequests===1,'The hook check must read the first generate request');
  write([{route:'count',body:plainBody(cueText)},...main]);
  assert(!check().hookSeen,'A count request supplied the hook evidence');
  write(main,[turn('one'),turn('two'),turn('one'),turn('three','end_turn')]);
  assert.equal(mainPairs(trace),null);
  fails('A transcript with a repeated response passed');
  write(main.slice(1),[turn('two'),turn('three','end_turn')],[promptRow,turn('one'),promptRow]);
  assert(check().complete,'A repeated prompt did not start the call at its last occurrence');
  write(main,[turn('two'),turn('three','end_turn')],[promptRow,turn('one'),promptRow]);
  fails('Turns before the last prompt entered the call');
  write(main);
  put(series,'projects/other/'+sid+'.jsonl',JSON.stringify(promptRow));
  fails('A second main transcript of the session passed');
  write(main);
  put(series,'projects/unit/'+sid+'/subagents/agent-a.jsonl',JSON.stringify(turn('agent')));
  fails('A subagent transcript passed');
}
function checkArchives() {
  const base=join(dir,'archives'),prompt=task.prompt;
  const leaked=plainBody(lesson.rule);
  const turn={type:'assistant',sessionId:sid,requestId:'r1',message:{id:'m1'}};
  const limit={type:'assistant',sessionId:sid,isApiErrorMessage:true,requestId:'r-limit',
    message:{id:'s1',model:'<synthetic>',content:[txt("You've hit your weekly limit")]}};
  const answered={requestId:'r1',id:'m1',stop:'tool_use'},limited={requestId:'r-limit',...failure('rate_limit_error',429)};
  const overloaded={requestId:'r-limit',...failure('overloaded_error',529)};
  const zero={input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0};
  const cut={session:sid,call:'apply',promptSha256:hash(prompt),json:true,subtype:'success',isError:true,turns:1,usage:zero,
    models:[],exit:1,apparatus:APPARATUS,cutOff:true,permissionDenials:[]};
  const attempt=(name,{turns=[],wire,options,record=cut,mode='bypassPermissions',transcript=true,lead=prompt,before=[],subagent,id='apply',change}={})=>{
    const live=join(base,name,'live'),operator=join(base,name,'operator'),project=join(live,'home/.claude/projects/unit');
    mkdir(live);
    const lines=[...before,{type:'user',permissionMode:mode,message:{role:'user',content:lead}},...turns];
    if(transcript) put(project,sid+'.jsonl',lines.map(r=>JSON.stringify(r)).join('\n'));
    if(subagent) put(join(project,sid,'subagents'),'agent-a.jsonl',subagent.map(r=>JSON.stringify(r)).join('\n'));
    if(wire) wireRecord(join(operator,'wire',id),wire,options);
    change?.(join(operator,'wire',id));
    if(record) put(operator,id+'.json',JSON.stringify(record));
    return live;
  };
  const audit=(lives,id='apply')=>archivedAudit(lives,id,sid,prompt,lesson,task);
  const passes=(live,name,target=false,id)=>assert.deepEqual(
    Object.values(audit([live],id)).slice(1),[0,target,true],name);
  const first={turns:[limit],wire:[limited]};
  const later={turns:[turn,limit],wire:[answered,limited]};
  const firstLive=attempt('limit-first',first),laterLive=attempt('limit-later',later);
  assert.deepEqual(audit([firstLive,laterLive]),{archivedAttempts:2,archivedUnauditable:0,archivedTargetText:false,archivedPermissions:true});
  passes(attempt('limit-leak',{...later,wire:[answered,{...limited,body:leaked}]}),'limit-leak',true);
  passes(attempt('count-leak',{...later,wire:[{route:'count',body:leaked},answered,limited]}),'count-leak',true);
  passes(attempt('retry-leak',{...later,wire:[answered,{...overloaded,requestId:'r-a',body:leaked},limited]}),'retry-leak',true);
  passes(attempt('settings-first',{...later,wire:[{route:'settings'},{route:'policy'},answered,limited]}),'settings-first');
  passes(attempt('exhausted-529',{...first,wire:[{...overloaded,requestId:'r-a'},{...overloaded,requestId:'r-b'},overloaded]}),'exhausted-529');
  passes(attempt('error-in-200',{...first,wire:[{requestId:'r-limit',reply:brokenStream('msg-x'),contentType:'text/event-stream'}]}),'error-in-200');
  passes(attempt('retried-then-cut',{...later,wire:[{...overloaded,requestId:'r0'},answered,limited]}),'retried-then-cut');
  const teachRows=[{type:'user',permissionMode:'default',message:{role:'user',content:'Teach first'}},
    {...turn,requestId:'t1',message:{id:'tm1'}}];
  const resumed={...later,id:'feedback',record:{...cut,call:'feedback'},before:teachRows};
  passes(attempt('resumed',resumed),'Teach rows leaked into the resumed feedback audit',false,'feedback');
  const twice=attempt('twice',first);
  put(join(twice,'home/.claude/projects/other'),sid+'.jsonl',JSON.stringify({type:'user',message:{role:'user',content:prompt}}));
  assert.throws(()=>auditApply([twice],sid,twice),/Missing apply transcript/,'A second main transcript passed the path audit');
  assert.equal(audit([twice]).archivedUnauditable,1,'A second main transcript passed the archive audit');
  const silent=attempt('silent',{...first,transcript:false});
  assert.throws(()=>auditApply([silent,laterLive],sid,laterLive),/Missing apply transcript/);
  assert.equal(auditApply([firstLive,laterLive],sid,laterLive).transcripts,2);
  for(const [name,spec] of [
    ['no-wire',{...later,wire:undefined}],['open-wire',{...later,options:{closed:false}}],
    ['fault',{...later,options:{extra:[{kind:'fault',seq:2,stage:'exchange',error:'disk full'}]}}],
    ['missing-main',{...first,wire:[{route:'settings'}]}],
    ['auxiliary-429',{...first,wire:[{...limited,requestId:'r-aux'}]}],
    ['late-success',{...first,wire:[limited,{requestId:'r9',id:'m9'}]}],
    ['early-extra',{...first,wire:[{requestId:'r9',id:'m9'},limited]}],
    ['unbound-limit',{...first,turns:[{...limit,requestId:undefined}]}],
    ['limit-not-last',{...later,turns:[limit,turn]}],
    ['exhausted-wrong-bind',{...first,wire:[overloaded,{...overloaded,requestId:'r-z'}]}],
    ['untranscribed',{...later,transcript:false}],['subagent',{...later,subagent:[turn]}],
    ['subagent-only',{...first,transcript:false,subagent:[turn]}],
    ['lost-body',{...later,change:d=>fs.unlinkSync(join(d,'00001.request.json'))}],
    ['changed-body',{...later,change:d=>fs.appendFileSync(join(d,'00002.request.json'),' ')}],
    ['changed-reply',{...later,change:d=>fs.appendFileSync(join(d,'00002.response'),' ')}],
    ['unknown-route',{...later,wire:[{path:'/v1/complete'},answered,limited]}],
    ['unindexed-turn',{...later,wire:[limited]}],
    ['no-record',{...later,record:null}],['other-call',{...later,record:{...cut,call:'teach'}}],
    ['other-session',{...later,record:{...cut,session:'other'}}],['not-cut-off',{...later,record:{...cut,cutOff:false}}],
    ['other-prompt',{...later,record:{...cut,promptSha256:hash('Another prompt')}}],
    ['other-apparatus',{...later,record:{...cut,apparatus:APPARATUS-1}}],
    ['other-lead',{...later,lead:'Another prompt'}]]) {
    const r=audit([attempt(name,spec)]);
    assert(r.archivedUnauditable===1 && r.archivedTargetText===false,name);
  }
  for(const [name,spec] of [['default',{...later,mode:'default'}],
    ['no-prompt-mode',{...later,mode:null,turns:[{...turn,permissionMode:'bypassPermissions'},limit]}],
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
  assert(/gate\?\.\(\);\s*const code=await recorded\(live,call,/.test(fs.readFileSync(join(folder,'delivery.mjs'),'utf8')),
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
  assert.notEqual(installedPackages(linked),linkedPrint,'A version change at the same link target was not fingerprinted');
  put(outside,'package.json','{"name":"w","version":"9"}');
  assert.notEqual(installedPackages(linked),linkedPrint,'A name change at the same link target was not fingerprinted');
  const renamed=installed('renamed');
  put(renamed,'work/node_modules/a/package.json','{"name":"other-a","version":"1.0.0"}');
  assert.notEqual(installedPackages(renamed),fingerprint,'A package name change was not fingerprinted');
  put(outside,'package.json','{"name":"z","version":"9"}');
  put(outside,'node_modules/y/package.json','{"name":"y","version":"1"}');
  assert.equal(installedPackages(linked),linkedPrint,'A linked package folder was walked');
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
  assert.equal(grade('spoof.mjs',"process.stderr.write('checker crashed: not really\\n');process.exit(['CHECK_GUARD_FD','CHECK_GUARD_NONCE','CHECK_STATUS_KEY','CHECK_STATUS'].every(k=>process.env[k]===undefined) && ['file','pipe'].includes(process.env.LESSON_STDIO)?1:0);"),'fail','The checker saw the guard channel, its nonce or the status key, or had no stdio mode');
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
  assert.equal(stateOf(()=>grade('fd3-forge.mjs',"import fs from 'node:fs';fs.writeSync(3,'crash\\n');throw new Error('forged');")),
    'unguarded','A checker write to the guard channel passed as a guard signal');
  assert.equal(stateOf(()=>grade('fd3-exit.mjs',"import fs from 'node:fs';fs.writeSync(3,'crash\\n');process.exit(2);")),
    'unguarded','A checker write to the guard channel before an ordinary exit 2 passed as a crash');
  assert.equal(stateOf(()=>grade('fd3-child.mjs',"import {spawnSync} from 'node:child_process';"+
    "const r=spawnSync(process.execPath,['-e',\"require('fs').writeSync(3,'crash\\\\n')\"],{stdio:['inherit','inherit','inherit',3]});"+
    "if(r.status!==0) process.exit(9);process.exit(1);")),'unguarded','A child given the guard channel forged a guard signal');
  assert.equal(stateOf(()=>grade('crash-code.mjs',"process.on('exit',()=>{process.exitCode=5;});throw new Error('other code');")),
    'unguarded','A crash signal with another exit code passed');
  const spy=join(base,'probe-spy.cjs');
  put(base,'probe-spy.cjs',"const cp=require('node:child_process'),o=cp.spawnSync;cp.spawnSync=(f,a,opt={})=>{"+
    "if(f==='git')process.stdout.write(JSON.stringify(Object.keys(opt.env??process.env).sort()));return o(f,a,opt);};"+
    "require("+JSON.stringify(join(folder,'local-stdio.cjs'))+");");
  const {LESSON_STDIO:parentMode,...unset}=process.env;
  const probed=env=>execFileSync(process.execPath,['--require',spy,'-e',''],{env,encoding:'utf8'});
  assert.deepEqual(JSON.parse(probed({...unset,CHECK_STATUS_KEY:'secret',CHECK_STATUS:'status'})),['PATH','SystemRoot'],
    'The stdio mode probe saw more than SystemRoot and PATH');
  assert.equal(probed({...unset,LESSON_STDIO:'pipe'}),'','A child with a stdio mode probed again');
  assert(['file','pipe'].includes(graded.LESSON_STDIO) && [undefined,graded.LESSON_STDIO].includes(parentMode),
    'The checker environment lost the stdio mode the parent selected');
  const fileMode={env:{...graded,LESSON_STDIO:'file'}};
  assert.equal(grade('file-exit.mjs',"console.log('file mode');process.exit(1);",fileMode),'fail','The file stdio guard channel lost an ordinary exit');
  assert.equal(stateOf(()=>grade('file-crash.mjs',"throw new Error('file mode crash');",fileMode)),'crash','The file stdio guard channel lost a crash');
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
checkCallWire();
console.log('Passed the wire ledger: final turn match, ordered replies, retries, side routes, file integrity, faults, tunnels and decoding.');
checkRequestSeries();
console.log('Passed ordered replies, duplicate and reordered pairs, retries, broken streams, the first generate body for the hook, repeated prompts and agent files.');
checkArchives();
const offline=await checkWireOffline(join(dir,'wire-offline'));
console.log('Passed the pinned CLI through the wire offline: '+offline.cases+' cases, '+offline.requests+' forwarded requests, '+offline.files+' retained files without the credential or identity fields.');
console.log('Passed cut-off attempt audit: 429, exhausted 529 and broken-stream ends bound to the last request, resumed feedback boundary, leaks, unauditable records and permission evidence.');
checkTrees();
console.log('Passed work tree, ignored setup listing, installed package versions and the apply tree gate.');
const state=join(dir,'retry');mkdir(state);put(state,'pre','original');
const records=join(dir,'operator');mkdir(records);
for(const name of ['checkpoints','limit-archives']) mkdir(join(dir,name));
const testCa=makeWireCa(join(dir,'wire-ca'),2);
const record=base=>openWire(base,{ca:testCa}).then(w=>({...w,close:()=>w.close(300)}));
const clearWire=()=>fs.rmSync(join(records,'wire'),{recursive:true,force:true});
const wireRows=id=>fs.readFileSync(join(records,'wire',id,'wire.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
function sentCall() {
  const {wireEnv:env,...sent}=read(join(records,'call.json'));
  assert.deepEqual(Object.keys(env),['HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'],'The call carries other wire settings');
  assert.match(env.HTTPS_PROXY,/^http:\/\/127\.0\.0\.1:\d+$/);
  return sent;
}
const proxyPort=()=>Number(new URL(read(join(records,'call.json')).wireEnv.HTTPS_PROXY).port);
function connectThrough(port) {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method:'CONNECT',path:'api.anthropic.com:443'});
    req.on('connect',(res,socket)=>{
      const t=tls.connect({socket,servername:'api.anthropic.com',ca:fs.readFileSync(join(testCa,'ca.pem'))},()=>resolve(t));
      t.on('error',()=>{});
    });
    req.on('error',reject);
    req.end();
  });
}
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
    assert.deepEqual(sentCall(),call);
    put(records,call.id+'.json',JSON.stringify({session:call.session}));
    calls++;
    return 0;
  },()=>checks.shift(),{maxWaits:0,record,onFirstCall:()=>{intents++},delay:ms=>{
    assert.equal(ms,300000);
    assert.equal(calls,0);
    assert.equal(intents,0);
    assert.deepEqual(unitState(),before);
    pauses++;
  }});
  assert.deepEqual([pauses,calls,archives],[2,1,[]]);
  assert.equal(read(join(records,call.id+'.json')).session,call.session);
  assert.deepEqual(wireRows(call.id).map(r=>r.kind),['closed'],'The attempt kept no closed wire record');
  if(call===feedback) { fs.renameSync(records,join(dir,'collected-teach')); mkdir(records); }
  else clearWire();
}
const unexpectedWait=()=>assert.fail('Unexpected wait');
await assert.rejects(retryLimited(state,fork,()=>assert.fail('Unexpected dispatch'),
  ()=>({status:1,stdout:'script error'}),{delay:unexpectedWait,record}),/box-check.sh failed/);
let dispatched=0,boxed=0;
await assert.rejects(retryLimited(state,fork,()=>{dispatched++;return 0;},()=>{boxed++;return ready;},
  {gate:()=>{throw Error('Apply work tree differs from arm 0');},delay:unexpectedWait,record}),/differs from arm 0/);
assert.deepEqual([dispatched,boxed],[0,0],'A failed tree gate let the apply session start');
const order=[];
await retryLimited(state,fork,()=>{order.push('dispatch');return 0;},()=>ready,{gate:()=>order.push('gate'),delay:unexpectedWait,record});
assert.deepEqual(order,['gate','dispatch'],'The tree gate ran after dispatch');
clearWire();
const gateBefore=unitState();
let gateIntents=0,launchCalls=0,launchBoxes=0;
await assert.rejects(launch(state,'NO_TOKEN_VAR',{},{...fork,smoke:false},{gate:()=>{throw Error('Rejected by the tree gate');},record,
  onFirstCall:()=>{gateIntents++;},dispatch:()=>{launchCalls++;return 0;},checkBox:()=>{launchBoxes++;return ready;}}),/Rejected by the tree gate/);
assert.deepEqual([gateIntents,launchCalls,launchBoxes,unitState()],[0,0,0,gateBefore],'The scored launch path did work before its gate');

assert(fs.readFileSync(join(folder,'run.mjs'),'utf8').split('async function session(')[1].split('\n}\n')[0]
  .includes('await launch(live,token,checkEnv,call,{gate,onFirstCall});'),'The session does not pass its gate to the scored launch');
assert(fs.readFileSync(join(folder,'run.mjs'),'utf8').split('async function session(')[1].split('\n}\n')[0]
  .includes("assert(wire.complete,'Wire record does not match the call '"),'The session grades a call without its wire record');
for(const name of ['check-smoke.mjs','wire-smoke.mjs'])
  assert(fs.readFileSync(join(folder,name),'utf8').includes("notes,u.lesson,{prompt},"),'The '+name+' probe audit has no prompt');
let attempts=0;
const checks=[ready,refused,ready],delays=[],priorArchives=new Set(fs.readdirSync(join(dir,'limit-archives')));
await retryLimited(state,feedback,async()=>{
  assert.equal(fs.readFileSync(join(state,'pre'),'utf8'),'original');
  assert(!fs.existsSync(join(state,'partial')));
  assert.deepEqual(sentCall(),feedback);
  if(attempts++===0){put(state,'partial','cut off');put(state,'pre','changed');put(records,'call.json','{"cut":"off"}');return 75;}
  return 0;
},()=>checks.shift(),{maxWaits:1,record,delay:ms=>{
  if(ms===300000) {
    assert.deepEqual(sentCall(),fork);
    assert(!fs.existsSync(join(records,'wire','feedback')),'The restored attempt kept the cut-off wire record');
    assert.equal(attempts,1);
  }
  delays.push(ms);
}});
assert.equal(attempts,2);assert.deepEqual(delays,[900000,300000]);assert.equal(checks.length,0);
const cutoffArchives=fs.readdirSync(join(dir,'limit-archives')).filter(n=>!priorArchives.has(n));
assert.equal(cutoffArchives.length,1);
assert.deepEqual(fs.readdirSync(join(dir,'limit-archives',cutoffArchives[0],'operator/wire/feedback')),['wire.jsonl'],
  'The cut-off snapshot lost its wire record');
clearWire();
await assert.rejects(retryLimited(state,fork,()=>1,()=>ready,{delay:unexpectedWait,record}),/exited 1/);
clearWire();
await assert.rejects(retryLimited(state,fork,()=>75,()=>ready,{delay:unexpectedWait,maxWaits:0,record}),/wait exhausted/);
clearWire();
const archivedBefore=fs.readdirSync(join(dir,'limit-archives')).length;
const brokenClose=async()=>({port:1,close:async()=>({ok:false,failure:'fixture',open:1,exchanges:1})});
await assert.rejects(retryLimited(state,fork,()=>75,()=>ready,{delay:unexpectedWait,record:brokenClose}),/Wire record failed/);
assert.equal(fs.readdirSync(join(dir,'limit-archives')).length,archivedBefore,'A failed wire close reached the cut-off snapshot');
await assert.rejects(retryLimited(state,fork,async()=>{
  const socket=await connectThrough(proxyPort());
  socket.write('POST /v1/messages?beta=true HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"model":');
  await wait(200);
  return 75;
},()=>ready,{delay:unexpectedWait,record}),/Wire record failed/);
assert.deepEqual(wireRows('apply').map(r=>r.kind),['fault','closed'],'An unfinished upload did not invalidate the attempt');
assert.equal(fs.readdirSync(join(dir,'limit-archives')).length,archivedBefore,'A late upload reached the cut-off snapshot');
clearWire();
await assert.rejects(retryLimited(state,fork,async()=>{
  await fs.promises.mkdir(join(records,'wire','apply','00001.request.json'));
  const socket=await connectThrough(proxyPort());
  const body='{"model":"x"}';
  socket.write('POST /v1/messages?beta=true HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nContent-Length: '+body.length+'\r\n\r\n'+body);
  const status=await new Promise(resolve=>socket.once('data',d=>resolve(/^HTTP\/1\.1 (\d+)/.exec(String(d))?.[1])));
  assert.equal(status,'502','A request the wire could not save was forwarded');
  return 0;
},()=>ready,{delay:unexpectedWait,record}),/Wire record failed/);
assert.deepEqual(wireRows('apply').map(r=>r.kind),['fault','closed'],'A failed body write did not latch the wire');
clearWire();
fs.mkdirSync(join(records,'wire','apply'),{recursive:true});
await assert.rejects(retryLimited(state,fork,()=>0,()=>ready,{delay:unexpectedWait,record}),/Stale wire record for apply/);
clearWire();
await assert.rejects(retryLimited(state,fork,async()=>{ throw Error('invoke fixture'); },()=>ready,{delay:unexpectedWait,record}),/invoke fixture/);
assert.deepEqual(wireRows('apply').map(r=>r.kind),['closed'],'A failed invocation left its wire open');
clearWire();
const shortCa=makeWireCa(join(dir,'short-ca'),1);
await assert.rejects(async()=>openCallWire(join(dir,'short-wire'),shortCa),/expires within a day/);
await assert.rejects(async()=>openCallWire(join(dir,'no-wire'),join(dir,'no-ca')),/Missing wire CA/);
assert((await (await openCallWire(join(dir,'long-wire'),testCa)).close(100)).ok,'A valid wire CA was refused');
await launch(state,'NO_TOKEN_VAR',{},{...fork,smoke:false},{checkBox:()=>ready,record,dispatch:async()=>{
  const response=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:proxyPort(),path:'http://example.invalid/',agent:false},resolve).on('error',reject));
  response.resume();
  assert.equal(response.statusCode,502);
  return 0;
}});
assert.deepEqual(wireRows('apply').map(r=>[r.kind,r.reason]),[['refused','plain'],['closed',undefined]],'A plain proxy request was forwarded or the wire stayed open');
clearWire();
const echo=net.createServer(s=>s.end('tunnelled'));
await new Promise(r=>echo.listen(0,'127.0.0.1',r));
await launch(state,'NO_TOKEN_VAR',{},{...fork,smoke:false},{checkBox:()=>ready,record,dispatch:async()=>{
  const socket=net.connect(proxyPort(),'127.0.0.1');
  socket.write('CONNECT 127.0.0.1:'+echo.address().port+' HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  await new Promise(resolve=>{ let text=''; socket.on('data',d=>{ text+=d; if(text.includes('tunnelled')) resolve(); }); });
  socket.destroy();
  return 0;
}});
echo.close();
assert.deepEqual(wireRows('apply').map(r=>[r.kind,r.host]),[['tunnel','127.0.0.1'],['closed',undefined]],'A tunnel to another host was not recorded');
clearWire();
console.log('Passed box refusals before teach resume, fork apply and subscription retry, one wire per attempt, and wire close failures.');
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
const nested=join(root,'unit/nested/snapshot/hippo.db');
put(fixture,join(project,sid,'subagents/agent-test/subagents/agent-nested.jsonl'),row(tool('deep','Read',{file_path:nested})));
put(fixture,join(project,'unrelated-session.jsonl'),row(tool('foreign','Read',{file_path:checker})));
put(fixture,join(project,'unrelated-session/subagents/agent-x.jsonl'),row(tool('foreign-agent','Read',{file_path:checker})));
const planted=auditApply([fixture],sid,live);
assert.equal(planted.transcripts,4,'The path audit missed a nested agent or read another session');
assert.deepEqual(planted.hits.map(h=>[h.tool,h.path]),[['Read',checker],['Read',sibling],['Bash',checker],['Read',nested]]
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
assert.equal(retryAudit.hits.filter(h=>h.attempt===1).length,4);
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
const modelFixture=join(dir,'model-access');
put(modelFixture,join(project,sid+'.jsonl'),row(tool('cli','Bash',{command:'claude -p "hi"'}),
  tool('api','Bash',{command:'curl https://api.anthropic.com/v1/messages'}),tool('env','PowerShell',{command:'echo $env:CLAUDE_CODE_OAUTH_TOKEN'}),
  tool('doc','Bash',{command:'cat CLAUDE.md'})));
assert.deepEqual(auditApply([modelFixture],sid,live).hits.map(h=>[h.tool,h.reason]),
  [['Bash','model access'],['Bash','model access'],['PowerShell','model access']],'The path audit missed a shell route to the model');
const nestedLog=join(dir,'nested-log');
put(nestedLog,join(project,sid+'.jsonl'),row(tool('top','Bash',{command:'echo top'})));
put(nestedLog,join(project,sid,'subagents/agent-a/subagents/agent-b.jsonl'),row(tool('deep','Bash',{command:'echo nested-agent'})));
assert.deepEqual(commandLog(sessionInventory(join(nestedLog,'home/.claude/projects'),sid).files),['echo top','echo nested-agent'],
  'Grading missed a nested agent command');
assert(fs.readFileSync(join(folder,'run.mjs'),'utf8').includes('commands:commandLog(sessionInventory(projects,session).files)'),
  'Grading does not read the session inventory');
const savedTranscript=(p,file)=>join(p,'home/.claude/projects/unit',read(join(p,file)).session+'.jsonl');
function savedNotes(receipt) {
  const dst=fs.mkdtempSync(join(dir,'smoke-store-'));
  copy(join(receipt,'work/.hippo'),join(dst,'store'));
  return contents(join(dst,'store'));
}
function savedBodies(base) {
  const rows=fs.readFileSync(join(base,'index.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const usable=b=>Array.isArray(b?.messages) && !!b.system && !b.not_recorded;
  const first=rows.find(r=>/^(?:sdk|repl_main_thread)/.test(r.query_source));
  return {bodies:rows.map(r=>read(join(base,r.request_file))).filter(usable),first:first && read(join(base,first.request_file))};
}
if(fs.existsSync(join(unit,'delivery-check/N/delivery.json'))) {
  for(const arm of ['T','N']) {
    const p=join(unit,'delivery-check',arm),notes=savedNotes(p),probe={prompt:read(join(p,'call.json')).prompt};
    const {bodies,first}=savedBodies(join(p,'bodies/probe'));
    const saved=bodyAudit(bodies,notes,roster()[0].lesson,probe,first);
    assert(saved.hookSeen && saved.targetText===(arm==='T'),'The body audit changed its reading of a saved probe');
    assert.equal(evidence(join(p,'wire','probe'),read(join(p,'probe.json')),notes,roster()[0].lesson,probe,
      savedTranscript(p,'probe.json')).complete,false,'A saved probe without a wire record passed');
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
  const applyTask={...u.apply,work:join(unit,'coding-check/live/work')},notes=savedNotes(receipt);
  const {bodies,first}=savedBodies(join(receipt,'bodies/apply'));
  const saved=bodyAudit(bodies,notes,u.lesson,applyTask,first);
  assert(saved.hookSeen && saved.targetText===(arm==='T'),'The body audit changed its reading of a saved apply');
  assert.equal(evidence(join(receipt,'wire','apply'),read(join(receipt,'apply.json')),notes,u.lesson,applyTask,
    savedTranscript(receipt,'apply.json')).complete,false,'A saved apply without a wire record passed');
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
