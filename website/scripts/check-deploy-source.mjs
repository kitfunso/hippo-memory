#!/usr/bin/env node
// `npm run deploy` publishes this checkout to production, so it must be a clean copy of the newest
// master: a release branch or a stale checkout drops every site fix merged since it was cut.
import { execFileSync } from 'node:child_process';

const FIX =
  'Fix: deploy from a clean checkout of the newest master ' +
  '(git fetch origin, then git switch --detach origin/master) and run the deploy again.';

function refuse(why) {
  console.error(`[check-deploy-source] ${why}\n${FIX}`);
  process.exit(1);
}

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    refuse(`git ${args.join(' ')} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

git('fetch', '--quiet', 'origin', 'master');
const dirty = git('status', '--porcelain');
if (dirty) refuse(`the checkout has uncommitted changes:\n${dirty}`);
const head = git('rev-parse', 'HEAD');
const master = git('rev-parse', 'origin/master');
if (head !== master) refuse(`HEAD ${head.slice(0, 9)} is not origin/master ${master.slice(0, 9)}.`);
console.log(`[check-deploy-source] OK: deploying origin/master ${master.slice(0, 9)}.`);
