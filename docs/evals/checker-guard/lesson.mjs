import { fileURLToPath } from 'node:url';

export const GUARD='crash-guard-1';
const entry=fileURLToPath(new URL('./entry.mjs',import.meta.url));

export const guardedLesson=lesson=>({...lesson,checkPath:entry,
  check:{...lesson.check,args:[lesson.checkPath,...(lesson.check?.args??[])]}});
