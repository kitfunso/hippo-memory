import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARD='crash-guard-2';
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

const takeStatus=file=>fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : null;

export function guardedRun(runCheck,lesson,{env,deadlineMs=CHECK_MS,...options}) {
  if('status' in options) throw Error('guardedRun keeps its status record private');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'check-guard-')),status=path.join(dir,'status.json');
  try {
    const guarded={...env,CHECK_STATUS:status,CHECK_DEADLINE_MS:String(deadlineMs)};
    let verdict;
    try {
      verdict=runCheck(guardedLesson(lesson),{...options,env:guarded,timeoutMs:deadlineMs+5_000});
    } catch(error) {
      error.guard=takeStatus(status);
      throw error;
    }
    const record=takeStatus(status);
    if(record?.guard!==GUARD || record.state!=='exit' || record.code!==CODES[verdict])
      throw new GuardError('Checker for '+lesson.id+' gave a verdict without a matching guard record',record);
    return verdict;
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

export const guardState=error=>error?.guard?.guard===GUARD && error.guard.state==='crash' ? 'crash' : 'error';
