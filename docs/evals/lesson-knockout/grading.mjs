import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { assertNodeStarts,folder } from './plan.mjs';
import { setupProfile } from './setup.mjs';

export function gradeEnv(base,u,live,log) {
  const tool=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',path.join(folder,'task-env.ps1'),'-Chain',u.toolchain,'-Live',live],
    {env:{...base,...setupProfile(live)},encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','inherit']}));
  const env=Object.fromEntries(Object.entries(base).filter(([key])=>key.toUpperCase()!=='PATH'));
  Object.assign(env,tool,{CHECK_LOG:log});
  if(u.toolchain==='python') env.CHECK_PYTHON=path.join(live,'venv','Scripts','python.exe');
  assertNodeStarts(env,'Grading environment');
  return env;
}

export { guardedRun } from '../checker-guard/lesson.mjs';

export const checkerModules=checkPath=>[...new Set([...fs.readFileSync(checkPath,'utf8')
  .matchAll(/["']-m["']\s*,\s*["']([A-Za-z_][\w.]*)["']/g)].map(match=>match[1]))];

const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const tail=r=>String(r.stderr||r.stdout||r.error?.message||'').trim().slice(-400);

export function assertCheckerTools(u,env,live) {
  const modules=checkerModules(u.lesson.checkPath);
  if(!modules.length) return modules;
  if(!env.CHECK_PYTHON) throw Error('Checker for '+u.id+' runs Python modules outside a Python toolchain');
  const probe={...env,...setupProfile(live)};
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'module-probe-'));
  try {
    const run=(file,args)=>spawnSync(file,args,{env:probe,cwd,encoding:'utf8',windowsHide:true,timeout:120_000});
    const where=run('python',['-c','import sys;print(sys.executable)']),found=(where.stdout??'').trim();
    if(where.status!==0 || !same(found,env.CHECK_PYTHON))
      throw Error('python on the grading PATH for '+u.id+' is not CHECK_PYTHON: '+(found||tail(where)));
    for(const name of modules) {
      const r=run(env.CHECK_PYTHON,['-m',name,'--version']);
      if(r.status!==0) throw Error('Task venv cannot run python -m '+name+' for '+u.id+' (exit '+r.status+'): '+tail(r));
    }
  } finally {
    fs.rmSync(cwd,{recursive:true,force:true});
  }
  return modules;
}
