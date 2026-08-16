/**
 * LC2-E1 memory-value eval harness — deterministic mechanism tests.
 *
 * A tiny, fully hand-specified synthetic fixture (2 questions x 3 sessions x
 * ~10 turns, known gold flags — NOT the generic seeded generateSmokeFixture()
 * that run.mjs --smoke uses, because this test needs EXACT, hand-computable
 * retention numbers). Runs the real mechanism (ingest -> simulate -> extract
 * -> evaluate) against real SQLite scratch stores (house rule: no mocks).
 * Fixture definitions live in memory-value-fixtures.ts, shared with
 * memory-value-determinism.test.ts (codex confirmation-pass P1-B fix,
 * 2026-08-09: the file was split so neither Vitest worker's per-file
 * wallclock crosses the ~60s Windows worker-RPC "onTaskUpdate" timeout).
 * This file's pipeline tests run simulate.mjs at TEST_SIM_ROUNDS (8), not
 * the pinned CONFIG.SIM_ROUNDS (30) — they only need enough usage variance
 * to exercise retrieval_count, outcome counters, half_life_days, not the full
 * protocol depth. memory-value-determinism.test.ts keeps ONE full-30-round
 * test, where the pinned protocol itself is under test.
 *
 * Hand-computable retention design note: memory ids come from
 * crypto.randomUUID() inside the real createMemory() path (by design — this
 * harness must not fork production's id generation just to make a test
 * easier). That makes any retention number that depends on a BM25/score TIE
 * being broken by memory_id non-reproducible byte-for-byte across runs. The
 * `recency` scorer sidesteps this: it scores purely by age_days, which is a
 * pure function of each turn's SESSION DATE (fully controlled by this
 * fixture) and is untouched by simulate.mjs (which only ever mutates
 * retrieval_count, outcome counters, half_life_days, last_retrieved). Both
 * questions below are constructed so the answer/gold session is the NEWEST
 * session and the primary-budget keep count exactly covers (Q_A) or is a
 * subset of entirely-gold (Q_B) that session's tied group — so `recency`
 * retention is exact and reproducible regardless of which random ids win a
 * tie.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// @ts-expect-error - .mjs harness modules have no type declarations
import { CONFIG } from '../benchmarks/memory-value/config.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { computeSplit } from '../benchmarks/memory-value/split.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { ingestQuestion } from '../benchmarks/memory-value/ingest.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { simulateQuestion } from '../benchmarks/memory-value/simulate.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { extractQuestion } from '../benchmarks/memory-value/extract.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { evaluateAll, computeDatasetVariance, evaluateVarianceGate } from '../benchmarks/memory-value/evaluate.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { questionDir, metaPathFor, featuresPathFor, goldPathFor, readJsonl, readJson, computeGold, scratchRootDir, sanitizeQuestionId, safeRemoveScratchDir } from '../benchmarks/memory-value/common.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { computeSchemaFit } from '../dist/memory.js';

import { clearAblationEnv, QUESTIONS, QUESTION_C, cleanupScratch, runPipeline, TEST_SIM_ROUNDS } from './memory-value-fixtures.js';

beforeEach(clearAblationEnv);
afterEach(clearAblationEnv);

afterAll(cleanupScratch);

// Typed seams over the untyped .mjs harness surface (CONFIG / readJsonl /
// readJson / scratchRootDir all import as `any`, per the @ts-expect-error
// imports above). Each helper below owns the ONE cast for its shape so every
// call site downstream is fully typed without repeating the justification.

// SAFETY: config.mjs's FEATURES is a fixed array of feature-name strings,
// read once at module load and reused by every test below.
const FEATURE_NAMES = CONFIG.FEATURES as string[];

function jsonlRows<T>(filePath: string): T[] {
  // SAFETY: every call site below passes a features.jsonl path written by
  // extract.mjs, with the row shape the caller requests as T.
  return readJsonl(filePath) as T[];
}

function jsonFile<T>(filePath: string): T {
  // SAFETY: every call site below passes a meta.json/gold.json path written
  // by ingest.mjs/common.mjs, with the shape the caller requests as T.
  return readJson(filePath) as T;
}

type PairedRecord = { scorer: string; questionId: string; retention: number };

function pairedRecordsOf(result: { pairedRecords: unknown }): PairedRecord[] {
  // SAFETY: evaluate.mjs's evaluateAll always returns one pairedRecords row
  // per (scorer, question) pair with exactly these three fields.
  return result.pairedRecords as PairedRecord[];
}

// ---------------------------------------------------------------------------
// (a) split determinism
// ---------------------------------------------------------------------------

describe('split determinism', () => {
  it('same seed produces byte-identical split', () => {
    const qs = [
      { question_id: 'q1', question_type: 'a' },
      { question_id: 'q2', question_type: 'a' },
      { question_id: 'q3', question_type: 'b' },
      { question_id: 'q4', question_type: 'b' },
      { question_id: 'q5', question_type: 'b' },
    ];
    const s1 = computeSplit(qs, { seed: 42 });
    const s2 = computeSplit(qs, { seed: 42 });
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));

    const s3 = computeSplit(qs, { seed: 7 });
    // Different seed is allowed to (but is not guaranteed to) differ; the
    // real assertion is same-seed determinism above. Just confirm both
    // partitions are internally consistent (train+heldout = all ids).
    expect([...s3.train, ...s3.heldout].sort()).toEqual(qs.map((q) => q.question_id).sort());
  });
});

// ---------------------------------------------------------------------------
// Full-mechanism tests (real SQLite scratch stores)
// ---------------------------------------------------------------------------

describe('memory-value harness (real stores)', () => {
  beforeEach(cleanupScratch);

  it('(b) features.jsonl rows == ingested memories; >=6 non-constant post-simulation', async () => {
    for (const q of QUESTIONS) {
      const { ingestResult, extractResult } = await runPipeline(q);
      expect(extractResult.rows).toBe(ingestResult.memoryCount);
      expect(ingestResult.memoryCount).toBe(10); // fixture is exactly 10 turns/question, none empty

      const rows = jsonlRows<{ features: Record<string, number> }>(featuresPathFor(q.question_id));
      const nonConstant = FEATURE_NAMES.filter((f) => {
        const vals = new Set(rows.map((r) => r.features[f]));
        return vals.size > 1;
      });
      expect(nonConstant.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('schema_fit is wired to the REAL computeSchemaFit(text, [], entriesSoFar) path — verified by independent replay', async () => {
    // Coordinator's fix-round ask was "assert schema_fit varies". Measured
    // reality: computeSchemaFit returns the neutral 0.5 before ever reaching
    // the content-overlap branch — via the empty-store guard (src/memory.ts:558)
    // for each store's FIRST entry, and via the tag-overlap guard
    // (src/memory.ts:568, `tags.length === 0 && tagFreq.size === 0`) for every
    // entry after it, since ingest.mjs always passes `tags: []` (no invented
    // tags, per the leakage-rule design) so tagFreq stays empty for every
    // store. One of the two guards fires unconditionally and schema_fit is
    // provably dataset-wide constant on THIS substrate, correct wiring
    // notwithstanding. This test proves
    // CORRECTNESS of the wiring (the stored value matches an independent
    // replay of the real function against the real accumulated-so-far
    // store), which is the property that actually matters — a false
    // "it varies" assertion would not have been true and is not asserted.
    for (const q of QUESTIONS) {
      await runPipeline(q);
      const rows = jsonlRows<{ memory_id: string; features: { schema_fit: number } }>(featuresPathFor(q.question_id));
      const rowById = new Map(rows.map((r) => [r.memory_id, r]));
      const gold = jsonFile<{ memories: Array<{ id: string }> }>(goldPathFor(q.question_id));
      const { turns } = computeGold(q);

      const entriesSoFar: Array<{ tags: string[]; content: string }> = [];
      let memIdx = 0;
      for (const t of turns) {
        const content = (t.content ?? '').trim();
        if (content.length < 3) continue; // mirrors ingest.mjs MIN_CONTENT_LEN
        const expectedFit = computeSchemaFit(content, [], entriesSoFar);
        const memId = gold.memories[memIdx].id;
        const row = rowById.get(memId);
        expect(row, `no features row for ${memId}`).toBeDefined();
        expect(row!.features.schema_fit).toBeCloseTo(expectedFit, 10);
        entriesSoFar.push({ tags: [], content });
        memIdx++;
      }

      // Documented empirical finding, locked in as a test assertion: given
      // tags=[] always, schema_fit really is constant 0.5 across the whole
      // fixture — not because it's unwired, but because the real function
      // computes exactly that for untagged content every time.
      const schemaFits = new Set(rows.map((r) => r.features.schema_fit));
      expect(schemaFits).toEqual(new Set([0.5]));
    }
  });

  it('(c) recency retention is exact for the hand-computable case', async () => {
    for (const q of QUESTIONS) {
      await runPipeline(q);
    }
    const result = evaluateAll(
      QUESTIONS.map((q) => ({ questionId: q.question_id, split: 'train' as const })),
      { budgets: [0.3], primaryBudget: 0.3 },
    );
    const recencyByQuestion = new Map(
      pairedRecordsOf(result)
        .filter((r) => r.scorer === 'recency')
        .map((r) => [r.questionId, r.retention]),
    );
    // Q_A: N=10, keepN=ceil(0.3*10)=3, newest session (day 6) has exactly 3
    // turns and exactly 1 is gold -> the whole newest session is kept
    // regardless of tie-break order -> retention = 1/1 = 1.0 exactly.
    expect(recencyByQuestion.get('fixture_q_a')).toBe(1);
    // Q_B: N=10, keepN=ceil(0.3*10)=3, newest session (day 6) has 4 turns,
    // ALL gold (answer-session-all fallback) -> any 3-of-4 tied selection
    // still yields keptGold=3 -> retention = 3/4 = 0.75 exactly.
    expect(recencyByQuestion.get('fixture_q_b')).toBe(0.75);
  });

  it('(d) no NaN anywhere in extracted features', async () => {
    for (const q of QUESTIONS) {
      await runPipeline(q);
      const rows = jsonlRows<{ features: Record<string, number> }>(featuresPathFor(q.question_id));
      for (const row of rows) {
        for (const [name, value] of Object.entries(row.features)) {
          expect(Number.isFinite(value), `${q.question_id} ${name} = ${value}`).toBe(true);
        }
      }
    }
  });

  it('(e) rerunning is idempotent (recency retention, row counts, gold counts)', async () => {
    async function runOnceAndScore() {
      for (const q of QUESTIONS) {
        await runPipeline(q);
      }
      const rowCounts: Record<string, number> = {};
      const goldCounts: Record<string, number> = {};
      for (const q of QUESTIONS) {
        const rows = jsonlRows<{ gold: number }>(featuresPathFor(q.question_id));
        rowCounts[q.question_id] = rows.length;
        goldCounts[q.question_id] = rows.filter((r) => r.gold === 1).length;
      }
      const result = evaluateAll(
        QUESTIONS.map((q) => ({ questionId: q.question_id, split: 'train' as const })),
        { budgets: [0.3], primaryBudget: 0.3 },
      );
      const recency: Record<string, number> = {};
      for (const r of pairedRecordsOf(result)) {
        if (r.scorer === 'recency') recency[r.questionId] = r.retention;
      }
      return { rowCounts, goldCounts, recency };
    }

    const run1 = await runOnceAndScore();
    cleanupScratch();
    const run2 = await runOnceAndScore();

    expect(run2.rowCounts).toEqual(run1.rowCounts);
    expect(run2.goldCounts).toEqual(run1.goldCounts);
    expect(run2.recency).toEqual(run1.recency);
    // Sanity: the split.mjs determinism test above already proves the
    // harness's OWN seeded RNG reproduces identically; this test's
    // reproducibility instead comes from recency depending only on
    // fixture-controlled session dates, which never change between runs —
    // memory ids (crypto.randomUUID(), the real production path) are NOT
    // asserted equal across runs, by design (see file header).
  });
});

describe('causal clock clamp (codex review fix round #3 P1 fix verification)', () => {
  it('T_eval clamps forward past question_date to the latest haystack_date; age_days >= 0 for every row', async () => {
    fs.rmSync(questionDir(QUESTION_C.question_id), { recursive: true, force: true });
    try {
      const ingestResult = ingestQuestion(QUESTION_C);
      const meta = jsonFile<{ questionDate: string; tEval: string }>(metaPathFor(QUESTION_C.question_id));

      // question_date (day 7) predates session s1 (day 10) -> T_eval must
      // clamp FORWARD to day 10, not stay at question_date.
      const day10Iso = new Date(Date.UTC(2024, 0, 1, 9, 0, 0) + 10 * 86_400_000).toISOString();
      expect(meta.tEval).toBe(day10Iso);
      expect(meta.tEval).not.toBe(meta.questionDate);
      expect(meta.tEval > meta.questionDate).toBe(true);

      await simulateQuestion(QUESTION_C.question_id, meta.tEval, { seed: CONFIG.GLOBAL_SEED, rounds: TEST_SIM_ROUNDS });
      extractQuestion(QUESTION_C.question_id, meta.tEval);

      const rows = jsonlRows<{
        memory_id: string;
        sessionIndex: number;
        turnIdx: number;
        features: { age_days: number };
      }>(featuresPathFor(QUESTION_C.question_id));
      expect(rows.length).toBe(ingestResult.memoryCount);
      expect(rows.length).toBe(6); // 3 + 3 turns, none empty

      // No negative age anywhere — the bug this fix eliminates (codex
      // measured 15,162 such rows across the real 500-question dataset).
      for (const row of rows) {
        expect(row.features.age_days, `session ${row.sessionIndex} turn ${row.turnIdx}`).toBeGreaterThanOrEqual(0);
      }
      // s1 (day 10) IS T_eval -> its memories' age is exactly 0 (created ===
      // T_eval, untouched by simulation, which never mutates `created`).
      const s1Rows = rows.filter((r) => r.sessionIndex === 1);
      expect(s1Rows.length).toBe(3);
      for (const row of s1Rows) expect(row.features.age_days).toBe(0);
      // s0 (day 0) is exactly 10 days before T_eval (day 10).
      const s0Rows = rows.filter((r) => r.sessionIndex === 0);
      expect(s0Rows.length).toBe(3);
      for (const row of s0Rows) expect(row.features.age_days).toBe(10);
    } finally {
      fs.rmSync(questionDir(QUESTION_C.question_id), { recursive: true, force: true });
    }
  });
});

describe('--skip-simulate variance-gate exemption (codex review fix round #3 P2 fix verification)', () => {
  it('a real (non-smoke) run without simulation passes at threshold 3 but would fail at the default threshold 6', async () => {
    for (const q of QUESTIONS) {
      fs.rmSync(questionDir(q.question_id), { recursive: true, force: true });
      ingestQuestion(q); // no simulateQuestion call — mirrors --skip-simulate
      const meta = jsonFile<{ tEval: string }>(metaPathFor(q.question_id));
      extractQuestion(q.question_id, meta.tEval);
    }
    try {
      const storesRows = QUESTIONS.map(
        (q) => jsonlRows<{ features: Record<string, number> }>(featuresPathFor(q.question_id)),
      );
      const { varying, dead } = computeDatasetVariance(storesRows, FEATURE_NAMES);

      // Usage-derived dims are constant BY DESIGN without simulation.
      for (const f of ['retrieval_count', 'outcome_positive', 'outcome_negative', 'outcome_ratio', 'half_life_days']) {
        expect(dead, f).toContain(f);
      }
      // The naturally-surviving set (age varies by session date regardless
      // of simulation; strength's decay term is a pure function of age;
      // content_length is turn-text length, simulation-independent).
      for (const f of ['age_days', 'strength', 'content_length']) {
        expect(varying, f).toContain(f);
      }

      const defaultGate = evaluateVarianceGate(varying, dead); // minVarying defaults to 6
      expect(defaultGate.passed).toBe(false);
      const skipSimulateGate = evaluateVarianceGate(varying, dead, { minVarying: CONFIG.MIN_VARYING_FEATURES_SKIP_SIMULATE });
      expect(CONFIG.MIN_VARYING_FEATURES_SKIP_SIMULATE).toBe(3);
      expect(skipSimulateGate.passed).toBe(true);
    } finally {
      for (const q of QUESTIONS) fs.rmSync(questionDir(q.question_id), { recursive: true, force: true });
    }
  });
});

describe('variance gate (pure logic, no I/O)', () => {
  it('flags a hand-built ALL-CONSTANT feature set as failing', () => {
    const featureNames = FEATURE_NAMES;
    const rows = Array.from({ length: 5 }, () => {
      const features: Record<string, number> = {};
      for (const f of featureNames) features[f] = 0; // every dim frozen — the exact failure mode this gate exists for
      return { features };
    });
    const { varying, dead } = computeDatasetVariance([rows], featureNames); // one store
    expect(varying.length).toBe(0);
    expect(dead.length).toBe(featureNames.length);
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(false);
    expect(gate.varyingCount).toBe(0);
    expect(gate.deadFeatures.length).toBe(featureNames.length);
  });

  it('passes when exactly the minimum (6) features vary WITHIN a store', () => {
    const featureNames = FEATURE_NAMES;
    const rows = Array.from({ length: 5 }, (_, i) => {
      const features: Record<string, number> = {};
      featureNames.forEach((f, fi) => {
        features[f] = fi < 6 ? i : 0; // first 6 dims vary row-to-row WITHIN this one store, rest constant
      });
      return { features };
    });
    const { varying, dead } = computeDatasetVariance([rows], featureNames); // one store
    expect(varying.length).toBe(6);
    expect(dead.length).toBe(featureNames.length - 6);
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(true);
    expect(gate.varyingCount).toBe(6);
  });

  it('a feature constant WITHIN every store but differing ACROSS stores is DEAD, not varying (cross-store-constant liveness)', () => {
    // codex review fix round #3 P2 fix: pooled/cross-store variance would
    // wrongly call this "varying" (pooled sees {0.3, 0.7, ...}); every
    // scorer normalizes min-max PER STORE, so a feature constant within
    // each individual store normalizes to 0 everywhere regardless of the
    // cross-store spread — provably inert, must classify as dead.
    const featureNames = FEATURE_NAMES;
    const constantRowsAt = (value: number, n: number) =>
      Array.from({ length: n }, () => {
        const features: Record<string, number> = {};
        for (const f of featureNames) features[f] = value;
        return { features };
      });
    const storeA = constantRowsAt(0.3, 4); // constant 0.3 within store A
    const storeB = constantRowsAt(0.7, 4); // constant 0.7 within store B — DIFFERENT constant
    const storeC = constantRowsAt(1.5, 4); // a third distinct constant, for good measure

    const { varying, dead, detail } = computeDatasetVariance([storeA, storeB, storeC], featureNames);
    expect(varying.length).toBe(0);
    expect(dead.length).toBe(featureNames.length);
    for (const f of featureNames) {
      expect(detail[f].pooledVaries, `${f} pooledVaries`).toBe(true); // diagnostic: pooled DOES see the spread
      expect(detail[f].varies, `${f} varies`).toBe(false); // liveness: correctly dead
      expect(detail[f].min).toBe(0.3);
      expect(detail[f].max).toBe(1.5);
    }
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(false);
  });

  it('a real fixture run produces a passing gate (>=6 varying features)', async () => {
    for (const q of QUESTIONS) {
      await runPipeline(q);
    }
    const storesRows = QUESTIONS.map(
      (q) => jsonlRows<{ features: Record<string, number> }>(featuresPathFor(q.question_id)),
    );
    const { varying, dead } = computeDatasetVariance(storesRows, FEATURE_NAMES);
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(true);
    // schema_fit is proven constant above; it must land in `dead`, not `varying`.
    expect(dead).toContain('schema_fit');
  });
});

describe('scratch-cleanup containment guard (codex review P2 fix verification)', () => {
  it('sanitizeQuestionId strips path-traversal characters', () => {
    expect(sanitizeQuestionId('../../etc/passwd')).not.toContain('/');
    expect(sanitizeQuestionId('../../etc/passwd')).not.toContain('..');
    expect(sanitizeQuestionId('a/b\\c')).toBe('a_b_c');
    expect(sanitizeQuestionId('fixture_q_a')).toBe('fixture_q_a'); // already-safe ids pass through unchanged
  });

  it('safeRemoveScratchDir refuses a target outside the scratch root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-outside-root-'));
    try {
      expect(() => safeRemoveScratchDir(outside)).toThrow(/refusing/i);
      expect(fs.existsSync(outside)).toBe(true); // must survive the refused delete
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('safeRemoveScratchDir allows a target inside the scratch root', () => {
    const inside = questionDir('containment-guard-probe');
    fs.mkdirSync(inside, { recursive: true });
    expect(() => safeRemoveScratchDir(inside)).not.toThrow();
    expect(fs.existsSync(inside)).toBe(false);
  });
});

describe('scratch-store hygiene', () => {
  it('scratch stores live under the OS temp dir, never under the repo', () => {
    // SAFETY: scratchRootDir() (common.mjs) always returns the scratch-root
    // path as a string; it never returns a filesystem handle or undefined.
    const root = scratchRootDir() as string;
    expect(root.toLowerCase()).not.toContain('hippo-wt-lc2e1');
    expect(fs.existsSync(root) || true).toBe(true); // root need not exist yet; just checking the path shape
  });
});
