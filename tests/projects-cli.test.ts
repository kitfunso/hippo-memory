/** `hippo projects` through the built CLI: list project names, merge one into another, and the refusals. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { Layer, type MemoryEntry } from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let cwd: string;
let hippoRoot: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'hippo-projects-cli-'));
  hippoRoot = join(cwd, '.hippo');
  mkdirSync(join(cwd, 'global-hippo'));
  initStore(hippoRoot);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function hippo(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'projects', ...args], {
    cwd,
    env: { ...process.env, HIPPO_HOME: join(cwd, 'global-hippo'), HIPPO_TENANT: 'default', HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function seed(text: string, origin: string | null): MemoryEntry {
  const entry = { ...createMemory(text, { layer: Layer.Semantic }), origin_project: origin };
  writeEntry(hippoRoot, entry);
  return entry;
}

const originOf = (id: string): string | null | undefined => loadAllEntries(hippoRoot).find((e) => e.id === id)?.origin_project;

describe('hippo projects', () => {
  it('lists each project name with its live memory count', () => {
    seed('the deploy script needs node 22', 'repo');
    seed('the flaky sync test needs a fresh temp dir', 'repo');
    seed('a preference that applies everywhere', '');

    const json = hippo('list', '--json');
    expect(json.status).toBe(0);
    // SAFETY: --json prints listProjects' rows; the assertions below fail on any other shape.
    const { projects } = JSON.parse(json.stdout) as { projects: Array<{ origin: string | null; live: number }> };
    expect(projects.map((p) => [p.origin, p.live]).sort()).toEqual([['', 1], ['repo', 2]]);

    const text = hippo();
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('2 project names in');
    expect(text.stdout).toMatch(/repo {2}2 memories, 0 imported/);
    expect(text.stdout).toMatch(/\(user-global\) {2}1 memory,/);
  });

  it('a merge dry run writes nothing, and --apply re-tags the rows and leaves a backup', () => {
    const a = seed('worktree lesson one', 'repo-wt-a');
    const b = seed('worktree lesson two', 'repo-wt-a');
    const other = seed('an unrelated project memory', 'elsewhere');

    const dry = hippo('merge', 'repo-wt-a', 'repo');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('Dry run: would merge repo-wt-a into repo');
    expect(dry.stdout).toContain('2 memories re-tagged');
    expect(dry.stdout).toContain('Nothing written');
    expect(originOf(a.id)).toBe('repo-wt-a');

    const applied = hippo('merge', 'repo-wt-a', 'repo', '--apply');
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('Merged repo-wt-a into repo');
    const backup = /Backup: (.+)/.exec(applied.stdout)?.[1]?.trim();
    expect(backup && existsSync(backup)).toBe(true);
    expect([originOf(a.id), originOf(b.id), originOf(other.id)]).toEqual(['repo', 'repo', 'elsewhere']);
  });

  it('refuses to merge into the user-global name and exits non-zero without writing', () => {
    const a = seed('worktree lesson', 'repo-wt-a');
    const r = hippo('merge', 'repo-wt-a', ' ', '--apply');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/user-global/);
    expect(originOf(a.id)).toBe('repo-wt-a');
  });

  it('a repair dry run reports counts and writes nothing', () => {
    seed('a preference that applies everywhere', '');
    const r = hippo('repair');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Dry run: would repair');
    expect(r.stdout).toContain('0 imported note copies under the wrong project set aside');
    expect(r.stdout).toMatch(/0 re-tagged to their parents' project/);
    expect(r.stdout).toContain('Nothing written');
  });

  it('an unknown subcommand prints usage and exits 1', () => {
    const r = hippo('rename');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage: hippo projects');
  });
});
