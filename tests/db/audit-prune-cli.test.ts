/**
 * CLI integration tests for `hippo audit prune` (v1.12.9).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeStore } from '../_helpers/make-root.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

interface RunOptions {
  ok?: boolean;
  env?: Record<string, string>;
}

interface CliRunResult {
  stdout: string;
  stderr: string;
}

async function runCli(cwd: string, args: string[], opts: RunOptions = {}): Promise<CliRunResult> {
  const r = await runCliAs(args, { cwd, env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo'), ...opts.env } });
  if (r.status === 0) return { stdout: r.stdout, stderr: '' };
  if (opts.ok === false) return { stdout: r.stdout, stderr: r.stderr };
  throw new Error(`CLI exit ${r.status}: ${r.stderr}\nstdout: ${r.stdout}`);
}

function seed(cwd: string, tenantId: string, daysAgo: number, count: number): void {
  const db = openHippoDb(join(cwd, '.hippo'));
  try {
    const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      `INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < count; i++) stmt.run(ts, tenantId, 'seed', 'recall', null, '{}');
  } finally {
    closeHippoDb(db);
  }
}

describe('hippo audit prune CLI', () => {
  let root: string;

  beforeEach(() => {
    root = makeStore('audit-prune-cli').base;
  });

  it('prunes rows older than the cutoff and reports the count', async () => {
    seed(root, 'default', 100, 5);
    seed(root, 'default', 1, 3);

    const { stdout } = await runCli(root, ['audit', 'prune', '--older-than', '30d']);
    expect(stdout).toMatch(/deleted 5 rows for tenant "default"/);
    expect(stdout).toMatch(/with ts < \d{4}-\d{2}-\d{2}T/);
  });

  it('--dry-run reports count without deleting', async () => {
    seed(root, 'default', 100, 7);

    const { stdout } = await runCli(root, ['audit', 'prune', '--older-than', '30d', '--dry-run']);
    expect(stdout).toMatch(/would delete 7 rows/);
    expect(stdout).toMatch(/dry-run; re-run without --dry-run/);

    // Confirm nothing was actually deleted (rerun real prune still finds 7).
    const { stdout: stdout2 } = await runCli(root, ['audit', 'prune', '--older-than', '30d']);
    expect(stdout2).toMatch(/deleted 7 rows/);
  });

  it('--json emits machine-readable {cutoff, count, dryRun}', async () => {
    seed(root, 'default', 100, 2);

    const { stdout } = await runCli(root, ['audit', 'prune', '--older-than', '30d', '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(2);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts plain integer days (no d suffix)', async () => {
    seed(root, 'default', 100, 1);
    const { stdout } = await runCli(root, ['audit', 'prune', '--older-than', '30']);
    expect(stdout).toMatch(/deleted 1 row /); // singular
  });

  it('--tenant scopes the prune to a specific tenant', async () => {
    seed(root, 'tenant-a', 100, 4);
    seed(root, 'tenant-b', 100, 6);

    const { stdout } = await runCli(root, ['audit', 'prune', '--older-than', '30d', '--tenant', 'tenant-a']);
    expect(stdout).toMatch(/deleted 4 rows for tenant "tenant-a"/);

    // tenant-b should be untouched
    const { stdout: stdout2 } = await runCli(root, [
      'audit',
      'prune',
      '--older-than',
      '30d',
      '--tenant',
      'tenant-b',
      '--dry-run',
    ]);
    expect(stdout2).toMatch(/would delete 6 rows/);
  });

  it('rejects missing --older-than with usage error', async () => {
    const { stderr } = await runCli(root, ['audit', 'prune'], { ok: false });
    expect(stderr).toMatch(/Usage: hippo audit prune --older-than/);
  });

  it('rejects invalid --older-than value', async () => {
    const { stderr } = await runCli(root, ['audit', 'prune', '--older-than', 'abc'], { ok: false });
    expect(stderr).toMatch(/Invalid --older-than/);
  });

  it('--help short-circuits and prints usage', async () => {
    const { stdout } = await runCli(root, ['audit', 'prune', '--help']);
    expect(stdout).toMatch(/--older-than.*Nd/);
    expect(stdout).toMatch(/--dry-run/);
    expect(stdout).toMatch(/--tenant/);
  });

  // Note: unknown audit subcommands (e.g. `hippo audit frobnicate`) fall through
  // to the existing memory-quality auditor for back-compat. The audit subcommand
  // dispatcher only intercepts `list` and `prune`. No assertion possible on
  // strict "unknown sub" rejection without breaking back-compat.
});
