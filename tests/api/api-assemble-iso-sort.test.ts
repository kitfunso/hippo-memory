import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { assemble } from '../../src/api/index.js';
import { seededRandom } from '../../src/domain/eval/eval-stats.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

describe('assemble ISO sort: byte compare equivalence', () => {
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
    const seed = Number(process.env.HIPPO_TEST_SEED ?? Date.now() % 2 ** 32);
    const random = seededRandom(seed);
    const samples: string[] = [];
    for (let i = 0; i < 100; i++) {
      const epoch = Math.floor(random() * 1_700_000_000_000);
      samples.push(new Date(epoch).toISOString());
    }
    const cmpIso = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byteSorted = [...samples].sort(cmpIso);
    const numericSorted = [...samples].sort((a, b) => Date.parse(a) - Date.parse(b));
    expect(byteSorted, `HIPPO_TEST_SEED=${seed}`).toEqual(numericSorted);
  });
});

describe('assemble ISO sort: integration', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('f4-int');
  });

  it('returns items chronologically ordered by createdAt after byte-cmp sort', async () => {
    const sess = 'sess-F4';
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
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Buffer,
        confidence: 'observed',
        kind: 'raw',
        tenantId: 'default',
        sourceSessionId: sess,
      });
      e.created = expectedTimestamps[i]!;
      writeEntry(root, e);
    }

    const ctx: FullContext = apiCtx(root, 'default', { subject: 'test:f4-int', role: 'admin' });
    const result = await assemble(ctx, sess, { budget: 10_000 });

    const got = result.items.map((it) => it.createdAt);
    for (const t of got) {
      expect(expectedTimestamps).toContain(t);
    }
    for (let i = 1; i < got.length; i++) {
      expect(got[i - 1]!.localeCompare(got[i]!)).toBeLessThanOrEqual(0);
    }
  });
});
