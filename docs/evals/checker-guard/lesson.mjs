import fs from 'node:fs';
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

function takeStatus(file) {
  if(!fs.existsSync(file)) return null;
  const text=fs.readFileSync(file,'utf8');
  fs.rmSync(file);
  return JSON.parse(text);
}

export function guardedRun(runCheck,lesson,{env,status,deadlineMs=CHECK_MS,...options}) {
  fs.rmSync(status,{force:true});
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
}

export const guardState=error=>error?.guard?.guard===GUARD && error.guard.state==='crash' ? 'crash' : 'error';
