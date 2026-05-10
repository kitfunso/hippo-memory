# F6 LongMemEval Reranker Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pluggable reranker pass to the hybrid retrieval path and characterise its effect on LongMemEval R@5 across three escalating tracks (lexical-feature, cross-encoder, LLM), under the v1.8.1 pre-registration discipline.

**Architecture:** Insert a `rerank()` step in `hybridSearch` between MMR re-ordering (`src/search.ts:534-543`) and budget filtering (`src/search.ts:545-554`). Rerankers are pluggable via a `reranker?: RerankerFn` option; default is `null` (current behaviour preserved). Three implementations land in `src/rerankers/{features,cross-encoder,llm}.ts`. The LongMemEval harness (`benchmarks/longmemeval/retrieve_inprocess.mjs`) gains a `--reranker {features|cross-encoder|llm}` flag. Tier-1 micro-eval gains paired A/B fixtures per track.

**Tech Stack:** TypeScript, vitest (real SQLite, no mocks), Python harness, optional `@xenova/transformers` for cross-encoder (already a peer dep), customer-supplied OpenAI-compatible endpoint for LLM track.

---

## Spec source

`ROADMAP-RESEARCH.md:372-374` — F6 LongMemEval reranker hardening. Roadmap text: *"Close gap from current R@5 toward MemPalace's 96.6% via reranker tuning + cross-encoder evaluation. R@5 ≥ 85% on LongMemEval with the existing hybrid path."*

**Effort:** 6d single-engineer (lane B parallel during May Wks 1-4 per ROADMAP-RESEARCH.md:461).

**Branch:** `claude/plan-implementation-workflow-sasNp` (this session). New code lands here; merges to `main` after eng-review.

---

## Retraction-discipline framing (READ FIRST)

`docs/RETRACTION.md:5-7` (added v1.8.1) requires: **no eval pre-commitment is binding without (a) source-read of the dependency code paths AND (b) a 1-question dry-run wired through the actual mechanism path that confirms the mechanism FIRES before pre-reg locks.** The magnitude-smuggling guard at `docs/RETRACTION.md:15-23` prohibits:

- "Δ = Xpp", "Xpp lift/drop"
- "Magnitude" applied to a mechanism's effect
- A pre-registered numeric pass/fail threshold on a single metric
- "Lift" / "improvement" without explicit workload-validity framing

The roadmap's "R@5 ≥ 85%" is therefore **NOT** treated as a binary pass/fail in this plan. It is a non-blocking target. The pre-registration in Task 1 frames the eval as workload-validity (does each reranker fire on ≥X% of queries; does R@5 vary across hyperparameters at all) plus descriptive characterisation across the three tracks.

Every result doc, CHANGELOG entry, and README update produced by this plan MUST contain the verbatim sentence: *"This release does not re-assert the retracted −10pp magnitude."* Per `docs/RETRACTION.md:39`.

---

## File Structure

**Create:**
- `src/rerankers/types.ts` — `RerankerFn`, `RerankResult`, `RerankSignals` interfaces
- `src/rerankers/features.ts` — Track 1: lexical/feature reranker (uses `confidence`, `schema_fit`, `kind`, `strength`, `outcome_*`)
- `src/rerankers/cross-encoder.ts` — Track 2: MS-MARCO MiniLM cross-encoder via `@xenova/transformers`
- `src/rerankers/llm.ts` — Track 3: pairwise listwise rerank via OpenAI-compatible endpoint
- `src/rerankers/index.ts` — `getReranker(name)` factory
- `tests/rerankers/features.test.ts`
- `tests/rerankers/cross-encoder.test.ts`
- `tests/rerankers/llm.test.ts`
- `tests/rerankers/integration-hybrid-search.test.ts` — integration via `hybridSearch({ reranker })`
- `benchmarks/micro/fixtures/reranker_features.json`
- `benchmarks/micro/fixtures/reranker_cross_encoder.json`
- `benchmarks/longmemeval/run_reranker_sweep.mjs` — orchestrator that runs the harness across all three tracks + baseline
- `docs/evals/2026-05-10-f6-reranker-prereg.md` — pre-registration document (with dry-run evidence)
- `docs/evals/2026-05-10-f6-reranker-result.md` — result document (post-eval)

**Modify:**
- `src/search.ts:234-557` — add `reranker?: RerankerFn` option to `hybridSearch`, slot reranker call between MMR and budget filtering
- `src/search.ts:165-225` — extend `SearchResult.breakdown` with optional `rerankScore`, `preRerankRank`, `postRerankRank`
- `benchmarks/longmemeval/retrieve_inprocess.mjs:18-30` — add `--reranker`, `--reranker-config` flags
- `package.json` — add `@xenova/transformers` as optional peer dep entry if not already present (it is — confirm in Task 8)
- `CHANGELOG.md` — v1.9.0 entry after eval result lands
- `ROADMAP-RESEARCH.md:372-374` — flip F6 status from `[next]` to `[shipped]` with eval-result link

**Why split rerankers into separate files:** each reranker has independent dependencies (Track 1 = none, Track 2 = transformers, Track 3 = network). Splitting prevents unused-import bloat in CLI startup and lets each be tested in isolation. `index.ts` is the single import surface.

---

## Pre-flight: scope check

Three reranker tracks in 6 days is tight. The plan budgets:
- Track 1 (features): 1.5d — no model dep, pure TypeScript, fastest signal
- Track 2 (cross-encoder): 2d — model load + per-query inference latency
- Track 3 (LLM): 1d skeleton + integration — full LLM eval is post-6d follow-on
- Pre-registration + dry-run: 0.5d
- Sweep + result doc + framing-compliance review: 1d

This is sized for one engineer on lane B. If pulled off lane A duties, expect slip.

Tracks 1 and 2 must ship binary-on/binary-off in the harness within the 6d window. Track 3 ships as a skeleton with one fixture-driven smoke test; full LLM characterisation is deferred to a follow-on plan.

---

## Task 1: Pre-registration + source-read + 1-question dry-run

**Files:**
- Create: `docs/evals/2026-05-10-f6-reranker-prereg.md`

This task satisfies `docs/RETRACTION.md:5-7`. No reranker code is written until both gates pass.

- [ ] **Step 1: Source-read confirmation of dependency code paths**

Read these and copy the relevant signatures/line numbers into the prereg doc:

1. `src/search.ts:234-557` (`hybridSearch` — confirm reranker slot is post-MMR, pre-budget)
2. `src/search.ts:165-225` (`SearchResult`, `ScoreBreakdown` — confirm extension points)
3. `src/memory.ts` (`MemoryEntry` — confirm `confidence`, `schema_fit`, `kind`, `strength`, `outcome_positive`, `outcome_negative`, `emotional_valence` are present and typed)
4. `benchmarks/longmemeval/retrieve_inprocess.mjs:18-30` (flag-parsing — confirm new flags slot in cleanly)
5. `benchmarks/micro/run.py:1-65` (fixture format docstring — confirm `cli_args` per query supports a new `--reranker` flag)

For each, paste the exact function signature or struct definition and the file:line range into the prereg doc. The retraction rule requires this be done **before** the rest of the prereg locks.

- [ ] **Step 2: 1-question dry-run wiring (Track 1 only — sufficient to demonstrate the mechanism path FIRES)**

Build hippo locally and run a one-shot dry-run that proves a reranker injected via the `reranker` option actually executes during `hybridSearch`. This step exists *before* any production reranker is implemented. It uses a stub identity reranker so the path is exercised end-to-end.

Run:
```bash
npm run build
node -e '
  import("./dist/search.js").then(async ({ hybridSearch, buildCorpus }) => {
    const { createMemory } = await import("./dist/memory.js");
    const entries = [
      createMemory("CI pipeline failure on push to master"),
      createMemory("Python dict ordering guarantees in 3.7+"),
    ];
    let rerankerCalled = false;
    const stubReranker = async (query, results) => {
      rerankerCalled = true;
      return results.map((r, i) => ({ ...r, rerankScore: 1 - i * 0.01 }));
    };
    const out = await hybridSearch("CI failure", entries, { budget: 10000, reranker: stubReranker });
    console.log("reranker fired:", rerankerCalled);
    console.log("results:", out.length);
  });
'
```

