import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function setupProfile(live) {
  const profile=path.join(live,'setup-home');
  const local=path.join(profile,'AppData','Local'),roaming=path.join(profile,'AppData','Roaming');
  const tmp=path.join(profile,'tmp');
  for(const dir of [local,roaming,tmp]) fs.mkdirSync(dir,{recursive:true});
  return {HOME:profile,USERPROFILE:profile,LOCALAPPDATA:local,APPDATA:roaming,
    TEMP:tmp,TMP:tmp,PSModuleAnalysisCachePath:path.join(local,'ModuleAnalysisCache')};
}

export function runSetupScript(live,env,script) {
  const profile=setupProfile(live);
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',script,'-Live',live],{cwd:profile.USERPROFILE,env:{...env,...profile},stdio:'inherit',windowsHide:true});
}
