import fs from 'node:fs';
import path from 'node:path';
import { read } from './plan.mjs';
export const normalize=s=>s.replace(/\s+/g,' ').trim().toLowerCase();
function strings(obj) {
  if(typeof obj==='string') return [obj];
  return obj && typeof obj==='object' ? Object.values(obj).flatMap(strings) : [];
}
export function evidence(dir,result,notes,lesson) {
  const names=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.request.json')):[];
  const index=path.join(dir,'index.jsonl');
  const rows=fs.existsSync(index)?fs.readFileSync(index,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  const indexed=new Set(rows.map(r=>r.request_file));
  const bodies=names.map(n=>read(path.join(dir,n)));
  const complete=names.length>0 && names.every(n=>indexed.has(n)) && indexed.size===names.length &&
    rows.every(r=>r.session_id===result.session && path.basename(r.response_file)===r.response_file &&
      read(path.join(dir,r.response_file)).id===r.message_id) &&
    bodies.every(b=>Array.isArray(b.messages) && b.system && !b.not_recorded);
  const texts=bodies.map(b=>normalize(strings(b).join('\n')));
  const block=normalize('Project notes\n'+notes.map(e=>'- '+e.content).join('\n'));
  return {requests:bodies.length,complete:!!complete,hookSeen:texts.some(t=>t.includes(block)),
    targetText:texts.some(t=>t.includes(normalize(lesson.rule)) || t.includes(normalize(lesson.keyPhrase)))};
}
