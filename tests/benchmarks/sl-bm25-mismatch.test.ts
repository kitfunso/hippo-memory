import { describe, it, expect } from 'vitest';
import type { TrapCategory } from '../_helpers/trap-types.js';
import { TRAP_CATEGORIES as UNTYPED_CATEGORIES } from '../../benchmarks/sequential-learning/traps.mjs';

const TRAP_CATEGORIES: TrapCategory[] = UNTYPED_CATEGORIES;

const NEW_IDS = ['timezone_naive', 'idempotency_retry', 'float_accumulation'];

function score(query: string, docTokens: Set<string>): number {
  const queryTokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  let s = 0;
  for (const qt of queryTokens) if (docTokens.has(qt)) s += 1;
  return s;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
}

describe('BM25-mismatch sim — adversarial categories disjoint from existing recall queries', () => {
  it('each existing-category recall query does NOT top-1-rank a new-category lesson EXCLUSIVELY', () => {
    const newCats = TRAP_CATEGORIES.filter((c) => NEW_IDS.includes(c.id));
    const existingCats = TRAP_CATEGORIES.filter((c) => !NEW_IDS.includes(c.id));

    for (const ec of existingCats) {
      for (const query of ec.recallQueries) {
        const allCats = [...newCats, ...existingCats];
        const scored = allCats
          .map((c) => ({ id: c.id, score: score(query, tokenize(c.lesson)) }))
          .sort((a, b) => b.score - a.score);

        const top1Score = scored[0].score;

        if (top1Score === 0) continue;

        const top1Ids = scored.filter((s) => s.score === top1Score).map((s) => s.id);
        const newAtTopExclusively = top1Ids.length === 1 && NEW_IDS.includes(top1Ids[0]);
        expect(newAtTopExclusively).toBe(false);
      }
    }
  });

  it('each new-category recall query does NOT top-1-rank an existing-category lesson alone', () => {
    const newCats = TRAP_CATEGORIES.filter((c) => NEW_IDS.includes(c.id));
    const existingCats = TRAP_CATEGORIES.filter((c) => !NEW_IDS.includes(c.id));

    for (const nc of newCats) {
      for (const query of nc.recallQueries) {
        const allCats = [...newCats, ...existingCats];
        const scored = allCats
          .map((c) => ({ id: c.id, score: score(query, tokenize(c.lesson)) }))
          .sort((a, b) => b.score - a.score);

        const top1Score = scored[0].score;
        const top1Ids = scored.filter((s) => s.score === top1Score).map((s) => s.id);

        if (top1Score === 0) continue;

        const newAtTop = top1Ids.filter((id) => NEW_IDS.includes(id));
        expect(newAtTop).toEqual([nc.id]);
      }
    }
  });
});
