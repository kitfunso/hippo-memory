import fs from 'node:fs';
import path from 'node:path';
import { read,root } from './plan.mjs';

export const normalize=s=>s.replace(/\s+/g,' ').trim().toLowerCase();
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

export function evidence(dir,result,notes,lesson,task={},transcript) {
  const names=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.request.json')):[];
  const index=path.join(dir,'index.jsonl');
  const rows=fs.existsSync(index)?fs.readFileSync(index,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  const indexed=new Set(rows.map(r=>r.request_file));
  let transcriptResponse;
  const complete=names.length>0 && names.length===rows.length && names.every(n=>indexed.has(n)) &&
    rows.every((r,i)=>{
      if(r.session_id!==result.session || path.basename(r.response_file)!==r.response_file) return false;
      const raw=fs.readFileSync(path.join(dir,r.response_file));
      if(raw.length) return JSON.parse(raw).id===r.message_id;
      if(i!==rows.length-1 || !finalMessageMatches(transcript,r,result)) return false;
      transcriptResponse=r.request_id;
      return true;
    });
  const bodies=rows.filter(r=>names.includes(r.request_file)).map(r=>read(path.join(dir,r.request_file)));
  const valid=b=>Array.isArray(b.messages) && b.system && !b.not_recorded;
  const surfaces=bodies.filter(valid).map(b=>deliverySurfaces(b,task));
  const block=normalize('Project notes\n'+notes.map(e=>'- '+e.content).join('\n'));
  const target=(s,allow=false)=>normalize(s).includes(normalize(lesson.rule)) ||
    (!allow && normalize(s).includes(normalize(lesson.keyPhrase)));
  const targetText=surfaces.some(({system,prompt,results})=>
    [...system,...results].some(s=>target(s)) || prompt.some(s=>target(s,task.keyPhraseAllowed && s===task.prompt)));
  const first=surfaces[0];
  const hookSeen=!!first && [...first.system,...first.prompt].some(s=>s!==task.prompt && hook.test(s) &&
    normalize(s.split(hook).slice(1).join(' ')).includes(block));
  return {requests:bodies.length,complete:!!complete && bodies.every(valid),hookSeen,targetText,
    ...(transcriptResponse && {transcriptResponse})};
}