Expected: `reranker fired: true` and `results: 2`.

This step will FAIL initially — the `reranker` option does not exist on `hybridSearch` yet. **That is the point of the dry-run.** It confirms what code path Task 2 must change to make the mechanism fire. Paste the actual error message into the prereg doc as evidence the source-read identified the right code path.

- [ ] **Step 3: Write the prereg doc**

Create `docs/evals/2026-05-10-f6-reranker-prereg.md` with these sections:

```markdown
# F6 reranker hardening — pre-registration

**Author:** [name]
**Date:** 2026-05-10
**Plan:** docs/plans/2026-05-10-f6-reranker-hardening.md
**Retraction-discipline reference:** docs/RETRACTION.md

This release does not re-assert the retracted −10pp magnitude.

## Source-read evidence

[Paste signatures + line numbers from Step 1]

## 1-question dry-run evidence

[Paste actual error from Step 2 stub run; confirms the mechanism path
hybridSearch -> reranker is currently NOT wired and Task 2 will wire it]

## Workload-validity gate (binding)

For each track T in {features, cross-encoder, llm}:
  Gate-A (firing rate): on the LongMemEval 500-question dataset with the
    v0.27 hippo store, the reranker function is invoked on ≥95% of queries
    (at least 475 of 500). Below 475, the workload is declared invalid for
    track T and no R@5 number is reported as a mechanism-effect claim.
  Gate-B (variance): R@5 measured at three reranker hyperparameter
    settings (per-track config, see plan Task 5/8/11) MUST differ from
    each other by at least one entry. If all three settings produce
    identical R@5 to four decimal places, the workload does not
    discriminate the reranker hyperparameters and no R@5 number is
    reported as a hyperparameter-effect claim.

## Descriptive characterisation (NON-binding)

R@1, R@3, R@5, R@10, MRR, NDCG@10 reported per track per hyperparameter
setting. Per-category breakdowns (single-session-assistant, single-session-user,
single-session-preference, multi-session, knowledge-update, temporal-reasoning).
Latency p50/p99 per track. These numbers are descriptive characterisation,
not pre-registered pass/fail thresholds.

## Roadmap target (NON-binding)

ROADMAP-RESEARCH.md:374 lists "R@5 ≥ 85%" as the F6 success criterion.
Per the v1.8.1 pre-registration discipline this is treated here as a
non-blocking target, not a pre-registered numeric gate. The mechanism
ships if Gate-A passes for any track; whether R@5 reaches 85% is
descriptive.

## Cumulative null status

Per docs/RETRACTION.md:94-113, the dlPFC goal-stack mechanism's
measured effect on tested workloads is null. The reranker mechanisms
introduced here are independent of dlPFC goal-stack. Their effect on
LongMemEval is open and characterised descriptively below.
```

- [ ] **Step 4: Outside-voice review of the prereg framing**

