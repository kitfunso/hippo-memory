import stdioMode from './file-stdio.cjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { restoreInstructions } from '../../../scripts/token-eval/workspace.mjs';
import { corpus, digest, dist, json, read, root, slice } from './paths.mjs';

export const hippo = path.join(slice,'bin','hippo.js');
export const {HOOK_MEDIUM_TIMEOUT_SECONDS} = await dist('surface/hooks-install/rules/install-plan.js');
export const recorderTimeoutSeconds = 40;
export const posix = s => s.replaceAll('\\','/');
export const run = (file,args,cwd,env,opts={}) => execFileSync(file,args,{cwd,env,windowsHide:true,
  encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024,...opts});
export const runSetup = (setup,work,env) => run('cmd.exe',['/d','/s','/c','"'+setup+'"'],work,env,
  {timeout:1800000,windowsVerbatimArguments:true});
function shortSlotDir(kind,dir) {
  const [pair,prep,slot]=path.resolve(dir).split(path.sep).slice(-3);
  return path.join(root,kind,pair.slice(0,8)+'-'+prep.slice(-6)+'-'+slot);
}
export const poetryCache=dir=>shortSlotDir('pc',dir);
export const pythonTemp=dir=>shortSlotDir('pt',dir);
export function privateEnv(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    /^(SystemRoot|windir|ComSpec|Path|PATHEXT|ProgramFiles(?:\(x86\))?|ProgramW6432|SystemDrive|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(k)));
  for (const [k,v] of Object.entries({HOME:'home',USERPROFILE:'home',CLAUDE_CONFIG_DIR:'cc',HIPPO_HOME:'global',
    APPDATA:'appdata',LOCALAPPDATA:'local',TEMP:'tmp',TMP:'tmp',XDG_CACHE_HOME:'cache'})) {
    env[k]=path.join(dir,v); fs.mkdirSync(env[k],{recursive:true});
  }
  for (const sub of ['Local','Roaming']) fs.mkdirSync(path.join(env.USERPROFILE,'AppData',sub),{recursive:true});
  return {...env,HIPPO_CAPTURE_SCRIPTED:'1',HIPPO_AGENT_MEMORY_TOOLS:'claude-code,codex',
    LESSON_STDIO:stdioMode,LESSON_HIPPO:hippo,LESSON_STOP_TIMEOUT_MS:String(HOOK_MEDIUM_TIMEOUT_SECONDS*1000),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY:'0',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_GIT_BASH_PATH:'C:/Program Files/Git/bin/bash.exe',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',CI:'true'};
}
export function blob(f) {
  const b = fs.readFileSync(path.join(corpus,'blobs',f.sha256));
  assert.equal(digest(b),f.sha256);
  return b;
}
export async function seed(u,dir) {
  const {initStore,writeEntry,loadAllEntries} = await dist('entry/testing.js');
  const {deserializeEntry} = await dist('base/memory/markdown.js');
  const {createMemory,USER_RULE_TAG} = await dist('base/memory/entry.js');
  const {detectorTags} = await dist('base/memory/detect-tags.js');
  const {cliFolder} = await dist('surface/cli/api-context.js');
  const {duplicateKey} = await dist('base/util/same-text.js');
  const {statedText} = await dist('surface/capture/extract.js');
  const {followUpRules} = await dist('surface/capture/follow-up.js');
  const held=new Set();
  for(const h of u.history.filter(h=>h.rules.length)) {
    const {item,answer}=read(path.join(corpus,'replies',h.promptId+'.json'));
    const picked=await followUpRules(item.turns,{send:async req=>{
      assert.equal(req.prompt,item.prompt);
      return {ok:true,text:answer.reply};
    }},msg=>{throw new Error(msg);});
    assert.deepEqual(picked.rules.map(r=>r.content),h.rules.map(r=>r.content));
    for(const rule of picked.rules) {
      held.add(duplicateKey(rule.content));
      for(const sentence of rule.sentences) held.add(duplicateKey(statedText(sentence)));
    }
  }
  const project = path.join(dir,'project'), global = path.join(dir,'global');
  for (const db of [project,global]) {fs.mkdirSync(db,{recursive:true});initStore(db);}
  for (const f of u.files.filter(f=>f.surface.startsWith('hippo'))) {
    const row = deserializeEntry(blob(f).toString(),new Date(u.history[0].created));
    assert.ok(row);
    // Model capture supersedes the picked sentences, including their shared mirrors.
    if ((row.source==='capture' || row.source.startsWith('shared:')) && held.has(duplicateKey(row.content))) continue;
    writeEntry(f.surface==='hippoGlobal'?global:project,row);
  }
  const seen = new Set();
  for (const h of u.history) for (const r of h.rules) {
    const key=duplicateKey(r.content);
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = ['follow-up',USER_RULE_TAG,...(r.detector?detectorTags(r.detector):[])];
    const entry = createMemory(r.content,{source:'capture',sourceSessionId:h.sessionId,
      baseHalfLifeDays:cliFolder(project).config.defaultHalfLifeDays,tags,confidence:'observed',pinned:true},new Date(h.created));
    writeEntry(project,{...entry,originProject:'work',id:'mem_'+digest(h.sessionId+r.content).slice(0,12)});
  }
  json(path.join(project,'config.json'),{capture:{followUpRules:'model'},extraction:{enabled:false},pinnedInject:{promptRecall:true}});
  const stores=[project,global].map(d=>loadAllEntries(d).sort((a,b)=>a.id.localeCompare(b.id)));
  const taught=stores.flat().filter(r=>(r.source==='capture' || r.source.startsWith('shared:')) && held.has(duplicateKey(r.content)));
  assert.deepEqual(taught.map(r=>duplicateKey(r.content)).sort(),[...seen].sort(),'duplicate taught rules in seed');
  return digest(JSON.stringify(stores));
}
export function checkout(u,dir,env,template) {
  const work = path.join(dir,'work');
  fs.mkdirSync(work);
  const git = args => run('git',args,work,env);
  git(['init','-q']);
  for (const [k,v] of [['user.name','eval'],['user.email','eval@localhost'],['core.autocrlf','false'],['core.longpaths','true']])
    git(['config',k,v]);
  const pack=path.join(work,'.git','objects','pack','pack-base.pack');
  const out=fs.openSync(pack,'wx');
  try {
    run('git',['pack-objects','--revs','--stdout'],u.repo,env,{input:u.task.baseRef+'\n',stdio:['pipe',out,'pipe']});
  } finally {fs.closeSync(out);}
  git(['index-pack',pack]);
  git(['checkout','--quiet','--detach',u.task.baseRef]);
  fs.appendFileSync(path.join(work,'.git/info/exclude'),'\n.hippo/\n');
  for (const f of u.files.filter(f=>!f.surface.startsWith('hippo') && f.surface!=='instructions')) {
    let dest;
    if (f.surface==='userInstructions') dest=path.join(env.CLAUDE_CONFIG_DIR,f.path.slice('claude-config/'.length));
    else {
      const m = /^claude-config\/projects\/[^/]+\/memory\/(.+)$/.exec(f.path);
      assert.ok(m);
      dest=path.join(env.CLAUDE_CONFIG_DIR,'projects',work.replace(/[^a-zA-Z0-9]/g,'-'),'memory',m[1]);
    }
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,blob(f));
  }
  // A2's carried instructions replace the repository's root instructions before the model sees git history.
  restoreInstructions(work,new Map(u.files.filter(f=>f.surface==='instructions').map(f=>[f.path.slice(5),blob(f)])));
  git(['add','-A']);
  git(['commit','--allow-empty','-qm','Apply workspace instructions']);
  assert.equal(git(['status','--porcelain']).trim(),'');
  fs.cpSync(path.join(template,'project'),path.join(work,'.hippo'),{recursive:true});
  fs.cpSync(path.join(template,'global'),env.HIPPO_HOME,{recursive:true});
  return work;
}
export function install(dir,work,env,arm) {
  const bin=path.join(dir,'bin');
  fs.mkdirSync(bin,{recursive:true});
  const monitor=fileURLToPath(new URL('./stop.mjs',import.meta.url));
  const shStop='if [ "$1" = end-check ]; then exec "'+posix(process.execPath)+'" "'+posix(monitor)+'"; fi\n';
  const cmdStop='@if "%~1"=="end-check" ("'+process.execPath+'" "'+monitor+'" & exit /b)\r\n';
  fs.writeFileSync(path.join(bin,'hippo'),'#!/bin/sh\nunset CLAUDE_CODE_OAUTH_TOKEN\n'+shStop+'exec "'+posix(process.execPath)+'" "'+posix(hippo)+'" "$@"\n',{mode:0o755});
  fs.writeFileSync(path.join(bin,'hippo.cmd'),'@setlocal\r\n@set "CLAUDE_CODE_OAUTH_TOKEN="\r\n'+cmdStop+'@"'+process.execPath+'" "'+hippo+'" %*\r\n');
  run(process.execPath,[hippo,'hook','install','claude-code',...(arm==='ON'?['--end-check']:[])],work,env);
  const settings=path.join(env.CLAUDE_CONFIG_DIR,'settings.json');
  const config=read(settings);
  const stops=config.hooks.Stop?.flatMap(g=>g.hooks)??[];
  assert.deepEqual(stops.map(h=>h.command),arm==='ON'?['hippo end-check']:[]);
  if(arm==='ON') {
    assert.equal(stops[0].timeout,HOOK_MEDIUM_TIMEOUT_SECONDS);
    assert.ok(recorderTimeoutSeconds>stops[0].timeout);
    stops[0].timeout=recorderTimeoutSeconds;
    fs.writeFileSync(settings,JSON.stringify(config,null,2)+'\n');
  }
  return settings;
}

