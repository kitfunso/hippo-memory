import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { serveKeyed } from '../_helpers/keyed-server.js';
import type { RecallResult } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { jsonAs } from '../_helpers/http-objects-server.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('http-c5');
  writeEntriesTogether(
    home,
    Array.from({ length: 20 }, (_, i) =>
      createMemory(`omega ${i}`, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Buffer,
        kind: 'raw',
        tenantId: 'default',
      }),
    ),
  );
  handle = await serveKeyed({ hippoRoot: home, port: 0 }, serve);
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP /v1/memories suppressionSummary', () => {
  it('response body includes suppressionSummary with all 6 camelCase counters', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=omega&limit=5`);
    expect(res.status).toBe(200);
    const body = await jsonAs<Partial<RecallResult>>(res);
    expect(body.suppressionSummary).toEqual({
      totalCandidates: 20,
      droppedPreRank: 0,
      droppedByBudget: 15,
      summarySubstitutionsAdded: 0,
      freshTailAdded: 0,
      suppressedByInterference: 0,
    });
  });

  it('droppedByBudget reflects the limit cut over the wire', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=omega&limit=5`);
    const body = await jsonAs<Partial<RecallResult>>(res);
    expect(body.results).toHaveLength(5);
    expect(body.suppressionSummary!.droppedByBudget).toBe(15);
  });
});