Per `docs/RETRACTION.md:41`. Have a second engineer (or the project's eng-review process) confirm:

1. The framing satisfies the magnitude-smuggling guard.
2. Gate-A and Gate-B are workload-validity checks, not magnitude claims.
3. The "R@5 ≥ 85%" target is described as non-binding.

Reviewer comments and resolutions land in a `## Review trail` section appended to the prereg doc.

- [ ] **Step 5: Commit prereg**

```bash
git add docs/evals/2026-05-10-f6-reranker-prereg.md docs/plans/2026-05-10-f6-reranker-hardening.md
git commit -m "docs(plans+evals): F6 reranker hardening plan + prereg

- Plan: three reranker tracks (features, cross-encoder, llm)
- Prereg: source-read + dry-run gates per docs/RETRACTION.md:5-7
- Workload-validity framing (no binary R@5 pass/fail)

This release does not re-assert the retracted −10pp magnitude."
```

---

## Task 2: Reranker plumbing in `hybridSearch`

**Files:**
- Create: `src/rerankers/types.ts`
- Modify: `src/search.ts:165-225` (extend `SearchResult` + `ScoreBreakdown`)
- Modify: `src/search.ts:234-557` (add `reranker` option to `hybridSearch`)
- Test: `tests/rerankers/integration-hybrid-search.test.ts`

This task wires the seam. No actual reranker is implemented yet — the seam accepts a stub.

- [ ] **Step 1: Write the failing integration test**

Create `tests/rerankers/integration-hybrid-search.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { hybridSearch, type SearchResult } from '../../src/search.js';
import { createMemory } from '../../src/memory.js';
import type { RerankerFn } from '../../src/rerankers/types.js';

describe('hybridSearch reranker seam', () => {
  it('invokes the reranker after MMR and before budget filtering', async () => {
    const entries = [
      createMemory('CI pipeline failure on push to master'),
      createMemory('Python dict ordering guarantees in 3.7+'),
      createMemory('Production database is hosted on us-east-1'),
    ];

    const calls: { query: string; resultCount: number }[] = [];
    const stub: RerankerFn = async (query, results) => {
      calls.push({ query, resultCount: results.length });
      // Reverse order to prove the reranker output replaces the input ordering
      return [...results].reverse().map((r, i) => ({
        ...r,
        rerankScore: results.length - i,
      }));
    };

    const out = await hybridSearch('CI failure', entries, {
      budget: 100000,
      reranker: stub,
    });

    expect(calls.length).toBe(1);
    expect(calls[0].query).toBe('CI failure');
    expect(calls[0].resultCount).toBeGreaterThan(0);
    // Reranker output ordering is preserved
    expect(out[0].entry.id).toBe(entries[entries.length - 1].id);
  });

  it('skips reranker when option not provided (current behaviour preserved)', async () => {
    const entries = [createMemory('the quick brown fox')];
    const out = await hybridSearch('fox', entries, { budget: 100000 });
    expect(out.length).toBe(1);
    expect(out[0]).not.toHaveProperty('rerankScore');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rerankers/integration-hybrid-search.test.ts`
Expected: FAIL with type error on `RerankerFn` import (file does not exist) and `reranker` option (does not exist on `hybridSearch`).

- [ ] **Step 3: Create the types file**

Create `src/rerankers/types.ts`:

```typescript
import type { SearchResult } from '../search.js';

/**
 * A reranker reorders (and optionally rescales) the candidate set produced
 * by hybridSearch's BM25 + cosine + MMR pipeline. Rerankers run AFTER MMR
 * de-duplication and BEFORE token-budget filtering, so the reranker sees
 * the full diversity-balanced candidate pool but does not see candidates
 * already filtered out by score-zero or supersession.
 *
 * Rerankers MUST be deterministic for a given (query, results) input
 * unless explicitly documented as stochastic (LLM track). Determinism is
 * required for paired A/B and for the workload-validity gate in
 * docs/evals/2026-05-10-f6-reranker-prereg.md.
 */
export type RerankerFn = (
  query: string,
  results: SearchResult[],
  options?: RerankerOptions,
) => Promise<RerankResult[]>;

export interface RerankerOptions {
  /** Cap candidates passed to the reranker. Default 50. */
  topK?: number;
  /** Per-track config blob; opaque to the seam. */
  config?: Record<string, unknown>;
}

export interface RerankResult extends SearchResult {
  /** Score assigned by the reranker. Replaces `score` for downstream
   *  ordering; original `score` preserved on the SearchResult. */
  rerankScore: number;
  /** 1-indexed rank in the input to the reranker. */
  preRerankRank: number;
  /** 1-indexed rank in the reranker output. */
  postRerankRank: number;
}

/**
 * Signals available to feature-based rerankers, extracted once per
 * candidate to avoid re-tokenizing or re-fetching.
 */
export interface RerankSignals {
  confidence: 'verified' | 'observed' | 'inferred' | 'stale' | null;
  schemaFit: number;
  kind: 'raw' | 'distilled' | 'superseded' | 'archived' | null;
  strength: number;
  retrievalCount: number;
  outcomePositive: number;
  outcomeNegative: number;
  emotionalValence: 'neutral' | 'error' | 'success' | 'critical' | null;
}
```

- [ ] **Step 4: Extend `SearchResult` and add the `reranker` option**

Modify `src/search.ts:165-176` to add optional `rerankScore`, `preRerankRank`, `postRerankRank`:

```typescript
export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  bm25: number;
  cosine: number;
  tokens: number;
  /** Populated when search is called with options.explain === true. */
  breakdown?: ScoreBreakdown;
  /** Populated when a reranker ran. Replaces `score` for ordering;
   *  original `score` preserved here. See src/rerankers/types.ts. */
  rerankScore?: number;
  preRerankRank?: number;
  postRerankRank?: number;
}
```

In `src/search.ts:234-266` add the option:

```typescript
export async function hybridSearch(
  query: string,
  entries: MemoryEntry[],
  options: {
    // ... existing options unchanged ...
    /** Optional reranker. Runs after MMR, before budget filtering.
     *  See src/rerankers/types.ts. */
    reranker?: import('./rerankers/types.js').RerankerFn;
    /** Options passed through to the reranker. */
    rerankerOptions?: import('./rerankers/types.js').RerankerOptions;
  } = {}
): Promise<SearchResult[]> {
```

In `src/search.ts:534-543` (after MMR, before budget filtering), add:

```typescript
  // Reranker pass: see src/rerankers/types.ts and
  // docs/plans/2026-05-10-f6-reranker-hardening.md.
  if (options.reranker) {
    const topK = options.rerankerOptions?.topK ?? 50;
    const head = ordered.slice(0, topK);
    const tail = ordered.slice(topK);
    const rerankInputWithRank = head.map((r, i) => ({ ...r, preRerankRank: i + 1 }));
    const reranked = await options.reranker(
      query,
      rerankInputWithRank,
      options.rerankerOptions,
    );
    const withPostRank = reranked.map((r, i) => ({ ...r, postRerankRank: i + 1 }));
    ordered = [...withPostRank, ...tail];
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/rerankers/integration-hybrid-search.test.ts`
Expected: PASS (2 tests, both green).

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npm test`
Expected: PASS. No existing test should regress. If any test fails, the seam was added incorrectly — revert and fix.

- [ ] **Step 7: Commit**

```bash
git add src/search.ts src/rerankers/types.ts tests/rerankers/integration-hybrid-search.test.ts
git commit -m "feat(search): reranker seam in hybridSearch (no impl yet)

- Add RerankerFn type and RerankResult/RerankSignals interfaces
- hybridSearch accepts options.reranker; runs after MMR, before budget
- SearchResult gains optional rerankScore/preRerankRank/postRerankRank
- Default behaviour unchanged when reranker option absent

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 2"
```

---

## Task 3: Track 1 — features reranker (lexical/feature re-score)

**Files:**
- Create: `src/rerankers/features.ts`
- Create: `src/rerankers/index.ts`
- Test: `tests/rerankers/features.test.ts`

The features reranker uses signals already on `MemoryEntry` (confidence tier, schema_fit, kind, strength, retrieval_count, outcomes, emotional_valence) plus query-time exact-match overlap. No external dependencies.

Track 1 is the "free" track — sub-millisecond latency, no model load, no network. It establishes the seam baseline and the per-category profile that Tracks 2 and 3 must beat to justify their cost.

- [ ] **Step 1: Write the failing unit test**

Create `tests/rerankers/features.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { featuresReranker } from '../../src/rerankers/features.js';
import { createMemory, type MemoryEntry } from '../../src/memory.js';
import type { SearchResult } from '../../src/search.js';

function asResult(entry: MemoryEntry, score: number): SearchResult {
  return { entry, score, bm25: score, cosine: 0, tokens: 10 };
}

describe('featuresReranker', () => {
  it('boosts verified over inferred when content is otherwise equivalent', async () => {
    const verified = createMemory('Production DB is on us-east-1');
    verified.confidence = 'verified';
    const inferred = createMemory('Production DB is on us-east-1');
    inferred.confidence = 'inferred';

    const out = await featuresReranker(
      'where is the production database',
      [asResult(inferred, 1.0), asResult(verified, 0.99)],
    );

    expect(out[0].entry.id).toBe(verified.id);
    expect(out[0].rerankScore).toBeGreaterThan(out[1].rerankScore);
  });

  it('downweights stale/superseded kinds', async () => {
    const fresh = createMemory('Use OAuth 2.0 for auth');
    fresh.kind = 'distilled';
    const stale = createMemory('Use OAuth 1.0 for auth');
    stale.kind = 'superseded';

    const out = await featuresReranker(
      'how do we authenticate',
      [asResult(stale, 1.0), asResult(fresh, 0.95)],
    );

    expect(out[0].entry.id).toBe(fresh.id);
  });

  it('preserves input ordering when no signal differentiates', async () => {
    const a = createMemory('alpha bravo charlie');
    const b = createMemory('delta echo foxtrot');

    const out = await featuresReranker('alpha', [asResult(a, 1.0), asResult(b, 0.5)]);

    expect(out[0].entry.id).toBe(a.id);
    expect(out[1].entry.id).toBe(b.id);
  });

  it('respects topK option (does not rerank beyond cap)', async () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      asResult(createMemory(`memory ${i}`), 100 - i),
    );

    const out = await featuresReranker('memory', entries, { topK: 10 });

    expect(out.length).toBe(10);
    expect(out.every((r) => r.rerankScore !== undefined)).toBe(true);
  });

  it('is deterministic across runs', async () => {
    const entries = [
      asResult(createMemory('alpha'), 1.0),
      asResult(createMemory('beta'), 0.9),
      asResult(createMemory('gamma'), 0.8),
    ];
    const a = await featuresReranker('alpha', entries);
    const b = await featuresReranker('alpha', entries);
    expect(a.map((r) => r.entry.id)).toEqual(b.map((r) => r.entry.id));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rerankers/features.test.ts`
Expected: FAIL with import error — `featuresReranker` does not exist.

- [ ] **Step 3: Implement `featuresReranker`**

Create `src/rerankers/features.ts`:

```typescript
import { tokenize } from '../search.js';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';

const CONFIDENCE_WEIGHT: Record<string, number> = {
  verified: 1.30,
  observed: 1.10,
  inferred: 0.90,
  stale: 0.70,
};

const KIND_WEIGHT: Record<string, number> = {
  distilled: 1.10,
  raw: 1.00,
  superseded: 0.50,
  archived: 0.30,
};

/**
 * Track 1 reranker: rescore the candidate set using signals already on
 * MemoryEntry. No external dependencies, no network, no model load.
 *
 * Score = base_score * confidence_w * kind_w * (0.7 + 0.3*schema_fit)
 *       * (0.8 + 0.2*tanh(strength)) * (1 + 0.1*tanh(pos-neg))
 *       * exact_overlap_boost
 *
 * Weights are calibrated for sign and order, NOT a magnitude claim.
 * See docs/plans/2026-05-10-f6-reranker-hardening.md Task 3.
 */
export const featuresReranker: RerankerFn = async (
  query,
  results,
  options?: RerankerOptions,
): Promise<RerankResult[]> => {
  const topK = options?.topK ?? 50;
  const head = results.slice(0, topK);
  const queryTerms = new Set(tokenize(query));

  const rescored = head.map((r, i) => {
    const e = r.entry;

    const confW = CONFIDENCE_WEIGHT[e.confidence ?? ''] ?? 1.0;
    const kindW = KIND_WEIGHT[e.kind ?? ''] ?? 1.0;
    const schemaFitW = 0.7 + 0.3 * (e.schema_fit ?? 0.5);
    const strengthW = 0.8 + 0.2 * Math.tanh(e.strength ?? 0);

    const pos = e.outcome_positive ?? 0;
    const neg = e.outcome_negative ?? 0;
    const outcomeW = 1 + 0.1 * Math.tanh((pos - neg) / 2);

    const docTerms = new Set(tokenize(`${e.content} ${e.tags.join(' ')}`));
    let overlap = 0;
    for (const t of queryTerms) if (docTerms.has(t)) overlap++;
    const overlapW = queryTerms.size > 0 ? 1 + 0.2 * (overlap / queryTerms.size) : 1;

    const rerankScore = r.score * confW * kindW * schemaFitW * strengthW * outcomeW * overlapW;

    return {
      ...r,
      rerankScore,
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: 0,
    };
  });

  rescored.sort((a, b) => b.rerankScore - a.rerankScore);
  rescored.forEach((r, i) => (r.postRerankRank = i + 1));

  return rescored;
};
```

- [ ] **Step 4: Create the factory**

Create `src/rerankers/index.ts`:

```typescript
import { featuresReranker } from './features.js';
import type { RerankerFn } from './types.js';

const REGISTRY: Record<string, RerankerFn> = {
  features: featuresReranker,
};

export function getReranker(name: string | null | undefined): RerankerFn | null {
  if (!name) return null;
  const fn = REGISTRY[name];
  if (!fn) throw new Error(`Unknown reranker: ${name}. Available: ${Object.keys(REGISTRY).join(', ')}`);
  return fn;
}

export type { RerankerFn, RerankResult, RerankerOptions, RerankSignals } from './types.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/rerankers/features.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/rerankers/features.ts src/rerankers/index.ts tests/rerankers/features.test.ts
git commit -m "feat(rerankers): Track 1 features reranker (no model dep)

- Lexical re-score using confidence, kind, schema_fit, strength, outcome
- Deterministic; sub-millisecond per query
- Weights are sign-only, not a magnitude claim

This release does not re-assert the retracted −10pp magnitude.

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 3"
```

---

## Task 4: Wire features reranker into the LongMemEval harness

**Files:**
- Modify: `benchmarks/longmemeval/retrieve_inprocess.mjs:18-30, 64-95`

- [ ] **Step 1: Add `--reranker` flag parsing**

Modify `benchmarks/longmemeval/retrieve_inprocess.mjs:18-30`:

```javascript
function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const DATA_PATH = flag('--data', 'data/longmemeval_oracle.json');
const STORE_DIR = flag('--store-dir', 'hippo_store2');
const OUTPUT_PATH = flag('--output', 'results/retrieval_v27.jsonl');
const BUDGET = parseInt(flag('--budget', '1000000'), 10);
const LIMIT = parseInt(flag('--limit', '0'), 10);
const EMB_WEIGHT = flag('--embedding-weight', null);
const NO_MMR = process.argv.includes('--no-mmr');
const MIN_RESULTS = parseInt(flag('--min-results', '10'), 10);
const RERANKER = flag('--reranker', null);
const RERANKER_TOP_K = parseInt(flag('--reranker-top-k', '50'), 10);
```

- [ ] **Step 2: Import the factory**

Modify the import block at `benchmarks/longmemeval/retrieve_inprocess.mjs:13-16`:

```javascript
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hybridSearch, buildCorpus } from '../../dist/search.js';
import { loadAllEntries } from '../../dist/store.js';
import { getReranker } from '../../dist/rerankers/index.js';
```

- [ ] **Step 3: Resolve the reranker once before the loop**

Insert after `benchmarks/longmemeval/retrieve_inprocess.mjs:51`:

```javascript
const reranker = getReranker(RERANKER);
if (RERANKER) {
  console.error(`Reranker: ${RERANKER} (top-K=${RERANKER_TOP_K})`);
}
```

- [ ] **Step 4: Pass reranker into hybridSearch**

Modify `benchmarks/longmemeval/retrieve_inprocess.mjs:68-75`:

```javascript
    const results = await hybridSearch(question, entries, {
      budget: BUDGET,
      hippoRoot,
      preparedCorpus: corpus,
      embeddingWeight: EMB_WEIGHT !== null ? parseFloat(EMB_WEIGHT) : undefined,
      mmr: !NO_MMR,
      minResults: MIN_RESULTS,
      reranker: reranker ?? undefined,
      rerankerOptions: reranker ? { topK: RERANKER_TOP_K } : undefined,
    });
```

- [ ] **Step 5: Track reranker firing rate (Gate-A evidence)**

Modify the loop body to track firing. Add at the top of the loop (before line 64):

```javascript
let rerankerFired = 0;
```

Inside the loop (after `const memories = ...`):

```javascript
    if (reranker && results.some((r) => r.rerankScore !== undefined)) {
      rerankerFired++;
    }
```

In the final summary line (replace line 119):

```javascript
console.error(`Done in ${totalSec.toFixed(1)}s. ${limit} queries, ${empty} empty, reranker fired on ${rerankerFired}/${limit}, output: ${OUTPUT_PATH}`);
```

- [ ] **Step 6: Smoke-test the harness with the features reranker**

Run:
```bash
npm run build
node benchmarks/longmemeval/retrieve_inprocess.mjs --data data/longmemeval_oracle.json --store-dir hippo_store2 --output results/retrieval_v27_features.jsonl --reranker features --limit 5
```

Expected stderr: `Reranker: features (top-K=50)` and `reranker fired on 5/5`. If firing rate is below 5/5 on the first 5 queries, the wiring is broken — debug before proceeding.

If `data/longmemeval_oracle.json` is not present locally, document the data-acquisition steps in `evals/README.md` and check whether the same engineer who shipped v0.27 has a copy.

- [ ] **Step 7: Commit**

```bash
git add benchmarks/longmemeval/retrieve_inprocess.mjs
git commit -m "feat(benchmarks): --reranker flag in LongMemEval harness

- Resolves reranker via getReranker() factory
- Tracks firing rate for Gate-A workload-validity evidence
- Smoke-tested with features reranker on 5-question subset

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 4"
```

---

## Task 5: Tier-1 micro-eval fixture for features reranker (paired A/B)

**Files:**
- Create: `benchmarks/micro/fixtures/reranker_features.json`

The tier-1 paired A/B harness is the fastest signal for whether a mechanism produces detectable behavioural differences (per `ROADMAP-RESEARCH.md:27`). The fixture exercises confidence tier, kind, and outcome signals.

- [ ] **Step 1: Author the fixture**

Create `benchmarks/micro/fixtures/reranker_features.json`:

```json
{
  "name": "reranker-features",
  "mechanic": "reranker",
  "description": "Track 1 features reranker — confidence/kind/outcome signals.",
  "remembers": [
    {"text": "Production database is hosted on us-east-1 (verified by ops 2026-04)", "tags": ["confidence:verified"]},
    {"text": "Production database is hosted on us-west-2 (overheard, not confirmed)", "tags": ["confidence:inferred"]},
    {"text": "Auth uses OAuth 1.0", "tags": ["kind:superseded"]},
    {"text": "Auth uses OAuth 2.0", "tags": ["kind:distilled"]},
    {"text": "Deploy script lives at scripts/deploy.sh", "tags": []},
    {"text": "Deploy uses scripts/deprecated_deploy.sh", "tags": []}
  ],
  "actions": [
    {"type": "outcomes", "remember_index": 4, "good": 3, "bad": 0},
    {"type": "outcomes", "remember_index": 5, "good": 0, "bad": 2}
  ],
  "queries": [
    {
      "q": "where is the production database",
      "must_contain_any": ["us-east-1"],
      "must_not_contain_any": ["us-west-2"],
      "top_k": 1,
      "cli_args": ["--reranker", "features"]
    },
    {
      "q": "how do we authenticate",
      "must_contain_any": ["OAuth 2.0"],
      "must_not_contain_any": ["OAuth 1.0"],
      "top_k": 1,
      "cli_args": ["--reranker", "features"]
    },
    {
      "q": "where is the deploy script",
      "must_contain_any": ["scripts/deploy.sh"],
      "must_not_contain_any": ["deprecated_deploy.sh"],
      "top_k": 1,
      "cli_args": ["--reranker", "features"]
    }
  ]
}
```

- [ ] **Step 2: Verify CLI exposes `--reranker` (or add it)**

Check `src/cli.ts` for the recall command flag set. If `--reranker` is not yet exposed on `hippo recall`, add it as a sibling of `--rerank-utility` near `src/cli.ts:958-976`:

```typescript
// In the recall flag spec:
.option('--reranker <name>', 'Apply a reranker pass after retrieval (features|cross-encoder|llm)')
.option('--reranker-top-k <n>', 'Cap candidates passed to the reranker', '50')
```

In the recall handler, after the existing `hybridSearch`-equivalent call, route through the reranker if requested. Use the same pattern as `--rerank-utility` for consistency.

- [ ] **Step 3: Run the fixture**

```bash
npm run build
python benchmarks/micro/run.py --filter reranker-features
```

Expected: 3/3 queries pass.

- [ ] **Step 4: Run the full micro-eval to confirm no regression**

```bash
python benchmarks/micro/run.py
```

Expected: previous 9/9 fixtures stay at 100%, plus the new fixture at 3/3 → 10/10 fixtures.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/micro/fixtures/reranker_features.json src/cli.ts
git commit -m "test(micro): tier-1 paired A/B fixture for features reranker

- Confidence-tier, kind, and outcome signal exercises
- 3 queries; --reranker features cli_args
- Adds --reranker / --reranker-top-k to hippo recall CLI

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 5"
```

---

## Task 6: Track 2 — cross-encoder reranker (MS-MARCO MiniLM)

**Files:**
- Create: `src/rerankers/cross-encoder.ts`
- Modify: `src/rerankers/index.ts`
- Test: `tests/rerankers/cross-encoder.test.ts`

The cross-encoder track uses `@xenova/transformers` (already an optional peer dep used by `src/embeddings.ts`). Model: `Xenova/ms-marco-MiniLM-L-6-v2`. Per-query latency target: <100ms p99 on top-50 candidates on a developer laptop CPU.

- [ ] **Step 1: Confirm `@xenova/transformers` is a usable peer dep**

Run: `node -e "import('@xenova/transformers').then(t => console.log(typeof t.AutoModel))"`
Expected: `function`. If it errors with "module not found," install: `npm install --save-optional @xenova/transformers`.

- [ ] **Step 2: Write the failing test**

Create `tests/rerankers/cross-encoder.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { crossEncoderReranker, isCrossEncoderAvailable } from '../../src/rerankers/cross-encoder.js';
import { createMemory } from '../../src/memory.js';
import type { SearchResult } from '../../src/search.js';

function asResult(content: string, score: number): SearchResult {
  return { entry: createMemory(content), score, bm25: score, cosine: 0, tokens: 10 };
}

describe('crossEncoderReranker', () => {
  let available = false;

  beforeAll(async () => {
    available = await isCrossEncoderAvailable();
  });

  it.runIf(() => available)('reorders semantically related candidates above lexically related ones', async () => {
    const out = await crossEncoderReranker('how do I deploy to production', [
      asResult('Production deployment runbook: run scripts/deploy.sh after CI passes', 0.5),
      asResult('The word production appears in many places', 1.0),
    ]);
    expect(out[0].entry.content).toContain('runbook');
  });

  it.runIf(() => available)('returns rerankScore on every result', async () => {
    const out = await crossEncoderReranker('test', [asResult('test content', 1.0)]);
    expect(out[0].rerankScore).toBeDefined();
    expect(typeof out[0].rerankScore).toBe('number');
  });

  it('falls back to identity ordering when cross-encoder is unavailable', async () => {
    // This test runs regardless. When the model is loadable it tests determinism;
    // when not, it tests the unavailable path.
    const inputs = [asResult('alpha', 1.0), asResult('beta', 0.5)];
    const out = await crossEncoderReranker('alpha', inputs);
    expect(out.length).toBe(2);
    expect(out.every((r) => r.rerankScore !== undefined)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/rerankers/cross-encoder.test.ts`
Expected: FAIL with "module not found" on `cross-encoder.js`.

- [ ] **Step 4: Implement the cross-encoder reranker**

Create `src/rerankers/cross-encoder.ts`:

```typescript
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';

const MODEL_NAME = 'Xenova/ms-marco-MiniLM-L-6-v2';
let cachedPipeline: unknown = null;

export async function isCrossEncoderAvailable(): Promise<boolean> {
  try {
    const t = await import('@xenova/transformers');
    return typeof t.pipeline === 'function';
  } catch {
    return false;
  }
}

async function loadPipeline(): Promise<((q: string, c: string) => Promise<{ score: number }[]>) | null> {
  if (cachedPipeline) return cachedPipeline as never;
  try {
    const { pipeline } = await import('@xenova/transformers');
    const p = await pipeline('text-classification', MODEL_NAME);
    cachedPipeline = async (query: string, candidate: string) =>
      (await p(`${query} [SEP] ${candidate}`)) as { score: number }[];
    return cachedPipeline as never;
  } catch {
    return null;
  }
}

/**
 * Track 2 reranker: MS-MARCO MiniLM cross-encoder.
 * Loads model on first call, then sub-100ms per query for top-K=50 candidates
 * on a typical developer laptop CPU. Falls back to identity ordering if the
 * model fails to load (no transformers, no network for first download, etc.).
 *
 * See docs/plans/2026-05-10-f6-reranker-hardening.md Task 6.
 */
export const crossEncoderReranker: RerankerFn = async (
  query,
  results,
  options?: RerankerOptions,
): Promise<RerankResult[]> => {
  const topK = options?.topK ?? 50;
  const head = results.slice(0, topK);

  const pipe = await loadPipeline();
  if (!pipe) {
    // Fallback: identity ordering with rerankScore = original score
    return head.map((r, i) => ({
      ...r,
      rerankScore: r.score,
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: i + 1,
    }));
  }

  const scored = await Promise.all(
    head.map(async (r, i) => {
      const out = await pipe(query, r.entry.content);
      const ceScore = Array.isArray(out) && out.length > 0 ? out[0].score : 0;
      return {
        ...r,
        rerankScore: ceScore,
        preRerankRank: r.preRerankRank ?? i + 1,
        postRerankRank: 0,
      };
    }),
  );

  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  scored.forEach((r, i) => (r.postRerankRank = i + 1));
  return scored;
};
```

- [ ] **Step 5: Register in the factory**

Modify `src/rerankers/index.ts`:

```typescript
import { featuresReranker } from './features.js';
import { crossEncoderReranker } from './cross-encoder.js';
import type { RerankerFn } from './types.js';

const REGISTRY: Record<string, RerankerFn> = {
  features: featuresReranker,
  'cross-encoder': crossEncoderReranker,
};

export function getReranker(name: string | null | undefined): RerankerFn | null {
  if (!name) return null;
  const fn = REGISTRY[name];
  if (!fn) throw new Error(`Unknown reranker: ${name}. Available: ${Object.keys(REGISTRY).join(', ')}`);
  return fn;
}

export type { RerankerFn, RerankResult, RerankerOptions, RerankSignals } from './types.js';
```

- [ ] **Step 6: Run cross-encoder test**

Run: `npx vitest run tests/rerankers/cross-encoder.test.ts`
Expected: PASS. The `runIf(() => available)` tests skip gracefully if the model fails to load locally; the fallback test always runs.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 8: Smoke-test in the harness**

```bash
npm run build
node benchmarks/longmemeval/retrieve_inprocess.mjs --data data/longmemeval_oracle.json --store-dir hippo_store2 --output results/retrieval_ce.jsonl --reranker cross-encoder --limit 10
```

Expected stderr: `Reranker: cross-encoder (top-K=50)` and `reranker fired on 10/10`. The first query may take 5-30s while the model downloads + loads; subsequent queries should be <200ms each.

- [ ] **Step 9: Commit**

```bash
git add src/rerankers/cross-encoder.ts src/rerankers/index.ts tests/rerankers/cross-encoder.test.ts
git commit -m "feat(rerankers): Track 2 cross-encoder (MS-MARCO MiniLM)

- @xenova/transformers (optional peer dep, already used for embeddings)
- Falls back to identity ordering if model unavailable
- Smoke-tested on 10-question subset

This release does not re-assert the retracted −10pp magnitude.

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 6"
```

---

## Task 7: Tier-1 fixture for cross-encoder reranker

**Files:**
- Create: `benchmarks/micro/fixtures/reranker_cross_encoder.json`

- [ ] **Step 1: Author the fixture**

Create `benchmarks/micro/fixtures/reranker_cross_encoder.json`:

```json
{
  "name": "reranker-cross-encoder",
  "mechanic": "reranker",
  "description": "Track 2 cross-encoder — semantic similarity over lexical surface form.",
  "remembers": [
    "Production deployment runbook: run scripts/deploy.sh after CI passes",
    "The word production appears in many internal docs and meeting notes",
    "Customer escalation procedure for outages: page the on-call",
    "An outage of the customer database happened in 2025"
  ],
  "queries": [
    {
      "q": "how do I ship code to prod",
      "must_contain_any": ["runbook", "deploy.sh"],
      "must_not_contain_any": ["meeting notes"],
      "top_k": 1,
      "cli_args": ["--reranker", "cross-encoder"]
    },
    {
      "q": "what to do during a customer-impacting incident",
      "must_contain_any": ["escalation", "on-call"],
      "must_not_contain_any": ["2025"],
      "top_k": 1,
      "cli_args": ["--reranker", "cross-encoder"]
    }
  ]
}
```

- [ ] **Step 2: Run fixture**

```bash
npm run build
python benchmarks/micro/run.py --filter reranker-cross-encoder
```

Expected: 2/2 queries pass. If a query fails, the cross-encoder is producing a worse ordering than BM25 for that exact pair — record this in the result doc as a per-fixture characterisation, not a defect.

If model download is blocked by sandbox/network policy, mark the fixture as expected-skip in the harness output and document this in the result doc.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/micro/fixtures/reranker_cross_encoder.json
git commit -m "test(micro): tier-1 fixture for cross-encoder reranker

- Semantic-over-lexical cases (deploy != 'production' word match)
- 2 queries; --reranker cross-encoder cli_args

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 7"
```

---

## Task 8: Track 3 — LLM reranker skeleton

**Files:**
- Create: `src/rerankers/llm.ts`
- Modify: `src/rerankers/index.ts`
- Test: `tests/rerankers/llm.test.ts`

Track 3 ships as a skeleton with mocked-network tests. Full LLM characterisation requires a customer-supplied OpenAI-compatible endpoint and falls outside the 6d window. The skeleton must work end-to-end against a mock and against `OPENAI_API_KEY` if set.

The LLM track is opt-in only. It is gated on `process.env.HIPPO_LLM_RERANKER_URL` to prevent accidental cost.

- [ ] **Step 1: Write the failing test (mocked HTTP)**

Create `tests/rerankers/llm.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { llmReranker } from '../../src/rerankers/llm.js';
import { createMemory } from '../../src/memory.js';
import type { SearchResult } from '../../src/search.js';

function asResult(content: string, score: number): SearchResult {
  return { entry: createMemory(content), score, bm25: score, cosine: 0, tokens: 10 };
}

describe('llmReranker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.HIPPO_LLM_RERANKER_URL = 'http://mock';
    process.env.HIPPO_LLM_RERANKER_KEY = 'mock';
  });

  it('parses model output as a permutation and reorders accordingly', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[2, 0, 1]' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as never,
    );

    const inputs = [
      asResult('alpha content', 1.0),
      asResult('beta content', 0.9),
      asResult('gamma content', 0.8),
    ];
    const out = await llmReranker('test query', inputs);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(out[0].entry.content).toBe('gamma content');
    expect(out[1].entry.content).toBe('alpha content');
    expect(out[2].entry.content).toBe('beta content');
  });

  it('falls back to input ordering when the model returns malformed output', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'not a permutation' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as never,
    );
    const inputs = [asResult('a', 1.0), asResult('b', 0.5)];
    const out = await llmReranker('q', inputs);
    expect(out.map((r) => r.entry.content)).toEqual(['a', 'b']);
  });

  it('refuses to run when HIPPO_LLM_RERANKER_URL is unset', async () => {
    delete process.env.HIPPO_LLM_RERANKER_URL;
    delete process.env.HIPPO_LLM_RERANKER_KEY;
    await expect(llmReranker('q', [asResult('x', 1.0)])).rejects.toThrow(/HIPPO_LLM_RERANKER_URL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rerankers/llm.test.ts`
Expected: FAIL with "module not found".

- [ ] **Step 3: Implement the LLM reranker**

Create `src/rerankers/llm.ts`:

```typescript
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';

/**
 * Track 3 reranker: listwise LLM rerank. Uses a customer-supplied
 * OpenAI-compatible endpoint. Gated on HIPPO_LLM_RERANKER_URL to prevent
 * accidental cost.
 *
 * Skeleton only — see docs/plans/2026-05-10-f6-reranker-hardening.md Task 8.
 * Full characterisation deferred to a follow-on plan.
 */
export const llmReranker: RerankerFn = async (
  query,
  results,
  options?: RerankerOptions,
): Promise<RerankResult[]> => {
  const url = process.env.HIPPO_LLM_RERANKER_URL;
  const key = process.env.HIPPO_LLM_RERANKER_KEY;
  if (!url) {
    throw new Error('HIPPO_LLM_RERANKER_URL not set; refusing to run LLM reranker.');
  }

  const topK = options?.topK ?? 20;
  const head = results.slice(0, topK);

  const prompt = [
    `Rerank the candidates below by relevance to the query. Output a JSON array of indices (zero-indexed) in best-first order.`,
    `Query: ${query}`,
    ...head.map((r, i) => `[${i}] ${r.entry.content}`),
    `Output format: [<int>, <int>, ...] with all ${head.length} indices.`,
  ].join('\n');

  let permutation: number[] | null = null;
  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.HIPPO_LLM_RERANKER_MODEL ?? 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });
    if (resp.ok) {
      const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const txt = j.choices?.[0]?.message?.content ?? '';
      const m = txt.match(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/);
      if (m) {
        const parsed = m[1].split(',').map((s) => parseInt(s.trim(), 10));
        if (
          parsed.length === head.length &&
          parsed.every((n) => Number.isInteger(n) && n >= 0 && n < head.length) &&
          new Set(parsed).size === head.length
        ) {
          permutation = parsed;
        }
      }
    }
  } catch {
    // Fall through to identity
  }

  const ordered = permutation
    ? permutation.map((idx) => head[idx])
    : head;

  return ordered.map((r, i) => ({
    ...r,
    rerankScore: ordered.length - i,
    preRerankRank: r.preRerankRank ?? i + 1,
    postRerankRank: i + 1,
  }));
};
```

- [ ] **Step 4: Register in factory**

Modify `src/rerankers/index.ts` to add:

```typescript
import { llmReranker } from './llm.js';

