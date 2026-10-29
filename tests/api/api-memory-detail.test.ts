// `hippo inspect`'s live values come from the api: the strength at a given time, the aged-out confidence and the
// reward factor.
import { describe, expect, it } from 'vitest';
import { memoryDetail } from '../../src/api/status.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

const DAY_MS = 86_400_000;

describe('memoryDetail', () => {
  it('reads the row at `now`: decayed strength, aged-out confidence and its reward factor', async () => {
    const root = makeRoot('api-memory-detail');
    const entry = {
      ...createMemory('the deploy needs the staging flag', { confidence: 'observed' }),
      outcomePositive: 3,
    };
    writeEntry(root, entry);
    const now = new Date(Date.parse(entry.lastRetrieved) + 40 * DAY_MS);

    const detail = await memoryDetail(apiCtx(root), entry.id, now);

    expect(detail?.entry).toMatchObject({ id: entry.id, confidence: 'observed' });
    expect(detail?.confidence).toBe('stale');
    expect(detail?.liveStrength).toBeLessThan(entry.strength);
    expect(detail?.rewardFactor).toBeGreaterThan(1);
  });

  it('answers null for a row in another tenant', async () => {
    const root = makeRoot('api-memory-detail-tenant');
    const entry = createMemory('tenant a keeps this one', { tenantId: 'a' });
    writeEntry(root, entry);

    expect(await memoryDetail(apiCtx(root, 'b'), entry.id, new Date())).toBeNull();
  });
});
