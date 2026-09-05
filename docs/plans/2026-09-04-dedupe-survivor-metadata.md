# Dedupe survivor metadata: metadata-aware tie keys in compareEntryIdentity

Backlog A3 item 3. Episode 01M1QAYF24B7S7EQ6VCD38MBVS. No version bump: rides 1.38.1 with #158 and #160.

## Problem (reproduced)

`deduplicateStore` (src/dedupe.ts:126-132) orders each tenant's near-dup cluster by
strength bucket desc, retrieval_count desc, then `compareEntryIdentity` (src/compare.ts:42-48),
which compares `content` and then `id`. Two byte-identical entries that differ only in
metadata therefore tie on every key except the random UUID, and the survivor is whichever
id happens to sort first.

Scratch vitest probe on a real SQLite store (deleted, worktree clean), six runs each:

| twin differs in | survivor over 6 runs | verdict |
|---|---|---|
| tags (`[alpha]` vs `[beta, gamma]`) | alpha x5, beta+gamma x1 | random |
| source (`src-a` vs `src-b`) | src-b x4, src-a x2 | random |
| layer (episodic vs semantic) | episodic x6 | deterministic by accident: `mem_` < `sem_` |

The layer case is stable today only because `generateId` prefixes episodic ids with `mem_`
and semantic ids with `sem_`. That accident always drops the semantic copy, which is the
consolidated one.

## Root cause

`compareEntryIdentity` is the leaf tie key every sort site routes through (api.ts x3, cli.ts,
consolidate.ts mergeContents, dedupe.ts, graph-recall.ts, memory-value.ts, search.ts x2). It
never looks at metadata, so no site can be metadata-deterministic. Fixing dedupe.ts alone
would leave consolidate/search/recall ties inconsistent with dedupe.

## Fix (at root)

### src/compare.ts

Extend the structural `EntryIdentity` with optional keys and extend the total order:

```ts
export interface EntryIdentity {
  content: string;
  id: string;
  layer?: string;
  tags?: readonly string[];
  source?: string;
}
```

Order: content asc -> layer rank asc -> tag count desc -> sorted tags asc -> source asc -> id asc.

- Layer rank: semantic 0, episodic 1, trace 2, buffer 3, anything else (including undefined) 4,
  then the raw layer string asc so unknown layers still form a total order. Semantic first is a
  deliberate behaviour change: semantic rows are consolidation output, so keeping that copy
  preserves the promotion instead of silently demoting the memory to episodic.
- Tags: more tags first (the richer copy survives, fewer tags are lost), then the sorted,
  NUL-joined tag list asc for a stable order between equal-count sets. Undefined = empty.
- Source asc, undefined = ''. Arbitrary but stable.
- Id asc stays the terminal key.
- Undefined layer is pinned the same way: rank 4 and raw string '' (so `{content, id}` callers
  compare equal on this key and fall through).
- Tags are de-duplicated before counting (`new Set(tags)`), so `[a, a]` does not outrank `[a]`;
  the count is a proxy for "the copy with more labels", nothing more.

Also rewrite the `compareEntryIdentity` JSDoc block (compare.ts:24-41), which today states the
order as "content ascending -> id ascending". It is the load-bearing doc for this file and must
name the new keys and the semantic-first rationale, matching the dedupe.ts comments and the
CHANGELOG bullet.

Callers that pass `{content, id}` (tests, benchmark) are unaffected: missing
keys compare equal and fall through to id. Callers that pass a `MemoryEntry` get the new keys
automatically because the type is structural. No signature change, no new export from index.ts.

### src/dedupe.ts

Update the two comments that spell out the total order (file header lines 11-14, loop
comment lines 122-124) to name the new keys.

