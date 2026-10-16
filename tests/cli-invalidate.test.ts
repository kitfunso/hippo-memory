/**
 * CLI integration tests for `hippo invalidate` safety (2026-06-09 fix):
 * pattern-XOR-id argument contract, value-less --id rejection, --dry-run
 * preview output, and exact-tag matching through the real CLI surface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { runCli as runCliEntry } from '../src/cli.js';
import { clearProjectIdentityCache } from '../src/core/project-identity.js';
import { runInProcess } from './_helpers/run-in-process.js';

const savedCwd = process.cwd();

async function runCli(args: string[], opts: { ok?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
  // A spawned hippo starts with an empty project-identity cache, so each in-process run clears it first.
  const res = await runInProcess(() => { clearProjectIdentityCache(); return runCliEntry(['node', 'hippo', ...args]); });
  if (res.status === 0) return { stdout: res.stdout, stderr: '' };
  if (opts.ok === false) return { stdout: res.stdout, stderr: res.stderr };
  throw new Error(`CLI exit ${res.status}: ${res.stderr}
stdout: ${res.stdout}`);
}

describe('hippo invalidate CLI contract', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hippo-cli-invalidate-'));
    hippoRoot = join(tmpDir, '.hippo');
    initStore(hippoRoot);
    vi.stubEnv('HIPPO_HOME', hippoRoot);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects pattern + --id together', async () => {
    const { stderr } = await runCli(['invalidate', 'pattern', '--id', 'mem_x'], { ok: false });
    expect(stderr).toContain('Pass a pattern OR --id, not both');
  });

  it('rejects neither pattern nor --id', async () => {
    const { stderr } = await runCli(['invalidate'], { ok: false });
    expect(stderr).toContain('Usage: hippo invalidate');
  });

  it('rejects a value-less --id instead of falling through to pattern mode', async () => {
    const { stderr } = await runCli(['invalidate', 'pattern', '--id'], { ok: false });
    expect(stderr).toContain('--id requires a memory id');
  });

  it('--dry-run before the pattern previews without writing (parser allowlist end-to-end)', async () => {
    const mem = createMemory('REST API uses Bearer tokens everywhere', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['api'] });
    writeEntry(hippoRoot, mem);

    const { stdout } = await runCli(['invalidate', '--dry-run', 'REST API']);
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain(mem.id);
    const untouched = readEntry(hippoRoot, mem.id);
    expect(untouched!.tags).not.toContain('invalidated');
    expect(untouched!.confidence).toBe(mem.confidence);
  });

  it('--id invalidates exactly one memory end-to-end', async () => {
    const target = createMemory('Unrelated gardening notes', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['garden'] });
    const other = createMemory('Unrelated cooking notes', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['cooking'] });
    writeEntry(hippoRoot, target);
    writeEntry(hippoRoot, other);

    const { stdout } = await runCli(['invalidate', '--id', target.id]);
    expect(stdout).toContain('Invalidated 1 memories');
    expect(readEntry(hippoRoot, target.id)!.confidence).toBe('stale');
    expect(readEntry(hippoRoot, other.id)!.confidence).toBe(other.confidence);
  });

  it('a pattern merely CONTAINING a tag word does not hit that tag (incident shape)', async () => {
    const bystander = createMemory('Weekly grocery budget tracking notes', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['hippo'] });
    writeEntry(hippoRoot, bystander);

    const { stdout } = await runCli(['invalidate', 'hippo salience gate experiment']);
    expect(stdout).toContain('No memories matched');
    expect(readEntry(hippoRoot, bystander.id)!.tags).not.toContain('invalidated');
  });
});
