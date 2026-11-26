import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { APPARATUS,hash,read,root } from './plan.mjs';
import { WIRE_LOG,wireName } from './wire.mjs';
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
export function sessionInventory(projects,sid) {
  const parts=f=>path.relative(path.resolve(projects),f).split(path.sep);
  const files=listTranscripts(projects).map(f=>path.resolve(f)).sort();
  const mains=files.filter(f=>{ const p=parts(f); return p.length===2 && p[1]===sid+'.jsonl'; });
  const subs=files.filter(f=>{ const p=parts(f); return p.length>=4 && p[1]===sid && p[2]==='subagents'; });
  const main=mains.length===1?mains[0]:null;
  return {main,subs,files:main?[main,...subs]:subs};
}
function callRows(inventory,prompt) {
  if(!inventory?.main) return null;
  const rows=rowsOf(inventory.main),start=promptStart(rows,prompt);
  return start<0 ? null : {rows:rows.slice(start)};
}
const ROUTES=new Map([['GET /api/claude_code/settings','settings'],['GET /api/claude_code/policy_limits','policy'],
  ['POST /v1/messages?beta=true','generate'],['POST /v1/messages/count_tokens?beta=true','count']]);
const MODEL_ROUTES=new Set(['generate','count']);
const ROW_KINDS=new Set(['request','response','end','tunnel','refused','closed']);
const ANTHROPIC_HOST=/(?:^|\.)(?:anthropic\.com|claude\.ai|claude\.com)$/i;
function decoded(raw,encoding) {
  if(!encoding || encoding==='identity') return raw;
  if(encoding==='gzip') return zlib.gunzipSync(raw,{finishFlush:zlib.constants.Z_SYNC_FLUSH});
  if(encoding==='deflate') return zlib.inflateSync(raw,{finishFlush:zlib.constants.Z_SYNC_FLUSH});
  if(encoding==='br') return zlib.brotliDecompressSync(raw,{finishFlush:zlib.constants.BROTLI_OPERATION_FLUSH});
  throw Error('Unknown content encoding '+encoding);
}
function replyOf(text,contentType) {
  if(/text\/event-stream/i.test(contentType??'')) {
    const events=text.split(/\r?\n\r?\n/).map(block=>block.split(/\r?\n/).filter(l=>l.startsWith('data:'))
      .map(l=>l.slice(5).trimStart()).join('\n')).filter(Boolean).map(data=>{
        try { return JSON.parse(data); } catch { return {type:'unparsed'}; }
      });
    const error=events.find(e=>e?.type==='error' || e?.type==='unparsed');
    return {id:events.find(e=>e?.type==='message_start')?.message?.id ?? null,stop:events.some(e=>e?.type==='message_stop'),
      error:error ? error.error?.type ?? error.type : null};
  }
  try {
    const body=JSON.parse(text);
    if(body?.type==='message') return {id:body.id ?? null,stop:true,error:null};
    return {id:null,stop:false,error:body?.type==='error' ? body.error?.type ?? 'error' : null,json:body};
  } catch { return {id:null,stop:false,error:'unparsed'}; }
}
function savedRequest(dir,q,route) {
  if(!MODEL_ROUTES.has(route)) return q.file===null ? {body:null} : {reason:'a non-model request file'};
  if(q.file!==wireName(q.seq,'.request.json')) return {reason:'request '+q.seq+' file name'};
  const file=path.join(dir,q.file);
  if(!fs.existsSync(file)) return {reason:'request '+q.seq+' file missing'};
  const saved=fs.readFileSync(file);
  if(hash(saved)!==q.savedSha256) return {reason:'request '+q.seq+' file changed'};
  let body;
  try { body=JSON.parse(saved.toString('utf8')); } catch { return {reason:'request '+q.seq+' is not JSON'}; }
  if(!Array.isArray(body?.messages) || (route==='generate' && !body.system)) return {reason:'request '+q.seq+' is not a model request'};
  return {body};
}
function savedReply(dir,q,route,response,end) {
  if(!response) return end.ended==='upstream-error' ? {reply:null} : {reason:'exchange '+q.seq+' has no response'};
  if(!MODEL_ROUTES.has(route)) return response.file===null ? {reply:null} : {reason:'a non-model response file'};
  if(response.file!==wireName(q.seq,'.response')) return {reason:'response '+q.seq+' file name'};
  const file=path.join(dir,response.file);
  if(!fs.existsSync(file)) return {reason:'response '+q.seq+' file missing'};
  const raw=fs.readFileSync(file);
  if(raw.length!==end.bytes || hash(raw)!==end.sha256) return {reason:'response '+q.seq+' file changed'};
  let text='';
  try { text=decoded(raw,response.encoding).toString('utf8'); }
  catch { if(end.ended==='complete') return {reason:'response '+q.seq+' does not decode'}; }
  return {reply:replyOf(text,response.contentType)};
}
function finished(route,response,end,reply) {
  if(response?.status!==200 || end.ended!=='complete') return false;
  if(route==='generate') return !!reply.id && reply.stop && !reply.error;
  return route==='count' ? Number.isInteger(reply.json?.input_tokens) : true;
}
export function wireLedger(dir) {
  const fail=reason=>({ok:false,reason,exchanges:[],hosts:[]});
  const log=path.join(dir,WIRE_LOG);
  if(!fs.existsSync(log)) return fail('no wire log');
  let rows;
  try { rows=rowsOf(log); } catch { return fail('unreadable wire log'); }
  const closed=rows.at(-1),hosts=rows.filter(r=>r.kind==='tunnel').map(r=>String(r.host));
  if(closed?.kind!=='closed' || closed.open!==0 || rows.filter(r=>r.kind==='closed').length!==1) return fail('wire not closed');
  if(rows.some(r=>!ROW_KINDS.has(r.kind))) return fail('fault or unknown wire row');
  if(rows.some(r=>r.kind==='refused' && r.reason!=='plain')) return fail('refused request');
  if(hosts.some(h=>ANTHROPIC_HOST.test(h))) return fail('tunnel to an Anthropic host');
  const requests=rows.filter(r=>r.kind==='request');
  if(requests.length!==closed.exchanges || requests.some((r,i)=>r.seq!==i+1)) return fail('wire sequence');
  const exchanges=[];
  for(const q of requests) {
    const at=kind=>rows.flatMap((r,i)=>r.kind===kind && r.seq===q.seq ? [i] : []);
    const [responses,ends]=[at('response'),at('end')],start=rows.indexOf(q);
    if(responses.length>1 || ends.length!==1 || ends[0]<start || (responses.length && !(start<responses[0] && responses[0]<ends[0])))
      return fail('exchange '+q.seq+' rows');
    const route=ROUTES.get(q.method+' '+q.path),response=rows[responses[0]],end=rows[ends[0]];
    if(!route) return fail('unknown route '+q.method+' '+q.path);
    const request=savedRequest(dir,q,route),answer=request.reason ? {} : savedReply(dir,q,route,response,end);
    if(request.reason || answer.reason) return fail(request.reason ?? answer.reason);
    exchanges.push({seq:q.seq,route,status:response?.status ?? null,requestId:response?.requestId ?? null,ended:end.ended,
      body:request.body,reply:answer.reply,complete:finished(route,response,end,answer.reply)});
  }
  return {ok:true,reason:null,exchanges,hosts};
}
const generated=w=>w.exchanges.filter(x=>x.route==='generate');
const modelBodies=w=>w.exchanges.filter(x=>MODEL_ROUTES.has(x.route)).map(x=>x.body);
function matched(w,inventory,call,{success}) {
  if(!w.ok || !call || inventory.subs.length) return false;
  const pairs=pairsOf(call.rows),sent=generated(w),done=sent.filter(x=>x.complete).map(x=>x.requestId+'\n'+x.reply.id);
  const last=sent.at(-1);
  if(!pairs || !last || pairs.length!==done.length || pairs.some((k,i)=>k!==done[i])) return false;
  if(success) return last.complete;
  const error=call.rows.filter(r=>r.type==='assistant' && !r.isSidechain).at(-1);
  return !last.complete && !!last.requestId && error?.isApiErrorMessage===true && error.requestId===last.requestId;
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

function finalMessage(call,result,w) {
  if(result.exit!==0 || result.isError!==false || result.subtype!=='success') return false;
  const last=call.rows.filter(r=>r.type==='assistant' && !r.isSidechain).at(-1),m=last?.message,sent=generated(w).at(-1);
  return !!sent && last?.sessionId===result.session && last.requestId===sent.requestId && m?.id===sent.reply?.id &&
    m.type==='message' && m.role==='assistant' && m.stop_reason==='end_turn' && m.usage?.output_tokens>0 &&
    Array.isArray(m.content) && m.content.some(b=>b.type==='text' && typeof b.text==='string' && b.text.trim());
}
export function callComplete(dir,result,prompt,transcript,{maxTurns=false}={}) {
  const w=wireLedger(dir);
  if(!transcript || !fs.existsSync(transcript) || path.basename(transcript)!==result.session+'.jsonl') return {w,complete:false};
  const inventory=sessionInventory(path.dirname(path.dirname(transcript)),result.session);
  const call=inventory.main===path.resolve(transcript) ? callRows(inventory,prompt) : null;
  const ended=!!call && (maxTurns && result.subtype==='error_max_turns' ? true : finalMessage(call,result,w));
  return {w,complete:ended && matched(w,inventory,call,{success:true})};
}
export function bodyAudit(bodies,notes,lesson,task={},first=bodies[0]) {
  const block=normalize('Project notes\n'+notes.map(e=>'- '+e.content).join('\n'));
  const opening=first ? deliverySurfaces(first,task) : null;
  const hookSeen=!!opening && [...opening.system,...opening.prompt].some(s=>s!==task.prompt && hook.test(s) &&
    normalize(s.split(hook).slice(1).join(' ')).includes(block));
  return {hookSeen,targetText:targetIn(bodies.map(b=>deliverySurfaces(b,task)),lesson,task)};
}
export function evidence(dir,result,notes,lesson,task={},transcript) {
  const {w,complete}=callComplete(dir,result,task.prompt,transcript,{maxTurns:task.maxTurns});
  const sent=generated(w);
  return {requests:sent.length,sideRequests:w.exchanges.length-sent.length,retries:sent.filter(x=>!x.complete).length,
    complete,...bodyAudit(modelBodies(w),notes,lesson,task,sent[0]?.body),wireHosts:w.hosts};
}

function targetIn(surfaces,lesson,task) {
  const target=(s,allow=false)=>normalize(s).includes(normalize(lesson.rule)) ||
    (!allow && normalize(s).includes(normalize(lesson.keyPhrase)));
  return surfaces.some(({system,prompt,results})=>
    [...system,...results].some(s=>target(s)) || prompt.some(s=>target(s,task.keyPhraseAllowed && s===task.prompt)));
}

export function cutOffBound(dir,projects,sid,prompt) {
  const inventory=sessionInventory(projects,sid),call=callRows(inventory,prompt),w=wireLedger(dir);
  return {w,inventory,call,bound:matched(w,inventory,call,{success:false})};
}
function archivedAttempt(live,id,sid,prompt,lesson,task) {
  const operator=path.join(path.dirname(live),'operator');
  const {w,inventory,call,bound}=cutOffBound(path.join(operator,'wire',id),path.join(live,'home/.claude/projects'),sid,prompt);
  const transcript=inventory.main;
  const recordFile=path.join(operator,id+'.json'),record=fs.existsSync(recordFile)?read(recordFile):null;
  const own=record?.session===sid && record.call===id && record.promptSha256===hash(prompt) &&
    record.apparatus===APPARATUS && record.cutOff===true;
  const inspectable=own && bound;
  const permissions=own && !!call && permissionAudit(transcript,prompt,record.permissionDenials).ok;
  return {status:inspectable?'dispatched':'unauditable',
    target:inspectable && targetIn(modelBodies(w).map(b=>deliverySurfaces(b,task)),lesson,task),permissions};
}

export function archivedAudit(archives,id,sid,prompt,lesson,task) {
  const attempts=archives.map(live=>archivedAttempt(live,id,sid,prompt,lesson,task));
  return {archivedAttempts:attempts.length,archivedUnauditable:attempts.filter(a=>a.status==='unauditable').length,
    archivedTargetText:attempts.some(a=>a.target),archivedPermissions:attempts.every(a=>a.permissions)};
}
export const neutralClean=r=>r.targetText===false && r.archivedTargetText===false && r.archivedUnauditable===0;
