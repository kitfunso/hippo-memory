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

function verdictLine(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    return (
      `check-tests-pass: report verdict success=${report.success} numPassedTests=${report.numPassedTests} ` +
      `numFailedTests=${report.numFailedTests} numFailedTestSuites=${report.numFailedTestSuites}.`
    );
  } catch (err) {
    return `check-tests-pass: no usable JSON report (${err.message}).`;
  }
}

function runGate() {
  const reserved = process.argv.slice(2).find((a) => /^--output-?file\b/i.test(a));
  if (reserved) {
    return {
      code: 1,
      lines: [`check-tests-pass: ${reserved} is reserved; the gate needs vitest's JSON report at its own path.`],
    };
  }

  // A fixed report path could hold a stale report from a run that died before writing it.
  const reportDir = mkdtempSync(path.join(tmpdir(), 'hippo-testgate-'));
  try {
    const reportPath = path.join(reportDir, 'report.json');

    // process.execPath + the bin file: no npm shim (ENOENT on Windows) and no pretest rebuild.
    const run = spawnSync(
      process.execPath,
      [vitestBin, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`, ...process.argv.slice(2)],
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

    // Every non-zero exit refuses: the JSON report covers assertions only, so it reads green over a teardown failure.
    return {
      code,
      lines: [
        `check-tests-pass: vitest exited with ${run.signal ?? code}; refusing to publish.`,
        verdictLine(reportPath),
        'Fix: make the suite green. There is no skip switch; npm publish --ignore-scripts skips the other guards too.',
      ],
    };
  } finally {
    // Swallowed on purpose: a cleanup EPERM says nothing, and throwing here would lose the verdict.
    try {
      rmSync(reportDir, { recursive: true, force: true });
    } catch {}
  }
}

const { code, lines } = runGate();
if (lines) console.error(lines.join('\n'));
process.exit(code);
