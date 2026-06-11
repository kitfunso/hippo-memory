/**
 * E1 longitudinal harness — invariant tests (pre-run gates from the frozen
 * design: rev #3 mutation/measurement split, rev #8 timestamp invariants,
 * rev #10 ablation wiring; outcome targeting via explicit ids).
 *
 * Real stores (house rule), tiny protocol sizes so the whole file stays fast.
 * Env isolation: the driver owns ablation env vars during runArmSeed and
 * clears them in its finally; tests also clear in beforeEach/afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// @ts-expect-error - .mjs harness modules have no type declarations
import { generateProtocol } from '../scripts/e1-lifecycle/generate.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { runArmSeed } from '../scripts/e1-lifecycle/run.mjs';
import { loadAllEntries } from '../src/store.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';

const ABLATION_ENV_VARS = [
  'HIPPO_ABLATE_DECAY',
  'HIPPO_ABLATE_RECALL_BOOST',
  'HIPPO_ABLATE_OUTCOME',
  'HIPPO_ABLATE_OUTCOME_SLOW',
  'HIPPO_ABLATE_OUTCOME_FAST',
  'HIPPO_FAKE_NOW',
] as const;

function clearAblationEnv(): void {
  for (const v of ABLATION_ENV_VARS) delete process.env[v];
  _resetAblationCacheForTests();
}
beforeEach(clearAblationEnv);
afterEach(clearAblationEnv);

const TINY = { numFacts: 12, numSessions: 6, distractorMultiple: 4 };

describe('E1 generator', () => {
  it('is deterministic: same seed => byte-identical protocol', () => {
    const a = JSON.stringify(generateProtocol({ seed: 7, ...TINY }));
    const b = JSON.stringify(generateProtocol({ seed: 7, ...TINY }));
    expect(a).toBe(b);
    const c = JSON.stringify(generateProtocol({ seed: 8, ...TINY }));
    expect(a).not.toBe(c);
  });

  it('honors the registered fractions and structural invariants', () => {
    const p = generateProtocol({ seed: 1, numFacts: 50, numSessions: 10, distractorMultiple: 10 });
    // 40% updates, 10% contradictions (exact via shuffled-slice draws).
    const updatedFacts = new Set(p.memories.filter((m: any) => m.kind === 'update').map((m: any) => m.factId));
    expect(updatedFacts.size).toBe(20);
    expect(p.memories.filter((m: any) => m.kind === 'contradiction').length).toBe(5);
    // Updates and contradictions are DISJOINT (codex P2): a contradicted fact
    // never has a version chain, so contradiction-intrusion is unconfounded.
    const contraFacts = new Set(p.memories.filter((m: any) => m.kind === 'contradiction').map((m: any) => m.factId));
    for (const cf of contraFacts) expect(updatedFacts.has(cf)).toBe(false);
    // Hard-negative pool >= 10x facts.
    expect(p.meta.counts.distractors).toBeGreaterThanOrEqual(500);
    // Version timelines strictly ordered; updates strictly after v1.
    for (const probe of p.probes) {
      const sessions = probe.versionTimeline.map((s: any) => s.session);
      for (let i = 1; i < sessions.length; i++) expect(sessions[i]).toBeGreaterThan(sessions[i - 1]);
    }
    // Every outcome target exists and is scheduled at/after its ingestion session.
    const memById = new Map(p.memories.map((m: any) => [m.id, m]));
    for (const o of p.outcomeSchedule) {
      const m = memById.get(o.memoryRef) as any;
      expect(m).toBeDefined();
      expect(o.session).toBeGreaterThanOrEqual(m.session);
    }
    // Traps are bad-marked; some positive outcomes exist.
    const trapIds = new Set(p.memories.filter((m: any) => m.kind === 'trap').map((m: any) => m.id));
    expect(p.outcomeSchedule.filter((o: any) => !o.good).every((o: any) => trapIds.has(o.memoryRef))).toBe(true);
    expect(p.outcomeSchedule.some((o: any) => o.good)).toBe(true);
  });
});

describe('E1 driver', () => {
  it('full arm: simulated time stamps the store; metrics emitted per epoch', async () => {
    let storeSeen = false;
    const result = await runArmSeed('full', 3, TINY, (hippoRoot: string) => {
      storeSeen = true;
      const entries = loadAllEntries(hippoRoot);
      expect(entries.length).toBeGreaterThan(0);
      // Every created timestamp lies within the protocol's simulated range -
      // nothing stamped with the real 2026 clock (rev #8 invariant).
      for (const e of entries) {
        expect(Date.parse(e.created)).toBeGreaterThanOrEqual(Date.parse('2025-01-06T00:00:00.000Z'));
        expect(Date.parse(e.created)).toBeLessThan(Date.parse('2025-06-01T00:00:00.000Z'));
      }
      // Scheduled retrievals strengthened SOMETHING (full arm: writes live).
      expect(entries.some((e) => e.retrieval_count > 0)).toBe(true);
    });
    expect(storeSeen).toBe(true);
    expect(result.epochs.length).toBe(TINY.numSessions);
    const last = result.epochs[TINY.numSessions - 1];
    expect(last.activeProbes).toBe(TINY.numFacts);
    expect(last.currentR5).not.toBeNull();
    expect(result.meta.protocolHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('strengthen-off arm: zero retrieval writes, outcome attribution still lands', async () => {
    await runArmSeed('strengthen-off', 3, TINY, (hippoRoot: string) => {
      const entries = loadAllEntries(hippoRoot);
      // No strengthening writes anywhere (rev #10: the arm isolates one mechanism).
      expect(entries.every((e) => e.retrieval_count === 0)).toBe(true);
      // Outcomes still applied via explicit ids (codex round-7 coupling fix):
      // traps received --bad despite strengthening being off.
      expect(entries.some((e) => (e.outcome_negative ?? 0) > 0)).toBe(true);
    });
  });

  it('probes are read-only: an all-off arm leaves zero retrieval state', async () => {
    await runArmSeed('all-off', 5, TINY, (hippoRoot: string) => {
      const entries = loadAllEntries(hippoRoot);
      // Probes ran every epoch over these entries; none of them wrote back.
      expect(entries.every((e) => e.retrieval_count === 0)).toBe(true);
      expect(entries.every((e) => e.half_life_days <= 90)).toBe(true); // no +2 accumulation beyond derive caps
    });
  });

  it('driver cleans its env: no ablation vars leak after a run', async () => {
    await runArmSeed('decay-off', 2, TINY);
    for (const v of ABLATION_ENV_VARS) expect(process.env[v]).toBeUndefined();
  });

  it('is REPRODUCIBLE: identical (arm, seed) runs produce identical metrics (codex P1)', async () => {
    // The protocol intentionally creates score ties (identical-form
    // negatives); with random entry UUIDs, tie order differed across runs of
    // the same seed. Entry ids are now derived from (seed, protocol id) -
    // two full runs must agree to the byte.
    const a = await runArmSeed('full', 11, TINY);
    const b = await runArmSeed('full', 11, TINY);
    expect(JSON.stringify(a.epochs)).toBe(JSON.stringify(b.epochs));
    expect(a.meta.protocolHash).toBe(b.meta.protocolHash);
  }, 60_000); // two full real-store runs; default 5s timeout is a CI flake (codex P2)

  it('baseline arms produce rankings (bm25-static + recency-window)', async () => {
    const bm25 = await runArmSeed('bm25-static', 4, TINY);
    const rec = await runArmSeed('recency-window', 4, TINY);
    expect(bm25.epochs[TINY.numSessions - 1].currentR5).not.toBeNull();
    expect(rec.epochs[TINY.numSessions - 1].currentR5).not.toBeNull();
  });
});
