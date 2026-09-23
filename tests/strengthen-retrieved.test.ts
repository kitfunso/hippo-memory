// Recall strengthening updates the live row's four retrieval columns, never a stale copy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';
import { initStore, writeEntry, readEntry, strengthenRetrieved } from '../src/store.js';

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-strengthen-'));
  roots.push(root);
  initStore(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('strengthenRetrieved', () => {
  it('keeps an edit made after the read and reports only the ids it found', () => {
    const root = newRoot();
    const e = createMemory('the deploy runs on fridays after the freeze');
    writeEntry(root, e);
    const returned = readEntry(root, e.id)!;
    writeEntry(root, { ...returned, tags: ['edited-meanwhile'] });

    const found = strengthenRetrieved(root, [e.id, 'no-such-id']);

    expect([...found]).toEqual([e.id]);
    const after = readEntry(root, e.id)!;
    expect(after.tags).toEqual(['edited-meanwhile']);
    expect(after.retrieval_count).toBe(returned.retrieval_count + 1);
    expect(after.half_life_days).toBe(returned.half_life_days + 2);
  });

  it('leaves a row in another tenant alone', () => {
    const root = newRoot();
    const e = createMemory('the staging cluster restarts every sunday');
    writeEntry(root, e);

    expect(strengthenRetrieved(root, [e.id], 'some-other-tenant').size).toBe(0);
    expect(readEntry(root, e.id)!.retrieval_count).toBe(0);
  });

  it('logs one line and never throws when the store cannot be opened', () => {
    const notAStore = join(newRoot(), 'not-a-store');
    writeFileSync(notAStore, 'a plain file where the store should be');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(strengthenRetrieved(notAStore, ['any-id']).size).toBe(0);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toMatch(/^hippo: retrieval stats not saved \(/);
  });
});
