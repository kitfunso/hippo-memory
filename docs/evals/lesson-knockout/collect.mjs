import './local-stdio.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { APPARATUS,checkedRoster,folder,read,root } from './plan.mjs';
import { checkTeachReceipts } from './continuation.mjs';
import { neutralClean } from './evidence.mjs';

const count=n=>Number.isInteger(n) && n>=0;
function complete(dir,u) {
  const grades=u.order.map((_,i)=>path.join(dir,'evidence','apply-'+i,'grade.json'));
  if(!grades.every(f=>fs.existsSync(f))) return false;
  const freeze=read(path.join(dir,'freeze.json')),sessions=new Set([freeze.teachId]),trees=new Set();
  assert(freeze.apparatus===APPARATUS,'Teach freeze from another apparatus '+dir);
  checkTeachReceipts(dir,freeze,u);
  for(const [i,f] of grades.entries()) {
    const r=read(f);
    assert(r.id===u.id && r.repo===u.repo && r.arm===u.order[i] && r.mode==='unit' && r.apparatus===APPARATUS &&
      ['pass','fail','na'].includes(r.verdict) && r.session && !sessions.has(r.session) &&
      r.teachId===freeze.teachId && r.snapshotHash===freeze.snapshotHash && r.resetHash===freeze.preHash &&
      r.targetCount===freeze.targetRows.length && r.storeVerified===true && r.complete===true &&
      r.requests>0 && count(r.sideRequests) && typeof r.hookSeen==='boolean' && typeof r.targetText==='boolean' &&
      typeof r.archivedTargetText==='boolean' && count(r.archivedAttempts) && count(r.archivedRefused) &&
      count(r.archivedUnauditable) && r.archivedPermissions===true &&
      /^[0-9a-f]{40}$/.test(r.preTree) && /^[0-9a-f]{64}$/.test(r.ignoredSetup) &&
      (r.arm!=='N' || neutralClean(r)) && r.pathAudit?.transcripts>0 && Array.isArray(r.pathAudit.hits),
    'Invalid scored receipt '+f);
    sessions.add(r.session);
    trees.add(r.preTree+' '+r.ignoredSetup);
  }
  assert.equal(trees.size,1,'Apply arms started from different work trees '+dir);
  return true;
}

export function collectRemaining(units,unitRoot,token,launch) {
  for(const u of units) {
    const dir=path.join(unitRoot,u.id);
    if(complete(dir,u)) continue;
    launch(u.id,token,fs.existsSync(dir));
    assert(complete(dir,u),'Unit returned without complete evidence: '+u.id);
  }
}

function launchUnit(id,token,continuation) {
  const args=[path.join(folder,'run.mjs'),'unit',id,token];
  if(continuation) args.push('frozen-apply');
  const env={...process.env,KNOCKOUT_SLICE_ROOT:process.env.KNOCKOUT_SLICE_ROOT ??
    path.resolve(folder,'../../../../wt-slice1')};
  execFileSync(process.execPath,args,{cwd:folder,env,stdio:'inherit',windowsHide:true});
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,...args]=process.argv.slice(2),token=args.at(-1);
  if(mode==='finish' && args.length===1 && args[0]==='q145-f1') {
    process.env.KNOCKOUT_SLICE_ROOT??=path.resolve(folder,'../../../../wt-slice1');
    const {finishQ145}=await import('./finish-q145.mjs');
    await finishQ145();
  } else {
    assert(/^Z0_SUB_TOKEN(?:_[123])?$/.test(token),'Expected a subscription token variable name');
    if(mode==='remaining' && args.length===1) collectRemaining(checkedRoster(),path.join(root,'unit'),token,launchUnit);
    else if(mode==='continue' && args.length===2) launchUnit(args[0],token,true);
    else throw Error('Usage: collect.mjs finish q145-f1 | continue FAMILY TOKEN_VAR | remaining TOKEN_VAR');
  }
}
