import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterAll } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { calculateStrength } from '../../src/entry/memory.js';
import { createMemory } from './default-half-life-memory.js';
import { type HippoConfig } from '../../src/base/config/config.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { makeRoot } from './make-root.js';
import type { AuditEvent } from '../../src/base/ports/store/types.js';

/** Sleep and decay here run on the pre-1.46 7-day base, so memories fade within the test's horizon. */
export const createMemory7 = (content: string, options: Parameters<typeof createMemory>[1] = {}) =>
  createMemory(content, { baseHalfLifeDays: 7, ...options });

export const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

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
  return { ...overridden, strength: calculateStrength(overridden, new Date(created)) };
}

export function hasStringTargetId(e: AuditEvent): e is AuditEvent & { targetId: string } {
  return e.targetId !== null;
}

export function auditRescueRows(hippoRoot: string, tenantId: string) {
  const db = openHippoDb(hippoRoot);
  try {
    return listAuditEvents(db, { tenantId, op: 'mv_rescue' });
  } finally {
    closeHippoDb(db);
  }
}
