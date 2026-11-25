import fs from 'node:fs';
import path from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { assertNodeStarts,folder,preload } from './plan.mjs';

export function gradeEnv(base,u,live,log) {
  const tool=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',path.join(folder,'task-env.ps1'),'-Chain',u.toolchain,'-Live',live],
    {env:base,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','inherit']}));
  const env=Object.fromEntries(Object.entries(base).filter(([key])=>key.toUpperCase()!=='PATH'));
  Object.assign(env,tool,{NODE_OPTIONS:base.NODE_OPTIONS+' '+preload('checker-guard.cjs'),CHECK_LOG:log});
  if(u.toolchain==='python') env.CHECK_PYTHON=path.join(live,'venv','Scripts','python.exe');
  assertNodeStarts(env,'Grading environment');
  return env;
}

export const checkerModules=checkPath=>[...new Set([...fs.readFileSync(checkPath,'utf8')
  .matchAll(/["']-m["']\s*,\s*["']([A-Za-z_][\w.]*)["']/g)].map(match=>match[1]))];

const findMissing='import importlib.util as u,sys;m=[n for n in sys.argv[1:] if u.find_spec(n) is None];print(" ".join(m));sys.exit(1 if m else 0)';

export function assertCheckerTools(u,env) {
  const modules=checkerModules(u.lesson.checkPath);
  if(!modules.length) return modules;
  if(!env.CHECK_PYTHON) throw Error('Checker for '+u.id+' runs Python modules outside a Python toolchain');
  const r=spawnSync(env.CHECK_PYTHON,['-c',findMissing,...modules],{env,encoding:'utf8',windowsHide:true});
  if(r.status!==0) throw Error('Task venv lacks checker modules for '+u.id+': '+String(r.stdout||r.stderr||r.error?.message).trim());
  return modules;
}
