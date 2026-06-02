# Plan: E3.1 cross-object `references` edges (name-match, first slice)

- Date: 2026-06-02
- Episode: 01KT4934PMMFKS7YW37P88V9PW (/dev-framework-rl, project_type=backend)
- Status: plan-eng-critic PASS (78, no must_fix). Grill folded 2 fixes: a disposition
  rule (verify precision decides always-on vs opt-in/experimental — the signal is unproven)
  and a regex-size bound on the target index.

## Goal

Add the **first cross-object relations** to `hippo graph extract`: a Pass 3 that emits
`references` edges when one consolidated object's text contains another extracted entity's
name. This gives E3.2 `recall --hops` real cross-entity edges to traverse (e.g. a decision
that mentions a policy by name), beyond today's `supersedes`-only graph.

## The reframe (carried from brainstorm — READ FIRST)

Pure-deterministic cross-object edges are **thin**: `incident.linkedMemoryIds` are evidence
receipts (often raw, not entities, and incidents aren't even an entity type yet), the
envelope `owner` isn't set by the E2 CLIs, and there are no structured
decision↔policy↔customer↔project link fields. The only no-migration, real-signal cross-object
source is **entity names appearing in other objects' text**. This slice ships that
name-match heuristic. It is NOT the full semantic extraction (depends-on / blocked-by /
incident+process entities) — that needs NLP + a migration and stays a follow-up. Because it
is a heuristic, **precision is measured at verify and reported honestly** (like the E3.2
benchmark); if precision is poor the feature is descriptive, not a silent default.

## Scope (and what is deferred)

IN:
- A Pass 3 in `src/graph-extract.ts` (the deterministic extractor) emitting `references`
  edges via conservative name matching, through the audited `insertRelation` writer (E3.3
  lint-safe — no raw SQL).
- Real-DB vitest coverage + a precision measurement recorded under
  `docs/evals/2026-06-02-e3-cross-object-precision.md`.

DEFERRED (named so they stay visible):
- Semantic relations (`depends-on` / `blocked-by` / `owns`) and incident/process/skill
  entities — need NLP and/or the `entity_type` enum migration.
- The `hippo sleep` enqueue-hook (auto-extract) — separate producer-wiring slice.
- No migration, no new CLI flag, no new entity type in THIS slice.

## Design

### What matches what

- **Match targets** (names searched FOR) = each entity's `name`, but only those whose
  length is in `[MIN_NAME_LEN, MAX_NAME_LEN]` (e.g. 4..80). This naturally includes the
  short identifiable names (`policyName`, `customer`, `repo`) and **excludes prose**
  (`decisionText` is usually > 80 chars, so a decision is a *source* but not a *target*).
- **Match sources** (text searched IN) = each object's full text:
  - decision: `decisionText` + `context`
  - policy: `policyName` + `policyText`
  - customer_note: `customer` + `note`
  - project_brief: `repo` + `summary`
  - So `ExtractRow` gains a `searchText` field; the loaders already return these columns,
    so Pass 1 pairs `nameOf` with a `textOf` extractor per source.

### Algorithm (Pass 3, after Pass 2 supersedes)

1. Build `targetIndex: Map<normName, entityId>` from the entities created in Pass 1 whose
   `name` length ∈ [MIN, MAX]. **Ambiguity guard:** if a normalised name maps to >1
   entity, drop it from the index (a shared name is an unreliable target).
2. Build ONE combined word-boundary, case-insensitive regex from all escaped target names
   (`\b(name1|name2|...)\b`), so each source text is scanned once (O(sources × textlen),
   not O(sources × targets)). (Regex-special chars in names are escaped.)
3. **Sources are Pass-1-CREATED entities only (plan-eng HIGH fix), never `allRows`.** Pass 1
   skips rows with `memoryId === null` (forgotten — `ON DELETE SET NULL`) and empty-name
   rows; such rows have no entity and no non-null source memory, and emitting from them would
   make `insertRelation`→`resolveConsolidatedSource(null)` THROW **after** `clearGraph` ran,
   bricking the tenant's graph mid-rebuild. So Pass 1 records `searchTextByKey` (key →
   searchText) ONLY for rows it actually turned into entities; Pass 3 iterates
   `entityIdByKey`, taking `sourceId` from it, `source.memoryId` from `memoryIdByKey` (the
   stored consolidated id), and `searchText` from `searchTextByKey`. A forgotten/empty-name
   E2 object is therefore never a source.
   For each such source: collect the distinct matched target names, map to target entity ids,
   drop `targetId === sourceId` (self), dedup per `(source, target)`, cap at
   `MAX_REFERENCES_PER_OBJECT` (e.g. 25). Emit `insertRelation(from=source, to=target,
   relType='references', memoryId=source.memoryId)` — both entities exist (both are
   Pass-1-created) and the source memory is consolidated, so the guard is satisfied.
