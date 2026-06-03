# Plan: Anchor graph entity/relation provenance to the authoritative E2 object

Status: SCOPED (build deferred until the `feat/e3-*` branches land on master)
Date: 2026-06-03
Owner: TBD (own /dev-framework-rl episode, project_type=library)

## Problem

An in-force E2 object (decision / policy / customer-note / project-brief) silently
disappears from the knowledge graph once its mirror memory is gone. This happens not
only via an explicit `hippo forget <mirror-id>`, but naturally over time: the mirror
memory is created with a half-life (`decisions.ts:152`, `DECISION_HALF_LIFE_DAYS`) and
is eligible for decay-driven pruning by consolidation (`hippo sleep`) while the E2
object stays `active` and authoritative.

Reproduce (verified 2026-06-02 on `feat/e3-sleep-enqueue-hook`):
1. `hippo policy new "X" --text "..."` ; `hippo decide "... mentions X ..."`
2. `hippo graph extract` -> entities + `references`/`supersedes` arcs present.
3. `hippo forget <decision-mirror-id>` (or let consolidation prune it).
4. `hippo graph extract` -> the still-active decision is GONE from the graph
   (extraction skips it), though `decide list` still shows it as active.

## Root cause

E3 graph extraction anchors entity/relation **provenance to the decaying memory
mirror**, not to the authoritative E2 row:

- `entities.memory_id` / `relations.memory_id` are `NOT NULL` (db.ts:1683, 1699).
- The consolidated-source guard ties `source_kind` to the FK'd memory's live `kind`
  via `BEFORE INSERT/UPDATE` triggers (`trg_entities_consolidated_only_*`,
  `trg_relations_consolidated_only_*`, db.ts:1730-1790) and `resolveConsolidatedSource`
  in graph.ts. Every entity/relation therefore requires a LIVE distilled/superseded
  memory row.
- Extraction skips rows whose mirror is gone: `graph-extract.ts:180`
  `if (row.memoryId === null) continue;`.

Meanwhile the E2 design (db.ts:1055-1059) is explicit that the **table is the source of
truth** and the memory is "kept for recall but is no longer authoritative; memory_id is
NULLABLE with ON DELETE SET NULL so forget/consolidate/archive does not lose a decision."

So the graph re-introduces exactly the decay-coupling that promoting `hippo decide` to a
canonical E2 table was built to eliminate for recall (db.ts:1055-1057) -- one layer up.

## NOT the fix (rejected)

- Cascade `forget` to delete the E2 row, or block `forget` and force `close`:
  contradicts the documented design. `SET NULL` exists precisely so forget/consolidate
  do NOT lose the authoritative object. Cascading would destroy the source of truth.
- Pin the mirror / exclude E2 mirrors from pruning: fights the "mirror may be dropped"
  design and re-introduces non-decaying mirrors (the thing E2 moved away from). Masks
  the explicit-forget trigger only; does not address the design mismatch.

## Fix (recommended): anchor provenance to the E2 object

The guard's real invariant is "the graph indexes consolidated state only (no raw)". For
an E2 object, "consolidated" is established by being an E2 object at all -- not by a
memory's `kind`. So ADD an authoritative-object provenance path alongside the existing
memory-kind path (keep the latter for prose / future NLP-sourced entities).

### Change surface

1. **Migration (next version):**
   - Add nullable `source_object_type` (`decision|policy|customer|project`) +
     `source_object_id INTEGER` to `entities` (and to `relations` for the edge's
     sourcing object).
   - Relax `entities.memory_id` and `relations.memory_id` to NULLABLE.
   - Add a CHECK / trigger requiring AT LEAST ONE provenance: a live distilled/superseded
     `memory_id`, OR a valid `source_object_*` referencing an `active|superseded` E2 row
     in the same tenant. Preserve the existing no-raw guarantee on the memory path.

2. **Guard rework (db.ts:1730-1790 triggers + `resolveConsolidatedSource` in graph.ts):**
   accept EITHER provenance. When `memory_id` is present it must still equal the FK'd
   memory's kind (raw still ABORTs). When absent, the `source_object_*` row must exist
   and be `active|superseded`. Keep the cross-tenant match triggers.

3. **graph-extract.ts:** Pass 1 stops skipping `memoryId === null` for E2 rows -- anchor
   the entity to the E2 row (`source_object_type/id`), set `memory_id` only when the
   mirror exists. Pass 2 (`supersedes`) and Pass 3 (`references`) source edges from the
   E2 object, with `memory_id` as an optional recall pointer.

4. **graph-recall.ts:** handle a graph-reached entity whose `memory_id` is null -- either
   surface from the E2 object's content, or count the hop without a recall-mirror row,
   instead of breaking on the by-id memory load (`loadEntriesByIds`). Re-check the
   bi-temporal / superseded-drop filters still apply via the E2 object's status.

### Test plan (real DB, no mocks)

- forget-then-extract: active object STAYS in the graph; arcs preserved.
- consolidation-prune-then-extract: mirror pruned -> object STAYS in the graph.
- `closed` E2 object: still excluded (status, not mirror presence, drives exclusion).
- raw memory: still REJECTED by the guard (no-raw invariant intact).
- multihop recall traverses an entity whose mirror was forgotten.
- supersedes + references edges survive a mirror forget on either endpoint.

## Risks / sequencing

- Touches the E3.3 guard + a migration; both live ONLY on the active `feat/e3-*`
  branches (not v1.18.0 / master at scope time). Heavy concurrent multi-agent activity
  on those branches -> build in worktree isolation and land AFTER E3 merges to master,
  or coordinate explicitly with the E session. Do not churn the guard under them.
- Migration + guard + recall change -> mandatory plan-eng + codex review before code
  (Outside Voice). Watch the scored-BFS visited-ordering and the cached-doc-vector
  gating lessons from the L1 v1.21.0 episode when editing graph-recall.

## Open questions for the episode

- Should a `references` edge whose SOURCE object is still active but whose mirror was
  pruned keep firing? (Yes under this fix -- provenance is the object.)
- Do we backfill `source_object_*` for existing entities at migration time, or only on
  the next `graph extract` rebuild? (Rebuild is idempotent; lean rebuild-only.)
