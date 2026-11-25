import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hippo, HOOK_MEDIUM_TIMEOUT_SECONDS } from './prepare.mjs';
import { commandLog, sessionFiles } from '../../../scripts/token-eval/records.mjs';
import { holdPre, stateCommit } from '../../../scripts/token-eval/checks.mjs';

const stdin = fs.readFileSync(0,'utf8');
const env = {...process.env};
delete env.CLAUDE_CODE_OAUTH_TOKEN;
const payload = JSON.parse(stdin);
const timeoutMs = HOOK_MEDIUM_TIMEOUT_SECONDS * 1000;
const started = performance.now();
const result = spawnSync(process.execPath,[hippo,'end-check'],{env,input:stdin,encoding:'utf8',windowsHide:true,timeout:timeoutMs});
const entry = {active:payload.stop_hook_active===true,timeoutMs,durationMs:Math.round(performance.now()-started)};
if (result.error?.code === 'ETIMEDOUT') {
  fs.appendFileSync(env.LESSON_EVENTS,JSON.stringify({...entry,outcome:'production_timeout'})+'\n');
  process.exit(0);
}
if (result.error || result.status !== 0) throw new Error('production Stop process failed');
entry.outcome='completed';
entry.response=result.stdout.trim();
if (entry.response) {
  const files = sessionFiles(path.join(env.CLAUDE_CONFIG_DIR,'projects'),payload.session_id);
  if (!files.length) throw new Error('no transcript at listing');
  entry.commands=commandLog(files);
  entry.post=stateCommit(env.LESSON_WORK,env.LESSON_PRE);
  holdPre(env.LESSON_WORK,entry.post,'refs/z0/hold/stop/'+entry.post);
}
fs.appendFileSync(env.LESSON_EVENTS,JSON.stringify(entry)+'\n');
process.stdout.write(result.stdout);

