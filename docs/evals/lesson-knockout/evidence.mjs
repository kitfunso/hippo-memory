import fs from 'node:fs';
import path from 'node:path';
import { APPARATUS,hash,read,root } from './plan.mjs';
import { listTranscripts } from '../../../scripts/token-eval/records.mjs';

const GATED_TOOLS=new Set(['Edit','Write','MultiEdit','NotebookEdit','Bash','PowerShell','Read','Glob','Grep']);
const rowsOf=file=>fs.readFileSync(file,'utf8').split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
const promptText=content=>typeof content==='string' ? content :
  Array.isArray(content) ? content.filter(b=>b.type==='text').map(b=>b.text).join('') : null;
export const wellFormedDenials=denials=>Array.isArray(denials) &&
  denials.every(d=>d && typeof d.tool==='string' && d.tool && typeof d.id==='string' && d.id);
export const cleanDenials=denials=>wellFormedDenials(denials) && !denials.some(d=>GATED_TOOLS.has(d.tool));
const promptStart=(rows,prompt)=>rows.findLastIndex(r=>r.type==='user' && promptText(r.message?.content)===prompt);
export function permissionAudit(transcript,prompt,denials) {
  const rows=rowsOf(transcript),start=promptStart(rows,prompt);
  const modes=[...new Set(rows.slice(Math.max(start,0)).map(r=>r.permissionMode).filter(Boolean))];
  const promptMode=start<0 ? null : rows[start].permissionMode ?? null;
  const denied=wellFormedDenials(denials) ? denials.filter(d=>GATED_TOOLS.has(d.tool)).map(d=>d.tool) : null;
  const ok=start>=0 && modes.length>0 && modes.every(m=>m==='bypassPermissions') && promptMode==='bypassPermissions' &&
    Array.isArray(denied) && denied.length===0;
  return {ok,modes,promptMode,denied};
}
function pairsOf(rows) {
  const pairs=[];
  for(const r of rows) {
    if(r.type!=='assistant' || r.isSidechain || r.isApiErrorMessage || r.message?.model==='<synthetic>') continue;
    if(!r.requestId || !r.message?.id) return null;
    const key=r.requestId+'\n'+r.message.id;
    if(pairs.at(-1)===key) continue;
    if(pairs.includes(key)) return null;
    pairs.push(key);
  }
  return pairs;
}
export const mainPairs=transcript=>pairsOf(rowsOf(transcript));
const pairOf=r=>r.request_id+'\n'+r.message_id;

export const sourceKind=s=>typeof s!=='string' || !s ? null :
  s.startsWith('repl_main_thread') || s==='sdk' ? 'main' : s.startsWith('agent:') || s==='hook_agent' ? 'subagent' : 'auxiliary';
const replayed=s=>['main','subagent'].includes(sourceKind(s));
export function sessionInventory(projects,sid) {
  const files=listTranscripts(projects).map(f=>path.resolve(f)).sort();
  const parts=f=>path.relative(path.resolve(projects),f).split(path.sep);
  const mains=files.filter(f=>{ const p=parts(f); return p.length===2 && p[1]===sid+'.jsonl'; });
  const subs=files.filter(f=>{ const p=parts(f); return p.length===4 && p[1]===sid && p[2]==='subagents'; });
  return {main:mains.length===1?mains[0]:null,subs,files};
}
const apiRows=rows=>rows.filter(r=>r.type==='api-request');
function callRows(inventory,prompt) {
  if(!inventory?.main) return null;
  const rows=rowsOf(inventory.main),start=promptStart(rows,prompt);
  if(start<0 || typeof rows[start].timestamp!=='string') return null;
  const since=rows[start].timestamp,sub=apiRows(inventory.subs.flatMap(rowsOf));
  if(sub.some(r=>typeof r.timestamp!=='string')) return null;
  return {rows:rows.slice(start),sub:sub.filter(r=>r.timestamp>=since),chain:[...apiRows(rows),...sub]};
}
const canon=v=>v===null || typeof v!=='object' ? JSON.stringify(v)??'null' :
  Array.isArray(v) ? '['+v.map(canon).join(',')+']' :
  '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined && k!=='cache_control').map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
