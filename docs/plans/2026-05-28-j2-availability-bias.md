# Plan: J2 Availability-bias detector (Track J)

Status: Draft — NOT yet engineering-reviewed. For plan-eng-critic fresh-eyes scrutiny.
Episode: 01KSQCBZGQAHNMSYM7D7J19HTJ
Date: 2026-05-28

## Goal

Add J2, a soft-warning detector that flags when a recall's top-K is dominated by recent
entries while substantially older relevant candidates in the same matched pool were passed
over: the availability/recency-bias failure mode (Thinking Fast and Slow). Soft warning
only, never filters or reorders results (ROADMAP-RESEARCH.md:571 discipline note). Mirrors
the existing C5 `suppressionSummary` (per-pipeline) and J1 `anchoringHint` patterns.

## Framing (from brainstorm, grilled)

Framing B+: compare the returned top-K age distribution against the MATCHED candidate pool
for the same query, and report the last-24h recency fraction as the concrete hook.
- Self-calibrating (no fixed-corpus assumption), no audit_log cold-start.
- Computable from candidate ages already in each pipeline's recall path.

Deferred to follow-up J2.2 (flagged, not silent): audit_log tag-class historical-answer-age
base rates (cold-start + complexity; mirrors J3.1 -> J3.2 incremental shipping).

## Detector design (src/predictions.ts)

New interface `AvailabilityHint` (mirror AnchoringHint: numeric evidence + `summary` +
`source` discriminator):
- `recentCount`, `returnedCount`, `recentFraction`
- `topKMedianAgeDays`, `poolMedianAgeDays`
- `olderCandidatesPassedOver`
- `summary` (human-readable, em-dash-free)
- `source: 'j2-recency'`

New PURE function `detectAvailabilityBias(opts)`:
- inputs: `topK: {id, created}[]`, `pool: {id, created}[]`, `now?`, `recencyWindowMs?`(=24h),
  `recentFractionThreshold?`(=0.7), `minReturned?`(=3), `minPool?`(=10), `minOlderPassedOver?`(=3)
- returns `AvailabilityHint | null`
- logic:
  1. gate: `topK.length >= minReturned && pool.length >= minPool`, else null
  2. `recentCount` = count(topK age <= recencyWindow from now); `recentFraction` = recentCount / topK.length
  3. if `recentFraction <= recentFractionThreshold` -> null (not recency-dominated)
  4. compute `topKMedianAgeDays`, `poolMedianAgeDays`
  5. `olderCandidatesPassedOver` = pool entries with age > topK median age AND id not in topK id-set
  6. fire only if `poolMedianAgeDays > topKMedianAgeDays && olderCandidatesPassedOver >= minOlderPassedOver`
  7. return hint
- PURE: no I/O, no env read inside (env gate + audit emission live in the callers, exactly like `detectAnchoring`).
- Perf: one O(n log n) sort over the already-loaded pool per recall; n is bounded by the load limit, negligible.
- Coexistence: `availabilityHint` is INDEPENDENT of the other hints (can co-occur with anchoringHint / planningFallacyHint), unlike the planningFallacy hint/watching pair which are mutually exclusive.

## Env knob

`HIPPO_AVAILABILITY=off` disables the detector (gates even the detect call so disabled
tenants pay zero work). Matches HIPPO_ANCHORING / HIPPO_AUTODEBIAS. Add to README env table.

## Audit op (observability-first, mirrors J1)

New op `recall_availability_detected`, emitted once when the hint fires in each pipeline
that computes it. LOCKSTEP 3 sites (the v1.11.5 CRIT A institutional rule):
1. `src/audit.ts:130` AuditOp union
2. `src/cli.ts:5218` VALID_AUDIT_OPS set
3. `src/server.ts:103` VALID_AUDIT_OPS set

## Lockstep wiring sites (new optional RecallResult field `availabilityHint`)

1. `src/predictions.ts` — AvailabilityHint type + detectAvailabilityBias + default consts
2. `src/api.ts` — RecallResult.availabilityHint field (JSDoc) + compute (pool = loaded candidates, topK = rankedOut) + env gate + audit emit + conditional splat (line ~1031 region)
3. `src/cli.ts` — cmdRecall compute + emitCliAudit + splat (L1414/1521) + render line (em-dash-free)
4. `src/mcp/server.ts` — compute + audit emit + MCP text-block render (em-dash-free)
5. `src/server.ts` — VALID_AUDIT_OPS only (field flows through api.recall result; HTTP returns JSON unchanged)
6. `python/src/hippo_memory/models.py` — AvailabilityHint model + `availability_hint` field on RecallResult
7. `python/src/hippo_memory/__init__.py` — export AvailabilityHint + __all__

`availabilityHint` is per-pipeline (like suppressionSummary): the candidate pool differs per
pipeline, so each computes its own from the entries it loaded.

## Data source

