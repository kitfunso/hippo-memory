import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { slice,mod } from './slice.mjs';
import { root,roster,read,pins,folder } from './plan.mjs';
import { join,mkdir,contents,forkStore,save,inside,resetBuiltIn } from './state.mjs';
import { launch,openCue } from './delivery.mjs';
import { evidence } from './evidence.mjs';

const u=roster()[0],unit=join(root,'smoke',u.id),pre=join(unit,'pre'),frozen=read(join(unit,'freeze.json'));
const [transport='http',token='Z0_SUB_TOKEN']=process.argv.slice(2);
assert(['command','http'].includes(transport) && token==='Z0_SUB_TOKEN');
const proof=join(unit,transport==='command'?'command-check':'delivery-check'),live=join(proof,'live'),work=join(live,'work');
const previous=fs.readdirSync(unit,{recursive:true}).filter(f=>f.endsWith('.request.json')).length;
assert(previous+2<=20 && !fs.existsSync(proof),'One delivery diagnostic only, within the smoke limit');
fs.mkdirSync(inside(proof));
const results=[];
for(const arm of ['T','N']) {
  mkdir(work);
  // Only the pre-teach instruction bytes and store enter this no-tool delivery probe.
  resetBuiltIn(live,pre,read(join(pre,'manifest.json')));
  const sid=randomUUID(),store=join(work,'.hippo');
  forkStore(join(unit,'snapshot'),join(pre,'store'),store,frozen.teachId,arm);
  const notes=contents(store),cue=transport==='command'?await productionHook():await openCue(work,sid);
  try {
    save(join(live,'settings.json'),{autoMemoryEnabled:true,autoMemoryDirectory:join(live,'home/.claude/projects/unit/memory'),
      hooks:{UserPromptSubmit:[{hooks:[cue.hook]}]}});
    const prompt='Reply OK.';
    await launch(live,token,process.env,{id:'probe',session:sid,smoke:true,diagnostic:true,
      prompt,model:pins.modelOpus,effort:pins.effort,toolchain:u.toolchain});
    const result=evidence(join(live,'wire','probe'),read(join(live,'probe.json')),notes,u.lesson,{prompt},
      join(live,'home/.claude/projects/unit',sid+'.jsonl'));
    if(transport==='command') {
      const output=join(live,'command-output.json');
      result.commandExit=fs.existsSync(join(live,'command-exit'))?Number(fs.readFileSync(join(live,'command-exit'),'utf8')):null;
      const context=fs.existsSync(output) && fs.readFileSync(output,'utf8').trim()
        ? read(output).hookSpecificOutput?.additionalContext : null;
      result.commandNotes=context?notes.filter(n=>context.includes(n.content.trim())).length:0;
    }
    results.push({arm,...result}); save(join(live,'delivery.json'),result);
  } finally { await cue.close(); }
  fs.renameSync(inside(live),inside(join(proof,arm)));
}
console.log(JSON.stringify({previous,results}));
assert(results.every(r=>r.requests===1 && r.complete && r.hookSeen && r.targetText===(r.arm==='T')),'Delivery gate failed');

async function productionHook() {
  const {HIPPO_PINNED_INJECT_COMMAND:command}=await mod('surface/hooks-install/rules/shared');
  // Preserve installer flags and stdout while recording whether the pinned CLI completed.
  const shellPath=p=>'"'+p.replaceAll('\\','/')+'"';
  const invoke=command.replace(/^hippo /,shellPath(process.execPath)+' '+shellPath(join(slice,'bin/hippo.js'))+' ');
  const output=shellPath(join(live,'command-output.json')),status=shellPath(join(live,'command-exit'));
  return {hook:{type:'command',timeout:5,command:`unset CLAUDE_CODE_OAUTH_TOKEN; ${invoke} > ${output}; rc=$?; echo "$rc" > ${status}; cat ${output}; exit "$rc"`},
    close:async()=>{}};
}
