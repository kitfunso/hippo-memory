/**
 * CLI integration tests for `hippo audit prune` (v1.12.9).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');

interface RunOpts {
  ok?: boolean;
  env?: Record<string, string>;
}

function runCli(cwd: string, args: string[], opts: RunOpts = {}): { stdout: string; stderr: string } {
  if (!existsSync(CLI)) {
    throw new Error(`bin/hippo.js not found at ${CLI} - run \`npm run build\` first`);
  }
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo'), ...(opts.env ?? {}) },
    });
    return { stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (opts.ok === false) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    throw new Error(`CLI exit ${e.status}: ${e.stderr ?? ''}\nstdout: ${e.stdout ?? ''}`);
  }
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
    root = mkdtempSync(join(tmpdir(), 'hippo-audit-prune-cli-'));
    initStore(join(root, '.hippo'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prunes rows older than the cutoff and reports the count', () => {
    seed(root, 'default', 100, 5);
    seed(root, 'default', 1, 3);

    const { stdout } = runCli(root, ['audit', 'prune', '--older-than', '30d']);
    expect(stdout).toMatch(/deleted 5 rows for tenant "default"/);
    expect(stdout).toMatch(/with ts < \d{4}-\d{2}-\d{2}T/);
  });

  it('--dry-run reports count without deleting', () => {
    seed(root, 'default', 100, 7);

    const { stdout } = runCli(root, ['audit', 'prune', '--older-than', '30d', '--dry-run']);
    expect(stdout).toMatch(/would delete 7 rows/);
    expect(stdout).toMatch(/dry-run; re-run without --dry-run/);

    // Confirm nothing was actually deleted (rerun real prune still finds 7).
    const { stdout: stdout2 } = runCli(root, ['audit', 'prune', '--older-than', '30d']);
    expect(stdout2).toMatch(/deleted 7 rows/);
  });

  it('--json emits machine-readable {cutoff, count, dryRun}', () => {
    seed(root, 'default', 100, 2);

    const { stdout } = runCli(root, ['audit', 'prune', '--older-than', '30d', '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(2);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts plain integer days (no d suffix)', () => {
    seed(root, 'default', 100, 1);
    const { stdout } = runCli(root, ['audit', 'prune', '--older-than', '30']);
    expect(stdout).toMatch(/deleted 1 row /); // singular
  });

  it('--tenant scopes the prune to a specific tenant', () => {
    seed(root, 'tenant-a', 100, 4);
    seed(root, 'tenant-b', 100, 6);

    const { stdout } = runCli(root, ['audit', 'prune', '--older-than', '30d', '--tenant', 'tenant-a']);
    expect(stdout).toMatch(/deleted 4 rows for tenant "tenant-a"/);

    // tenant-b should be untouched
    const { stdout: stdout2 } = runCli(root, ['audit', 'prune', '--older-than', '30d', '--tenant', 'tenant-b', '--dry-run']);
    expect(stdout2).toMatch(/would delete 6 rows/);
  });

  it('rejects missing --older-than with usage error', () => {
    const { stderr } = runCli(root, ['audit', 'prune'], { ok: false });
    expect(stderr).toMatch(/Usage: hippo audit prune --older-than/);
  });

  it('rejects invalid --older-than value', () => {
    const { stderr } = runCli(root, ['audit', 'prune', '--older-than', 'abc'], { ok: false });
    expect(stderr).toMatch(/Invalid --older-than/);
  });

  it('--help short-circuits and prints usage', () => {
    const { stdout } = runCli(root, ['audit', 'prune', '--help']);
    expect(stdout).toMatch(/--older-than.*Nd/);
    expect(stdout).toMatch(/--dry-run/);
    expect(stdout).toMatch(/--tenant/);
  });

  // Note: unknown audit subcommands (e.g. `hippo audit frobnicate`) fall through
  // to the existing memory-quality auditor for back-compat. The audit subcommand
  // dispatcher only intercepts `list` and `prune`. No assertion possible on
  // strict "unknown sub" rejection without breaking back-compat.
});
