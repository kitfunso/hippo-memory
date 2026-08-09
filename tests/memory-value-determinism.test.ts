/**
 * LC2-E1 memory-value eval harness — cross-ingest determinism.
 *
 * Split out of memory-value-harness.test.ts (codex confirmation-pass P1-B
 * fix, 2026-08-09): that file's per-test-file wallclock was crossing
 * Vitest's ~60s Windows worker-RPC "onTaskUpdate" timeout (62.86s observed,
 * exit 1, despite all 17 tests passing). This file holds the ONE test that
 * runs the full pinned protocol (CONFIG.SIM_ROUNDS = 30, not the reduced
 * TEST_SIM_ROUNDS the other file's generic pipeline tests use) — the
 * property under test here IS "does the pinned protocol reproduce
 * identically," so it must exercise the pinned round count, not a reduced
 * one. Fixture definitions are shared with memory-value-harness.test.ts via
 * memory-value-fixtures.ts.
 *
 * Proves the structural fix for codex's two P1 findings (2026-08-09):
 *   - crypto-random memory ids no longer leak into query sampling or the
 *     keep-budget tie-break (provenance-keyed throughout — see
 *     simulate.mjs/evaluate.mjs headers);
 *   - hybridSearch's own content-primary/id-secondary tie-break (real
 *     production behavior, 267/500 real questions have duplicate turn text)
 *     can no longer reach top-K membership — simulate.mjs stable re-sorts
 *     the full result list by (score DESC, sessionIndex ASC, turnIdx ASC)
 *     via the provenance map before ever slicing top-K.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// @ts-expect-error - .mjs harness modules have no type declarations
import { CONFIG } from '../benchmarks/memory-value/config.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { ingestQuestion } from '../benchmarks/memory-value/ingest.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { simulateQuestion } from '../benchmarks/memory-value/simulate.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { extractQuestion } from '../benchmarks/memory-value/extract.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { evaluateAll } from '../benchmarks/memory-value/evaluate.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { metaPathFor, featuresPathFor, readJson, readJsonl } from '../benchmarks/memory-value/common.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { _resetAblationCacheForTests } from '../dist/ablation.js';

import { clearAblationEnv, QUESTIONS } from './memory-value-fixtures.js';

beforeEach(clearAblationEnv);
afterEach(clearAblationEnv);

describe('cross-ingest determinism (codex review P1 fix verification)', () => {
  it('two separate scratch-root ingests of the same fixture, FULL 30-round protocol, produce identical retention (every scorer x budget) and identical per-row features joined on provenance key', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-xingest-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-xingest-b-'));
    const budgets = [0.1, 0.2, 0.3, 0.5];

    async function ingestSimExtractUnder(root: string) {
      process.env.HIPPO_MV_SCRATCH_ROOT = root;
      const rowsByQuestion: Record<string, Array<{ memory_id: string; sessionIndex: number; turnIdx: number; gold: number; features: Record<string, number> }>> = {};
      for (const q of QUESTIONS) {
        ingestQuestion(q);
        const meta = readJson(metaPathFor(q.question_id)) as { tEval: string };
        // No `rounds` override -> defaults to CONFIG.SIM_ROUNDS (30), the
        // pinned protocol — this is the one test that must run it in full.
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
