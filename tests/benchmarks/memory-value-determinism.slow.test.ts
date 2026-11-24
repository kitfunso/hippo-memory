import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CONFIG } from '../../benchmarks/memory-value/config.mjs';
import { ingestQuestion } from '../../benchmarks/memory-value/ingest.mjs';
import { simulateQuestion } from '../../benchmarks/memory-value/simulate.mjs';
import { extractQuestion } from '../../benchmarks/memory-value/extract.mjs';
import { evaluateAll } from '../../benchmarks/memory-value/evaluate.mjs';
import { metaPathFor, featuresPathFor, readJson, readJsonl } from '../../benchmarks/memory-value/common.mjs';

import { clearAblationEnv, QUESTIONS } from './memory-value-fixtures.js';
import { removeDir } from '../_helpers/remove-dir.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(clearAblationEnv);
afterEach(clearAblationEnv);

describe('cross-ingest determinism', () => {
  it('two separate scratch-root ingests of the same fixture, FULL 30-round protocol, produce identical retention (every scorer x budget) and identical per-row features joined on provenance key', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-xingest-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-xingest-b-'));
    const budgets = [0.1, 0.2, 0.3, 0.5];

    async function ingestSimExtractUnder(root: string) {
      vi.stubEnv('HIPPO_MV_SCRATCH_ROOT', root);
      const rowsByQuestion: Record<
        string,
        Array<{
          memory_id: string;
          sessionIndex: number;
          turnIdx: number;
          gold: number;
          features: Record<string, number>;
        }>
      > = {};
      for (const q of QUESTIONS) {
        ingestQuestion(q);
        // SAFETY: ingestQuestion (ingest.mjs) always writes a meta.json with
        // a tEval field before this file is read back; readJson has no
        // static type because it comes from an untyped .mjs harness module.
        const meta = readJson(metaPathFor(q.question_id)) as { tEval: string };
        await simulateQuestion(q.question_id, meta.tEval, { seed: CONFIG.GLOBAL_SEED });
        extractQuestion(q.question_id, meta.tEval);
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

      // SAFETY: evaluateAll returns summary.train as scorer -> budget -> { meanRetention } (evaluate.mjs); the inferred type is {}.
      const trainOf = (r: { evalResult: { summary: unknown } }) =>
        (r.evalResult.summary as { train: Record<string, Record<number, { meanRetention: number } | undefined>> })
          .train;

      // SAFETY: evaluateAll (evaluate.mjs) returns { scorers: string[], ... }
      // per its documented contract; the harness module has no .d.ts so
      // evalResult is untyped at the import boundary.
      for (const scorerName of runA.evalResult.scorers as string[]) {
        for (const budget of budgets) {
          const a = trainOf(runA)[scorerName]?.[budget];
          const b = trainOf(runB)[scorerName]?.[budget];
          expect(b?.meanRetention, `${scorerName}@${budget}`).toBe(a?.meanRetention);
        }
      }

      for (const q of QUESTIONS) {
        const rowsA = runA.rowsByQuestion[q.question_id];
        const rowsB = runB.rowsByQuestion[q.question_id];
        expect(rowsB.length).toBe(rowsA.length);
        const keyOf = (r: { sessionIndex: number; turnIdx: number }) => `${r.sessionIndex}:${r.turnIdx}`;
        const byKeyB = new Map(rowsB.map((r) => [keyOf(r), r]));
        for (const rowA of rowsA) {
          const rowB = byKeyB.get(keyOf(rowA));
          expect(rowB?.gold, `no provenance-matched row for ${keyOf(rowA)} in run B`).toBe(rowA.gold);
          expect(rowB!.features).toEqual(rowA.features);
        }
      }
    } finally {
      vi.stubEnv('HIPPO_MV_SCRATCH_ROOT', undefined);
      removeDir(rootA);
      removeDir(rootB);
    }
  });
});
