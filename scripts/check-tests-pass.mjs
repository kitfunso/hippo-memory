#!/usr/bin/env node
// Pre-publish guard: the test suite must pass before `npm publish` (docs/release-policy.md).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const vitestPkgPath = require.resolve('vitest/package.json');
const vitestBin = path.join(path.dirname(vitestPkgPath), require(vitestPkgPath).bin.vitest);

function runGate() {
  const reserved = process.argv.slice(2).find((a) => a.startsWith('--outputFile'));
  if (reserved) {
    return {
      code: 1,
      lines: [`check-tests-pass: ${reserved} is reserved; the gate needs vitest's JSON report at its own path.`],
    };
  }

  // A fixed report path could hold a stale green report from a run that died before writing it.
  const reportDir = mkdtempSync(path.join(tmpdir(), 'hippo-testgate-'));
  try {
    const reportPath = path.join(reportDir, 'report.json');

    // process.execPath + the bin file: no npm shim (ENOENT on Windows) and no pretest rebuild.
    const run = spawnSync(
      process.execPath,
      [
        vitestBin,
        'run',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit' },
    );

    if (run.error) {
      return {
        code: 1,
        lines: [`check-tests-pass: could not start vitest (${run.error.message}); refusing to publish.`],
      };
    }

    const code = run.status ?? 1;
    if (code === 0) return { code: 0 };

    let report = null;
    let reportError = null;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    } catch (err) {
      reportError = err;
    }

    const green =
      report &&
      report.success === true &&
      report.numFailedTests === 0 &&
      report.numFailedTestSuites === 0 &&
      report.numTotalTests > 0;

    if (green) {
      return {
        code: 0,
        lines: [
          `WARNING: vitest exited with ${run.signal ?? code} but the test results were green ` +
            `(numTotalTests=${report.numTotalTests}, numFailedTests=${report.numFailedTests}, ` +
            `numFailedTestSuites=${report.numFailedTestSuites}); publishing.`,
        ],
      };
    }

    const reason = (process.env.HIPPO_PUBLISH_SKIP_TESTS ?? '').trim();
    if (reason) {
      return { code: 0, lines: [`WARNING: publishing with a failed test run. Reason: ${reason}`] };
    }

    const verdictLine = report
      ? `check-tests-pass: report verdict success=${report.success} numTotalTests=${report.numTotalTests} ` +
        `numFailedTests=${report.numFailedTests} numFailedTestSuites=${report.numFailedTestSuites}.`
      : `check-tests-pass: no usable JSON report (${reportError ? reportError.message : 'unknown error'}).`;

    return {
      code,
      lines: [
        `check-tests-pass: vitest exited with ${run.signal ?? code}; refusing to publish.`,
        verdictLine,
        'Fix: make the suite green, or set HIPPO_PUBLISH_SKIP_TESTS="<reason>" to publish anyway.',
        'npm publish --ignore-scripts is NOT the escape hatch: it skips the other guards too.',
      ],
    };
  } finally {
    try {
      rmSync(reportDir, { recursive: true, force: true });
    } catch {}
  }
}

const { code, lines } = runGate();
if (lines) console.error(lines.join('\n'));
process.exit(code);
