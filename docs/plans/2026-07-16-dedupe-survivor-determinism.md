# Deterministic dedupe survivor selection (v1.26.3 candidate)

Status: Draft (episode 01KXPDKZJF2146W6R5VQA6M7FH; not yet engineering-reviewed)
Date: 2026-07-16
Branch: `fix/dedupe-survivor-determinism` off `origin/master` @ `fcca2d6`

## Problem

`deduplicateStore` (src/dedupe.ts:41) decides which of two near-duplicate
memories survives `hippo sleep` / `hippo dedup` with this comparator:

```ts
entries.sort((a, b) => {
  const sDiff = (b.strength ?? 0) - (a.strength ?? 0);
  if (Math.abs(sDiff) > 0.01) return sDiff;
  return (b.retrieval_count ?? 0) - (a.retrieval_count ?? 0);
});
```

Two defects, one visible and one latent:

1. **No final tie key (the filed defect, independent-review finding from the
   v1.26.0 episode).** Freshly-ingested near-duplicates tie EXACTLY — measured
   2026-07-16 on `fcca2d6` (probe: two stores, same near-dup pair A/B at
   Jaccard 0.9091, opposite ingest orders): `strength=1` vs `1`,
   `retrieval_count=0` vs `0` in both stores. The sort is stable, so the
   survivor falls to `loadAllEntries` order (`created ASC, id ASC`) — store1
   kept A, store2 kept B. WHICH CONTENT SURVIVES consolidation depends on
   arrival order: two runs of the same benchmark ingest, or two agents
   ingesting the same facts in different orders, consolidate to different
   surviving content. Same class as the v1.26.0 recall-determinism fix, but
   this one mutates the store (deletes the loser).

2. **The `0.01` epsilon makes the comparator non-transitive (latent).**
   Strengths 1.0 / 0.994 / 0.988: `1.0 ≈ 0.994` (tie branch), `0.994 ≈ 0.988`
   (tie branch), but `1.0 > 0.988` (strength branch). An inconsistent
   comparator hands `Array.prototype.sort` an unsatisfiable contract; the
   result is engine- and input-permutation-dependent even for a fixed store.
   Any appended tie key inherits this — a minimal "add a tie key" patch would
   NOT fix the class.

Sibling (same class, found by the §3b sibling-clone audit):
`mergeContents` (src/consolidate.ts:568) picks the merge base by
`content.length` desc with no tie key; equal-length cluster members fall to
cluster-assembly order.

## Design

### T1 — total-order comparator in `deduplicateStore`

Replace the sort comparator with a strict total order that preserves the
documented intent ("keeps the stronger copy, or more retrievals if tied")
and terminates in a deterministic, cross-ingest-stable key:

```ts
// Precompute per entry: bucket = strengthBucket(e.strength)
//   strengthBucket(s) = Number.isFinite(s) ? Math.round(s / STRENGTH_TIE_EPSILON) : 0
//   where STRENGTH_TIE_EPSILON = 0.01 (the existing epsilon, now transitive).
//   Non-finite strength (NaN/Infinity; null/undefined already ?? 0 today) maps
//   to bucket 0 — a NaN bucket would return NaN from the comparator and
//   silently reintroduce the non-total-order class this fix exists to kill
//   (plan-eng-critic r1 LOW). Bucket values are integers, so bucketB - bucketA
//   is exact.
// Sort by:
//   1. strength bucket desc      (materially-stronger survives)
//   2. retrieval_count desc      (more-retrieved survives; ?? 0)
//   3. compareEntryIdentity      (content asc -> id asc; src/compare.ts)
```

- **Quantization, not raw compare.** Comparing raw strength first would let a
  1e-9 decay-noise difference outrank a 10-retrieval difference, discarding
  the epsilon's intent. Deriving an integer bucket ONCE per entry and
  comparing buckets is the standard transitive encoding of "differences
  under ~0.01 are ties". Boundary nuance (documented in a code comment):
  two strengths straddling a bucket edge (e.g. 0.0049 vs 0.0051) now compare
  as different where the old epsilon called them tied — the flip always
  favors the not-weaker entry, and the OLD behavior at such pairs was
  order/engine-dependent, so there is no stable prior behavior to preserve.
