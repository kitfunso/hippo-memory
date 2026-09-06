import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { consolidate } from '../src/consolidate.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory, resolveConfidence, type MemoryEntry } from '../src/memory.js';
import { markRetrieved } from '../src/search.js';
import { sampleForReplay } from '../src/replay.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-confidence-tier-'));
  // replay picking this test's own fixtures would confound the assertions
  // on stored confidence, so disable it via the store's own config file.
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function agedEntry(overrides: Partial<MemoryEntry> & { confidence: MemoryEntry['confidence'] }): MemoryEntry {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  return {
    ...createMemory('an aged memory used to probe the confidence tier', { confidence: overrides.confidence }),
    last_retrieved: old,
    half_life_days: 3650, // survives DECAY_THRESHOLD so it stays a survivor
    ...overrides,
  };
}

describe('confidence tier survives sleep', () => {
  it('an inferred memory stays inferred through sleep and markRetrieved, never silently upgraded', async () => {
    initStore(tmpDir);
    const entry = agedEntry({ confidence: 'inferred' });
    writeEntry(tmpDir, entry);
    expect(readEntry(tmpDir, entry.id)!.confidence).toBe('inferred');

    await consolidate(tmpDir, { now: new Date() });
    const afterSleep = readEntry(tmpDir, entry.id)!;
    expect(afterSleep.confidence).toBe('inferred');
    expect(resolveConfidence(afterSleep, new Date())).toBe('stale');

    const [afterRecall] = markRetrieved([afterSleep]);
    expect(afterRecall.confidence).toBe('inferred');
  });

  it('distinguishes an aged-out stored tier from a deliberately invalidated one', async () => {
    initStore(tmpDir);
    const now = new Date();
    const aged = agedEntry({ confidence: 'observed' });
    const invalidated = agedEntry({ confidence: 'stale', tags: ['invalidated'] });
    writeEntry(tmpDir, aged);
    writeEntry(tmpDir, invalidated);

    await consolidate(tmpDir, { now });

    const loadedAged = readEntry(tmpDir, aged.id)!;
    expect(loadedAged.confidence).toBe('observed');
    expect(resolveConfidence(loadedAged, now)).toBe('stale');

    const loadedInvalidated = readEntry(tmpDir, invalidated.id)!;
    expect(loadedInvalidated.confidence).toBe('stale');
  });

  it('replay skips both an aged-out survivor and a deliberately marked one', () => {
    const now = new Date();
    const aged = agedEntry({ confidence: 'observed' });
    const marked = agedEntry({ confidence: 'stale' });
    const fresh = { ...agedEntry({ confidence: 'observed' }), last_retrieved: now.toISOString() };

    const picked = sampleForReplay([aged, marked, fresh], 3, now, 42);
    expect(picked.map((e) => e.id)).toEqual([fresh.id]);
  });

  it('verified and pinned memories are exempt from staleness regardless of age', async () => {
    initStore(tmpDir);
    const now = new Date();
    const verified = agedEntry({ confidence: 'verified' });
    const pinned = { ...agedEntry({ confidence: 'observed' }), pinned: true };
    writeEntry(tmpDir, verified);
    writeEntry(tmpDir, pinned);

    await consolidate(tmpDir, { now });

    expect(resolveConfidence(readEntry(tmpDir, verified.id)!, now)).toBe('verified');
    expect(resolveConfidence(readEntry(tmpDir, pinned.id)!, now)).toBe('observed');
  });
});