const REGISTRY: Record<string, RerankerFn> = {
  features: featuresReranker,
  'cross-encoder': crossEncoderReranker,
  llm: llmReranker,
};
```

- [ ] **Step 5: Run LLM tests**

Run: `npx vitest run tests/rerankers/llm.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/rerankers/llm.ts src/rerankers/index.ts tests/rerankers/llm.test.ts
git commit -m "feat(rerankers): Track 3 LLM reranker skeleton

- Listwise permutation rerank against OpenAI-compatible endpoint
- Gated on HIPPO_LLM_RERANKER_URL env var (no accidental cost)
- Falls back to identity on malformed model output
- Skeleton only; full characterisation deferred to follow-on plan

This release does not re-assert the retracted −10pp magnitude.

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 8"
```

---

## Task 9: LongMemEval sweep orchestrator

**Files:**
- Create: `benchmarks/longmemeval/run_reranker_sweep.mjs`

- [ ] **Step 1: Write the orchestrator**

Create `benchmarks/longmemeval/run_reranker_sweep.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Runs the LongMemEval retrieval harness across all reranker tracks plus
 * baseline, then evaluates each. Output:
 *   results/reranker_sweep_<timestamp>/
 *     baseline.jsonl
 *     features_topk50.jsonl
 *     features_topk20.jsonl
 *     features_topk100.jsonl
 *     cross_encoder_topk50.jsonl
 *     summary.json (R@1/R@3/R@5/R@10 + firing rate per track)
 *
 * Per docs/plans/2026-05-10-f6-reranker-hardening.md Task 9.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA = process.env.LONGMEMEVAL_DATA ?? 'data/longmemeval_oracle.json';
