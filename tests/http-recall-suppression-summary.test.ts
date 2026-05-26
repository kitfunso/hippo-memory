/**
 * v1.12.13 / C5 — WYSIATI cutoff transparency wire-format parity (HTTP path).
 *
 * Asserts:
 * 1. GET /v1/memories?q=... response body includes `suppressionSummary` with
 *    all 6 camelCase counters (matching the api.recall TS interface).
 * 2. Counters reflect actual filter activity (droppedByBudget non-zero when
 *    candidates > limit).
 * 3. Back-compat: a payload WITHOUT `suppressionSummary` (legacy server
 *    pre-v1.12.13) still parses into the TS RecallResult shape because the
 *    field is optional.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';
import type { RecallResult, RecallSuppressionSummary } from '../src/api.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-c5-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot();
  // Seed 20 query-matching memories so droppedByBudget > 0 when limit < 20.
  for (let i = 0; i < 20; i++) {
    writeEntry(home, createMemory(`omega ${i}`, {
      layer: Layer.Buffer,
      kind: 'raw' as MemoryKind,
      tenantId: 'default',
    }));
  }
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP /v1/memories suppressionSummary (C5 WYSIATI, v1.12.13)', () => {
  it('response body includes suppressionSummary with all 6 camelCase counters', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=omega&limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Partial<RecallResult>;
    expect(body.suppressionSummary).toBeDefined();
    const s = body.suppressionSummary!;
    // All 6 camelCase fields present on the wire.
    expect(s).toHaveProperty('totalCandidates');
    expect(s).toHaveProperty('droppedPreRank');
    expect(s).toHaveProperty('droppedByBudget');
    expect(s).toHaveProperty('summarySubstitutionsAdded');
    expect(s).toHaveProperty('freshTailAdded');
    expect(s).toHaveProperty('suppressedByInterference');
  });

  it('droppedByBudget reflects the limit cut over the wire', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=omega&limit=5`);
    const body = (await res.json()) as Partial<RecallResult>;
    expect(body.results!.length).toBeLessThanOrEqual(5);
    // 20 candidates, limit 5 -> 15 dropped by budget.
    expect(body.suppressionSummary!.droppedByBudget).toBeGreaterThanOrEqual(15);
  });

  it('suppressedByInterference is 0 in v1.12.13 (placeholder)', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=omega&limit=5`);
    const body = (await res.json()) as Partial<RecallResult>;
    expect(body.suppressionSummary!.suppressedByInterference).toBe(0);
  });

  it('back-compat: TS RecallResult type accepts a pre-v1.12.13 payload without suppressionSummary', () => {
    // Hand-construct a literal pre-v1.12.13-shaped response (no
    // suppressionSummary key). Cast to the new type and verify the field
    // is undefined (not throwing). This proves the field is forever
    // optional and existing clients receiving pre-v1.12.13 server payloads
    // do not break.
    const legacyPayload: RecallResult = {
      results: [],
      total: 0,
      tokens: 0,
      windowSize: 200,
      // NOTE: no suppressionSummary key
    };
    expect(legacyPayload.suppressionSummary).toBeUndefined();
    // And the type system accepts construction with the field present too.
    const newPayload: RecallResult = {
      results: [],
      total: 0,
      tokens: 0,
      windowSize: 200,
      suppressionSummary: {
        totalCandidates: 0,
        droppedPreRank: 0,
        droppedByBudget: 0,
        summarySubstitutionsAdded: 0,
        freshTailAdded: 0,
        suppressedByInterference: 0,
      } satisfies RecallSuppressionSummary,
    };
    expect(newPayload.suppressionSummary).toBeDefined();
  });
});
