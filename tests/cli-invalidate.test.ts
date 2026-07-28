/**
 * CLI integration tests for `hippo invalidate` safety (2026-06-09 fix):
 * pattern-XOR-id argument contract, value-less --id rejection, --dry-run
 * preview output, and exact-tag matching through the real CLI surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');

function runCli(
  cwd: string,
  args: string[],
  opts: { ok?: boolean } = {},
): { stdout: string; stderr: string } {
  if (!existsSync(CLI)) {
    throw new Error(`bin/hippo.js not found at ${CLI} - run \`npm run build\` first`);
  }
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo') },
    });
    return { stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (opts.ok === false) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    throw new Error(`CLI exit ${e.status}: ${e.stderr ?? ''}\nstdout: ${e.stdout ?? ''}`);
  }
}

describe('hippo invalidate CLI contract', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hippo-cli-invalidate-'));
    hippoRoot = join(tmpDir, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects pattern + --id together', () => {
    const { stderr } = runCli(tmpDir, ['invalidate', 'pattern', '--id', 'mem_x'], { ok: false });
    expect(stderr).toContain('Pass a pattern OR --id, not both');
  });

  it('rejects neither pattern nor --id', () => {
    const { stderr } = runCli(tmpDir, ['invalidate'], { ok: false });
    expect(stderr).toContain('Usage: hippo invalidate');
  });

  it('rejects a value-less --id instead of falling through to pattern mode', () => {
    const { stderr } = runCli(tmpDir, ['invalidate', 'pattern', '--id'], { ok: false });
    expect(stderr).toContain('--id requires a memory id');
  });

  it('--dry-run before the pattern previews without writing (parser allowlist end-to-end)', () => {
    const mem = createMemory('REST API uses Bearer tokens everywhere', { tags: ['api'] });
    writeEntry(hippoRoot, mem);

    const { stdout } = runCli(tmpDir, ['invalidate', '--dry-run', 'REST API']);
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain(mem.id);
    const untouched = readEntry(hippoRoot, mem.id);
    expect(untouched!.tags).not.toContain('invalidated');
    expect(untouched!.confidence).toBe(mem.confidence);
  });

  it('--id invalidates exactly one memory end-to-end', () => {
    const target = createMemory('Unrelated gardening notes', { tags: ['garden'] });
    const other = createMemory('Unrelated cooking notes', { tags: ['cooking'] });
    writeEntry(hippoRoot, target);
    writeEntry(hippoRoot, other);

    const { stdout } = runCli(tmpDir, ['invalidate', '--id', target.id]);
    expect(stdout).toContain('Invalidated 1 memories');
    expect(readEntry(hippoRoot, target.id)!.confidence).toBe('stale');
    expect(readEntry(hippoRoot, other.id)!.confidence).toBe(other.confidence);
  });

  it('a pattern merely CONTAINING a tag word does not hit that tag (incident shape)', () => {
    const bystander = createMemory('Weekly grocery budget tracking notes', { tags: ['hippo'] });
    writeEntry(hippoRoot, bystander);

    const { stdout } = runCli(tmpDir, ['invalidate', 'hippo salience gate experiment']);
    expect(stdout).toContain('No memories matched');
    expect(readEntry(hippoRoot, bystander.id)!.tags).not.toContain('invalidated');
  });
});
