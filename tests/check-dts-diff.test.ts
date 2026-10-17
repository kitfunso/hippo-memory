import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-dts-diff.mjs');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'api-report');
const roots: string[] = [];

function tempReport(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-api-report-'));
  roots.push(root);
  return join(root, 'nested', 'report.txt');
}

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-dts-diff', () => {
  it('--write lists every name with its kind, sorted, for index and entry files only', () => {
    const report = tempReport();
    const r = run('--write', '--dist', join(FIXTURES, 'v1'), '--report', report);
    expect(r.status).toBe(0);
    expect(readFileSync(report, 'utf8')).toBe(readFileSync(join(FIXTURES, 'v1.api.txt'), 'utf8'));
    expect(readFileSync(report, 'utf8')).not.toContain('hidden');
    expect(readFileSync(report, 'utf8')).not.toContain('inComment');
  });

  it('--check passes when dist matches the committed report', () => {
    const r = run('--check', '--dist', join(FIXTURES, 'v1'), '--report', join(FIXTURES, 'v1.api.txt'));
    expect(r.status).toBe(0);
    expect(r.out).toContain('matches');
  });

  it('--check fails with a diff of removed and added names', () => {
    const r = run('--check', '--dist', join(FIXTURES, 'v2'), '--report', join(FIXTURES, 'v1.api.txt'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('- index.d.ts: Alias type');
    expect(r.out).toContain('+ index.d.ts: Renamed type');
    expect(r.out).toContain('- entry/testing.d.ts: gone const');
    expect(r.out).toContain('+ entry/testing.d.ts: fresh const');
    expect(r.err).toContain('--write');
  });

  it('--check fails when the report file is missing', () => {
    const r = run('--check', '--dist', join(FIXTURES, 'v1'), '--report', tempReport());
    expect(r.status).toBe(1);
    expect(r.err).toContain('is missing');
  });

  it('exits 2 with a usage line without a mode, and when dist is missing', () => {
    const noMode = run();
    expect(noMode.status).toBe(2);
    expect(noMode.err).toContain('usage:');
    const noDist = run('--check', '--dist', join(FIXTURES, 'nope'));
    expect(noDist.status).toBe(2);
    expect(noDist.err).toContain('does not exist');
  });
});
