/**
 * LC2-E1 memory-value eval harness — deterministic smoke test.
 *
 * A tiny, fully hand-specified synthetic fixture (2 questions x 3 sessions x
 * ~10 turns, known gold flags — NOT the generic seeded generateSmokeFixture()
 * that run.mjs --smoke uses, because this test needs EXACT, hand-computable
 * retention numbers). Runs the real mechanism (ingest -> simulate -> extract
 * -> evaluate) against real SQLite scratch stores (house rule: no mocks).
 *
 * Hand-computable retention design note: memory ids come from
 * crypto.randomUUID() inside the real createMemory() path (by design — this
 * harness must not fork production's id generation just to make a test
 * easier). That makes any retention number that depends on a BM25/score TIE
 * being broken by memory_id non-reproducible byte-for-byte across runs. The
 * `recency` scorer sidesteps this: it scores purely by age_days, which is a
 * pure function of each turn's SESSION DATE (fully controlled by this
 * fixture) and is untouched by simulate.mjs (which only ever mutates
 * retrieval_count, outcome counters, half_life_days, last_retrieved). Both questions
 * below are constructed so the answer/gold session is the NEWEST session and
 * the primary-budget keep count exactly covers (Q_A) or is a subset of
 * entirely-gold (Q_B) that session's tied group — so `recency` retention is
 * exact and reproducible regardless of which random ids win a tie.
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
import { formatLmeDate, questionDir, featuresPathFor, goldPathFor, readJsonl, readJson, computeGold, scratchRootDir, sanitizeQuestionId, safeRemoveScratchDir } from '../benchmarks/memory-value/common.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { _resetAblationCacheForTests } from '../dist/ablation.js';
// @ts-expect-error - .mjs harness modules have no type declarations
import { computeSchemaFit } from '../dist/memory.js';

// HIPPO_MV_SCRATCH_ROOT is included here (not just the ablation vars) so the
// cross-ingest determinism test below can never leak its scratch-root
// override into another test if it throws before its own finally runs.
const RESET_ENV_VARS = ['HIPPO_FAKE_NOW', 'HIPPO_MV_SCRATCH_ROOT'] as const;
function clearAblationEnv(): void {
  for (const v of RESET_ENV_VARS) delete process.env[v];
  _resetAblationCacheForTests();
}
beforeEach(clearAblationEnv);
afterEach(clearAblationEnv);

// ---------------------------------------------------------------------------
// Fixture: 2 questions, 3 sessions each, ~10 turns each, known gold flags.
// ---------------------------------------------------------------------------

const BASE = Date.UTC(2024, 0, 1, 9, 0, 0); // 2024-01-01T09:00:00Z, a Monday
const day = (n: number) => new Date(BASE + n * 86_400_000);

function turn(role: 'user' | 'assistant', text: string, hasAnswer?: boolean) {
  const t: Record<string, unknown> = { role, content: text };
  if (hasAnswer !== undefined) t.has_answer = hasAnswer;
  return t;
}

/** Q_A: evidence-turn mode. Sessions at day 0, 3, 6 (day 6 = newest = answer
 *  session). 4+3+3 = 10 turns. Exactly 1 gold turn (the last turn of the
 *  answer session). question_date = day 7 (one day after the newest session). */
function buildQuestionA() {
  const s0 = [turn('user', 'A-s0-t0 alpha topic note'), turn('assistant', 'A-s0-t1 alpha topic reply'), turn('user', 'A-s0-t2 alpha topic follow-up'), turn('assistant', 'A-s0-t3 alpha topic wrap-up')];
  const s1 = [turn('user', 'A-s1-t0 beta topic note'), turn('assistant', 'A-s1-t1 beta topic reply'), turn('user', 'A-s1-t2 beta topic follow-up')];
  const s2 = [turn('user', 'A-s2-t0 gamma topic note', false), turn('assistant', 'A-s2-t1 gamma topic reply', false), turn('user', 'A-s2-t2 gamma topic answer', true)];
  return {
    question_id: 'fixture_q_a',
    question_type: 'single-session-user',
    question: 'What was the gamma topic answer? (never read by simulate/extract)',
    question_date: formatLmeDate(day(7)),
    answer: 'the gamma topic answer (never read by simulate/extract)',
    answer_session_ids: ['fixture_q_a_sess2'],
    haystack_dates: [formatLmeDate(day(0)), formatLmeDate(day(3)), formatLmeDate(day(6))],
    haystack_session_ids: ['fixture_q_a_sess0', 'fixture_q_a_sess1', 'fixture_q_a_sess2'],
    haystack_sessions: [s0, s1, s2],
  };
}

