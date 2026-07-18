# S5 path-overlap tuning — measurement + decision record

**Episode:** 01KXTBPRV5R3KJVTPMPPG9M8TT | **Base:** v1.26.3 (`564c9719`)
**Plan:** `docs/plans/2026-07-18-s5-path-overlap-tuning.md`

## Pre-registration (written BEFORE any measurement run)

**Question.** Does replacing `pathOverlapScore`'s memory-count normalization
(`matches / |memPathTags|`, C0) with a candidate normalization fix the
genericity-rewarded defect (bare generic path tag scores 1.0 from every cwd
under home) without regressing any existing tier-1 fixture or test?

**Candidates.**
- C0 (status quo): `matches / |memPathTags|`
- C1 (Jaccard): `matches / |mem ∪ cur|`
- C2: `matches / max(|mem|, |cur|)`

**Instruments.**
1. New tier-1 fixture `benchmarks/micro/fixtures/path_boost.json`
   (mechanic `path-boost`), authored from desired locality semantics using the
   new `cwd_subdir` harness knob. Discriminating query runs from LOCAL's own
   cwd with GENERIC holding a slight lexical edge (authored ratio target
   inside (1.0, ~1.13) — the Windows-binding band).

   _Amendment 1 (2026-07-18, BEFORE any candidate measurement ran):_ the
   original single-store instrument was unimplementable (local store root is
   strictly cwd-derived, no walk-up; see the plan's Amendment 1 + red-run
   evidence file). Instrument revised to hippo's real cross-project mechanism:
   per-subdir initialized stores + `promote`-to-global, with the fixture's
   competitors meeting in the per-fixture global store. Same falsifiable
   red/green shape, same decision rule. No candidate had been measured when
   this amendment was made.

   _Amendment 1a (2026-07-18, same session, still pre-candidate-measurement):_
   score-verified prechecks exposed two scoring asymmetries that invalidated
   the v2 instrument mid-amendment — `localBump` 1.2x on local rows, and
   promoted global rows carrying NO embedding (bm25-only, ~5.4x base deficit
   vs local hybrid rows; filed as a product follow-up). Final v3 instrument:
   all three competitors promoted to global, LOCAL's local copy forgotten —
   symmetric bm25-only rows. C0 red re-verified at real fixture depth with
   locked contents: GENERIC 0.2737282201552896 > LOCAL 0.2468671207643772,
   equal 1.3x boosts, base ratio 1.1088 in the (1.0, 1.13) band; predicted
   C2 flip green Windows 0.981 / Linux 0.938. The plan's Amendment 1 carries
   the full evidence.
2. The 11 pre-existing micro fixtures (non-regression; provably
   path-boost-uniform, so any delta indicates collateral damage).
3. Full vitest suite.

**Decision rule (ship a candidate iff ALL):**
1. `path_boost` fixture: candidate green on every query AND C0 demonstrably
   red (or inverted) on at least one — the red/green pair is the evidence;
2. all 11 pre-existing fixtures green under the candidate;
3. full suite green with unit tests updated to the new contract and the old
   defect case pinned to its fixed value.

If no candidate satisfies all three: ship T1+T2 only (helper + instruments),
record the negative result here, keep a narrowed TODOS follow-up.

**Discipline notes.** Score pairs are printed at full precision before any
tie/inversion claim (probation memory: measured ties, not asserted ones).
The fixture asserts top-1 membership only, never scores. Red runs are captured
BEFORE the fix lands (red-run evidence discipline).

## Baseline measurements (C0)

- 11 pre-existing fixtures under C0 + the new harness code: 11/11 PASS
  (`overall pass=1.000 total=39.2s fixtures=11`).
- `path_boost` fixture under C0: **q1 RED** — top-1 = GENERIC
  (`MISS zephyrline` + leaked `gravemark`), q2 GREEN
  (`pass=0.50 (1/2)`). Full verbose capture:
  `trajectories/01KXTBPRV5R3KJVTPMPPG9M8TT/red-run-path-boost-v3.txt`.
- Pre-dispatch full-precision score pair (scratch replica at real fixture
  depth, identity verified by marker; both rows at x1.300 path boost — the
  subset defect live): GENERIC `0.2737282201552896` > LOCAL
  `0.2468671207643772`, base ratio 1.1088 inside the pre-registered
  (1.0, ~1.13) band.

## Candidate measurements

| Candidate | q1 (from proj-nova/lib) | q2 (from proj-rho) | full micro |
|---|---|---|---|
| C0 `matches/\|mem\|` | RED (GENERIC top-1) | GREEN | 11/11 (pre-fixture) |
| C1 Jaccard | GREEN | GREEN | 12/12 |
| C2 `matches/max(\|mem\|,\|cur\|)` | GREEN | GREEN | 12/12 |

Measured C2 q1 score pair (scratch replica, `hippo recall --json`): LOCAL
`0.2649624951947676` (rank 1) > GENERIC `0.22506366401187083` — the measured
green the round-3 critic required, not the arithmetic prediction. (Replica
home was deeper than the harness tempdir, which only strengthens LOCAL's win
per the documented depth caveat; the harness-run fixture green is the
canonical measurement.)

Unit contract under final C2: 16/16 in tests/path-context.test.ts (defect pin
flipped 1.3 -> 1.1 with fixed-by comment; the mem-3/cur-3 partial 2/3 pin and
the 2-of-4 1.15 pin unchanged — C2 agrees with C0 whenever
`\|mem\| >= \|cur\|`). Adjacent smoke: scope-boost 4/4,
cli-recall-scope-deny 7/7.

## Decision

**SHIP C2** (`matches / Math.max(memoryPathTags.length,
currentPathTags.length)`), per the pre-registered rule — all three criteria
measured: (1) fixture red under C0 / green under C2; (2) all pre-existing
fixtures green (12/12 including the new one); (3) full suite green with the
unit contract updated, the old defect case pinned to its fixed value, and the
change called out in CHANGELOG (the CHANGELOG entry lands with the 1.26.4
release-prep commit at the ship stage, per the plan's Version/release
section — noted here so criterion 3's CHANGELOG clause is tracked, not
silently dropped; flagged by code-review-critic). C1 also satisfied the
rule; C2 was the pre-registered default pick (normalize by the more specific
side; identical to C0 on every case where the memory is at least as specific
as the query).

**Blast-radius correction (review stage):** the changed region is every
`|mem| < |cur|` pair, NOT only generic-tagged memories. A same-project
root memory recalled from deeper cwds of its own project softens one level
earlier than under C0 (1.3/1.2/1.15/1.075/1.0 vs 1.3/1.3/1.3/1.15/1.0 at
depths 0-4) - measured by the independent-review critic, re-derived by the
orchestrator, and pinned as intended semantics in tests/path-context.test.ts
(rationale: same mathematical phenomenon as the defect, indistinguishable
under tag-set overlap; exact locality now outranks root locality instead of
tying). The fixture covers the cross-project genericity case; the unit pins
cover the same-project depth gradient.
