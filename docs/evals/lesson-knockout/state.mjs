import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { hash, root, folder } from './plan.mjs';
import { mod } from './slice.mjs';
const {createMemory} = await mod('base/memory/entry');
const {DEFAULT_CONFIG} = await mod('base/config/config');
const {initStore,writeEntry,loadAllEntries} = await mod('store/sqlite/fixtures');
const {extractFromTexts} = await mod('surface/capture/extract');
const {collectSessionTurns} = await mod('surface/capture/transcript');
export const join = path.join;
const verifying=path.resolve(process.argv[1]??'')===join(folder,'verify.mjs');
export const stateRoot=verifying ? fs.mkdtempSync(join(tmpdir(),'knockout-verify-')) : root;
if(verifying) process.on('exit',()=>fs.rmSync(stateRoot,{recursive:true,force:true}));
export const mkdir = dir => fs.mkdirSync(dir,{recursive:true});
export const treeOf=(git,commit)=>git('rev-parse',commit+'^{tree}');
export const ignoredListing=git=>hash(git('ls-files','--others','--ignored','--exclude-standard','--directory'));
const OUTSIDE_INSTALL=new Set(['home','setup-home','cache']);
const byName=(a,b)=>a.name<b.name ? -1 : a.name>b.name ? 1 : 0;
const linkTarget=(live,full)=>{
  const target=path.resolve(path.dirname(full),fs.readlinkSync(full)),rel=path.relative(path.resolve(live),target);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? target : rel).split(path.sep).join('/');
};
export function installedPackages(live) {
  const out=[];
  const walk=(dir,rel)=>{
    const parent=path.basename(dir),modules=parent==='node_modules' || (parent.startsWith('@') && path.basename(path.dirname(dir))==='node_modules');
    for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort(byName)) {
      const full=join(dir,e.name),r=rel ? rel+'/'+e.name : e.name;
      if(e.isFile() && e.name==='project.assets.json')
        out.push(r+' '+Object.keys(JSON.parse(fs.readFileSync(full,'utf8')).libraries??{}).sort().join(','));
      if(modules && e.isSymbolicLink()) out.push(r+' -> '+linkTarget(live,full));
      if(!e.isDirectory() || e.name==='.git' || (!rel && OUTSIDE_INSTALL.has(e.name))) continue;
      if(e.name.endsWith('.dist-info')) { out.push(r); continue; }
      if(modules && fs.existsSync(join(full,'package.json'))) {
        const {name,version}=JSON.parse(fs.readFileSync(join(full,'package.json'),'utf8'));
        out.push(r+' '+JSON.stringify([name,version]));
      }
      walk(full,r);
    }
  };
  walk(live,'');
  return hash(out.join('\n'));
}
export const save = (f,v) => fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
export function inside(p) {
  const rel=path.relative(path.resolve(stateRoot),path.resolve(p));
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel),'Outside experiment root');
  for (let cur=path.resolve(p); cur!==path.dirname(cur); cur=path.dirname(cur))
    assert(!fs.lstatSync(cur,{throwIfNoEntry:false})?.isSymbolicLink(),'Linked path '+cur);
  return p;
}
export function copy(src,dst) {
  inside(dst);
  assert(!fs.existsSync(dst),'Occupied destination '+dst);
  fs.cpSync(src,dst,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
}
const names = new Set(['claude.md','claude.local.md','agents.md','agents.override.md','memory.md']);
const memoryPath = rel => names.has(path.posix.basename(rel).toLowerCase()) ||
  rel.toLowerCase().split('/').some(p=>p==='.claude' || p==='.agents');

// Entire config/home is restored, including unknown future memory locations and session history.
export function files(dir,{memoryOnly=false,home=false}={}) {
  const out={};
  function walk(rel) {
    for (const e of fs.readdirSync(join(dir,rel),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const key=rel ? rel+'/'+e.name : e.name;
      if (home && ['tmp','local','roaming'].includes(key)) continue;
      if (memoryOnly && ['.git','.hippo'].includes(e.name)) continue;
      if (e.isSymbolicLink()) {
        if ((!memoryOnly && !home) || memoryPath(key)) throw Error('Linked surface '+key);
        continue;
      }
      if (e.isDirectory()) walk(key);
      else if ((!memoryOnly && !home) || memoryPath(key)) out[key]=hash(fs.readFileSync(join(dir,key)));
    }
  }
  walk('');
  return out;
}
export function externalCheck(work) {
  const paths=['C:/Program Files/ClaudeCode','C:/ProgramData/ClaudeCode'].flatMap(dir=>
    ['CLAUDE.md','managed-settings.json','managed-settings.d'].map(file=>join(dir,file)));
  for (let p=path.dirname(work);;p=path.dirname(p)) {
    for (const f of ['CLAUDE.md','CLAUDE.local.md','AGENTS.md','.claude']) paths.push(join(p,f));
    if (p===path.dirname(p) || (verifying && p===stateRoot)) break;
  }
  for (const f of paths) assert(!fs.existsSync(f),'Uncontrolled external instructions '+f);
}
export function checkProjectSettings(work) {
  for (const name of ['settings.json','settings.local.json']) {
    assert(!fs.lstatSync(join(work,'.claude',name),{throwIfNoEntry:false}),'Uncontrolled project settings: '+name);
  }
}
export function freezeBuiltIn(live,pre) {
  inside(pre); mkdir(pre);
  checkProjectSettings(join(live,'work'));
  const home=files(join(live,'home'),{home:true});
  mkdir(join(pre,'home'));
  for(const f of Object.keys(home)) {
    const dest=join(pre,'home',f); mkdir(path.dirname(dest)); fs.copyFileSync(join(live,'home',f),dest);
  }
  const work=join(live,'work'), repo=files(work,{memoryOnly:true});
  for (const f of Object.keys(repo)) {
    const dest=join(pre,'repo',f); mkdir(path.dirname(dest)); fs.copyFileSync(join(work,f),dest);
    if (/(@(?:[~/.\\]|[\w-]+[./]))/.test(fs.readFileSync(dest,'utf8'))) throw Error('Unresolved instruction import '+f);
  }
  assert.deepEqual(files(join(pre,'home')),home);
  return {repo,home};
}
export function resetBuiltIn(live,pre,expected) {
  externalCheck(join(live,'work'));
  copy(join(pre,'home'),join(live,'home'));
  const work=join(live,'work');
  for (const f of Object.keys(files(work,{memoryOnly:true}))) {
    if (!(f in expected.repo)) fs.unlinkSync(inside(join(work,f)));
  }
  for (const f of Object.keys(expected.repo)) {
    const dest=inside(join(work,f)); mkdir(path.dirname(dest)); fs.copyFileSync(join(pre,'repo',f),dest);
  }
  checkProjectSettings(work);
  const actual={repo:files(work,{memoryOnly:true}),home:files(join(live,'home'),{home:true})};
  assert.deepEqual(actual,expected,'Built-in state differs from pre-teach');
  return hash(JSON.stringify(expected));
}

export function createStore(dst,entries) {
  inside(dst); assert(!fs.existsSync(dst)); mkdir(dst); initStore(dst);
  for (const entry of entries) writeEntry(dst,entry);
}
export function entry(text,session,source) {
  return createMemory(text,{source,sourceSessionId:session,pinned:true,baseHalfLifeDays:DEFAULT_CONFIG.defaultHalfLifeDays},new Date());
}
export function capture(transcript,followup,home,pre,session) {
  const turns=collectSessionTurns(fs.readFileSync(transcript,'utf8'),undefined,{scriptedIsHuman:true});
  const actual=turns.filter(t=>t.role==='user').at(-1)?.text.trim();
  assert.equal(actual,followup.trim(),'Missing teaching turn');
  const rows=extractFromTexts([actual],1,0).map(item=>entry(item.content,session,'capture'));
  const after=files(home,{home:true});
  for (const [key,digest] of Object.entries(after)) {
    if (pre.home[key]===digest || !/\/memory\/.*\.md$/i.test(key)) continue;
    const text=fs.readFileSync(join(home,key),'utf8').trim();
    if (text.length>=3) rows.push(entry(text,session,'note-written'));
  }
  return rows;
}
function neutral(text) {
  const n=Buffer.byteLength(text);
  const words='This repository contains project files. The files are held in a directory. ';
  let line=words.repeat(Math.ceil(n/words.length)).slice(0,n).replace(/\s+\S*$/,'').trimEnd();
  if (line.length<3) line='Git'.slice(0,n);
  return line.padEnd(n,' ');
}
export const contents = dir => loadAllEntries(dir).sort((a,b)=>a.id.localeCompare(b.id));
export function forkStore(snap,baseline,dst,session,arm) {
  const source=contents(snap),old=contents(baseline);
  const targets=source.filter(e=>e.sourceSessionId===session);
  assert.deepEqual(source.filter(e=>e.sourceSessionId!==session),old,'Unattributed teach write');
  if (arm==='N' && targets.length) {
    copy(baseline,dst);
    for (const e of targets) writeEntry(dst,{...e,content:neutral(e.content),sourceSessionId:null,source:'neutral'});
  } else copy(snap,dst);
  return verifyFork(source,dst,session,arm);
}
export function verifyFork(source,dst,session,arm) {
  const targets=source.filter(e=>e.sourceSessionId===session);
  const rows=contents(dst);
  assert.deepEqual(rows.map(e=>e.id),source.map(e=>e.id));
  if (arm==='N') {
    assert(!rows.some(e=>e.sourceSessionId===session));
    for(const file of Object.keys(files(dst))) {
      assert(!fs.readFileSync(join(dst,file)).includes(Buffer.from(session)),'Residual provenance in '+file);
    }
    for (const e of targets) {
      const n=rows.find(r=>r.id===e.id);
      assert.equal(Buffer.byteLength(n.content),Buffer.byteLength(e.content));
      assert.equal(n.content,neutral(e.content));
    }
  } else assert.deepEqual(rows,source);
  return {slotIds:rows.map(e=>e.id),targetCount:targets.length,storeVerified:true};
}
