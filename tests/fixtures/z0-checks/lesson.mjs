#!/usr/bin/env node
// Toy lesson checker for the runner tests: grades a file the fake agent writes, and logs what the runner handed it.
// Args: file=<name> (default lesson.txt; absent is na, "bad" is fail, else pass), exit=<n> (crash), probe, has=<sha>, escape (writes ../CLAUDE.md), escape-if=<file> (only when <file> exists).
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const arg = (name) => process.argv.slice(2).find((a) => a === name || a.startsWith(`${name}=`))?.split('=')[1] ?? null;
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
const out = (r) => (r.status === 0 ? r.stdout.trim() : null);
const logFile = process.env.FAKE_CLAUDE_LOG;
const log = (o) => logFile && fs.appendFileSync(logFile, `check ${JSON.stringify(o)}\n`);

if (process.argv.includes('escape') || (arg('escape-if') && fs.existsSync(arg('escape-if')))) fs.writeFileSync('../CLAUDE.md', 'written by a checker\n');
// A pruned pre-session commit must never pass as a verdict.
if (git('cat-file', '-e', `${process.env.Z0_PRE_COMMIT}^{commit}`).status !== 0) {
  log({ lesson: process.env.Z0_LESSON_ID, prunedPre: process.env.Z0_PRE_COMMIT });
  process.exit(2);
}
const entry = {
  lesson: process.env.Z0_LESSON_ID, pre: process.env.Z0_PRE_COMMIT, post: process.env.Z0_POST_COMMIT,
  preRef: out(git('rev-parse', '-q', '--verify', 'refs/z0/pre')),
  commands: JSON.parse(fs.readFileSync(process.env.Z0_COMMANDS, 'utf8')),
};
const has = arg('has');
if (has) entry.has = git('cat-file', '-e', has).status === 0;
if (process.argv.includes('probe')) {
  const cut = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').match(/^cutoff-commit (\w+)$/m)?.[1] ?? null;
  Object.assign(entry, {
    head: out(git('rev-parse', 'HEAD')), symbolic: out(git('symbolic-ref', '-q', 'HEAD')), work: out(git('rev-parse', '-q', '--verify', 'refs/heads/work')),
    cutoffOnDisk: fs.existsSync('cutoff.txt'), cutoffStaged: out(git('ls-files', '--', 'cutoff.txt')) !== '',
    cachedStatus: git('diff', '--cached', '--name-only').status, stagedA: out(git('show', ':a.txt')), diskA: fs.existsSync('a.txt') ? fs.readFileSync('a.txt', 'utf8').trim() : null,
    kept: fs.existsSync('kept.txt'), claudeMd: fs.readFileSync('CLAUDE.md', 'utf8'),
    logAll: out(git('log', '--all', '--format=%s')), reflog: out(git('reflog', '--all', '--format=%s')),
    cutCommitAlive: cut ? git('cat-file', '-e', cut).status === 0 : null,
    refs: out(git('for-each-ref', '--format=%(refname)')),
  });
}
log(entry);
const forced = arg('exit');
if (forced) process.exit(Number(forced));
const file = arg('file') ?? 'lesson.txt';
if (!fs.existsSync(file)) process.exit(3);
process.exit(fs.readFileSync(file, 'utf8').trim() === 'bad' ? 1 : 0);
