/**
 * v1.12.13 / C5 — WYSIATI cutoff transparency wire-format parity (HTTP path).
 *
 * Asserts:
 * 1. GET /v1/memories?q=... response body includes `suppressionSummary` with
 *    all 6 camelCase counters (matching the api.recall TS interface).
 * 2. Counters reflect actual filter activity (droppedByBudget non-zero when
 *    candidates > limit).
 * The field staying optional needs no test here: resultOf in src/api/recall/request.ts builds a RecallResult without
 * it, so `npm run typecheck:tests` fails the day it turns required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { serve, type ServerHandle } from '../../src/server.js';
import type { RecallResult } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every call site below targets GET /v1/memories under test in
  // this file; the response is the api.recall RecallResult contract
  // (imported above), checked field-by-field by the assertions immediately
  // following each call.
  return res.json() as Promise<T>;
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('http-c5');
  // Seed 20 query-matching memories so droppedByBudget > 0 when limit < 20.
  for (let i = 0; i < 20; i++) {
    writeEntry(
      home,
      createMemory(`omega ${i}`, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Buffer,
        kind: 'raw',
        tenantId: 'default',
      }),
    );
  }
  handle = await serve({ hippoRoot: home, port: 0 });
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
    // All 6 camelCase fields on the wire: 20 seeded matches, none filtered before rank, no session, summary or tail.
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
    // 20 candidates, limit 5 -> 15 dropped by budget.
    expect(body.suppressionSummary!.droppedByBudget).toBe(15);
  });
});