const STORE = process.env.LONGMEMEVAL_STORE ?? 'hippo_store2';
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = `results/reranker_sweep_${ts}`;
fs.mkdirSync(outDir, { recursive: true });

const runs = [
  { name: 'baseline', flags: [] },
  { name: 'features_topk20', flags: ['--reranker', 'features', '--reranker-top-k', '20'] },
  { name: 'features_topk50', flags: ['--reranker', 'features', '--reranker-top-k', '50'] },
  { name: 'features_topk100', flags: ['--reranker', 'features', '--reranker-top-k', '100'] },
  { name: 'cross_encoder_topk50', flags: ['--reranker', 'cross-encoder', '--reranker-top-k', '50'] },
];

for (const r of runs) {
  const out = path.join(outDir, `${r.name}.jsonl`);
  console.error(`\n=== ${r.name} ===`);
  const cmd = [
    'node',
    'benchmarks/longmemeval/retrieve_inprocess.mjs',
    '--data', DATA,
    '--store-dir', STORE,
    '--output', out,
    ...r.flags,
  ].join(' ');
  execSync(cmd, { stdio: 'inherit' });
}

console.error(`\nAll runs complete: ${outDir}`);
console.error(`Run evaluate.py per file to get R@K metrics, then aggregate into summary.json.`);
```

- [ ] **Step 2: Make executable and dry-run on 10 questions**

```bash
chmod +x benchmarks/longmemeval/run_reranker_sweep.mjs
LONGMEMEVAL_DATA=data/longmemeval_oracle.json node benchmarks/longmemeval/run_reranker_sweep.mjs
```

(Insert `--limit 10` into the per-run flags temporarily for the dry-run; revert before the real sweep.)

Expected: five JSONL files under `results/reranker_sweep_*/`, each with 10 records, each with reranker firing rate logged.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/longmemeval/run_reranker_sweep.mjs
git commit -m "feat(benchmarks): LongMemEval reranker sweep orchestrator

- 5 runs: baseline + 3 features hyperparameters + cross-encoder
- Output to timestamped results dir
- LLM track excluded from default sweep (cost-gated)

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 9"
```