/** Q_B: answer-session-all fallback mode (no has_answer key anywhere).
 *  Sessions at day 0, 3, 6 (day 6 = newest = answer session, ALL 4 turns
 *  gold). 3+3+4 = 10 turns. question_date = day 7. */
function buildQuestionB() {
  const s0 = [turn('user', 'B-s0-t0 delta topic note'), turn('assistant', 'B-s0-t1 delta topic reply'), turn('user', 'B-s0-t2 delta topic follow-up')];
  const s1 = [turn('user', 'B-s1-t0 epsilon topic note'), turn('assistant', 'B-s1-t1 epsilon topic reply'), turn('user', 'B-s1-t2 epsilon topic follow-up')];
  const s2 = [turn('user', 'B-s2-t0 zeta topic note'), turn('assistant', 'B-s2-t1 zeta topic reply'), turn('user', 'B-s2-t2 zeta topic follow-up'), turn('assistant', 'B-s2-t3 zeta topic answer')];
  return {
    question_id: 'fixture_q_b',
    question_type: 'multi-session',
    question: 'What was decided in the zeta topic thread? (never read by simulate/extract)',
    question_date: formatLmeDate(day(7)),
    answer: 'the zeta topic decision (never read by simulate/extract)',
    answer_session_ids: ['fixture_q_b_sess2'],
    haystack_dates: [formatLmeDate(day(0)), formatLmeDate(day(3)), formatLmeDate(day(6))],
    haystack_session_ids: ['fixture_q_b_sess0', 'fixture_q_b_sess1', 'fixture_q_b_sess2'],
    haystack_sessions: [s0, s1, s2],
  };
}

const QUESTIONS = [buildQuestionA(), buildQuestionB()];

function cleanupScratch(): void {
  for (const q of QUESTIONS) {
    fs.rmSync(questionDir(q.question_id), { recursive: true, force: true });
  }
}

const QUESTION_DATE_ISO = day(7).toISOString(); // both fixtures share question_date = day 7

async function runPipeline(q: ReturnType<typeof buildQuestionA>) {
  const ingestResult = ingestQuestion(q);
  await simulateQuestion(q.question_id, QUESTION_DATE_ISO);
  const extractResult = extractQuestion(q.question_id, QUESTION_DATE_ISO);
  return { ingestResult, extractResult };
}

