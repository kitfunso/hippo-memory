#!/usr/bin/env node
// Smoke lesson checker: pass when the session added a new file under the folder given as the first arg, else fail.
import { spawnSync } from 'node:child_process';

const prefix = process.argv[2];
const r = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=A', process.env.Z0_PRE_COMMIT, process.env.Z0_POST_COMMIT], { encoding: 'utf8' });
if (r.status !== 0 || !prefix) process.exit(2);
process.exit(r.stdout.split('\n').some((p) => p.startsWith(prefix)) ? 0 : 1);