const billing=b=>typeof b?.text==='string' && b.text.startsWith('x-anthropic-billing-header:');
export const shapeOf=body=>{
  const system=Array.isArray(body.system)?body.system.filter(b=>!billing(b)):body.system;
  return hash(canon({...(system!==undefined && {system}),...(body.tools!==undefined && {tools:body.tools})}));
};
const unredacted=m=>m.role==='assistant' && Array.isArray(m.content) ?
  {...m,content:m.content.map(b=>b.type==='thinking' && b.thinking==='<REDACTED>' ? {...b,thinking:''} : b)} : m;
export const messageHash=m=>hash(canon(typeof m.content==='string' ? {...m,content:[{type:'text',text:m.content}]} : unredacted(m)));
const bodyKey=body=>shapeOf(body)+':'+body.messages.map(messageHash).join(',');
function rowKeys(chain) {
  const byId=new Map(chain.map(r=>[r.id,r])),memo=new Map();
  const hashes=(r,seen=new Set())=>{
    if(memo.has(r)) return memo.get(r);
    if(seen.has(r) || !Array.isArray(r.tail)) return null;
    seen.add(r);
    const base=r.base!==undefined && byId.has(r.base) ? hashes(byId.get(r.base),seen) : [];
    const all=base && [...base.slice(0,r.keep),...r.tail];
    memo.set(r,all);
    return all;
  };
  return r=>{
    const all=typeof r.shapeHash==='string' ? hashes(r) : null;
    return all && r.shapeHash+':'+all.join(',');
  };
}
function bind(api,chain,bodies,source) {
  const keyOf=rowKeys(chain),free=[...bodies].map(([name,body])=>({name,key:bodyKey(body)})),bound=new Set();
  const take=(key,fits)=>{
    const i=free.findIndex(b=>b.key===key && fits(b));
    if(i<0) return false;
    bound.add(free[i].name);
    free.splice(i,1);
    return true;
  };
  const all=api.every(r=>{
    const key=keyOf(r);
    return !!key && (take(key,b=>source.get(b.name)===r.querySource) || take(key,b=>!source.has(b.name)));
  });
  return all && [...source].every(([name,s])=>!replayed(s) || bound.has(name));
}
const indexRows=dir=>{
  const index=path.join(dir,'index.jsonl');
  return fs.existsSync(index)?rowsOf(index):[];
};
const requestNames=dir=>fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.request.json')).sort():[];
const ownFile=name=>typeof name==='string' && path.basename(name)===name;
const valid=b=>Array.isArray(b?.messages) && !!b.system && !b.not_recorded;
function ledger(dir,sid,call) {
  const names=requestNames(dir),rows=indexRows(dir),files=new Set(names),indexed=rows.map(r=>r.request_file);
  const bodies=new Map(names.map(n=>[n,read(path.join(dir,n))]));
  const api=call?[...apiRows(call.rows),...call.sub]:[];
  const ok=!!call && new Set(indexed).size===indexed.length &&
    rows.every(r=>r.session_id===sid && sourceKind(r.query_source) && ownFile(r.request_file) && ownFile(r.response_file) &&
      files.has(r.request_file) && fs.existsSync(path.join(dir,r.response_file))) &&
    api.every(r=>r.sessionId===sid && replayed(r.querySource)) && names.every(n=>valid(bodies.get(n))) &&
    bind(api,call.chain,bodies,new Map(rows.map(r=>[r.request_file,r.query_source])));
  const main=rows.filter(r=>sourceKind(r.query_source)==='main');
  const ordered=[...main.map(r=>r.request_file),...names.filter(n=>!main.some(r=>r.request_file===n))];
  return {ok,rows,main,byName:bodies,bodies:ordered.filter(n=>bodies.has(n)).map(n=>bodies.get(n)),unanswered:names.length-rows.length};
}
function answered(dir,rows,lastMain,emptyLast) {
  return rows.every(r=>{
    const raw=fs.readFileSync(path.join(dir,r.response_file));
    if(raw.length) return JSON.parse(raw).id===r.message_id;
    return r===lastMain && emptyLast(r);
  });
}
function reconciled(main,pairs) {
  const sent=main.map(pairOf);
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
  const last=rowsOf(file).filter(r=>r.type==='assistant').at(-1),m=last?.message;
  return last?.sessionId===result.session && last.requestId===row.request_id && last.uuid===row.message_uuid &&
    m?.id===row.message_id && m.type==='message' && m.role==='assistant' && m.stop_reason==='end_turn' &&
    m.usage?.output_tokens>0 && Array.isArray(m.content) &&
    m.content.some(b=>b.type==='text' && typeof b.text==='string' && b.text.trim());
}