- **`compareEntryIdentity` (content asc -> id asc) as the terminal key.**
  Content is the cross-ingest-stable key (the acceptance criterion — two
  fresh identical ingests consolidate to identical surviving content —
  requires it). `id` is the per-instance last resort for exact-content
  duplicates, where either survivor is content-identical.
  **Rejected alternative — `created ASC` ("keep the oldest").** Arguably
  nicer provenance semantics, but `created` is per-run wall clock: it is
  exactly the load-order behavior that produced the filed bug and can never
  satisfy the cross-ingest criterion.
- dedupe.ts gains one import from `./compare.js` — a true leaf module
  (imports nothing), so no cycle risk (v1.26.0 established this pattern).
- The greedy pair scan, `removed` Set insertion order, `pairs` output order,
  and `deleteEntry` loop all become deterministic functions of the entry
  multiset once the sort is a total order; no changes needed there.
- Semantics NOT changed: threshold, Jaccard measure, host-wide (cross-tenant)
  scan posture (v1.12.10 `__host__` note), dryRun contract, DedupPair shape.

### T2 — same-class one-liner in `mergeContents` (critic-flagged scope add)

`src/consolidate.ts:568`:

```ts
const sorted = [...entries].sort(
  (a, b) => (b.content.length - a.content.length) || compareEntryIdentity(a, b)
);
```

Equal-length merge bases then break on content asc instead of cluster-assembly
order. One line + one test; zero semantic change off-tie. The 3+ entry bullet
ORDER (inherits upstream cluster order) is explicitly OUT of scope — filed as
a follow-up in TODOS.md, because cluster assembly order is an upstream
consolidation concern (recently-stabilized subsystem, #111) and bullets are a
rendering of all members, not a survivor choice.

### Out of scope

- BM25 path-tag depth residual (eval-gated, filed), S5 tuning (eval-gated),
  assemble/recall `--scope` asymmetry (decision-shaped, filed).
- Consolidation cluster-assembly ordering (follow-up filed by this plan).
- Any change to which rows COUNT as duplicates (threshold/Jaccard untouched).

## Tests (new file `tests/dedupe-survivor-determinism.test.ts`, real DB)

1. **Red-on-master core:** two stores, same near-dup pair ingested in opposite
   orders -> `deduplicateStore` keeps the SAME content in both (the probe as a
   regression test; fails on `fcca2d6`).
2. **Permutation invariance:** 3 near-duplicates at pairwise-tied strength
   (incl. an epsilon-chain triple 1.0/0.994/0.988 to pin transitivity), all 6
   ingest permutations -> identical surviving-content set.
3. **Strength dominance preserved:** materially stronger (>1 bucket apart)
   survives even when ingested last.
4. **Retrieval-count tiebreak preserved:** equal bucket, higher
   retrieval_count survives regardless of ingest order.
5. **Exact-content duplicates:** dedupe removes one, keeps one; store ends
   with exactly one copy (id key exercised; content identical either way).
6. **dryRun parity:** dryRun pairs equal the rows a non-dry run deletes.
7. **mergeContents tie (T2):** two equal-length contents in a merge cluster ->
   merged base identical for both ingest orders.
8. **Non-finite strength (unit-level):** `strengthBucket(NaN)` = 0 and a
   NaN-strength entry still yields a strict total order (comparator never
   returns NaN) — pins the plan-eng-critic r1 LOW.

Suite-level gates: full `npm test` green; tier-1 micro-eval 11/11
non-regression; `npm run build:all` (release rule).

## Release

Patch bump 1.26.2 -> **1.26.3** across the 5 lockstep manifests
(`package.json`, `openclaw.plugin.json`, `extensions/openclaw-plugin/package.json`,
`extensions/openclaw-plugin/openclaw.plugin.json`, `src/version.ts`;
`scripts/check-manifest-versions.mjs` enforces at prepublish). CHANGELOG entry
documents the behavior change (deterministic survivor selection; bucket-edge
nuance) with no API change. No migration (no schema touch).

## Evidence base (measured this episode, pre-fix)

- Probe on `fcca2d6` dist: `jaccard(A,B)=0.9090909090909091`;
  store1 (A,B): both `strength=1 retrieval_count=0`, kept=A;
  store2 (B,A): both `strength=1 retrieval_count=0`, kept=B.
  Full-precision tie confirmed (measure-ties-before-fixing memory applied).
