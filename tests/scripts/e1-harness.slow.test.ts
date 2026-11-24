import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateProtocol } from '../../scripts/e1-lifecycle/generate.mjs';
import { runArmSeed } from '../../scripts/e1-lifecycle/run.mjs';
import { loadAllEntries } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const ABLATION_ENV_VARS = [
  'HIPPO_ABLATE_DECAY',
  'HIPPO_ABLATE_RECALL_BOOST',
  'HIPPO_ABLATE_OUTCOME',
  'HIPPO_ABLATE_OUTCOME_SLOW',
  'HIPPO_ABLATE_OUTCOME_FAST',
  'HIPPO_ABLATE_RECENCY',
  'HIPPO_EVAL_RECENCY_DAYS',
  'HIPPO_FAKE_NOW',
] as const;

function clearAblationEnv(): void {
  for (const v of ABLATION_ENV_VARS) vi.stubEnv(v, undefined);
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
    const updatedFacts = new Set(p.memories.filter((m: any) => m.kind === 'update').map((m: any) => m.factId));
    expect(updatedFacts.size).toBe(20);
    expect(p.memories.filter((m: any) => m.kind === 'contradiction').length).toBe(5);
    const contraFacts = new Set(p.memories.filter((m: any) => m.kind === 'contradiction').map((m: any) => m.factId));
    for (const cf of contraFacts) expect(updatedFacts.has(cf)).toBe(false);
    expect(p.meta.counts.distractors).toBeGreaterThanOrEqual(500);
    for (const probe of p.probes) {
      const sessions = probe.versionTimeline.map((s: any) => s.session);
      for (let i = 1; i < sessions.length; i++) expect(sessions[i]).toBeGreaterThan(sessions[i - 1]);
    }
    const memById = new Map<string, { session: number }>(p.memories.map((m: any) => [m.id, m]));
    for (const o of p.outcomeSchedule) {
      const m = memById.get(o.memoryRef);
      if (m === undefined) throw new Error(`outcome targets missing memory ${o.memoryRef}`);
      expect(o.session).toBeGreaterThanOrEqual(m.session);
    }
    const trapIds = new Set(p.memories.filter((m: any) => m.kind === 'trap').map((m: any) => m.id));
    expect(p.outcomeSchedule.filter((o: any) => !o.good).every((o: any) => trapIds.has(o.memoryRef))).toBe(true);
    expect(p.outcomeSchedule.some((o: any) => o.good)).toBe(true);
  });

  it("lookalikeWindow: the default is byte-identical; 'v1' only moves distractor sessions", () => {
    const base = generateProtocol({ seed: 5, ...TINY });
    expect(JSON.stringify(generateProtocol({ seed: 5, ...TINY, lookalikeWindow: 'all' }))).toBe(JSON.stringify(base));
    const v1 = generateProtocol({ seed: 5, ...TINY, lookalikeWindow: 'v1' });
    expect(v1.meta.lookalikeWindow).toBe('v1');
    const floor = Math.floor(TINY.numSessions * 0.6);
    const strip = (p: any, keep: (m: any) => boolean) =>
      JSON.stringify(
        p.memories.filter(keep).map((m: any) => ({ ...m, session: m.kind === 'distractor' ? 0 : m.session })),
      );
    expect(strip(v1, () => true)).toBe(strip(base, () => true));
    const negs = v1.memories.filter((m: any) => m.kind === 'distractor');
    expect(negs).toHaveLength(TINY.numFacts * TINY.distractorMultiple);
    expect(negs.every((m: any) => m.session < floor)).toBe(true);
    // @ts-expect-error - 'junk' is deliberately outside the lookalikeWindow union to reach the runtime validation
    expect(() => generateProtocol({ seed: 5, ...TINY, lookalikeWindow: 'junk' })).toThrow(/lookalikeWindow/);
  });
});

describe('E1 driver', () => {
  it('full arm: simulated time stamps the store; metrics emitted per epoch', async () => {
    let storeSeen = false;
    const result = await runArmSeed('full', 3, TINY, (hippoRoot: string) => {
      storeSeen = true;
      const entries = loadAllEntries(hippoRoot, 'default');
      expect(entries).toHaveLength(68);
      for (const e of entries) {
        expect(Date.parse(e.created)).toBeGreaterThanOrEqual(Date.parse('2025-01-06T00:00:00.000Z'));
        expect(Date.parse(e.created)).toBeLessThan(Date.parse('2025-06-01T00:00:00.000Z'));
      }
      expect(entries.some((e) => e.retrievalCount > 0)).toBe(true);
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
      const entries = loadAllEntries(hippoRoot, 'default');
      expect(entries.every((e) => e.retrievalCount === 0)).toBe(true);
      expect(entries.some((e) => (e.outcomeNegative ?? 0) > 0)).toBe(true);
    });
  });

  it('probes are read-only: an all-off arm leaves zero retrieval state', async () => {
    await runArmSeed('all-off', 5, TINY, (hippoRoot: string) => {
      const entries = loadAllEntries(hippoRoot, 'default');
      expect(entries.every((e) => e.retrievalCount === 0)).toBe(true);
      expect(entries.every((e) => e.halfLifeDays <= 90)).toBe(true);
    });
  });

  it('driver cleans its env: no ablation vars leak after a run', async () => {
    await runArmSeed('decay-off', 2, TINY);
    for (const v of ABLATION_ENV_VARS) expect(process.env[v]).toBeUndefined();
  });

  it('is REPRODUCIBLE: identical (arm, seed) runs produce identical metrics', async () => {
    const a = await runArmSeed('full', 11, TINY);
    const b = await runArmSeed('full', 11, TINY);
    expect(JSON.stringify(a.epochs)).toBe(JSON.stringify(b.epochs));
    expect(a.meta.protocolHash).toBe(b.meta.protocolHash);
  }, 16_000);

  it('baseline arms produce rankings (bm25-static + recency-window)', async () => {
    const bm25 = await runArmSeed('bm25-static', 4, TINY);
    const rec = await runArmSeed('recency-window', 4, TINY);
    for (const r of [bm25, rec]) {
      const r5 = r.epochs[TINY.numSessions - 1].currentR5;
      expect(r5).toBeGreaterThanOrEqual(0);
      expect(r5).toBeLessThanOrEqual(1);
    }
  });

  it('round-2 arms produce rankings and record their settings in meta', async () => {
    for (const arm of ['recency-off', 'bm25-outcome', 'bm25-newest']) {
      const r = await runArmSeed(arm, 4, TINY);
      expect(r.epochs[TINY.numSessions - 1].currentR5).not.toBeNull();
      expect(r.meta).toHaveProperty('halfLife');
    }
    for (const v of ABLATION_ENV_VARS) expect(process.env[v]).toBeUndefined();
  });
});
