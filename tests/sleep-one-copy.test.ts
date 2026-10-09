// Sleep reads the store twice (before consolidation, after it) and keeps no deep copy: the
// "as loaded" copy of a row is rebuilt from the row that was read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries, loadAllEntriesWithBase } from '../src/store/entry-reads.js';
import { runSleep } from '../src/api/sleep-run.js';
import { computeAmbientState } from '../src/core/ambient.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import type { Context } from '../src/api/index.js';

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-one-copy-'));
  roots.push(root);
  initStore(root);
  return root;
}

const ctxFor = (hippoRoot: string): Context =>
  ({ hippoRoot, tenantId: 'default', actor: { subject: 'one-copy-test', role: 'admin' } });

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('loadAllEntriesWithBase', () => {
  const seeded = (): string => {
    const root = newRoot();
    for (const text of ['the deploy runs on friday', 'billing is owned by alice', 'staging restarts on sunday']) {
      writeEntry(root, createMemory(text, { tags: ['ops'] }));
    }
    return root;
  };

  it('gives each row as loaded, equal to what loadAllEntries returns', () => {
    const root = seeded();
    const { entries, base } = loadAllEntriesWithBase(root);
    expect(entries).toEqual(loadAllEntries(root));
    for (const e of loadAllEntries(root)) expect(base.get(e.id)).toEqual(e);
  });

  it('stays as loaded after the caller edits the entry in place', () => {
    const root = seeded();
    const { entries, base } = loadAllEntriesWithBase(root);
    const [first] = entries;
    const before = structuredClone(first!);
    first!.tags.push('edited');
    first!.strength = 0.01;
    first!.retrieval_count += 5;
    expect(base.get(first!.id)).toEqual(before);
    expect(base.get(first!.id)).not.toBe(first);
  });

  it('gives undefined for an unknown id and one object for repeat gets', () => {
    const { entries, base } = loadAllEntriesWithBase(seeded());
    expect(base.get('no-such-id')).toBeUndefined();
    expect(base.get(entries[0]!.id)).toBe(base.get(entries[0]!.id));
  });
});

describe('sleep reads the store once after consolidation', () => {
  it('reuses the audit load for the ambient summary, less the rows the audit deleted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-one-copy-home-'));
    roots.push(home);
    vi.stubEnv('HIPPO_HOME', home);
    vi.stubEnv('HIPPO_FAKE_NOW', '2026-06-01T12:00:00.000Z');
    _resetAblationCacheForTests();
    const root = newRoot();
    const kept = ['the deploy runs on friday', 'billing is owned by alice', 'staging restarts on sunday'];
    for (const text of kept) writeEntry(root, createMemory(text, { tags: ['ops'] }));
    const junk = createMemory('nope');
    writeEntry(root, junk);

    let loads = 0;
    const counting = (hippoRoot: string, tenantId?: string) => {
      loads++;
      return loadAllEntries(hippoRoot, tenantId);
    };
    const result = await runSleep(ctxFor(root), { noShare: true }, { loadAllEntries: counting });

    expect(result.audit?.errorsRemoved).toBe(1);
    expect(loads).toBe(1);
    const after = loadAllEntries(root);
    expect(after.some((e) => e.id === junk.id)).toBe(false);
    expect(result.ambient).toEqual(computeAmbientState(after.filter((e) => !e.superseded_by)));
  });
});
