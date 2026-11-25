import fs from 'node:fs';
import path from 'node:path';
import { read,root } from './plan.mjs';
import { findTranscript } from '../../../scripts/token-eval/records.mjs';

const GATED_TOOLS=new Set(['Edit','Write','MultiEdit','NotebookEdit','Bash','PowerShell','Read','Glob','Grep']);
const MAIN_SOURCE='sdk';
const rowsOf=file=>fs.readFileSync(file,'utf8').split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
const promptText=content=>typeof content==='string' ? content :
  Array.isArray(content) ? content.filter(b=>b.type==='text').map(b=>b.text).join('') : null;
export const wellFormedDenials=denials=>Array.isArray(denials) &&
  denials.every(d=>d && typeof d.tool==='string' && d.tool && typeof d.id==='string' && d.id);
export const cleanDenials=denials=>wellFormedDenials(denials) && !denials.some(d=>GATED_TOOLS.has(d.tool));
export function permissionAudit(transcript,prompt,denials) {
  const rows=rowsOf(transcript);
  const modes=[...new Set(rows.map(r=>r.permissionMode).filter(Boolean))];
  const promptRows=rows.filter(r=>r.type==='user' && promptText(r.message?.content)===prompt);
  const promptMode=promptRows.at(-1)?.permissionMode ?? null;
  const denied=wellFormedDenials(denials) ? denials.filter(d=>GATED_TOOLS.has(d.tool)).map(d=>d.tool) : null;
  const ok=modes.length>0 && modes.every(m=>m==='bypassPermissions') && promptMode==='bypassPermissions' &&
    Array.isArray(denied) && denied.length===0;
  return {ok,modes,promptMode,denied};
}
const mainTurns=transcript=>rowsOf(transcript).filter(r=>r.type==='assistant' && !r.isSidechain &&
  !r.isApiErrorMessage && r.message?.model!=='<synthetic>');
export function mainPairs(transcript) {
  const pairs=[];
  for(const r of mainTurns(transcript)) {
    if(!r.requestId || !r.message?.id) return null;
    const key=r.requestId+'\n'+r.message.id;
    if(pairs.at(-1)===key) continue;
    if(pairs.includes(key)) return null;
    pairs.push(key);
  }
  return pairs;
}
const pairOf=r=>r.request_id+'\n'+r.message_id;
function reconciled(main,transcript) {
  if(!transcript || !fs.existsSync(transcript) || !main.length) return false;
  const pairs=mainPairs(transcript),sent=main.map(pairOf);
  return !!pairs && new Set(sent).size===sent.length && sent.length===pairs.length && sent.every((k,i)=>k===pairs[i]);
}
export const normalize=s=>s.replace(/\s+/g,' ').trim().toLowerCase();
export const flagOf=(u,verdict,commands)=>u.cls==='variant' ?
  verdict==='fail' && commands.some(c=>normalize(c).includes(normalize(u.lesson.keyPhrase))) : null;
const textBlocks=value=>typeof value==='string' ? [value] :
  (value??[]).filter(x=>x.type==='text').map(x=>x.text);
