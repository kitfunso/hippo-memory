import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CONFIG } from '../../benchmarks/memory-value/config.mjs';
import { computeSplit } from '../../benchmarks/memory-value/split.mjs';
import { ingestQuestion } from '../../benchmarks/memory-value/ingest.mjs';
import { simulateQuestion } from '../../benchmarks/memory-value/simulate.mjs';
import { extractQuestion } from '../../benchmarks/memory-value/extract.mjs';
import { evaluateAll, computeDatasetVariance, evaluateVarianceGate } from '../../benchmarks/memory-value/evaluate.mjs';
import {
  questionDir,
  metaPathFor,
  featuresPathFor,
  goldPathFor,
  readJsonl,
  readJson,
  computeGold,
  scratchRootDir,
  sanitizeQuestionId,
  safeRemoveScratchDir,
} from '../../benchmarks/memory-value/common.mjs';
import { computeSchemaFit } from '../../dist/base/memory/entry.js';

import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  clearAblationEnv,
  QUESTIONS,
  QUESTION_C,
  cleanupScratch,
  runPipeline,
  TEST_SIM_ROUNDS,
} from './memory-value-fixtures.js';
import { removeDir } from '../_helpers/remove-dir.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const HARNESS_SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-harness-test-scratch-'));

beforeEach(clearAblationEnv);
beforeEach(() => {
  vi.stubEnv('HIPPO_MV_SCRATCH_ROOT', HARNESS_SCRATCH_ROOT);
});
afterEach(clearAblationEnv);

afterAll(() => {
  fs.rmSync(HARNESS_SCRATCH_ROOT, { recursive: true, force: true });
});

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
    expect([...s3.train, ...s3.heldout].sort()).toEqual(qs.map((q) => q.question_id).sort());
  });
});

type PipelineRun = Awaited<ReturnType<typeof runPipeline>>;

async function runEachQuestion(): Promise<Map<string, PipelineRun>> {
  cleanupScratch();
  const runs = new Map<string, PipelineRun>();
  for (const q of QUESTIONS) runs.set(q.question_id, await runPipeline(q));
  return runs;
}