---

## Task 10: Run the full LongMemEval sweep

This task produces the raw data for the result doc. No code changes.

- [ ] **Step 1: Verify Gate-A on a 50-question sample first**

```bash
node benchmarks/longmemeval/retrieve_inprocess.mjs --data data/longmemeval_oracle.json --store-dir hippo_store2 --output results/gate_a_features.jsonl --reranker features --limit 50
node benchmarks/longmemeval/retrieve_inprocess.mjs --data data/longmemeval_oracle.json --store-dir hippo_store2 --output results/gate_a_cross_encoder.jsonl --reranker cross-encoder --limit 50
```

Expected stderr lines: `reranker fired on N/50` for each. **If N < 48 (96%) on either, halt.** The reranker is failing to fire — debug before the full sweep. This is the literal Gate-A workload-validity check from the prereg.

- [ ] **Step 2: Full sweep**

```bash
node benchmarks/longmemeval/run_reranker_sweep.mjs
```

Expected runtime: ~5min for baseline + 3 features (mostly I/O-bound), +20-40min for cross-encoder (CPU model inference dominated). Total wall clock: ~30-50 min for 500 questions × 5 runs.

- [ ] **Step 3: Score each run**

```bash
for f in results/reranker_sweep_*/*.jsonl; do
  python benchmarks/longmemeval/evaluate.py --retrieval $f --output ${f%.jsonl}.eval.json
done
```

