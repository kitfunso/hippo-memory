/** `hippo projects` through the CLI entry: list project names, merge one into another, and the refusals. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Layer, type MemoryEntry } from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initStore } from '../../src/store/sqlite/handles.js';

const savedCwd = process.cwd();
let cwd: string;
let hippoRoot: string;
beforeEach(() => {
  cwd = makeRoot('projects-cli', { init: false });
  hippoRoot = join(cwd, '.hippo');
  mkdirSync(join(cwd, 'global-hippo'));
  initStore(hippoRoot);
  vi.stubEnv('HIPPO_HOME', join(cwd, 'global-hippo'));
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  process.chdir(cwd);
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
});

// A verb that sets process.exitCode instead of exiting reports it here, as the real process would on exit.
async function runVerb(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    return { status: r.status || Number(process.exitCode ?? 0), stdout: r.stdout, stderr: r.stderr };
  } finally {
    process.exitCode = undefined;
  }
}

const hippo = (...args: string[]) => runVerb('projects', ...args);

function seed(text: string, origin: string | null): MemoryEntry {
  const entry = { ...createMemory(text, { layer: Layer.Semantic }), origin_project: origin };
  writeEntry(hippoRoot, entry);
  return entry;
}

const originOf = (id: string): string | null | undefined =>
  loadAllEntries(hippoRoot, 'default').find((e) => e.id === id)?.origin_project;

describe('hippo projects', () => {
  it('lists each project name with its live memory count', async () => {
    seed('the deploy script needs node 22', 'repo');
    seed('the flaky sync test needs a fresh temp dir', 'repo');
    seed('a preference that applies everywhere', '');

    const json = await hippo('list', '--json');
    expect(json.status).toBe(0);
    // SAFETY: --json prints listProjects' rows; the assertions below fail on any other shape.
    const { projects } = JSON.parse(json.stdout) as { projects: Array<{ origin: string | null; live: number }> };
    expect(projects.map((p) => [p.origin, p.live]).sort()).toEqual([
      ['', 1],
      ['repo', 2],
    ]);

    const text = await hippo();
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('2 project names in');
    expect(text.stdout).toMatch(/repo {2}2 memories, 0 imported/);
    expect(text.stdout).toMatch(/\(user-global\) {2}1 memory,/);
  });

  it('a merge dry run writes nothing, and --apply re-tags the rows and leaves a backup', async () => {
    const a = seed('worktree lesson one', 'repo-wt-a');
    const b = seed('worktree lesson two', 'repo-wt-a');
    const other = seed('an unrelated project memory', 'elsewhere');

    const dry = await hippo('merge', 'repo-wt-a', 'repo');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('Dry run: would merge repo-wt-a into repo');
    expect(dry.stdout).toContain('2 memories re-tagged');
    expect(dry.stdout).toContain('Nothing written');
    expect(originOf(a.id)).toBe('repo-wt-a');

    const applied = await hippo('merge', 'repo-wt-a', 'repo', '--apply');
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('Merged repo-wt-a into repo');
    const backup = /Backup: (.+)/.exec(applied.stdout)?.[1]?.trim();
    expect(backup && existsSync(backup)).toBe(true);
    expect([originOf(a.id), originOf(b.id), originOf(other.id)]).toEqual(['repo', 'repo', 'elsewhere']);
  });

  it('refuses to merge into the user-global name and exits non-zero without writing', async () => {
    const a = seed('worktree lesson', 'repo-wt-a');
    const r = await hippo('merge', 'repo-wt-a', ' ', '--apply');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/user-global/);
    expect(originOf(a.id)).toBe('repo-wt-a');
  });

  it('a repair dry run reports counts and writes nothing', async () => {
    seed('a preference that applies everywhere', '');
    const r = await hippo('repair');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Dry run: would repair');
    expect(r.stdout).toContain('0 imported note copies under the wrong project set aside');
    expect(r.stdout).toMatch(/0 re-tagged to their parents' project/);
    expect(r.stdout).toContain('Nothing written');
  });

  it('an unknown subcommand prints usage and exits 1', async () => {
    const r = await hippo('rename');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage: hippo projects');
  });
});
