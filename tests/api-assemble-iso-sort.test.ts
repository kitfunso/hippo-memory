import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind, type MemoryEntry } from '../src/memory.js';
import { assemble, type Context } from '../src/api.js';

/**
 * F4 — byte compare canonical UTC ISO timestamps instead of localeCompare.
 *
 * Canonical UTC ISO (`Date.prototype.toISOString()`) is 24 chars, fixed-width,
 * trailing `Z`. Byte compare is chronological for these strings; localeCompare
 * does locale-aware Unicode collation (~50× slower) with no semantic benefit.
 *
 * Tests cover three layers:
 *   1. Pure equivalence — byte cmp matches localeCompare on a fixed sample
 *      across cross-second / minute / hour / day / month / year + epoch +
 *      max date, plus a randomized 100-sample cross-check vs Date.parse.
 *   2. Assemble integration — call api.assemble against a real store with
 *      raw rows inserted in shuffled creation order; assert items come back
 *      sorted ascending by createdAt under the byte-cmp swap.
 */
describe('assemble ISO sort (F4) — byte compare equivalence', () => {
  it('byte compare matches localeCompare for canonical UTC ISO timestamps', () => {
    const isoSamples = [
      '2026-05-06T00:00:00.000Z',
      '2026-05-06T00:00:00.001Z',
      '2026-05-06T00:00:00.999Z',
      '2026-05-06T00:00:01.000Z',
      '2026-05-06T00:01:00.000Z',
      '2026-05-06T01:00:00.000Z',
      '2026-05-06T23:59:59.999Z',
      '2026-05-07T00:00:00.000Z',
      '2026-06-06T00:00:00.000Z',
      '2027-05-06T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z',
      '1970-01-01T00:00:00.001Z',
      '2099-12-31T23:59:59.999Z',
    ];
    const cmpIso = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byteSorted = [...isoSamples].sort(cmpIso);
    const localeSorted = [...isoSamples].sort((a, b) => a.localeCompare(b));
    expect(byteSorted).toEqual(localeSorted);
  });

  it('byte compare matches Date-numeric ordering for randomized canonical ISO inputs', () => {
    // Random check across 100 generated timestamps spanning ~50 years.
    const samples: string[] = [];
    for (let i = 0; i < 100; i++) {
      const epoch = Math.floor(Math.random() * 1_700_000_000_000);
      samples.push(new Date(epoch).toISOString());
    }
    const cmpIso = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byteSorted = [...samples].sort(cmpIso);
    const numericSorted = [...samples].sort(
      (a, b) => Date.parse(a) - Date.parse(b),
    );
    expect(byteSorted).toEqual(numericSorted);
  });
});

/**
 * Assemble integration — confirms the byte-cmp swap actually orders items
 * the way callers expect. Inserts raws with shuffled `created` timestamps,
 * calls api.assemble, asserts the returned items are chronologically
 * ascending by `createdAt`.
 */
describe('assemble ISO sort (F4) — integration', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-f4-int-'));
    mkdirSync(join(root, '.hippo'), { recursive: true });
    initStore(root);
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('returns items chronologically ordered by createdAt after byte-cmp sort', () => {
    const sess = 'sess-F4';
    // Insert in shuffled order so any sort failure is caught (insertion
    // order is NOT chronological; fixture timestamps are).
    const fixtureOrder = [3, 0, 4, 1, 2];
    const expectedTimestamps = [
      '2026-05-06T00:00:00.000Z',
      '2026-05-06T00:00:01.500Z',
      '2026-05-06T00:01:00.000Z',
      '2026-05-06T01:00:00.000Z',
      '2026-05-07T00:00:00.000Z',
    ];
    for (const i of fixtureOrder) {
      const e: MemoryEntry = createMemory(`row ${i}`, {
        layer: Layer.Buffer,
        confidence: 'observed',
        kind: 'raw' as MemoryKind,
        tenantId: 'default',
        source_session_id: sess,
      });
      e.created = expectedTimestamps[i]!;
      writeEntry(root, e);
    }

    const ctx: Context = { hippoRoot: root, tenantId: 'default', actor: 'test:f4-int' };
    const result = assemble(ctx, sess, { budget: 10_000 });

    // Strip down to the createdAt strings on returned items, in returned order.
    const got = result.items.map((it) => it.createdAt);
    // Every returned timestamp must come from our fixture (no extras).
    for (const t of got) {
      expect(expectedTimestamps).toContain(t);
    }
    // Returned order must be ascending byte-cmp on canonical ISO.
    for (let i = 1; i < got.length; i++) {
      expect(got[i - 1]!.localeCompare(got[i]!)).toBeLessThanOrEqual(0);
    }
  });
});