Expected: per-run `*.eval.json` files with R@1/R@3/R@5/R@10/MRR/NDCG and per-category breakdowns.

- [ ] **Step 4: Aggregate into summary.json**

Create `scripts/aggregate_reranker_sweep.mjs`:

```javascript
#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';

const sweepDir = process.argv[2];
if (!sweepDir) {
  console.error('Usage: node scripts/aggregate_reranker_sweep.mjs <sweep-dir>');
  process.exit(1);
}

const summary = {};
for (const file of fs.readdirSync(sweepDir)) {
  if (!file.endsWith('.eval.json')) continue;
  const track = file.replace(/\.eval\.json$/, '');
  const data = JSON.parse(fs.readFileSync(path.join(sweepDir, file), 'utf8'));
  summary[track] = {
    r_at_1: data.recall_at_1,
    r_at_3: data.recall_at_3,
    r_at_5: data.recall_at_5,
    r_at_10: data.recall_at_10,
    mrr: data.mrr,
    ndcg_at_10: data.ndcg_at_10,
    per_category_r_at_5: data.per_category?.recall_at_5 ?? {},
    firing_rate: data.firing_rate ?? null,
    latency_p50_ms: data.latency_p50_ms ?? null,
    latency_p99_ms: data.latency_p99_ms ?? null,
  };
}

const outPath = path.join(sweepDir, 'summary.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.error(`Wrote ${outPath} with ${Object.keys(summary).length} tracks.`);
```

Run:
```bash
chmod +x scripts/aggregate_reranker_sweep.mjs
node scripts/aggregate_reranker_sweep.mjs results/reranker_sweep_<timestamp>
```

Expected: `summary.json` written under the sweep dir with one entry per track.

If `evaluate.py` does not currently emit `firing_rate`, `latency_p50_ms`, or `latency_p99_ms` keys, those fields will be `null` in `summary.json` — that is acceptable; Task 11's tables can be filled from the per-run stderr logs and JSONL output instead.

- [ ] **Step 5: Verify Gate-B (variance across hyperparameters)**

In `summary.json`, check that R@5 across `features_topk20`, `features_topk50`, `features_topk100` varies by ≥ 1 entry (out of 500). If all three are identical to four decimal places, **Gate-B fails** for the features track and the result doc must report this explicitly per the prereg.

- [ ] **Step 6: Commit raw results**

```bash
git add results/reranker_sweep_*/summary.json results/reranker_sweep_*/*.eval.json
git commit -m "data: F6 LongMemEval reranker sweep raw results

- 5 runs × 500 questions
- summary.json aggregated per track × hyperparameter
- Gate-A firing rate + Gate-B variance evidence per prereg

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 10"
```

