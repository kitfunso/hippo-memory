// Supersede hands the old row's origin and session to its replacement, so a project row stays in its project.
// Real SQLite stores in tmp dirs, no mocks.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMemory,
  createSuccessor,
  DEFAULT_HALF_LIFE_DAYS,
  Layer,
  type MemoryEntry,
} from '../../src/core/memory.js';
import { supersede } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';
import { initStore } from '../../src/store/sqlite/handles.js';

let tmpRoot: string;
let projectStore: string;
let globalStore: string;

const ctxFor = (hippoRoot: string): FullContext =>
  apiCtx(hippoRoot, 'default', { subject: 'supersede-provenance-test', role: 'admin' });

function seed(root: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
  writeEntry(root, entry);
  return entry;
}

beforeEach(() => {
  tmpRoot = makeRoot('supersede-provenance', { init: false });
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
});

describe('supersede keeps provenance', () => {
  it('keeps a project row in its project when it is superseded in the global store', async () => {
    const old = seed(globalStore, 'the billing service retries a failed charge three times before it pages', {
      originProject: 'proj-a',
      sourceSessionId: 'sess-old',
    });

    const { newId } = await supersede(
      ctxFor(globalStore),
      old.id,
      'the billing service retries a failed charge five times before it pages',
    );

    const next = readEntry(globalStore, newId);
    expect(next?.originProject).toBe('proj-a');
    expect(next?.sourceSessionId).toBe('sess-old');
    expect(readEntry(globalStore, old.id)?.supersededBy).toBe(newId);
  });

  it('keeps a user-global row user-global in a project store', async () => {
    const old = seed(projectStore, 'the release checklist lives in the wiki under the platform section', {
      originProject: '',
    });

    const { newId } = await supersede(
      ctxFor(projectStore),
      old.id,
      'the release checklist lives in the wiki under the delivery section',
    );

    const next = readEntry(projectStore, newId);
    expect(next?.originProject).toBe('');
    expect(next?.sourceSessionId).toBeNull();
  });

  it('lets the store stamp the origin of a legacy row that has none', async () => {
    const old = seed(projectStore, 'the nightly export job writes its files to the shared archive bucket', {
      originProject: null,
    });
    expect(readEntry(projectStore, old.id)?.originProject).toBeNull();

    const { newId } = await supersede(
      ctxFor(projectStore),
      old.id,
      'the nightly export job writes its files to the cold archive bucket',
    );

    expect(readEntry(projectStore, newId)?.originProject).toBe('proj');
  });
});

describe('createSuccessor', () => {
  const opts = { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS };
  const oldRow = (extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
    ...createMemory('the deploy pipeline signs every artifact before upload', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      tags: ['deploy', 'signing'],
      pinned: true,
      source: 'compaction:sess-old',
      scope: 'project:billing',
    }),
    sourceSessionId: 'sess-old',
    originProject: 'proj-a',
    ...extra,
  });

  it('keeps source, scope, session and origin, and defaults layer, tags and pin to the old row', () => {
    const old = oldRow();

    const next = createSuccessor(old, 'the deploy pipeline signs and scans every artifact before upload', opts);

    expect(next.id).not.toBe(old.id);
    expect(next.content).toBe('the deploy pipeline signs and scans every artifact before upload');
    expect(next.source).toBe('compaction:sess-old');
    expect(next.scope).toBe('project:billing');
    expect(next.sourceSessionId).toBe('sess-old');
    expect(next.originProject).toBe('proj-a');
    expect(next.layer).toBe(Layer.Semantic);
    expect(next.tags).toEqual(['deploy', 'signing']);
    expect(next.tags).not.toBe(old.tags);
    expect(next.pinned).toBe(true);
    expect(next.confidence).toBe('verified');
    expect(next.supersededBy).toBeNull();
  });

  it('keeps a user-global origin', () => {
    expect(
      createSuccessor(oldRow({ originProject: '' }), 'the deploy pipeline now signs twice', opts).originProject,
    ).toBe('');
  });

  it('leaves a legacy null or unset origin unset so the store stamps it', () => {
    expect(
      createSuccessor(oldRow({ originProject: null }), 'the deploy pipeline now signs twice', opts).originProject,
    ).toBeUndefined();
    expect(
      createSuccessor(oldRow({ originProject: undefined }), 'the deploy pipeline now signs twice', opts).originProject,
    ).toBeUndefined();
  });

  it('lets layer, tags and pinned overrides win, including an empty tag list and pinned false', () => {
    const next = createSuccessor(oldRow(), 'the deploy pipeline now signs twice', {
      ...opts,
      layer: Layer.Episodic,
      tags: [],
      pinned: false,
    });

    expect(next.layer).toBe(Layer.Episodic);
    expect(next.tags).toEqual([]);
    expect(next.pinned).toBe(false);
    expect(next.sourceSessionId).toBe('sess-old');
    expect(next.originProject).toBe('proj-a');
  });

  it('takes the tenant from the options', () => {
    expect(
      createSuccessor(oldRow(), 'the deploy pipeline now signs twice', { ...opts, tenantId: 'tenant-b' }).tenantId,
    ).toBe('tenant-b');
  });
});