4. `extractGraph` stays an idempotent rebuild: Pass 3 runs after `clearGraph` + Pass 1/2,
   so re-extract self-corrects. `ExtractResult.relations` count now includes references.

### Precision guards (the grill's objection — false matches)

- `MIN_NAME_LEN` (skip short/generic names) + `MAX_NAME_LEN` (skip prose).
- Word-boundary regex (not substring) so `cache` doesn't match `cached`.
- Exact normalised match (lowercase), NOT fuzzy/stemmed.
- Ambiguity guard (drop names shared by >1 entity).
- Per-source cap so one object can't explode the graph.
- These are tunable constants; verify measures the resulting precision.

## Tests (real DB, vitest)

`tests/graph-cross-object.test.ts`:
1. A decision whose `decisionText`/`context` names a policy → one `references` edge
   (decision → policy), `memoryId` = the decision's memory.
2. No self-edge (an object naming itself).
3. Word-boundary: a policy named `cache` does NOT match the substring in `cached`.
4. `MIN_NAME_LEN`: a 2-3 char name is not a target.
5. `MAX_NAME_LEN`: a prose decisionText is not a target (decision is source-only).
6. Ambiguity guard: a name shared by two entities emits no edge.
7. `MAX_REFERENCES_PER_OBJECT` cap respected.
8. Idempotent: running `extractGraph` twice yields the same edges (no dupes).
9. E3.3 guard holds: the references edge's source memory is consolidated (a references
   edge is never emitted from a raw source — entities only exist for consolidated objects).
10. tenant isolation: a name in another tenant's object is not matched (extract is
    per-tenant; targetIndex built per-tenant).
11. (plan-eng MED) a forgotten source: a consolidated E2 object whose `memory_id` is NULL
    that textually contains another entity's name emits NO references edge and does NOT throw
    (it is never a Pass-3 source).

Eval doc also documents two known recall limitations (plan-eng LOW): word-boundary `\b`
silently misses names whose first/last char is non-word (`@scope/pkg`, `.env`); and a
generic-but-unique short name (a customer literally named `Cache`, a repo `core`) can match
common prose — so the verify seed deliberately includes a generic-word decoy entity so the
precision number reflects that failure mode rather than hiding it.

## Verify-stage precision measurement

Seed a store with N decisions that genuinely reference M policies/customers/repos by name,
plus decoys (decisions with generic words, policies with near-miss names). Run
`extractGraph`, then for each emitted `references` edge classify true/false by construction.
Report precision + edge count in `docs/evals/2026-06-02-e3-cross-object-precision.md`.
Honest framing: this is a heuristic; the number characterises it, it is not a pass/fail gate.

**Disposition rule (grill fix — the feature's real-world signal is unproven).** Exact-name
matching may fire RARELY on real prose (a decision says "the retry policy", not the policy's
verbatim name) or coincidentally. The verify measurement decides how it ships:
- **Reasonable precision (≈≥70% on the realistic seeded set) AND non-trivial recall** →
  ship always-on as part of `graph extract`.
- **Thin or noisy** → still ship the Pass-3 code, but honestly: document it as experimental
  in the eval doc, and prefer making it **opt-in** (only emit `references` when explicitly
  requested) rather than polluting every graph by default. The measurement, not optimism,
  picks. A near-zero-signal result is reported as such, not spun.

## Ship checklist

Minor bump 1.16.0 → 1.17.0 (same 5 targets as E3.2: package.json, src/version.ts,
openclaw.plugin.json, extensions/openclaw-plugin/{openclaw.plugin.json,package.json}).
CHANGELOG `## 1.17.0` section (em-dash lint). README: note `graph extract` now emits
cross-object `references` edges. graph-write lint stays green (insertRelation is the
audited writer).

## Risks for plan-eng-critic

- **Precision / false positives** — the central risk; bounded by the guards + measured at
  verify. Is the guard set sufficient, or is a stopword list needed?
- **Performance / regex size** — combined-regex scan is O(sources × textlen); acceptable at
  the per-type cap. A pathological name set (thousands of distinct targets) makes one giant
  alternation regex — bound it: cap the target index (e.g. first `MAX_TARGET_NAMES`), or
  build the regex in chunks and scan per chunk. Note any truncation in `ExtractResult`.
- **Prose-as-name** — relying on MAX_NAME_LEN to exclude decisionText; is that robust, or
  should decisions be explicitly source-only by type?
