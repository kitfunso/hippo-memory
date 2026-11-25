import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {root,e1,hash,families,jobs} from './design.mjs';

const {loadRound3,firstApplies,lessonInfo,ARMS,ROOT} = await import(pathToFileURL(e1+'/scripts/load.mjs'));
const {records,filtered}=loadRound3(), info=lessonInfo(records);
const corpus=path.join(root,'corpus');
fs.mkdirSync(corpus,{recursive:true});
function save(name, data) {
  const file=path.join(corpus,name);
  if (fs.existsSync(file)) {
    if (hash(fs.readFileSync(file))!==hash(data)) throw Error('Frozen input changed: '+name);
  } else fs.writeFileSync(file,data,{flag:'wx'});
}
function copyCheck(file, base) {
  const rel=path.relative(base,file), destination=path.join('checks',path.basename(base),rel);
  fs.mkdirSync(path.dirname(path.join(corpus,destination)),{recursive:true});
  const code=fs.readFileSync(file,'utf8');
  save(destination,code);
  for(const m of code.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g))
    copyCheck(path.resolve(path.dirname(file),m[1]),base);
  return destination;
}
const inputFile=path.join(root,'extract-commands.json');
function grade(check,args,commands) {
  fs.writeFileSync(inputFile,JSON.stringify(commands));
  const result=spawnSync(process.execPath,[path.join(corpus,check),...args],{cwd:root,
    env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,CHECK_COMMANDS:inputFile},stdio:'ignore'});
  if (![0,1,3].includes(result.status)) throw Error('Checker error: '+check);
  return result.status;
}
const key=m=>m.filter(x=>x.role==='assistant').flatMap(x=>x.content.filter(b=>b.type==='tool_use').map(b=>b.id)).join('|');
const resultRows=[], excluded={}, inventory={};
function skip(reason){excluded[reason]=(excluded[reason]??0)+1;}
function extract(r) {
  const f=families[r.familyId];
  if (!f) return skip('outside-command-families');
  const lesson=info.get(r.lessons[0].lessonId);
  const check=copyCheck(path.join(lesson.dir,lesson.check.script),lesson.dir);
  const args=lesson.check.args??[];
  const file=path.join(ROOT,'r3run',r._run,'run','raw',r.sequence,r.arm,'seed'+r.seed,r.taskId+'.session1.requests.jsonl');
  let previous=null;
  for (const line of fs.readFileSync(file,'utf8').split('\n')) {
    if(!line.trim()) continue;
    const entry=JSON.parse(line);
    if(!entry.body || !/\/v1\/messages(?:\?|$)/.test(entry.url)) continue;
    const req=JSON.parse(entry.body);
    if(!req.tools?.some(t=>t.name==='Bash') || req.model!==r.model) continue;
    const ms=req.messages, last=ms.findLastIndex(m=>m.role==='assistant');
    const before=previous;
    previous=req;
    if(last<0 || !before || key(ms.slice(0,last))!==key(before.messages)) continue;
    const commands=ms[last].content.filter(b=>b.type==='tool_use' && ['Bash','PowerShell'].includes(b.name)).map(b=>b.input.command);
    if (!commands.some(s=>new RegExp(f[0],'i').test(s))) continue;
    const gradeCode=grade(check,args,commands);
    if (gradeCode===3) continue;
    const evidence={messages:before.messages,system:before.system,tools:before.tools,model:before.model,effort:before.output_config?.effort};
    const serial=JSON.stringify(evidence);
    if (/sk-ant-(?:oat|api)\d{2}-[\w-]{15,}/.test(serial)) throw Error('Credential-shaped corpus input');
    const first=before.messages[0].content;
    const span=Array.isArray(first)?first.flatMap((b,i)=>(b.text??'').split('\n').filter(s=>s.includes(lesson.rule)).map(s=>({text:s,index:i}))):[];
    const remainder=structuredClone(before.messages);
    if(span.length===1) {
      const b=remainder[0].content[span[0].index]; b.text=b.text.replace(span[0].text,'');
    }
    const clean=r.arm==='A4' && span.length===1 && !JSON.stringify(remainder).toLowerCase().includes(f[1].toLowerCase());
    const usage=r.usage.firstSession;
    save(r.sessionId+'.json',serial);
    resultRows.push({sid:r.sessionId,family:r.familyId,arm:r.arm,run:r._run,seed:r.seed,task:r.taskId,
      source:file,sha256:hash(serial),model:r.model,version:r.claudeVersion,pass:r.lessons[0].first==='pass',
      decisionPass:gradeCode===0,realFirst:r.lessons[0].first,check,args,span:span.length===1?span[0]:null,
      clean,rule:lesson.rule,paraphrase:f[2],tokensIn:(usage.inputTokens+usage.cacheWriteTokens+usage.cacheReadTokens)/r.turns,
      tokensOut:usage.outputTokens/r.turns});
    return;
  }
  skip('no-observed-gradable-successor');
}
for(const arm of ARMS) {
  const rows=firstApplies(filtered,arm);
  inventory[arm]=rows.length;
  for(const r of rows) extract(r);
}
save('manifest.json',JSON.stringify(resultRows,null,2));
const report={inventory,excluded,eligible:resultRows.length,clean:resultRows.filter(r=>r.clean).length,
  families:[...new Set(resultRows.map(r=>r.family))],smokeFamily:'gr3-f1',
  historicalDecisionDisagrees:resultRows.filter(r=>r.pass!==r.decisionPass).length,phases:{}};
const byId=new Map(resultRows.map(r=>[r.sid,r]));
for(const phase of ['smoke','gate','treatment']){
  const plan=jobs(resultRows,phase), counts={},usage={};
  for(const j of plan){
    counts[j.arm]=(counts[j.arm]??0)+1;
    const row=byId.get(j.sid), estimate=usage[j.arm]??={input:0,output:0};
    const distractors=Number(/^d(\d+)$/.exec(j.arm)?.[1]??0);
    estimate.input+=row.tokensIn+18*distractors;estimate.output+=row.tokensOut;
  }
  for(const v of Object.values(usage)){v.input=Math.ceil(v.input);v.output=Math.ceil(v.output);}
  save(phase+'.json',JSON.stringify(plan));
  report.phases[phase]={counts,usage};
}
save('inventory.json',JSON.stringify(report,null,2));
const seal={};
for(const name of fs.readdirSync(corpus,{recursive:true}).sort()) {
  const file=path.join(corpus,name);
  if(name!=='seal.json' && fs.statSync(file).isFile()) seal[name]=hash(fs.readFileSync(file));
}
save('seal.json',JSON.stringify(seal,null,2));
console.log(JSON.stringify(report));