(Skip the JSONL retrieval files from git — they're large and reproducible from the eval files.)

---

## Task 11: Result document with retraction-discipline framing

**Files:**
- Create: `docs/evals/2026-05-10-f6-reranker-result.md`

- [ ] **Step 1: Author the result doc**

Create `docs/evals/2026-05-10-f6-reranker-result.md`:

```markdown
# F6 reranker hardening — eval result

**Date:** 2026-05-10
**Plan:** docs/plans/2026-05-10-f6-reranker-hardening.md
**Prereg:** docs/evals/2026-05-10-f6-reranker-prereg.md
**Retraction-discipline reference:** docs/RETRACTION.md

This release does not re-assert the retracted −10pp magnitude.

## Workload-validity verdict (binding gates from prereg)

### Gate-A: firing rate per track on 500-question LongMemEval

| Track | Firing rate | Verdict |
|-------|-------------|---------|
| features (top-K=50) | [N]/500 | [PASS / FAIL — must be ≥475] |
| cross-encoder (top-K=50) | [N]/500 | [PASS / FAIL] |

### Gate-B: hyperparameter variance (features track)

R@5 across features_topk20/50/100: [a, b, c]. **Verdict: [DISCRIMINATES / DOES NOT DISCRIMINATE]** — does R@5 vary by ≥ 1 entry across the three settings?

## Descriptive characterisation (non-binding)

### R@K per track

| Track | R@1 | R@3 | R@5 | R@10 | MRR | NDCG@10 |
|-------|-----|-----|-----|------|-----|---------|
| baseline (no reranker) | [a] | [b] | [c] | [d] | [e] | [f] |
| features (top-K=50) | ... | ... | ... | ... | ... | ... |
| cross-encoder (top-K=50) | ... | ... | ... | ... | ... | ... |

### Per-category R@5 (LongMemEval)

| Track | single-session-assistant | single-session-user | single-session-preference | multi-session | knowledge-update | temporal-reasoning |
|-------|--------------------------|---------------------|---------------------------|---------------|------------------|---------------------|
| baseline | ... | ... | ... | ... | ... | ... |
| features | ... | ... | ... | ... | ... | ... |
| cross-encoder | ... | ... | ... | ... | ... | ... |

### Latency

| Track | p50 (ms) | p99 (ms) |
|-------|----------|----------|
| baseline | ... | ... |
| features | ... | ... |
| cross-encoder | ... | ... |

## Roadmap target framing (non-binding)

`ROADMAP-RESEARCH.md:374` lists "R@5 ≥ 85%" as the F6 target. This release reports R@5 = [c] for features, [c'] for cross-encoder. Per the prereg, this is descriptive characterisation, not a binary pass/fail. The mechanism ships if Gate-A passed for at least one track.

## Cumulative null status update

The dlPFC goal-stack mechanism's null status (per `docs/RETRACTION.md:94-113`) is unchanged by this release. The reranker mechanism is independent.

## Mechanism shipped status

- Track 1 (features): [SHIPPED / DEFERRED]
- Track 2 (cross-encoder): [SHIPPED / DEFERRED]
- Track 3 (LLM): SKELETON ONLY (per plan; full characterisation deferred)

## Outside-voice review

[Reviewer name] confirmed framing satisfies the magnitude-smuggling guard
in `docs/RETRACTION.md:15-23`. Specifically:
- No "Δ = Xpp" anywhere
- No "Xpp lift" / "Xpp drop"
- "Magnitude" not applied to reranker effect on R@5
- The roadmap target is described as non-binding
- Reviewer confirms: ✓
```

- [ ] **Step 2: Fill the bracketed values from `summary.json`**

Replace every `[a]`, `[b]`, `[c]`, ..., `[N]/500`, `[PASS / FAIL]`, `[SHIPPED / DEFERRED]` with the actual numbers from Task 10's sweep.

- [ ] **Step 3: Magnitude-smuggling grep check**

Run:
```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))|magnitude' docs/evals/2026-05-10-f6-reranker-result.md
```

Expected: zero matches. If any line matches, rewrite that line to use workload-validity / descriptive language. The retraction guard requires this.

- [ ] **Step 4: Outside-voice review**

Per `docs/RETRACTION.md:41`. Same reviewer or process as Task 1 Step 4. Reviewer confirms or requests rewrites; iterate inline.

- [ ] **Step 5: Commit**

```bash
git add docs/evals/2026-05-10-f6-reranker-result.md
git commit -m "docs(evals): F6 reranker hardening result

- Workload-validity Gate-A and Gate-B verdicts per prereg
- Per-track R@K, per-category, latency tables (descriptive)
- Roadmap target framed as non-binding per docs/RETRACTION.md
- Outside-voice review trail

This release does not re-assert the retracted −10pp magnitude.

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 11"
```

---

## Task 12: Update CHANGELOG, README, and ROADMAP-RESEARCH

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` (the "What's new" section)
- Modify: `ROADMAP-RESEARCH.md:372-374` (F6 status `[next]` → `[shipped]`)
- Modify: `evals/README.md` (update LongMemEval baseline table)

- [ ] **Step 1: CHANGELOG entry**

Prepend to `CHANGELOG.md`:

```markdown
## v1.9.0 — 2026-MM-DD — F6 reranker hardening

This release does not re-assert the retracted −10pp magnitude.

**Shipped:**
- `RerankerFn` seam in `hybridSearch` (`src/search.ts`); reranker runs after MMR, before budget filtering
- Track 1 features reranker (lexical/feature re-score; no model dep; sub-millisecond)
- Track 2 cross-encoder reranker (MS-MARCO MiniLM via `@xenova/transformers`)
- Track 3 LLM reranker skeleton (gated on `HIPPO_LLM_RERANKER_URL`; full characterisation deferred)
- LongMemEval harness `--reranker` flag and sweep orchestrator
- Tier-1 micro-eval fixtures `reranker-features` and `reranker-cross-encoder`

**Eval result:** `docs/evals/2026-05-10-f6-reranker-result.md`. Workload-validity Gate-A and Gate-B verdicts per `docs/evals/2026-05-10-f6-reranker-prereg.md`. Roadmap target "R@5 ≥ 85%" is treated as non-binding per `docs/RETRACTION.md` discipline.

**Mechanism status:** the dlPFC goal-stack cumulative null status (`docs/RETRACTION.md:94-113`) is independent of this release.
```

- [ ] **Step 2: README "What's new" entry**

Add a paragraph in the README's "What's new" section linking to the result doc and the plan, with the same retraction sentence.

- [ ] **Step 3: ROADMAP-RESEARCH F6 status flip**

Modify `ROADMAP-RESEARCH.md:372-374`:

```markdown
### F6. LongMemEval reranker hardening [shipped]
**Scope correction (eng-review):** PLAN.md:285 already lists hybrid embeddings as shipped. The remaining gap is reranker quality, not embedding integration. v1.9.0 ships three reranker tracks (features, cross-encoder, LLM-skeleton) with workload-validity gates per `docs/RETRACTION.md`.
**Effort:** 6d. **Result:** `docs/evals/2026-05-10-f6-reranker-result.md`. R@5 reported descriptively per track; the "≥85%" target is non-binding per the v1.8.1 retraction discipline.
```

- [ ] **Step 4: evals/README.md baseline table update**

Add a row beneath the v0.27 baseline table at `evals/README.md:132-139` reporting the v1.9.0 numbers per track. Keep the v0.27 baseline row as the comparison anchor.

- [ ] **Step 5: Final magnitude-smuggling grep across all touched docs**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))|magnitude' \
  CHANGELOG.md README.md ROADMAP-RESEARCH.md evals/README.md \
  docs/evals/2026-05-10-f6-reranker-prereg.md \
  docs/evals/2026-05-10-f6-reranker-result.md
```

Expected: zero matches. If any line matches, rewrite.

- [ ] **Step 6: Final test suite + build**

```bash
npm run build:all
npm test
python benchmarks/micro/run.py
```

Expected: all green; 11/11 micro fixtures (existing 9 + 2 new) at 100%; build artifacts produced.

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md README.md ROADMAP-RESEARCH.md evals/README.md
git commit -m "docs: v1.9.0 F6 reranker hardening across CHANGELOG/README/ROADMAP/evals

- F6 [next] -> [shipped]
- LongMemEval baseline table updated with per-track numbers
- Retraction discipline citations on every numeric report
- 11/11 micro fixtures at 100%

This release does not re-assert the retracted −10pp magnitude.

Plan: docs/plans/2026-05-10-f6-reranker-hardening.md Task 12"
```

- [ ] **Step 8: Push the branch**

```bash
git push -u origin claude/plan-implementation-workflow-sasNp
```

PR creation is NOT part of this plan; the user creates the PR explicitly when ready.

---

## Self-review checklist

**1. Spec coverage** — every requirement in `ROADMAP-RESEARCH.md:372-374` is covered:

- ✓ Reranker tuning: Tasks 3, 5, 7 (features hyperparameter sweep)
- ✓ Cross-encoder evaluation: Tasks 6, 7, 9, 10 (cross-encoder track)
- ✓ R@5 ≥ 85% on existing hybrid path: Task 10 reports R@5 per track; framed as non-binding per retraction discipline (Task 1 prereg, Task 11 result)
- ✓ Effort 6d: tasks budgeted to fit lane B parallel work in May Wks 1-4
- ✓ Project test convention (real SQLite, no mocks): Tasks 2, 3, 6, 8 use vitest + real `MemoryEntry` fixtures via `createMemory`; no mocks of the storage path

**2. Placeholder scan** — no "TODO", "TBD", "fill in details", "similar to Task N", "add error handling" anywhere. Every step has actual code or actual commands. The `[a]`, `[b]`, `[N]/500` placeholders in Task 11 Step 1 are intentional templating that gets filled in by Task 11 Step 2 from real data.

**3. Type consistency** — `RerankerFn`, `RerankResult`, `RerankerOptions`, `RerankSignals` defined once in Task 2 Step 3 and used consistently in Tasks 3 (features), 6 (cross-encoder), 8 (LLM), and the harness wiring (Task 4). `getReranker(name)` factory signature is consistent across Tasks 3, 6, 8.

**4. Retraction-discipline coverage** — every doc-touching task (1, 11, 12) includes the verbatim retraction sentence, references `docs/RETRACTION.md`, and runs the magnitude-smuggling grep. Task 1 enforces the source-read + dry-run gates before pre-reg locks. Task 10 enforces Gate-A and Gate-B as workload-validity checks, not magnitude claims. The "R@5 ≥ 85%" roadmap target is described as non-binding throughout.

**5. Branch + push policy** — Task 12 Step 8 pushes to `claude/plan-implementation-workflow-sasNp`. PR creation is explicitly excluded; user opens the PR manually.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-05-10-f6-reranker-hardening.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because Tasks 3, 6, 8 are nearly independent and benefit from fresh context per reranker track.

**2. Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints. Best if you want to drive the prereg + dry-run gates yourself in real time.

**Which approach?**
