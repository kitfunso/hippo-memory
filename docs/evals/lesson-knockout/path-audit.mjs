import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findTranscript,listTranscripts } from '../../../scripts/token-eval/records.mjs';
import { root,roster,guardPaths } from './plan.mjs';
import { slice } from './slice.mjs';

const win=path.win32;
function normalize(value,cwd) {
  const local=value.replaceAll('\\','/').replace(/^file:\/\/\/|^\/\/[?.]\//i,'')
    .replace(/^\/\/(?:localhost|127\.0\.0\.1)\/([a-z])\$(?=\/)/i,'$1:')
    .replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?=\/)/i,'$1:');
  return win.resolve(cwd,local).replaceAll('\\','/').toLowerCase();
}
const under=(file,dir)=>file===dir || file.startsWith(dir+'/');
const protectedPaths=[root,'C:/z0-runs','C:/eval-authors',...guardPaths(roster())].map(p=>normalize(p,root));
const dist=normalize(win.join(slice,'dist'),root);

function reason(file,live) {
  if(under(file,live) || under(file,dist) || under(file,'c:/z0-runs/r4/poetry-2.5.1')) return;
  if(protectedPaths.some(dir=>under(file,dir))) return 'protected path';
  if(!/^[a-z]:\//.test(file)) return;
  if(under(file,'c:/eval-envs') || under(file,'c:/program files') || under(file,'c:/program files (x86)')) return;
  for(let dir=file;;dir=normalize('..',dir)) {
    if(fs.existsSync(win.join(dir,'.git'))) return 'source repository';
    if(dir===normalize('..',dir)) return;
  }
}

function commandPaths(command,cwd,live) {
  const paths=[];
  const variables={pwd:cwd,home:live+'/home',userprofile:live+'/home',temp:live+'/home/tmp',tmp:live+'/home/tmp'};
  const expanded=command.replace(/\$(?:env:)?(\w+)|%(\w+)%/gi,(token,a,b)=>variables[(a??b).toLowerCase()]??token);
  const stack=[];
  for(const part of expanded.split(/(?:&&|\|\||[;|\n])/)) {
    const words=part.match(/(?:"[^"]*"|'[^']*'|[^\s"'<>])+/g)??[];
    const args=words.map(word=>word.replace(/["']/g,'').replace(/^(?:--?[\w-]+[=:]|\w+=)/,''));
    for(const arg of args) {
      if(/[\\/]/.test(arg) || arg==='..' || arg==='.') paths.push(normalize(arg,cwd));
    }
    for(const match of part.matchAll(/(?:[a-z]:[\\/]|\/(?:mnt\/|cygdrive\/)?[a-z]\/|\.\.[\\/])[^'"\s;,()<>|]+/gi))
      paths.push(normalize(match[0],cwd));
    if(/^(cd|chdir|set-location|sl|pushd|push-location)$/i.test(args[0])) {
      const target=args.slice(1).find(v=>!/^(?:-path|-literalpath|\/d|--|-)$/i.test(v));
      if(target) {
        if(/^push/i.test(args[0])) stack.push(cwd);
        cwd=normalize(target,cwd);
        paths.push(cwd);
      }
    } else if(/^(popd|pop-location)$/i.test(args[0]) && stack.length) cwd=stack.pop();
  }
  return paths;
}

function toolPaths({name,input},cwd,live) {
  if(['Bash','PowerShell'].includes(name)) {
    assert.equal(typeof input.command,'string','Missing transcript command');
    return [cwd,...commandPaths(input.command,cwd,live)];
  }
  if(['Read','Write','Edit'].includes(name)) {
    assert.equal(typeof input.file_path,'string','Missing transcript file path');
    return [normalize(input.file_path,cwd)];
  }
  if(['Grep','Glob','LS'].includes(name)) {
    const dir=normalize(input.path??'.',cwd),pattern=name==='Glob'?input.pattern:input.glob;
    return pattern ? [dir,normalize(pattern,dir)] : [dir];
  }
  return [];
}

function transcriptHits(file,live) {
  const hits=[];
  let assistant=false;
  const lines=fs.readFileSync(file,'utf8').trim().split(/\r?\n/);
  for(const [index,line] of lines.entries()) {
    const row=JSON.parse(line);
    if(row.type!=='assistant') continue;
    assistant=true;
    const cwd=normalize(row.cwd??live+'/work',live+'/work');
    for(const tool of (Array.isArray(row.message?.content)?row.message.content:[])) {
      if(tool.type!=='tool_use') continue;
      for(const target of new Set(toolPaths(tool,cwd,live))) {
        const why=reason(target,live);
        if(why) hits.push({line:index+1,tool:tool.name,path:target,reason:why});
      }
    }
  }
  return {assistant,hits};
}

export function auditApply(attempts,session,livePath) {
  const live=normalize(livePath,root),hits=[];
  let transcripts=0;
  for(const [index,attempt] of attempts.entries()) {
    const main=findTranscript(win.join(attempt,'home/.claude/projects'),session);
    assert(main,'Missing apply transcript in '+attempt);
    const sub=win.join(win.dirname(main),session,'subagents');
    for(const file of [main,...listTranscripts(sub)]) {
      const result=transcriptHits(file,live);
      if(file===main && index===attempts.length-1) assert(result.assistant,'Incomplete apply transcript '+file);
      transcripts++;
      for(const hit of result.hits) hits.push({attempt:index,archive:index===attempts.length-1?null:win.relative(root,attempt),
        file:win.relative(attempt,file),...hit});
    }
  }
  assert(transcripts>0,'Missing apply transcripts');
  return {transcripts,hits};
}
