#!/usr/bin/env node
// Smoke lesson checker: pass when VERSION's patch number went up by exactly one and nothing else in it changed.
import { spawnSync } from 'node:child_process';

const read = (commit) => {
  const r = spawnSync('git', ['show', `${commit}:VERSION`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('.').map(Number) : null;
};
const before = read(process.env.Z0_PRE_COMMIT);
if (!before) process.exit(2);
const after = read(process.env.Z0_POST_COMMIT);
const bumped = after && after.length === 3 && after[0] === before[0] && after[1] === before[1] && after[2] === before[2] + 1;
process.exit(bumped ? 0 : 1);
