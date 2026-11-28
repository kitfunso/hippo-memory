import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function profileEnv(live) {
  const profile=path.join(live,'setup-home');
  const local=path.join(profile,'AppData','Local'),roaming=path.join(profile,'AppData','Roaming');
  const tmp=path.join(profile,'tmp');
  return {HOME:profile,USERPROFILE:profile,LOCALAPPDATA:local,APPDATA:roaming,
    TEMP:tmp,TMP:tmp,PSModuleAnalysisCachePath:path.join(local,'ModuleAnalysisCache')};
}

export function setupProfile(live) {
  const env=profileEnv(live);
  for(const dir of [env.LOCALAPPDATA,env.APPDATA,env.TEMP]) fs.mkdirSync(dir,{recursive:true});
  return env;
}

export function operatorEnv(base,live) {
  const {TEMP,TMP,...profile}=profileEnv(live);
  return {...base,...profile};
}

export function runSetupScript(live,env,script) {
  const profile=setupProfile(live);
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',script,'-Live',live],{cwd:profile.USERPROFILE,env:{...env,...profile},stdio:'inherit',windowsHide:true});
}