Each entry's creation timestamp (`MemoryEntry.created`). Execute-stage pins the
ISO-vs-epoch representation and normalizes via one `toEpochMs` helper. `topK` = returned
results; `pool` = the matched candidate set each pipeline already counts for
`suppressionSummary.totalCandidates`. Execute must confirm the MCP physics/hybrid path
carries `created` on its candidate entries (suppressionSummary proves count parity; verify
the timestamp field is present there too).

## Tests (real DB; honors the roadmap success metric)

1. `tests/predictions-availability-bias.test.ts` (new), pure-function unit tests:
   - FIRES: pool has an old relevant entry + a recent noise cluster, topK skews recent
     (recentFraction > 0.7), poolMedian > topKMedian -> hint with correct numbers.
   - DOES NOT FIRE: topK < minReturned; pool < minPool; recentFraction <= 0.7; pool not
     older than topK (recency genuinely correct); olderCandidatesPassedOver < min.
   - SUCCESS-CRITERION test: a planted set where the correct (oldest-relevant) answer
     predates the topK median by > X days; assert the detector fires; check precision on a
     small planted multi-query set is > 70% (roadmap success bar).
2. Update MCP + CLI render snapshot tests for the new block.
3. `python/tests/test_models.py`: AvailabilityHint roundtrip + RecallResult parse +
   coexistence with the other hint fields.

## Roadmap-sync (bundled hygiene, per codebase-audit step 4)

- ROADMAP-RESEARCH.md: J2 [planned] -> [shipped vX]; J1 [planned] -> [shipped v1.13.2];
  J3 [next] -> [shipped v1.13.1 + v1.13.4]; J5 [next] -> [shipped v1.13.5];
  J-Wire [next, blocks J5+] -> [done-by-disproof, dogfood 8/9].
- ROADMAP.md: mark priority-queue #3 DONE (cite PR #30 / #31 + v1.12.1); fix the stale
  "Current version: 1.11.4" header; resolve the existing uncommitted line-ending diff.

## Out of scope (explicit)

- audit_log tag-class historical base rates (-> J2.2).
- `recall --why` integration + observatory dashboard surface (separate UI track).
- No new migration, no schema change, no reorder/filter of results.

## Self-grill (plan), carried into plan-eng-critic

1. WEAKEST PREMISE: comparing topK vs matched pool is the right availability signal. If
   hippo's ranking SHOULD prefer recent (recency is a legitimate relevance signal), J2 fires
   on correct behavior = false positive. Defense: soft-warning-only + the
   poolMedian>topKMedian + olderCandidatesPassedOver gate means it fires only when
   substantially-older matched candidates were genuinely passed over. Residual risk:
   recency-dominated domains see noise. Accept as a documented Known Limitation; env knob +
   soft nature bound the harm.
2. Magic thresholds (24h, 0.7, min 10/3/3): they are the roadmap's stated values plus
   defensive minimums; the synthetic precision test validates them; tunable via detector
   opts. Do not hardcode without the test.
3. Per-pipeline compute risk: MCP physics/hybrid pool may lack clean `created`. Mitigation:
   verify at execute; suppressionSummary already proves count parity across all 3 pipelines.
4. Roadmap-sync bundling could read as scope creep. Defense: mandated by the codebase-audit
   roadmap-sync step, doc-only, flagged. If the critic objects, split into a follow-up doc commit.

## Success criteria

- detectAvailabilityBias fires at > 70% precision on the planted synthetic set.
- All existing tests green; new tests green; build clean.
- Zero em-dashes in CLI/MCP render strings, CHANGELOG, commit body.
- All 3 audit-op sites + all 7 wiring sites updated in lockstep (no drift).

## Plan-eng-critic round 1 fold-in (2026-05-28, verdict PASS score 78)

Corrections folded for execute (the lines below supersede the earlier draft where they conflict):

1. (MUST-FIX, med) api.recall topK: `rankedOut` is `RecallResultItem[]` with NO `created`
   field. Build topK `{id, created}` from the in-scope candidate `MemoryEntry[]`
   (post-goal-boost slice) or id-join rankedOut back to `entries`/`all`. The earlier
   "topK = rankedOut" / "topK = returned results" phrasing is superseded by this.
2. (low) Verification target is api.recall, NOT MCP. cmdRecall + MCP return
   `results[].entry` (full MemoryEntry, `created` present) and are the safe paths.
3. (low) `MemoryEntry.created` is canonical ISO 8601 (src/memory.ts:48 invariant), not an
   open question; normalize via a `Date.parse`-based `toEpochMs` helper.
4. (low) Audit-op 3-site lockstep CONFIRMED complete (audit.ts union + cli.ts + server.ts).
   api.ts + mcp/server.ts are compile-time-union emitters with no runtime VALID set. No 4th site.
5. (low, adopted) Roadmap-sync ships as a SEPARATE commit from the J2 feature diff so the
   feature stays reviewable in isolation.
