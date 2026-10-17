#!/usr/bin/env node
// Toy checker that grades only through `git diff $CHECK_PRE_COMMIT $CHECK_POST_COMMIT`.
// want=<path>: pass when the agent added or changed that path. noinstr: fail when any instruction file changed.
import { spawnSync } from 'node:child_process';

const r = spawnSync('git', ['diff', '--name-only', process.env.CHECK_PRE_COMMIT, process.env.CHECK_POST_COMMIT], { encoding: 'utf8' });
if (r.status !== 0) process.exit(2);
const changed = r.stdout.split('\n').filter(Boolean);
const want = process.argv.slice(2).find((a) => a.startsWith('want='))?.slice(5);
if (want) process.exit(changed.includes(want) ? 0 : 1);
const instruction = (p) => /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/.test(p) || p.startsWith('.claude/rules/');
process.exit(changed.some(instruction) ? 1 : 0);
