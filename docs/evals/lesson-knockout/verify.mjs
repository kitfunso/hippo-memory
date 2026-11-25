import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import { folder,root,checkTaskPins,roster,hash,read } from './plan.mjs';
import { join,mkdir,entry,createStore,contents,forkStore,freezeBuiltIn,resetBuiltIn } from './state.mjs';
import { evidence } from './evidence.mjs';
import { openCue,retryLimited } from './delivery.mjs';

checkTaskPins();
const rosterHash=hash(JSON.stringify(roster()));
assert.equal(rosterHash,'7b3e3078f73cd6c11a2a6e50aabad48728016f5aae6f28a2db50daa1db8a2e42');
const dir=fs.mkdtempSync(join(root,'verify-')),teach=join(dir,'teach'),pre=join(dir,'pre');
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
resetBuiltIn(apply,pre,manifest);
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
  fs.writeFileSync(join(auditDir,'index.jsonl'),JSON.stringify({request_file:'r.request.json',response_file:'a.json',message_id:'m',session_id:sid}));
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
const state=join(dir,'retry');mkdir(state);put(state,'pre','original');
for(const name of ['checkpoints','limit-archives']) mkdir(join(root,name));
let attempts=0,waits=0;
await retryLimited(state,async()=>{
  assert.equal(fs.readFileSync(join(state,'pre'),'utf8'),'original');
  assert(!fs.existsSync(join(state,'partial')));
  if(attempts++===0){put(state,'partial','cut off');put(state,'pre','changed');return 75;}
  return 0;
},async ms=>{assert.equal(ms,900000);waits++;},1);
assert.equal(attempts,2);assert.equal(waits,1);
await assert.rejects(retryLimited(state,async()=>1,async()=>assert.fail('Unexpected wait')),/exited 1/);
await assert.rejects(retryLimited(state,async()=>75,async()=>assert.fail('Unexpected wait'),0),/wait exhausted/);
const unit=join(root,'smoke',roster()[0].id);
if(fs.existsSync(join(unit,'delivery-check/N/delivery.json'))) {
  for(const arm of ['T','N']) {
    const p=join(unit,'delivery-check',arm), result=evidence(join(p,'bodies/probe'),read(join(p,'probe.json')),
      contents(join(p,'work/.hippo')),roster()[0].lesson);
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
  const r=evidence(join(receipt,'bodies/apply'),read(join(receipt,'apply.json')),contents(join(receipt,'work/.hippo')),
    u.lesson,{...u.apply,work:join(unit,'coding-check/live/work')});
  assert(r.complete && r.hookSeen && r.targetText===(arm==='T'));
}
const work=join(dir,'loopback');mkdir(work);
createStore(join(work,'.hippo'),Array.from({length:20},(_,i)=>entry('Fixture '+i,null,'background')));
const cue=await openCue(work,sid),event={cwd:work,session_id:sid,hook_event_name:'UserPromptSubmit'};
try {
  const response=await fetch(cue.hook.url,{method:'POST',body:JSON.stringify(event)});
  const body=await response.json();
  assert.equal(body.hookSpecificOutput.additionalContext,'Project notes\n'+contents(join(work,'.hippo')).map(e=>'- '+e.content).join('\n'));
  if(process.argv.includes('--worker')) {
    const proc=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(folder,'worker.ps1'),
      '-Action','check','-ProbeUrl',cue.hook.url,'-ProbeEvent',Buffer.from(JSON.stringify(event)).toString('base64')],{stdio:'inherit'});
    assert.equal((await once(proc,'exit'))[0],0,'Worker qualification failed');
  }
} finally { await cue.close(); }
console.log('Passed task pins, state forks, settings, cache link, delivery sources, retry rollback, saved coding and diagnostic receipts, and HTTP hook.');
