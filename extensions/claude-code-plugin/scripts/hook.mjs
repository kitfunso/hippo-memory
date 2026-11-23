#!/usr/bin/env node
// Runs one hippo hook verb with the contract of the shell line it replaced: exit 0 always, and stderr
// dropped (`2>/dev/null`) except for `last-sleep`, whose line kept it for the last sleep's report.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnHippo } from './spawn-hippo.mjs';

const KEEPS_STDERR = new Set(['last-sleep']);
const args = process.argv.slice(2);
// `hippo last-sleep` shows this log at the next session start.
if (args[0] === 'session-end') args.push('--log-file', join(homedir(), '.hippo', 'logs', 'last-sleep.log'));

try {
  const child = spawnHippo(args, ['inherit', 'inherit', KEEPS_STDERR.has(args[0]) ? 'inherit' : 'ignore']);
  child.on('error', () => process.exit(0));
  child.on('exit', () => process.exit(0));
} catch {
  process.exit(0);
}
