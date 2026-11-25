import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { findTranscript,listTranscripts } from '../../../scripts/token-eval/records.mjs';
import { APPARATUS,read,hash,pins } from './plan.mjs';
import { files,inside,join,mkdir,stateRoot } from './state.mjs';

function readFreeze(unit) {
  const freeze=read(inside(join(unit,'freeze.json')));
  const expected=read(inside(join(unit,'pre/manifest.json')));
  assert.equal(hash(JSON.stringify(expected)),freeze.preHash,'Pre-teach manifest changed');
  assert.equal(freeze.apparatus,APPARATUS,'Teach freeze from another apparatus');
  return {...freeze,expected};
}

export async function applyFrozen(unit,order,apply,freeze=readFreeze(unit)) {
  for(const [index,arm] of order.entries()) await apply(arm,index,freeze);
}

function checkArchivedAttempts(u) {
  const archives=inside(join(stateRoot,'limit-archives'));
  for(const name of fs.readdirSync(archives)) {
    const operator=inside(join(archives,name,'operator')),callFile=join(operator,'call.json');
    if(!fs.existsSync(callFile)) continue;
    const owner=join(operator,'owner.json');
    if(fs.existsSync(owner)) {
      if(read(owner).unit===u.id) assert.notEqual(read(callFile).id,'apply','Archived apply already started');
    } else {
      const base=inside(join(archives,name,'live/work/.git/shallow'));
      if(!fs.existsSync(base) || fs.readFileSync(base,'utf8').trim()!==u.apply.baseRef) continue;
      const call=read(callFile);
      assert(call.id!=='apply' || call.prompt!==u.apply.prompt,'Archived apply matches the task');
    }
  }
}

export function checkContinuation(design) {
  const u=design.unit,unit=inside(join(stateRoot,'unit',u.id));
  assert.deepEqual(read(inside(join(unit,'design.json'))),design,'Scored design changed');
  const freeze=readFreeze(unit);
  for(const part of ['home','repo']) {
    const src=inside(join(unit,'pre',part));
    const saved=part==='repo' && !fs.existsSync(src) ? {} : files(src);
    assert.deepEqual(saved,freeze.expected[part],'Pre-teach '+part+' changed');
  }
  assert.equal(hash(JSON.stringify(files(inside(join(unit,'snapshot'))))),freeze.snapshotHash,'Frozen snapshot changed');
  assert(fs.statSync(inside(join(unit,'pre/store/hippo.db'))).isFile(),'Missing pre-teach store');
  assert.deepEqual(fs.readdirSync(inside(join(unit,'evidence'))),['teach'],'Apply evidence or intent already exists');
  const teach=inside(join(unit,'evidence/teach'));
  assert(freeze.teachId && findTranscript(join(teach,'home/.claude/projects'),freeze.teachId),'Missing teach transcript');
  for(const id of ['teach','feedback']) {
    const r=read(inside(join(teach,'operator',id+'.json')));
    assert(r.session===freeze.teachId && r.exit===0 && r.isError===false && r.apparatus===APPARATUS,'Invalid frozen teach receipt: '+id);
  }
  checkArchivedAttempts(u);
  const active=inside(join(stateRoot,'active')),live=inside(join(active,'live')),operator=inside(join(active,'operator'));
  if(!fs.existsSync(live) && !fs.existsSync(operator)) return {unit,freeze};
  const records=fs.readdirSync(operator);
  assert(records.every(n=>n==='owner.json' || n==='setup.json'),'Apply intent, result or other operator evidence exists');
  if(records.includes('owner.json')) {
    assert.deepEqual(read(join(operator,'owner.json')),{unit:u.id,task:u.apply.id},'Different active task');
  } else {
    assert.equal(fs.readFileSync(inside(join(live,'work/.git/HEAD')),'utf8').trim(),u.apply.baseRef,'Different active base');
    assert.deepEqual(read(join(operator,'setup.json')),
      {toolchain:u.toolchain,setup:u.apply.setup,constraintHash:pins['sha256:pip-constraint']},'Different active setup');
  }
  assert(fs.statSync(live).isDirectory(),'Missing active tree');
  assert.equal(listTranscripts(inside(join(live,'home/.claude/projects'))).length,0,'Apply transcript already exists');
  return {unit,freeze,active};
}

export async function continueUnit(design,apply) {
  const {unit,freeze,active}=checkContinuation(design);
  if(active) {
    const archive=inside(join(unit,'interrupted-'+randomUUID()));
    fs.renameSync(active,archive);
    console.log('Archived interrupted setup at '+archive);
  }
  mkdir(inside(join(stateRoot,'active')));
  await applyFrozen(unit,design.unit.order,apply,freeze);
}
