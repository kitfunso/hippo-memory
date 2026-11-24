#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnHippo } from './spawn-hippo.mjs';

const KEEPS_STDERR = new Set(['last-sleep']);
const args = process.argv.slice(2);
if (args[0] === 'session-end') args.push('--log-file', join(homedir(), '.hippo', 'logs', 'last-sleep.log'));

try {
  const child = spawnHippo(args, ['inherit', 'inherit', KEEPS_STDERR.has(args[0]) ? 'inherit' : 'ignore']);
  child.on('error', () => process.exit(0));
  child.on('exit', () => process.exit(0));
} catch {
  process.exit(0);
}
