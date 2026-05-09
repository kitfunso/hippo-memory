// tests/sl-bm25-mismatch.test.ts
//
// v1.8.0 — Independent verification beyond Jaccard: confirm that the new
// adversarial categories' lessons are NOT trivially BM25-matched by the
// existing-10 categories' recall queries (and vice versa).
//
// Per outside voice E4 (v1.8.0 plan): BM25 catches token-frequency-weighted
// match that pure Jaccard might miss.
//
// Per `docs/RETRACTION.md`: this is a workload-validity check on lesson/query
// disjointness. It is NOT a magnitude claim.

import { describe, it, expect } from 'vitest';
import { TRAP_CATEGORIES } from '../benchmarks/sequential-learning/traps.mjs';

const NEW_IDS = ['timezone_naive', 'idempotency_retry', 'float_accumulation'];

// Simple BM25-like score: shared-token count, tokens lower-cased, length>2.
// Not full BM25 (no IDF, no length normalisation) — sufficient as a sanity sim.
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

        // If top1Score === 0, all categories tie at zero (no lexical match to the query).
        // That is NOT a BM25 mismatch — the query's tokens don't appear in any lesson.
        // Skip the assertion. The simple-tokenize sim is intentionally not stemmed,
        // so single/plural mismatches (e.g. 'exception' query vs 'exceptions' lesson)
        // produce zero-ties; Jaccard with Porter-stem catches the real overlap.
        if (top1Score === 0) continue;

        // For non-degenerate scores: no new-category should be the SOLE top-1 winner.
        // (Tied-at-top with the expected existing category is acceptable — same shared engineering vocab.)
        const top1Ids = scored.filter((s) => s.score === top1Score).map((s) => s.id);
        const newAtTopExclusively = top1Ids.length === 1 && NEW_IDS.includes(top1Ids[0]);
        expect(newAtTopExclusively).toBe(false);
      }
    }
  });

  it('each new-category recall query does NOT top-1-rank an existing-category lesson alone', () => {
    // Symmetric check: a new-category query should retrieve EITHER its own new lesson
    // (ideal) OR a tied set including new categories. It should NOT exclusively rank
    // an existing-category lesson at top-1.
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

        // If top1Score === 0, all categories tie at zero (degenerate); that's NOT a mismatch — query just isn't lexically anywhere.
        if (top1Score === 0) continue;

        // If top1Score > 0, at least one new-category should be at the top tier.
        const newAtTop = top1Ids.filter((id) => NEW_IDS.includes(id));
        expect(newAtTop.length).toBeGreaterThan(0);
      }
    }
  });
});
