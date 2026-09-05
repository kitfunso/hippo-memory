#!/usr/bin/env node
// Pre-publish guard: the test suite must pass before `npm publish` (docs/release-policy.md).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const vitestPkgPath = require.resolve('vitest/package.json');
const vitestBin = path.join(path.dirname(vitestPkgPath), require(vitestPkgPath).bin.vitest);

// process.execPath + the bin file: no npm shim (ENOENT on Windows) and no pretest rebuild.
const run = spawnSync(process.execPath, [vitestBin, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (run.error) {
  console.error(`check-tests-pass: could not start vitest (${run.error.message}); refusing to publish.`);
  process.exit(1);
}

const code = run.status ?? 1;
if (code === 0) process.exit(0);

const reason = (process.env.HIPPO_PUBLISH_SKIP_TESTS ?? '').trim();
if (reason) {
  console.error(`WARNING: publishing with a failed test run. Reason: ${reason}`);
  process.exit(0);
}

console.error(
  [
    `check-tests-pass: vitest exited with ${run.signal ?? code}; refusing to publish.`,
    'If the run above shows zero failed tests, that is the vitest worker IPC artifact',
    '([vitest-worker]: Timeout calling "onTaskUpdate"): rerun the failed files alone first.',
    'Fix: make the suite green, or set HIPPO_PUBLISH_SKIP_TESTS="<reason>" to publish anyway.',
    'npm publish --ignore-scripts is NOT the escape hatch: it skips the other guards too.',
  ].join('\n'),
);
process.exit(code);
