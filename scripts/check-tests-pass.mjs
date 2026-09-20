#!/usr/bin/env node
// Pre-publish guard: the test suite must pass before `npm publish` (docs/release-policy.md).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const vitestPkgPath = require.resolve('vitest/package.json');
const vitestBin = path.join(path.dirname(vitestPkgPath), require(vitestPkgPath).bin.vitest);
const WORKER_IPC_ARTIFACT = '[vitest-worker]: Timeout calling';
// Built from a char code so no invisible ESC byte lands in source; vitest colorizes even when redirected.
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// vitest sends its error sections to stdout on some runs and stderr on others, so capture both and echo them live.
function runVitest(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    for (const [source, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      source.setEncoding('utf-8');
      source.on('data', (chunk) => {
        output += chunk;
        sink.write(chunk);
      });
    }
    child.on('error', (error) => resolve({ error }));
    child.on('close', (status, signal) => resolve({ status, signal, output }));
  });
}

async function runGate() {
  const reserved = process.argv.slice(2).find((a) => /^--output-?file\b/i.test(a));
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
    const run = await runVitest([
      vitestBin,
      'run',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
      ...process.argv.slice(2),
    ]);

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

    // The report covers assertions only, so a globalSetup teardown throw (tests/_real-store-guard.ts) is green in it.
    // Vitest's tally discriminates; read ONE section because every reporter reprints it and pooled copies mask an error.
    const plain = (run.output ?? '').replace(SGR, '');
    const sectionAt = plain.indexOf('Unhandled Errors');
    const nextSection = plain.indexOf('Unhandled Errors', sectionAt + 1);
    const section =
      sectionAt === -1 ? '' : plain.slice(sectionAt, nextSection === -1 ? plain.length : nextSection);
    const caught = section.match(/Vitest caught (\d+) unhandled error/);
    const messages = section.split('\n').filter((line) => /^\w*(Error|Exception): /.test(line));
    const artifactOnly =
      caught !== null &&
      messages.length > 0 &&
      messages.length === Number(caught[1]) &&
      messages.every((line) => line.includes(WORKER_IPC_ARTIFACT)) &&
      !plain.includes('Startup Error');

    const green =
      report &&
      report.success === true &&
      report.numFailedTests === 0 &&
      report.numFailedTestSuites === 0 &&
      report.numPassedTests > 0 &&
      artifactOnly;

    if (green) {
      return {
        code: 0,
        lines: [
          `WARNING: vitest exited with ${run.signal ?? code} but the test results were green ` +
            `(numPassedTests=${report.numPassedTests}, numFailedTests=${report.numFailedTests}, ` +
            `numFailedTestSuites=${report.numFailedTestSuites}) and every error printed was the known ` +
            `worker IPC artifact (${WORKER_IPC_ARTIFACT}); publishing.`,
        ],
      };
    }

    const reason = (process.env.HIPPO_PUBLISH_SKIP_TESTS ?? '').trim();
    if (reason) {
      return { code: 0, lines: [`WARNING: publishing with a failed test run. Reason: ${reason}`] };
    }

    const verdictLine = report
      ? `check-tests-pass: report verdict success=${report.success} numPassedTests=${report.numPassedTests} ` +
        `numFailedTests=${report.numFailedTests} numFailedTestSuites=${report.numFailedTestSuites} ` +
        `workerIpcArtifactOnly=${artifactOnly}.`
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
    // Swallowed on purpose: a cleanup EPERM says nothing, and throwing here would lose the verdict.
    try {
      rmSync(reportDir, { recursive: true, force: true });
    } catch {}
  }
}

const { code, lines } = await runGate();
if (lines) console.error(lines.join('\n'));
process.exit(code);
