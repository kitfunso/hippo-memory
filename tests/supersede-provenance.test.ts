// Supersede hands the old row's origin and session to its replacement, so a project row stays in its project.
// Real SQLite stores in tmp dirs, no mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/memory.js';
import { initStore, readEntry, writeEntry } from '../src/store.js';
import { supersede, type Context } from '../src/api.js';

let tmpRoot: string;
let projectStore: string;
let globalStore: string;

const ctxFor = (hippoRoot: string): Context =>
  ({ hippoRoot, tenantId: 'default', actor: { subject: 'supersede-provenance-test', role: 'admin' } });

function seed(root: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
  writeEntry(root, entry);
  return entry;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'hippo-supersede-provenance-'));
  projectStore = join(tmpRoot, 'proj', '.hippo');
  globalStore = join(tmpRoot, 'global');
  mkdirSync(projectStore, { recursive: true });
  mkdirSync(globalStore, { recursive: true });
  initStore(projectStore);
  initStore(globalStore);
  vi.stubEnv('HIPPO_HOME', globalStore);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('supersede keeps provenance', () => {
  it('keeps a project row in its project when it is superseded in the global store', () => {
    const old = seed(globalStore, 'the billing service retries a failed charge three times before it pages', {
      origin_project: 'proj-a',
      source_session_id: 'sess-old',
    });

    const { newId } = supersede(ctxFor(globalStore), old.id, 'the billing service retries a failed charge five times before it pages');

    const next = readEntry(globalStore, newId);
    expect(next?.origin_project).toBe('proj-a');
    expect(next?.source_session_id).toBe('sess-old');
    expect(readEntry(globalStore, old.id)?.superseded_by).toBe(newId);
  });

  it('keeps a user-global row user-global in a project store', () => {
    const old = seed(projectStore, 'the release checklist lives in the wiki under the platform section', {
      origin_project: '',
    });

    const { newId } = supersede(ctxFor(projectStore), old.id, 'the release checklist lives in the wiki under the delivery section');

    const next = readEntry(projectStore, newId);
    expect(next?.origin_project).toBe('');
    expect(next?.source_session_id).toBeNull();
  });

  it('lets the store stamp the origin of a legacy row that has none', () => {
    const old = seed(projectStore, 'the nightly export job writes its files to the shared archive bucket', {
      origin_project: null,
    });
    expect(readEntry(projectStore, old.id)?.origin_project).toBeNull();

    const { newId } = supersede(ctxFor(projectStore), old.id, 'the nightly export job writes its files to the cold archive bucket');

    expect(readEntry(projectStore, newId)?.origin_project).toBe('proj');
  });
});
