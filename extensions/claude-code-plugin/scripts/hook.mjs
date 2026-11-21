#!/usr/bin/env node
// Runs one hippo hook verb with the same contract as the shell line it replaced (`2>/dev/null || true`): stderr dropped, exit 0.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnHippo } from './spawn-hippo.mjs';

const args = process.argv.slice(2);
// `hippo last-sleep` shows this log at the next session start.
if (args[0] === 'session-end') args.push('--log-file', join(homedir(), '.hippo', 'logs', 'last-sleep.log'));

try {
  const child = spawnHippo(args, ['inherit', 'inherit', 'ignore']);
  child.on('error', () => process.exit(0));
  child.on('exit', () => process.exit(0));
} catch {
  process.exit(0);
}
