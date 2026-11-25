import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { root,roster,read,pins } from './plan.mjs';
import { join,mkdir,contents,forkStore,save,inside,resetBuiltIn } from './state.mjs';
import { launch,openCue } from './delivery.mjs';
import { evidence } from './evidence.mjs';

const u=roster()[0],unit=join(root,'smoke',u.id),pre=join(unit,'pre'),frozen=read(join(unit,'freeze.json'));
const proof=join(unit,'delivery-check'),live=join(proof,'live'),work=join(live,'work');
const previous=fs.readdirSync(join(unit,'evidence'),{recursive:true}).filter(f=>f.endsWith('.request.json')).length;
assert(previous+2<=20 && !fs.existsSync(proof),'One delivery diagnostic only, within the smoke limit');
fs.mkdirSync(inside(proof));
const results=[];
for(const arm of ['T','N']) {
  mkdir(work);
  // Only the pre-teach instruction bytes and store enter this no-tool delivery probe.
  resetBuiltIn(live,pre,read(join(pre,'manifest.json')));
  const sid=randomUUID(),store=join(work,'.hippo');
  forkStore(join(unit,'snapshot'),join(pre,'store'),store,frozen.teachId,arm);
  const notes=contents(store),cue=await openCue(work,sid);
  try {
    save(join(live,'settings.json'),{autoMemoryEnabled:true,autoMemoryDirectory:join(live,'home/.claude/projects/unit/memory'),
      hooks:{UserPromptSubmit:[{hooks:[cue.hook]}]}});
    save(join(live,'call.json'),{id:'probe',session:sid,smoke:true,diagnostic:true,
      prompt:'Reply OK.',model:pins.modelOpus,effort:pins.effort,toolchain:u.toolchain});
    await launch(live,'Z0_SUB_TOKEN',process.env);
    const result=evidence(join(live,'bodies/probe'),read(join(live,'probe.json')),notes,u.lesson);
    results.push({arm,...result}); save(join(live,'delivery.json'),result);
  } finally { await cue.close(); }
  fs.renameSync(inside(live),inside(join(proof,arm)));
}
console.log(JSON.stringify({previous,results}));
assert(results.every(r=>r.requests===1 && r.complete && r.hookSeen && r.targetText===(r.arm==='T')),'Delivery gate failed');
