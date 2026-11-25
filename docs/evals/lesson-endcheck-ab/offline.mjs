import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateEnv,run} from './prepare.mjs';
import {upperNet} from './safety.mjs';
import {verifyBoxCheck} from './pins.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));

export async function checkRecovery(root,collect) {
  const base=path.join(root,'recovery'),initial=path.join(base,'initial');
  fs.mkdirSync(initial,{recursive:true});
  const slot=dir=>({dir,work:dir,common:{},env:{LESSON_PRE:'test'},preTree:'same'});
  const assigned={base,slot:slot(initial),arm:'ON',pair:'fixture',seedHash:'frozen',promptText:'same prompt'};
  const launched=[],gated=[],waits=[];
  const dispatch=({id,token,slot,arm,seedHash,intent})=>
    fs.writeFileSync(intent,JSON.stringify({id,tokenVar:token,dir:slot.dir,pre:slot.env.LESSON_PRE,arm,seedHash}),{flag:'wx'});
  const ops={
    launch:args=>{
      dispatch(args);
      const {id,slot:{work}}=args;
      launched.push({id,work});
      if(launched.length===1) {fs.writeFileSync(path.join(work,'dirty'),'limited attempt');return 'LIMITED';}
      assert.equal(fs.existsSync(path.join(work,'dirty')),false);
      return id;
    },
    prepare:(_u,dir)=>slot(dir),gate:s=>gated.push(s.dir),grade:()=>({first:'fail'}),sleep:ms=>waits.push(ms),
  };
  const preStart={...ops,launch:()=>{throw new Error('User credential unavailable');}};
  await assert.rejects(collect({...assigned,pair:'qualify'},preStart),/Schedule paused.*did not start/);
  assert.equal(fs.existsSync(path.join(base,'ON-0.json')),false);
  assert.equal(fs.existsSync(path.join(base,'ON.json')),false);
  gated.length=0;
  const row=await collect(assigned,ops);
  assert.deepEqual(row.row,{first:'fail'});
  assert.deepEqual(await collect(assigned,ops),row);
  assert.deepEqual(gated,launched.map(x=>x.work));
  assert.equal(new Set(launched.map(x=>x.id)).size,2);
  assert.ok(waits.length===1 && waits[0]>0 && waits[0]<=900000);
  const interrupted={...ops,launch:args=>{
    dispatch(args);
    throw new Error('expired token');
  }};
  await assert.rejects(collect({...assigned,arm:'OFF'},interrupted),/Schedule paused.*dispatch unconfirmed/);
  assert.equal(fs.existsSync(path.join(base,'OFF.json')),false);
  assert.equal((await collect({...assigned,arm:'OFF'},ops)).row,null);
  assert.equal(launched.length,2);
  assert.ok(upperNet(129,5,5)<0.05 && upperNet(129,5,0)>0.05);
  const changed=path.join(base,'changed-box.sh');
  fs.writeFileSync(changed,'exit 0\n');
  assert.throws(()=>verifyBoxCheck(changed),/differs from the registered script/);
  const ps=". '"+path.join(here,'limit.ps1').replaceAll("'","''")+"'\n"+
    "if ($SessionTimeoutMs -ne 1800000 -or (Test-SubscriptionLimit $null 'invalid_grant usage limit') "+
    "-or !(Test-SubscriptionLimit $null 'overloaded_error') -or (Test-SubscriptionLimit @{is_error=$false} 'usage limit') "+
    "-or (Test-SubscriptionLimit @{is_error=$true;subtype='error_max_turns'} 'usage limit')) {exit 1}";
  run('powershell.exe',['-NoProfile','-Command',ps],base,privateEnv(base));
  const intent=path.join(base,'preflight.json');
  assert.throws(()=>run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'claude.ps1'),
    '-Mode','apply','-TokenVar','Z0_SUB_TOKEN','-SessionId','00000000-0000-4000-8000-000000000001',
    '-Settings',changed,'-PromptFile',path.join(base,'absent'),'-Arm','ON','-SeedHash','test','-Intent',intent],
    base,privateEnv(base)),e=>String(e.stderr).includes('ReadAllBytes'));
  assert.equal(fs.existsSync(intent),false);
}

export function checkTimeout(root) {
  const dir=path.join(root,'deadline'),env=privateEnv(dir);
  env.LESSON_EVENTS=path.join(dir,'events.jsonl');
  const preload=path.join(dir,'slow.cjs');
  fs.writeFileSync(preload,`const cp=require('node:child_process'),spawn=cp.spawnSync;
require('node:module').registerHooks({resolve(name,context,next){
  if (/(prepare|checks|records)\\.mjs$/.test(name)) throw new Error('unexpected Stop import '+name);
  return next(name,context);
}});
cp.spawnSync=(file,args,opts)=>{
  if(args[1]!=='end-check') throw new Error('unexpected Stop subprocess '+file);
  if(process.env.LESSON_EMPTY_FIXTURE==='1') return {status:0,stdout:''};
  return spawn(process.execPath,['-e',"process.stdout.write('partial');setTimeout(()=>{},60000)"],opts);
};
require('node:module').syncBuiltinESMExports();`);
  const args=['--require',preload,path.join(here,'stop.mjs')];
  const output=run(process.execPath,args,dir,env,{input:'{}'});
  assert.equal(output,'');
  assert.equal(JSON.parse(fs.readFileSync(env.LESSON_EVENTS)).outcome,'production_timeout');
  assert.equal(run(process.execPath,args,dir,{...env,LESSON_EMPTY_FIXTURE:'1'},{input:'{}'}),'');
  const events=fs.readFileSync(env.LESSON_EVENTS,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e=>e.outcome),['production_timeout','completed']);
  assert.equal(events[1].response,'');
}
