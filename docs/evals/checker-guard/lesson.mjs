import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac,randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const GUARD='crash-guard-3';
export const CHECK_MS=120_000;
const entry=fileURLToPath(new URL('./entry.mjs',import.meta.url));
const CODES={pass:0,fail:1,na:3};

export class GuardError extends Error {
  constructor(message,guard) {
    super(message);
    this.name='GuardError';
    this.guard=guard;
  }
}

export const guardedLesson=lesson=>({...lesson,checkPath:entry,
  check:{...lesson.check,args:[lesson.checkPath,...(lesson.check?.args??[])]}});

export const seal=(key,body)=>createHmac('sha256',key).update(JSON.stringify(body)).digest('hex');
function takeStatus(file,key) {
  if(!fs.existsSync(file)) return null;
  const {seal:mark,...body}=JSON.parse(fs.readFileSync(file,'utf8'));
  return mark===seal(key,body) ? body : {forged:body};
}

export function guardedRun(runCheck,lesson,{env,deadlineMs=CHECK_MS,...options}) {
  if('status' in options) throw Error('guardedRun keeps its status record private');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'check-guard-')),status=path.join(dir,'status.json');
  const key=randomBytes(32).toString('hex');
  try {
    const guarded={...env,CHECK_STATUS:status,CHECK_STATUS_KEY:key,CHECK_DEADLINE_MS:String(deadlineMs)};
    let verdict;
    try {
      verdict=runCheck(guardedLesson(lesson),{...options,env:guarded,timeoutMs:deadlineMs+5_000});
    } catch(error) {
      try { error.guard=takeStatus(status,key); } catch(cause) { error.guard={unreadable:String(cause)}; }
      throw error;
    }
    const record=takeStatus(status,key);
    if(record?.guard!==GUARD || record.state!=='exit' || record.code!==CODES[verdict])
      throw new GuardError('Checker for '+lesson.id+' gave a verdict without a matching guard record',record);
    return verdict;
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

export const guardState=error=>error?.guard?.guard===GUARD && error.guard.state==='crash' ? 'crash' : 'error';
