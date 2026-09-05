# Consolidation 3+ bullet order follows the merge order, not ingest order

Episode 01M1S1MH5XZ4STGM08PBD5X3ZP (devrl loop hippoloop-20260904T205515Z, batch 01M1S1M7). Backlog A3 item 6.

## Problem

`mergeContents` (`src/consolidate.ts:933-948`) sorts the cluster once to pick the merge base
(`content.length` desc, then `compareEntryIdentity`, line 938) but renders the 3+ entry bullet
list from the RAW cluster (`entries.map`, line 946). The cluster is assembled in
`mergeCandidates` order, which is `loadAllEntries` order (`created ASC, id ASC`): stable within
one store, not stable across ingest orders. Two stores holding the same three memories ingested
in different orders produce two different semantic rows for the same rollup.

Filed as the T2 out-of-scope follow-up of `docs/plans/2026-07-16-dedupe-survivor-determinism.md`
(TODOS.md:66-75), with the condition "land only with a deliberate cluster-ordering decision".

## Root cause

One function holds two orders: the sorted view decides the base, the raw view renders the members.
The deliberate decision is that the merged row renders its members in the SAME order that chose
its base. Bullet 1 is the base; the rest follow the same total order. No upstream change: the
greedy pivot clustering in the merge pass (lines 731-745) is left alone, because sorting the
candidates there can change cluster MEMBERSHIP when overlap is non-transitive, and that pass was
stabilised recently (#111, T1 tenant partition). The filed defect is rendering noise, not
membership.

Same class, one block up at the call site (line 748): `allTags = Array.from(new Set(cluster.flatMap(...)))`
also inherits cluster order into the merged row's `tags`. Fixed in the same PR by sorting.

## Consequence the plan owns: rejection tombstones

The merged content is digested (`rejectionDigest(semantic.content)`, line 773) and looked up
against human-rejected rollups. Today that digest for a 3+ cluster depends on ingest order, so a
tombstone only matches while the store keeps the order it had when the human rejected it. After
this change the digest is order-independent, so tombstones become MORE stable. One-time effect:
a 3+ rollup rejected before this release whose stored digest was computed from a non-sorted order
regenerates once on the next sleep and can be rejected again. No migration (the old digests are
not recomputable without the original order, and the class was already unstable). Called out in
CHANGELOG.

## Changes (all in the worktree branch `fix/consolidate-bullet-order`, base c130d7a)

### 1. `src/consolidate.ts`

- line 946: `entries.map(...)` -> `sorted.map(...)`. One identifier. Comment (one line, WHY):
  bullets follow the base order so the merged row is byte-identical across ingest orders and the
  rejection digest is stable.
- line 748: `const allTags = Array.from(new Set(cluster.flatMap((e) => e.tags)));` ->
  `... .sort()` (default UTF-16 code-unit order, matching `compareStrings` in `compare.ts`; no
  `localeCompare`, per the compare.ts rationale).

Nothing else. `mergeContents` stays module-private; its single caller (line 747) is unchanged.
`refine-llm.ts` matches only the `[Consolidated pattern from` prefix, so the bullet body is free to
reorder.

### 2. `tests/dedupe-survivor-determinism.test.ts` (existing real-DB file, next to test 7)

New test 14, `mergeContents 3+ bullets: bullet order and merged tags identical across all 6 ingest
orders (base order: length desc -> content asc)`. Reuses the file's `VARIANT_A/B/C` (each pair
Jaccard 18/22 = 0.82 > `MERGE_OVERLAP_THRESHOLD` 0.35, so any pivot clusters all three and
membership is order-independent), `permutationsOf3`, `tmpHome`, and a fixed `now`. Each variant
carries one distinct tag (`['t-a']`, `['t-b']`, `['t-c']`) so the tags assertion has something to
reorder. Per permutation: write the three, `consolidate(home, { now })`, expect `merged > 0`, load
the one semantic row starting with `[Consolidated pattern from 3 related memories]`, collect the
bullet block (`content.split('\n\n')[1]`) and `tags`. Assert all six bullet blocks are identical
and equal the expected order computed in the test from the same rule (A and C are equal length
and longer than B; `A < C` by content, so `A, C, B`), and all six tag arrays equal
`['t-a','t-b','t-c']`.

Red-first: on unchanged `master` the bullet block follows ingest order, so at least the
`[A,B,C]` and `[C,B,A]` permutations differ and the test fails at the first `toBe`. Captured
before the fix commit.

Sad paths, enumerated up front: decay between permutations is neutralised by the shared `now`;
`VARIANT_*` lengths are asserted in the test (`A.length === C.length`, `B.length < A.length`) so a
later constant edit cannot silently turn the length tie into a non-tie; the semantic-row filter
requires exactly one match so a partial cluster (2+1) fails loudly instead of passing on the
wrong row.

### 3. `CHANGELOG.md`

New heading `## 1.38.2 - unreleased` above 1.38.1 (the batch's shared heading; the deploy gate
bumps the version and dates it). One `### Fixed` bullet: bullets in a 3+ consolidation now follow
the merge order (base first, then the shared tie order) and merged tags are sorted, so the same
memories produce the same semantic row in any ingest order; note the one-time tombstone
regeneration.

### 4. `TODOS.md:66-75`

Replace the follow-up with a RESOLVED line naming this episode and the decision (render order =
base order; upstream cluster assembly deliberately untouched).

## Out of scope

- Sorting `mergeCandidates` upstream (membership change, see Root cause).
- The 2-entry branch (line 941-943): it renders only the base, already deterministic since 1.26.3.
- Audit `sourceIds: cluster.map(e => e.id)` (line 794): an audit payload, not a stored memory
  row; ids are per-instance random anyway so no order of them is cross-ingest stable.

## Verification

- Targeted: `node ./node_modules/vitest/vitest.mjs run tests/dedupe-survivor-determinism.test.ts tests/consolidate.test.ts tests/consolidate-tenant-landing.test.ts tests/rejection-acceptance.test.ts`.
- `npx tsc --noEmit`, `npx oxlint` on the touched files.
- Drive the affected flow: a scratch `HIPPO_HOME` store, three near-duplicate `hippo remember` calls in two orders, `hippo sleep`, compare the semantic row text with `hippo recall`.
- CI green on the PR head.
