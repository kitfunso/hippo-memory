import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { root,roster,read,pins } from './plan.mjs';
import { join,mkdir,contents,forkStore,save,inside,resetBuiltIn } from './state.mjs';
import { launch,openCue } from './delivery.mjs';
import { evidence,smokeClean } from './evidence.mjs';

const u=roster()[0],unit=join(root,'smoke',u.id),pre=join(unit,'pre'),frozen=read(join(unit,'freeze.json'));
const [token='Z0_SUB_TOKEN']=process.argv.slice(2);
assert.equal(token,'Z0_SUB_TOKEN','Usage: node wire-smoke.mjs [Z0_SUB_TOKEN]');
const proof=join(root,'wire-smoke'),live=join(proof,'live'),work=join(live,'work');
assert(!fs.existsSync(proof),'One wire smoke only; '+proof+' exists');
fs.mkdirSync(inside(proof));
const results=[];
for(const arm of ['T','N']) {
  mkdir(work);
  resetBuiltIn(live,pre,read(join(pre,'manifest.json')));
  const sid=randomUUID(),store=join(work,'.hippo');
  forkStore(join(unit,'snapshot'),join(pre,'store'),store,frozen.teachId,arm);
  const notes=contents(store),cue=await openCue(work,sid);
  try {
    save(join(live,'settings.json'),{autoMemoryEnabled:true,autoMemoryDirectory:join(live,'home/.claude/projects/unit/memory'),
      hooks:{UserPromptSubmit:[{hooks:[cue.hook]}]}});
    const prompt='Reply OK.';
    await launch(live,token,process.env,{id:'probe',session:sid,smoke:true,diagnostic:true,
      prompt,model:pins.modelOpus,effort:pins.effort,toolchain:u.toolchain});
    const result=evidence(join(live,'wire','probe'),read(join(live,'probe.json')),notes,u.lesson,{prompt},
      join(live,'home/.claude/projects/unit',sid+'.jsonl'));
    results.push({arm,...result}); save(join(live,'delivery.json'),result);
  } finally { await cue.close(); }
  fs.renameSync(inside(live),inside(join(proof,arm)));
}
console.log(JSON.stringify(results));
assert(results.every(r=>smokeClean(r) && !r.wireHosts.length),
  'Wire smoke failed');
