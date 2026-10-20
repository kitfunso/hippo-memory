// Scratch store, fixed clock and condemned entries the memory-value wiring tests share; each test file gets its own scratch root.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterAll } from 'vitest';
import { Layer, calculateStrength, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { type HippoConfig } from '../../src/base/config/config.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { makeRoot } from '../_helpers/make-root.js';
import type { AuditEvent } from '../../src/store/port/types.js';

/** Sleep and decay here run on the pre-1.46 7-day base, so memories fade within the test's horizon. */
export const createMemory7 = (content: string, options: Parameters<typeof createMemory>[1] = {}) =>
  createMemory(content, { baseHalfLifeDays: 7, ...options });

export const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// mkdtemp per process: two worktrees running this suite at once must not share a root.
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-wiring-test-scratch-'));

export let dir: string;

export function useMemoryValueScratch() {
  beforeEach(() => {
    dir = makeRoot('case', { init: false });
  });
  afterAll(() => {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });
}

/** Fixed clock for every test in this file — removes real-wall-clock drift
 *  from age_days-sensitive scoring assertions. */
export const NOW = new Date('2026-08-10T12:00:00.000Z');
export function ancientDate(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

export function enableMemoryValue(hippoRoot: string, extra: Partial<HippoConfig> = {}): void {
  const configPath = path.join(hippoRoot, 'config.json');
  fs.writeFileSync(
    configPath,
    // dormant off: these gates were pre-registered on the delete path.
    JSON.stringify(
      { memoryValue: { enabled: true }, physics: { enabled: false }, dormant: { enabled: false }, ...extra },
      null,
      2,
    ),
  );
}

/** A condemned-by-construction entry: ancient + half_life_days=1 pushes
 *  clock-basis AND any DecayOptions-basis strength to ~0 regardless of the
 *  configured decayBasis. Only `content` (and therefore content_length,
 *  the largest-magnitude live weight) varies by default across callers that
 *  hold every other field constant — see the rank-determinism comment in
 *  describe('(e) rescue semantics'). */
export function condemnedEntry(
  content: string,
  opts: { layer?: Layer; tenantId?: string; tags?: string[]; confidence?: MemoryEntry['confidence'] } = {},
): MemoryEntry {
  const created = ancientDate(3650);
  const base = createMemory7(content, {
    layer: opts.layer ?? Layer.Semantic,
    tenantId: opts.tenantId,
    tags: opts.tags,
    confidence: opts.confidence,
  });
  const overridden: MemoryEntry = {
    ...base,
    created,
    lastRetrieved: created,
    validFrom: created,
    halfLifeDays: 1,
    retrievalCount: 0,
    outcomePositive: 0,
    outcomeNegative: 0,
    pinned: false,
  };
  // T5 fix (AT1 in-suite flake): single-source the stored `strength` to the
  // same frozen clock basis as every other field above, instead of trusting
  // createMemory's own computed value. createMemory (memory.ts:539) derives
  // its initial strength via calculateStrength(entry) with NO explicit
  // `now`, which defaults to a SECOND, separate evalNow() call -- distinct
  // from the one that stamped created/last_retrieved a few lines earlier
  // (memory.ts:494). Any real clock tick between those two reads makes
  // daysSince a tiny positive epsilon instead of exactly 0, so `base.strength`
  // can land at 0.999999999... instead of 1.0 (confirmed empirically: ~0.1%
  // of calls landed non-unity in a 200k-iteration stress repro -- rare in
  // isolation, likelier under full-suite worker contention, matching the
  // observed isolation-pass/suite-fail split). Re-deriving here against
  // `created` itself as `now` makes daysSince exactly 0 by definition
  // (last_retrieved === created above): strength is exactly 1.0 with zero
  // dependency on the real clock.
  return { ...overridden, strength: calculateStrength(overridden, new Date(created)) };
}

export function hasStringTargetId(e: AuditEvent): e is AuditEvent & { targetId: string } {
  return e.targetId !== null;
}

export function auditRescueRows(hippoRoot: string, tenantId: string) {
  const db = openHippoDb(hippoRoot);
  try {
    return queryAuditEvents(db, { tenantId, op: 'mv_rescue' });
  } finally {
    closeHippoDb(db);
  }
}
