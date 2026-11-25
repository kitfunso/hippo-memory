import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateEnv,run} from './prepare.mjs';
import {upperNet} from './safety.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));

export async function checkRecovery(root,collect) {
  const base=path.join(root,'recovery'),initial=path.join(base,'initial');
  fs.mkdirSync(initial,{recursive:true});
  const slot=dir=>({dir,work:dir,common:{},env:{LESSON_PRE:'test'},preTree:'same'});
  const assigned={base,slot:slot(initial),arm:'ON',pair:'fixture',seedHash:'frozen',promptText:'same prompt'};
  const launched=[],gated=[],waits=[];
  const ops={
    launch:(id,_token,_settings,work)=>{
      launched.push({id,work});
      if(launched.length===1) {fs.writeFileSync(path.join(work,'dirty'),'limited attempt');return 'LIMITED';}
      assert.equal(fs.existsSync(path.join(work,'dirty')),false);
      return id;
    },
    prepare:(_u,dir)=>slot(dir),gate:s=>gated.push(s.dir),grade:()=>({first:'fail'}),sleep:ms=>waits.push(ms),
  };
  const row=await collect(assigned,ops);
  assert.deepEqual(row.row,{first:'fail'});
  assert.deepEqual(await collect(assigned,ops),row);
  assert.deepEqual(gated,launched.map(x=>x.work));
  assert.equal(new Set(launched.map(x=>x.id)).size,2);
  assert.ok(waits.length===1 && waits[0]>0 && waits[0]<=900000);
  fs.writeFileSync(path.join(base,'OFF-0.json'),JSON.stringify({dir:initial,id:'lost',pre:'test'}));
  assert.equal((await collect({...assigned,arm:'OFF'},ops)).row,null);
  assert.equal(launched.length,2);
  assert.ok(upperNet(129,5,5)<0.05 && upperNet(129,5,0)>0.05);
  const ps=". '"+path.join(here,'limit.ps1').replaceAll("'","''")+"'\n"+
    "if (!(Test-SubscriptionLimit $null 'overloaded_error') -or (Test-SubscriptionLimit @{is_error=$false} 'usage limit') "+
    "-or (Test-SubscriptionLimit @{is_error=$true;subtype='error_max_turns'} 'usage limit')) {exit 1}";
  run('powershell.exe',['-NoProfile','-Command',ps],base,privateEnv(base));
}

export function checkTimeout(root) {
  const dir=path.join(root,'deadline'),env=privateEnv(dir);
  env.LESSON_EVENTS=path.join(dir,'events.jsonl');
  const preload=path.join(dir,'slow.cjs');
  fs.writeFileSync(preload,`const cp=require('node:child_process'),spawn=cp.spawnSync;
cp.spawnSync=(file,args,opts)=>args[1]==='end-check'
  ? spawn(process.execPath,['-e',"process.stdout.write('partial');setTimeout(()=>{},60000)"],opts)
  : spawn(file,args,opts);
require('node:module').syncBuiltinESMExports();`);
  const output=run(process.execPath,['--require',preload,path.join(here,'stop.mjs')],dir,env,{input:'{}'});
  assert.equal(output,'');
  assert.equal(JSON.parse(fs.readFileSync(env.LESSON_EVENTS)).outcome,'production_timeout');
}