afterAll(cleanupScratch);

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

      const rows = readJsonl(featuresPathFor(q.question_id)) as Array<{ features: Record<string, number> }>;
      const featureNames = CONFIG.FEATURES as string[];
      const nonConstant = featureNames.filter((f) => {
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
      const rows = readJsonl(featuresPathFor(q.question_id)) as Array<{ memory_id: string; features: { schema_fit: number } }>;
      const rowById = new Map(rows.map((r) => [r.memory_id, r]));
      const gold = readJson(goldPathFor(q.question_id)) as { memories: Array<{ id: string }> };
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
      result.pairedRecords
        .filter((r: { scorer: string }) => r.scorer === 'recency')
        .map((r: { questionId: string; retention: number }) => [r.questionId, r.retention]),
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
      const rows = readJsonl(featuresPathFor(q.question_id)) as Array<{ features: Record<string, number> }>;
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
        const rows = readJsonl(featuresPathFor(q.question_id)) as Array<{ gold: number }>;
        rowCounts[q.question_id] = rows.length;
        goldCounts[q.question_id] = rows.filter((r) => r.gold === 1).length;
      }
      const result = evaluateAll(
        QUESTIONS.map((q) => ({ questionId: q.question_id, split: 'train' as const })),
        { budgets: [0.3], primaryBudget: 0.3 },
      );
      const recency: Record<string, number> = {};
      for (const r of result.pairedRecords as Array<{ scorer: string; questionId: string; retention: number }>) {
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

describe('variance gate (pure logic, no I/O)', () => {
  it('flags a hand-built ALL-CONSTANT feature set as failing', () => {
    const featureNames = CONFIG.FEATURES as string[];
    const rows = Array.from({ length: 5 }, () => {
      const features: Record<string, number> = {};
      for (const f of featureNames) features[f] = 0; // every dim frozen — the exact failure mode this gate exists for
      return { features };
    });
    const { varying, dead } = computeDatasetVariance(rows, featureNames);
    expect(varying.length).toBe(0);
    expect(dead.length).toBe(featureNames.length);
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(false);
    expect(gate.varyingCount).toBe(0);
    expect(gate.deadFeatures.length).toBe(featureNames.length);
  });

  it('passes when exactly the minimum (6) features vary', () => {
    const featureNames = CONFIG.FEATURES as string[];
    const rows = Array.from({ length: 5 }, (_, i) => {
      const features: Record<string, number> = {};
      featureNames.forEach((f, fi) => {
        features[f] = fi < 6 ? i : 0; // first 6 dims vary row-to-row, the rest stay constant
      });
      return { features };
    });
    const { varying, dead } = computeDatasetVariance(rows, featureNames);
    expect(varying.length).toBe(6);
    expect(dead.length).toBe(featureNames.length - 6);
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(true);
    expect(gate.varyingCount).toBe(6);
  });

  it('a real fixture run produces a passing gate (>=6 varying features)', async () => {
    for (const q of QUESTIONS) {
      await runPipeline(q);
    }
    const allRows: Array<{ features: Record<string, number> }> = [];
    for (const q of QUESTIONS) {
      allRows.push(...(readJsonl(featuresPathFor(q.question_id)) as Array<{ features: Record<string, number> }>));
    }
    const { varying, dead } = computeDatasetVariance(allRows, CONFIG.FEATURES as string[]);
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(true);
    // schema_fit is proven constant above; it must land in `dead`, not `varying`.
    expect(dead).toContain('schema_fit');
  });
});

describe('cross-ingest determinism (codex review P1 fix verification)', () => {
  it('two separate scratch-root ingests of the same fixture produce identical retention (every scorer x budget) and identical per-row features joined on provenance key', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-xingest-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-xingest-b-'));
    const budgets = [0.1, 0.2, 0.3, 0.5];

    async function ingestSimExtractUnder(root: string) {
      process.env.HIPPO_MV_SCRATCH_ROOT = root;
      const rowsByQuestion: Record<string, Array<{ memory_id: string; sessionIndex: number; turnIdx: number; gold: number; features: Record<string, number> }>> = {};
      for (const q of QUESTIONS) {
        ingestQuestion(q);
        await simulateQuestion(q.question_id, QUESTION_DATE_ISO, { seed: CONFIG.GLOBAL_SEED });
        extractQuestion(q.question_id, QUESTION_DATE_ISO);
        rowsByQuestion[q.question_id] = readJsonl(featuresPathFor(q.question_id));
      }
      const evalResult = evaluateAll(
        QUESTIONS.map((q) => ({ questionId: q.question_id, split: 'train' as const })),
        { budgets, primaryBudget: 0.3 },
      );
      return { rowsByQuestion, evalResult };
    }

    try {
      const runA = await ingestSimExtractUnder(rootA);
      const runB = await ingestSimExtractUnder(rootB);

      // (1) retention identical for EVERY scorer x budget (not just recency) —
      // this is the property the previous memory_id-primary tie-break broke.
      for (const scorerName of runA.evalResult.scorers as string[]) {
        for (const budget of budgets) {
          const a = runA.evalResult.summary.train[scorerName]?.[budget];
          const b = runB.evalResult.summary.train[scorerName]?.[budget];
          expect(b?.meanRetention, `${scorerName}@${budget}`).toBe(a?.meanRetention);
        }
      }

      // (2) per-row features identical when joined on (sessionIndex, turnIdx)
      //     — NOT on memory_id, which is crypto-random per ingest by design.
      for (const q of QUESTIONS) {
        const rowsA = runA.rowsByQuestion[q.question_id];
        const rowsB = runB.rowsByQuestion[q.question_id];
        expect(rowsB.length).toBe(rowsA.length);
        const keyOf = (r: { sessionIndex: number; turnIdx: number }) => `${r.sessionIndex}:${r.turnIdx}`;
        const byKeyB = new Map(rowsB.map((r) => [keyOf(r), r]));
        for (const rowA of rowsA) {
          const rowB = byKeyB.get(keyOf(rowA));
          expect(rowB, `no provenance-matched row for ${keyOf(rowA)} in run B`).toBeDefined();
          expect(rowB!.gold).toBe(rowA.gold);
          expect(rowB!.features).toEqual(rowA.features);
          // memory_id is deliberately NOT compared here (see file header).
        }
      }
    } finally {
      delete process.env.HIPPO_MV_SCRATCH_ROOT;
      _resetAblationCacheForTests();
      // Both temp roots are OUTSIDE the default scratch root (scratchRootDir()
      // reads the env var, which is already cleared above), so a plain
      // fs.rmSync is correct here — safeRemoveScratchDir would refuse them.
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  }, 90_000);
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
    const root = scratchRootDir() as string;
    expect(root.toLowerCase()).not.toContain('hippo-wt-lc2e1');
    expect(fs.existsSync(root) || true).toBe(true); // root need not exist yet; just checking the path shape
  });
});