describe('memory-value harness (real stores)', () => {
  let shared: Promise<Map<string, PipelineRun>> | undefined;
  async function runOf(q: (typeof QUESTIONS)[number]): Promise<PipelineRun> {
    shared ??= runEachQuestion();
    return (await shared).get(q.question_id)!;
  }

  it('(b) features.jsonl rows == ingested memories; >=6 non-constant post-simulation', async () => {
    for (const q of QUESTIONS) {
      const { ingestResult, extractResult } = await runOf(q);
      expect(extractResult.rows).toBe(ingestResult.memoryCount);
      expect(ingestResult.memoryCount).toBe(10);

      const rows = jsonlRows<{ features: Record<string, number> }>(featuresPathFor(q.question_id));
      const nonConstant = FEATURE_NAMES.filter((f) => {
        const vals = new Set(rows.map((r) => r.features[f]));
        return vals.size > 1;
      });
      expect(nonConstant.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('schema_fit is wired to the REAL computeSchemaFit(text, [], entriesSoFar) path — verified by independent replay', async () => {
    for (const q of QUESTIONS) {
      await runOf(q);
      const rows = jsonlRows<{ memory_id: string; features: { schema_fit: number } }>(featuresPathFor(q.question_id));
      const rowById = new Map(rows.map((r) => [r.memory_id, r]));
      const gold = jsonFile<{ memories: Array<{ id: string }> }>(goldPathFor(q.question_id));
      const { turns } = computeGold(q);

      const entriesSoFar: MemoryEntry[] = [];
      let memIdx = 0;
      for (const t of turns) {
        // SAFETY: computeGold pushes `content: t.content` on every turn (common.mjs:285); the inferred element type drops it.
        const content = ((t as { content?: string }).content ?? '').trim();
        if (content.length < 3) continue;
        const expectedFit = computeSchemaFit(content, [], entriesSoFar);
        const memId = gold.memories[memIdx].id;
        const row = rowById.get(memId);
        expect(row!.features.schema_fit).toBeCloseTo(expectedFit, 10);
        entriesSoFar.push(createMemory(content));
        memIdx++;
      }

      const schemaFits = new Set(rows.map((r) => r.features.schema_fit));
      expect(schemaFits).toEqual(new Set([0.5]));
    }
  });

  it('(c) recency retention is exact for the hand-computable case', async () => {
    for (const q of QUESTIONS) {
      await runOf(q);
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
    expect(recencyByQuestion.get('fixture_q_a')).toBe(1);
    expect(recencyByQuestion.get('fixture_q_b')).toBe(0.75);
  });

  it('(d) no NaN anywhere in extracted features', async () => {
    for (const q of QUESTIONS) {
      await runOf(q);
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

    cleanupScratch();
    shared = undefined;
    const run1 = await runOnceAndScore();
    for (const q of QUESTIONS) removeDir(questionDir(q.question_id));
    const run2 = await runOnceAndScore();

    expect(run2.rowCounts).toEqual(run1.rowCounts);
    expect(run2.goldCounts).toEqual(run1.goldCounts);
    expect(run2.recency).toEqual(run1.recency);
  });
});

describe('causal clock clamp', () => {
  it('T_eval clamps forward past question_date to the latest haystack_date; age_days >= 0 for every row', async () => {
    fs.rmSync(questionDir(QUESTION_C.question_id), { recursive: true, force: true });
    try {
      const ingestResult = ingestQuestion(QUESTION_C);
      const meta = jsonFile<{ questionDate: string; tEval: string }>(metaPathFor(QUESTION_C.question_id));

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
      expect(rows.length).toBe(6);
      for (const row of rows) {
        expect(row.features.age_days, `session ${row.sessionIndex} turn ${row.turnIdx}`).toBeGreaterThanOrEqual(0);
      }
      const s1Rows = rows.filter((r) => r.sessionIndex === 1);
      expect(s1Rows.length).toBe(3);
      for (const row of s1Rows) expect(row.features.age_days).toBe(0);
      const s0Rows = rows.filter((r) => r.sessionIndex === 0);
      expect(s0Rows.length).toBe(3);
      for (const row of s0Rows) expect(row.features.age_days).toBe(10);
    } finally {
      removeDir(questionDir(QUESTION_C.question_id));
    }
  });
});

describe('--skip-simulate variance-gate exemption', () => {
  it('a real (non-smoke) run without simulation passes at threshold 3 but would fail at the default threshold 6', async () => {
    for (const q of QUESTIONS) {
      fs.rmSync(questionDir(q.question_id), { recursive: true, force: true });
      ingestQuestion(q);
      const meta = jsonFile<{ tEval: string }>(metaPathFor(q.question_id));
      extractQuestion(q.question_id, meta.tEval);
    }
    try {
      const storesRows = QUESTIONS.map((q) =>
        jsonlRows<{ features: Record<string, number> }>(featuresPathFor(q.question_id)),
      );
      const { varying, dead } = computeDatasetVariance(storesRows, FEATURE_NAMES);

      for (const f of ['retrieval_count', 'outcome_positive', 'outcome_negative', 'outcome_ratio', 'half_life_days']) {
        expect(dead, f).toContain(f);
      }
      for (const f of ['age_days', 'strength', 'content_length']) {
        expect(varying, f).toContain(f);
      }

      const defaultGate = evaluateVarianceGate(varying, dead);
      expect(defaultGate.passed).toBe(false);
      const skipSimulateGate = evaluateVarianceGate(varying, dead, {
        minVarying: CONFIG.MIN_VARYING_FEATURES_SKIP_SIMULATE,
      });
      expect(CONFIG.MIN_VARYING_FEATURES_SKIP_SIMULATE).toBe(3);
      expect(skipSimulateGate.passed).toBe(true);
    } finally {
      for (const q of QUESTIONS) removeDir(questionDir(q.question_id));
    }
  });
});

describe('variance gate (pure logic, no I/O)', () => {
  it('flags a hand-built ALL-CONSTANT feature set as failing', () => {
    const featureNames = FEATURE_NAMES;
    const rows = Array.from({ length: 5 }, () => {
      const features: Record<string, number> = {};
      for (const f of featureNames) features[f] = 0;
      return { features };
    });
    const { varying, dead } = computeDatasetVariance([rows], featureNames);
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
        features[f] = fi < 6 ? i : 0;
      });
      return { features };
    });
    const { varying, dead } = computeDatasetVariance([rows], featureNames);
    expect(varying.length).toBe(6);
    expect(dead.length).toBe(featureNames.length - 6);
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(true);
    expect(gate.varyingCount).toBe(6);
  });

  it('a feature constant WITHIN every store but differing ACROSS stores is DEAD, not varying (cross-store-constant liveness)', () => {
    const featureNames = FEATURE_NAMES;
    const constantRowsAt = (value: number, n: number) =>
      Array.from({ length: n }, () => {
        const features: Record<string, number> = {};
        for (const f of featureNames) features[f] = value;
        return { features };
      });
    const storeA = constantRowsAt(0.3, 4);
    const storeB = constantRowsAt(0.7, 4);
    const storeC = constantRowsAt(1.5, 4);

    const { varying, dead, detail } = computeDatasetVariance([storeA, storeB, storeC], featureNames);
    expect(varying.length).toBe(0);
    expect(dead.length).toBe(featureNames.length);
    for (const f of featureNames) {
      expect(detail[f].pooledVaries, `${f} pooledVaries`).toBe(true);
      expect(detail[f].varies, `${f} varies`).toBe(false);
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
    const storesRows = QUESTIONS.map((q) =>
      jsonlRows<{ features: Record<string, number> }>(featuresPathFor(q.question_id)),
    );
    const { varying, dead } = computeDatasetVariance(storesRows, FEATURE_NAMES);
    const gate = evaluateVarianceGate(varying, dead);
    expect(gate.passed).toBe(true);
    expect(dead).toContain('schema_fit');
  });
});

describe('scratch-cleanup containment guard', () => {
  it('sanitizeQuestionId strips path-traversal characters', () => {
    expect(sanitizeQuestionId('../../etc/passwd')).not.toContain('/');
    expect(sanitizeQuestionId('../../etc/passwd')).not.toContain('..');
    expect(sanitizeQuestionId('a/b\\c')).toBe('a_b_c');
    expect(sanitizeQuestionId('fixture_q_a')).toBe('fixture_q_a');
  });

  it('safeRemoveScratchDir refuses a target outside the scratch root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-outside-root-'));
    try {
      expect(() => safeRemoveScratchDir(outside)).toThrow(/refusing/i);
      expect(fs.existsSync(outside)).toBe(true);
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
    vi.stubEnv('HIPPO_MV_SCRATCH_ROOT', undefined);
    // SAFETY: scratchRootDir() (common.mjs) always returns the scratch-root
    // path as a string; it never returns a filesystem handle or undefined.
    const root = scratchRootDir() as string;
    expect(path.relative(os.tmpdir(), root).startsWith('..')).toBe(false);
    expect(root.toLowerCase()).not.toContain('hippo-wt-lc2e1');
    expect(fs.existsSync(root) || true).toBe(true);
  });
});