const hook=/UserPromptSubmit hook (?:additional )?context:\s*/i;
const instruction=/(?:^|\/)(?:\.hippo|\.claude|\.agents|claude(?:\.local)?\.md|agents(?:\.override)?\.md|memory\.md|\.git\/config|managed-settings(?:\.json|\.d))(?=$|\/)/i;
function sensitivePath(value,work) {
  if(!value) return false;
  const p=path.win32.resolve(work,value).replaceAll('\\','/').toLowerCase();
  const base=work.replaceAll('\\','/').toLowerCase();
  if(p===base || p.startsWith(base+'/')) return instruction.test(p.slice(base.length));
  return instruction.test(p) || p.startsWith(root.toLowerCase()+'/') || p.includes('/z0-runs/r4/tasks/');
}
function readsDelivery(tool,work) {
  const input=tool.input??{};
  if(['Read','Grep','Glob','LS'].includes(tool.name))
    return [input.file_path,input.path,input.glob,tool.name==='Glob' && input.pattern].some(v=>sensitivePath(v,work));
  if(!['Bash','PowerShell'].includes(tool.name)) return false;
  return (input.command??'').split(/[|;&\n]+/).some(command=>{
    const words=command.trim().match(/"[^"]*"|'[^']*'|[^\s]+/g)??[];
    if(/^hippo$/i.test(words[0]) && /^(context|recall|show)$/i.test(words[1])) return true;
    return /^(cat|type|more|head|tail|sed|awk|rg|grep|sqlite3|readfile|get-content|gc)$/i.test(words[0]) &&
      words.slice(1).some(w=>sensitivePath(w.replace(/^["']|["']$/g,''),work));
  });
}

export function deliverySurfaces(body,task={}) {
  const system=textBlocks(body.system), prompt=[], results=[], tools=new Map();
  const work=task.work??root+'/active/live/work';
  let assistant=false;
  for(const message of body.messages) {
    const content=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content;
    if(message.role==='assistant') {
      assistant=true;
      for(const tool of content) if(tool.type==='tool_use') tools.set(tool.id,tool);
    } else if(message.role==='system') system.push(...textBlocks(content));
    else if(message.role==='user') for(const block of content) {
      if(block.type==='tool_result') {
        const tool=tools.get(block.tool_use_id), output=textBlocks(block.content);
        if(tool && readsDelivery(tool,work)) results.push(...output);
        else if(tool?.name==='Grep' || (tool?.name==='Bash' && /^\s*(?:rg|grep)\s/.test(tool.input?.command??''))) {
          for(const line of output.flatMap(s=>s.split(/\r?\n/))) {
            const hit=/^((?:[a-z]:[\\/])?[^:\r\n]+):(?:\d+:)?(.*)$/i.exec(line);
            if(hit && sensitivePath(hit[1],work)) results.push(hit[2]);
          }
        }
      }
      if(block.type==='text' && !assistant) prompt.push(block.text);
      else if(block.type==='text' && /^<system-reminder>\s*UserPromptSubmit hook/i.test(block.text)) system.push(block.text);
    }
  }
  return {system,prompt,results};
}

function finalMessageMatches(file,row,result) {
  if(!file || result.exit!==0 || result.isError!==false || result.subtype!=='success' ||
    !row.request_id || !row.message_id || !row.message_uuid || row.response_file!==row.request_id+'.response.json' ||
    path.basename(file)!==result.session+'.jsonl' || !fs.existsSync(file)) return false;
  const transcript=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const last=transcript.filter(r=>r.type==='assistant').at(-1),m=last?.message;
  return last?.sessionId===result.session && last.requestId===row.request_id && last.uuid===row.message_uuid &&
    m?.id===row.message_id && m.type==='message' && m.role==='assistant' && m.stop_reason==='end_turn' &&
    m.usage?.output_tokens>0 && Array.isArray(m.content) &&
    m.content.some(b=>b.type==='text' && typeof b.text==='string' && b.text.trim());
}

const indexRows=dir=>{
  const index=path.join(dir,'index.jsonl');
  return fs.existsSync(index)?rowsOf(index):[];
};
const requestNames=dir=>fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.request.json')):[];
const ownFile=name=>typeof name==='string' && path.basename(name)===name;

export function evidence(dir,result,notes,lesson,task={},transcript) {
  const names=requestNames(dir),rows=indexRows(dir);
  const indexed=new Set(rows.map(r=>r.request_file));
  const main=rows.filter(r=>r.query_source===MAIN_SOURCE),side=rows.filter(r=>r.query_source!==MAIN_SOURCE);
  let transcriptResponse;
  const complete=names.length>0 && names.length===rows.length && indexed.size===rows.length && names.every(n=>indexed.has(n)) &&
    rows.every(r=>typeof r.query_source==='string' && /^[a-z_:]+$/.test(r.query_source) &&
      r.session_id===result.session && ownFile(r.request_file) && ownFile(r.response_file)) &&
    main.every((r,i)=>{
      const raw=fs.readFileSync(path.join(dir,r.response_file));
      if(raw.length) return JSON.parse(raw).id===r.message_id;
      if(i!==main.length-1 || !finalMessageMatches(transcript,r,result)) return false;
      transcriptResponse=r.request_id;
      return true;
    });
  const bodyOf=r=>names.includes(r.request_file)?read(path.join(dir,r.request_file)):{};
  const mainBodies=main.map(bodyOf),bodies=[...mainBodies,...side.map(bodyOf)];
  const surfaces=bodies.filter(valid).map(b=>deliverySurfaces(b,task));
  const block=normalize('Project notes\n'+notes.map(e=>'- '+e.content).join('\n'));
  const first=valid(mainBodies[0]??{}) ? deliverySurfaces(mainBodies[0],task) : null;
  const hookSeen=!!first && [...first.system,...first.prompt].some(s=>s!==task.prompt && hook.test(s) &&
    normalize(s.split(hook).slice(1).join(' ')).includes(block));
  return {requests:bodies.length,sideRequests:side.length,
    complete:!!complete && bodies.every(valid) && reconciled(main,transcript),hookSeen,
    targetText:targetIn(surfaces,lesson,task),...(transcriptResponse && {transcriptResponse})};
}

const valid=b=>Array.isArray(b?.messages) && !!b.system && !b.not_recorded;
function targetIn(surfaces,lesson,task) {
  const target=(s,allow=false)=>normalize(s).includes(normalize(lesson.rule)) ||
    (!allow && normalize(s).includes(normalize(lesson.keyPhrase)));
  return surfaces.some(({system,prompt,results})=>
    [...system,...results].some(s=>target(s)) || prompt.some(s=>target(s,task.keyPhraseAllowed && s===task.prompt)));
}

function archivedAttempt(live,id,sid,lesson,task) {
  const operator=path.join(path.dirname(live),'operator'),dir=path.join(operator,'bodies',id);
  const transcript=findTranscript(path.join(live,'home/.claude/projects'),sid);
  const pairs=transcript?mainPairs(transcript):[];
  const names=requestNames(dir),rows=indexRows(dir),record=path.join(operator,id+'.json');
  const deniedOk=!fs.existsSync(record) || cleanDenials(read(record).permissionDenials);
  const modes=transcript?rowsOf(transcript).map(r=>r.permissionMode).filter(Boolean):[];
  const permissions=deniedOk && modes.every(m=>m==='bypassPermissions');
  if(!names.length && !rows.length && pairs && !pairs.length) return {status:'refused',target:false,permissions};
  const bodies=names.map(n=>read(path.join(dir,n))),sent=new Set(rows.map(pairOf));
  const inspectable=!!pairs && !!transcript && names.length>0 && bodies.every(valid) &&
    rows.every(r=>names.includes(r.request_file) && r.session_id===sid) && pairs.every(p=>sent.has(p));
  return {status:inspectable?'dispatched':'unauditable',
    target:inspectable && targetIn(bodies.map(b=>deliverySurfaces(b,task)),lesson,task),permissions};
}

export function archivedAudit(archives,id,sid,lesson,task) {
  const attempts=archives.map(live=>archivedAttempt(live,id,sid,lesson,task));
  const count=status=>attempts.filter(a=>a.status===status).length;
  return {archivedAttempts:attempts.length,archivedRefused:count('refused'),archivedUnauditable:count('unauditable'),
    archivedTargetText:attempts.some(a=>a.target),archivedPermissions:attempts.every(a=>a.permissions)};
}
export const neutralClean=r=>r.targetText===false && r.archivedTargetText===false && r.archivedUnauditable===0;