Codex review round 1 (2026-09-05) found that the layer rank turns two lifecycle states into
deterministic losers. A raw (append-only, `kind='raw'`) episodic twin now always loses to a
semantic twin; `deleteEntry` then trips `trg_memories_raw_append_only` and `api.sleep` aborts
mid-loop with earlier deletions already committed. A superseded semantic twin now beats a
current episodic re-ingest and the current copy is deleted. `consolidate.ts` already skips
superseded pairs at its merge loop (line 983); dedupe had no such filter. Fix at the candidate
set, not in the comparator: `deduplicateStore` filters `loadAllEntries` to
`kind === 'distilled' && !superseded_by` before the tenant partition. Also replace the `\0`
join in `compareTags` with an element-wise compare, since a tag containing `\0` could collide.

### src/sleep-redact.ts

`deduped.crossDups` is computed in api.ts:3021 as `keptLayer !== removedLayer`, a cross-LAYER
count. The header (line 4) and the redaction surface list (line 42) call it a cross-tenant
counter. Reword both to say cross-layer while keeping it on the host-wide list (it is still an
aggregate across every tenant, which is why it is redacted).

### CHANGELOG.md

Bullet under `## 1.38.1 - 2026-09-04` / `### Fixed` (heading created by #158; rebase onto it at
the batch gate). State the tags/source randomness, the semantic-first change, and the comment fix.

## Tests

### tests/compare.test.ts (unit, no DB)

- layer rank: semantic sorts before episodic, trace, buffer with equal content; unknown layer sorts last.
- tags: three tags before one; equal count ordered by sorted-joined tags; tag order inside the array is irrelevant.
- source: `src-a` before `src-b` with equal content/layer/tags.
- missing metadata falls through to id (the existing `{content, id}` cases keep passing).
- total order: a shuffled six-entry array sorts to the same sequence from three different starting orders.

### tests/dedupe-survivor-determinism.test.ts (real SQLite store, existing helpers)

- case 9: four byte-identical twins, tags `[a]`, `[b]`, `[c]`, `[d, e]`, inserted in two different orders, survivor tags are `[d, e]` both times.
- case 10: four twins differing in source only (`src-a` to `src-d`), two orders, survivor source is `src-a` both times.
- case 11: episodic/semantic twins, both orders, the semantic copy survives both times (red today: episodic wins via `mem_`).
- Each case asserts the removed entry is gone from `loadAllEntries` and the pair records the expected kept/removed layer where relevant.
- case 12: raw episodic twin plus semantic twin, both orders: dedupe removes nothing and does not throw (red today: `raw is append-only`).
- case 13: superseded semantic twin (with a real successor row) plus current episodic twin: dedupe removes nothing (red today: the current copy is deleted).
- compare.test.ts: tags `['a', 'b\0c']` vs `['a\0b', 'c']` order by the tag list, not the id (red today: the joined strings collide).

Red-before check: run the new dedupe cases and the compare cases against the base comparator
before editing compare.ts. Case 11 and the unit cases are a solid red. Cases 9 and 10 depend on
random UUID order under the old comparator, so a single both-orders run passes by luck about
half the time; use a four-twin tie group (tags `[a]`, `[b]`, `[c]`, `[d, e]`; sources `src-a` to
`src-d`) as recall-cross-store-determinism.test.ts already does, and repeat the red run five
times. The shipped test is deterministic after the fix, so this only matters for the one-time
red check.

### Blast radius suites

recall-tiebreak-primary-keys, recall-cross-store-determinism, memory-value-determinism, graph-recall*,
search, consolidate, dedupe-tenant-partition, dedupe-survivor-determinism, compare, sleep-redact,
cli-context-render-snapshot, then the full suite in verify.

## Acceptance

- Two byte-identical entries with different metadata, inserted in both orders, dedupe to the same survivor metadata (backlog acceptance, cases 9-11).
- All existing compare/dedupe/recall determinism tests still pass.
- sleep-redact.ts no longer calls crossDups cross-tenant.
- oxlint, tsc, and the full vitest suite green (harness timeouts confirmed by isolated rerun).

## Non-goals

- Changing the strength bucket or retrieval_count keys.
- Merging tags from the removed twin into the survivor (a different feature; the survivor keeps its own metadata).
- Exporting compare.ts from the package index.
