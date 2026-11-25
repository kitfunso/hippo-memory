import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hippo } from './prepare.mjs';
import { commandLog, sessionFiles } from '../../../scripts/token-eval/records.mjs';
import { stateCommit } from '../../../scripts/token-eval/checks.mjs';

const stdin = fs.readFileSync(0,'utf8');
const env = {...process.env};
delete env.CLAUDE_CODE_OAUTH_TOKEN;
const result = spawnSync(process.execPath,[hippo,'end-check'],{env,input:stdin,encoding:'utf8',windowsHide:true});
if (result.error || result.status !== 0) throw new Error('production Stop process failed');
const payload = JSON.parse(stdin);
const entry = {active:payload.stop_hook_active===true,response:result.stdout.trim()};
if (entry.response) {
  const files = sessionFiles(path.join(env.CLAUDE_CONFIG_DIR,'projects'),payload.session_id);
  if (!files.length) throw new Error('no transcript at listing');
  entry.commands=commandLog(files);
  entry.post=stateCommit(process.cwd(),env.LESSON_PRE);
}
fs.appendFileSync(env.LESSON_EVENTS,JSON.stringify(entry)+'\n');
process.stdout.write(result.stdout);