export function evidence(dir,result,notes,lesson,task={},transcript) {
  const inventory=transcript && fs.existsSync(transcript) ? sessionInventory(path.dirname(path.dirname(transcript)),result.session) : null;
  const call=inventory?.main===path.resolve(transcript ?? '') ? callRows(inventory,task.prompt) : null;
  const l=ledger(dir,result.session,call);
  const last=l.main.at(-1);
  const complete=l.ok && !!last && answered(dir,l.rows,last,r=>finalMessageMatches(transcript,r,result)) &&
    reconciled(l.main,pairsOf(call.rows));
  const transcriptResponse=complete && fs.statSync(path.join(dir,last.response_file)).size===0 ? last.request_id : undefined;
  const surfaces=l.bodies.filter(valid).map(b=>deliverySurfaces(b,task));
  const block=normalize('Project notes\n'+notes.map(e=>'- '+e.content).join('\n'));
  const firstMain=l.byName.get(l.main[0]?.request_file);
  const first=valid(firstMain) ? deliverySurfaces(firstMain,task) : null;
  const hookSeen=!!first && [...first.system,...first.prompt].some(s=>s!==task.prompt && hook.test(s) &&
    normalize(s.split(hook).slice(1).join(' ')).includes(block));
  return {requests:l.bodies.length,sideRequests:l.rows.length-l.main.length,unanswered:l.unanswered,complete:!!complete,hookSeen,
    targetText:targetIn(surfaces,lesson,task),...(transcriptResponse && {transcriptResponse})};
}

function targetIn(surfaces,lesson,task) {
  const target=(s,allow=false)=>normalize(s).includes(normalize(lesson.rule)) ||
    (!allow && normalize(s).includes(normalize(lesson.keyPhrase)));
  return surfaces.some(({system,prompt,results})=>
    [...system,...results].some(s=>target(s)) || prompt.some(s=>target(s,task.keyPhraseAllowed && s===task.prompt)));
}

function archivedAttempt(live,id,sid,prompt,lesson,task) {
  const operator=path.join(path.dirname(live),'operator'),dir=path.join(operator,'bodies',id);
  const inventory=sessionInventory(path.join(live,'home/.claude/projects'),sid),transcript=inventory.main;
  const call=callRows(inventory,prompt),l=ledger(dir,sid,call);
  const recordFile=path.join(operator,id+'.json'),record=fs.existsSync(recordFile)?read(recordFile):null;
  const own=record?.session===sid && record.call===id && record.promptSha256===hash(prompt) &&
    record.apparatus===APPARATUS && record.cutOff===true;
  const inspectable=own && l.ok && l.bodies.length>0 && reconciled(l.main,pairsOf(call.rows)) &&
    answered(dir,l.rows,l.main.at(-1),()=>true);
  const permissions=own && !!call && permissionAudit(transcript,prompt,record.permissionDenials).ok;
  return {status:inspectable?'dispatched':'unauditable',
    target:inspectable && targetIn(l.bodies.map(b=>deliverySurfaces(b,task)),lesson,task),permissions};
}

export function archivedAudit(archives,id,sid,prompt,lesson,task) {
  const attempts=archives.map(live=>archivedAttempt(live,id,sid,prompt,lesson,task));
  return {archivedAttempts:attempts.length,archivedUnauditable:attempts.filter(a=>a.status==='unauditable').length,
    archivedTargetText:attempts.some(a=>a.target),archivedPermissions:attempts.every(a=>a.permissions)};
}
export const neutralClean=r=>r.targetText===false && r.archivedTargetText===false && r.archivedUnauditable===0;
