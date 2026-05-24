# v1.8.x research pre-registration drafts — 2026-05-24

**Status:** DRAFT — not yet pre-registered. Each card MUST satisfy the
v1.8.1 discipline rule before lock:

> No pre-commitment is binding without (a) source-read of code paths
> the design depends on, AND (b) a 1-question dry-run confirming the
> mechanism FIRES before pre-reg locks.

Per `docs/RETRACTION.md` "Pre-registration discipline rule" added v1.8.1.
Three prior pre-registrations were retracted (v1.7.5, v1.7.6, v1.7.7 +
v1.8.0 magnitude + v1.9 pre-commitment) for failing one or both of
(a) and (b).

Sign off by editing each card with `PREREG-LOCK <date>` in the Status
field. Reject by deleting the card with a one-line reason. Cards
deferred indefinitely stay as DRAFT.

---

## Card 1 — vlPFC interference suppression (v1.8.x)

**Status:** DRAFT (v1.8.1 discipline-rule unmet on both (a) and (b)).

**Mechanism claim.** Adding vlPFC-style interference suppression (a
companion to the v1.7.4 dlPFC goal-stack push/pop) should improve
multi-goal-active recall accuracy by suppressing recall of memories
tagged with non-active goals.

**(a) Source-read required before lock.** Confirm the following files
exist and route as described:

- `src/api.ts::recall` — confirm where the goal-stack boost is applied
  (`applyGoalStackBoost` at line ~?). Read the function signature,
  confirm `RecallOpts.sessionId` + `RecallOpts.goalTag` plumbing from
  v1.7.4 is intact at the call site.
- `src/goals.ts` — confirm push/pop API: `pushGoal`, `completeGoal`,
  `resumeGoal`, `enforceDepthCapWithinTx`. List the actual function
  signatures.
- Identify the call site that would apply interference suppression: the
  natural seam is `recall` AFTER goal-stack boost but BEFORE final
  ranking. Confirm such a seam exists OR document where it would have
  to be added.
- `benchmarks/sequential-learning/adapters/hippo.mjs` — confirm push/pop
  hooks are wired. If not, this is upstream work (the v1.7.5
  sequential-learning adapter contract needs to actually fire pushGoal
  during the benchmark for any vlPFC eval to have a workload).

**(b) 1-question dry-run before lock.** Build the smallest possible
synthetic workload where:
- A session has 2 active goals (G1 tagged `[work:cache-refactor]`, G2
  tagged `[work:auth-bugfix]`).
- The store has 10 memories: 5 tagged with `[work:cache-refactor]`, 5
  tagged with `[work:auth-bugfix]`, all sharing a BM25-matchable token.
- Query: a token in the shared vocabulary.
- Expected: with G1 active and G2 suspended, the vlPFC mechanism
  suppresses G2-tagged memories in the top-K. Without the mechanism,
  the top-K is mixed.

The dry-run question: does the mechanism, as implemented in the smallest
possible version, change top-K ordering on this synthetic workload at
all? If NO → mechanism does not FIRE; do not lock pre-reg.

**Pre-reg gates (proposed; do not lock until (a) + (b) clear).**

- Composite IC vs no-vlPFC baseline ≥ +0.05 (small effect)
- Walk-forward Sharpe ≥ 0.0 (not negative)
- Sign consistency ≥ 60% across 20 seeds
- Workload-validity: C2 lateMean ≥ 0.20, 20/20 seeds non-zero (matches
  v1.8.0 PASS bar)

**Retraction conditions.**
- Any gate fails → RETRACT mechanism claim per v1.7.9 / v1.8.0 precedent.
- vlPFC mechanism remains SHIPPED but no magnitude is claimed.
- If two retractions accumulate on goal-stack mechanism family, freeze
  the family and route research to a different track (per v1.8.1
  retraction inventory).

---

## Card 2 — C3 Pineal ambient state vector (research track)

**Status:** DRAFT (v1.8.1 discipline-rule unmet on both (a) and (b)).

**Mechanism claim.** A "Pineal" ambient state vector that scores
incoming recall queries against a slowly-drifting ambient embedding (vs
the per-session active embedding) should surface schema-shifted
memories that the per-session recall path misses.

**Background.** Logged in `RESEARCH.md` (per memory: "Pineal gland
concept logged in RESEARCH.md"). Not implemented in code. No source-read
candidates yet — this is a research-design card, not an
implementation-pending card.

**(a) Source-read required before lock.** N/A — mechanism is not yet
implemented. Pre-lock work:

1. Find the RESEARCH.md section describing Pineal (`grep -n -i pineal
   RESEARCH.md`).
2. Identify the minimal addition: probably a slow-drift exponential
   moving average of session embeddings stored alongside per-session
   state, plus a recall-time blending option.
3. Identify the call site for blending: `src/api.ts::recall` ambient
   path (used by `cmdContext` no-query branch).
4. Draft an implementation plan as a separate doc; do not pre-reg
   eval gates against unwritten code.

**(b) 1-question dry-run before lock.** N/A until (a)'s implementation
plan is drafted.

**Pre-reg gates.** Deferred until implementation plan lands.

**Recommendation.** This card stays DRAFT indefinitely. It's a research
seedling, not a near-term eval candidate. Move to v1.10.x or v2.x
roadmap as "Pineal proposal" rather than a pre-reg card.

---

## Card 3 — E2 first-class `decision` / `handoff` object promotion

**Status:** DRAFT (different shape — this is a contract change, not a
research eval; pre-reg discipline doesn't apply, but a `/plan-eng-review`
gate does).

**Mechanism claim.** Promoting `decision` and `handoff` from JSDoc-typed
`dict[str, Any]` (today's `ContextResult.active_snapshot` /
`session_handoff` shape) to first-class Pydantic + TypeScript classes
should improve SDK ergonomics and enable per-object validation.

**Not a pre-reg item.** This is contract-engineering, not research. Pre-reg
discipline doesn't apply. The right gate is `/plan-eng-review` on a
written plan + `/codex` cross-model review.

**Pre-plan work.**

1. Grep current shape consumers: `grep -rn "active_snapshot\|session_handoff" src/ python/src/`.
2. Decide breaking-change strategy: (i) add new typed fields alongside,
   deprecate the dicts in next major; (ii) replace inline, breaking SDK
   v0.x → v1.0.
3. Draft a plan doc at `docs/plans/2026-MM-DD-e2-decision-handoff-promotion.md`.
4. `/plan-eng-review` + `/codex` on the plan before any code.

**Recommendation.** Park behind D1/D2/D3 (the non-loopback gate). If
non-loopback ships, the SDK shape contract becomes higher-leverage; if
it doesn't, today's `dict[str, Any]` is fine for single-machine users.

---

## Card 4 — Sequential-learning adapter contract eval (re-run)

**Status:** DRAFT — (a) source-read PASS + (b) dry-run PASS. **Pre-reg lock
unblocked, pending Keith's signoff.** See
`docs/evals/2026-05-24-card4-dryrun.md` for the full report (including the
2026-05-24 13:50 retraction of the earlier "regression" claim — apples-to-
oranges error on `--restrict-late-to` flag).

**v1.8 baseline reproduced.** Master v1.12.6 with `--restrict-late-to 4`
produces lateMean=0.25 across all 3 seeds — identical to v1.8 baseline.
Mechanism FIRES on master. Hook failures 0/0.

**Pre-reg gates (config now explicit):**
- Workload-validity preserved: **C2 lateMean ≥ 0.20, 20/20 seeds non-zero,
  using `--restrict-late-to 4`** ← flag is part of the gate definition
- C3 lateMean STRICTLY_HIGHER than C2 on ≥ 12/20 seeds (paired permutation CI)
- C3 − C2 delta ≥ +5pp (effect-size floor)

**Retraction conditions:** Gate fail → RETRACT mechanism-effect claim.
**4th retraction in this family freezes the line per v1.8.1 retraction
discipline** — that's the catastrophic-cost outcome any pre-reg lock here
must price in.

**Mechanism claim.** With the v1.7.5 sequential-learning adapter contract
shipped (`pushGoal`/`completeGoal` hooks on `interface.mjs`,
`benchmarks/sequential-learning/adapters/hippo.mjs` implementing both),
re-running the public benchmark with the contract WIRED should produce
a discriminating workload — one where the goal-stack mechanism's effect
on late-task lattice rate is measurable.

**Background.** v1.7.6 calibration sweep (5 budgets × 10 seeds) showed
`phases.late = 0.0` on every run — budget reduction did NOT produce a
discriminating workload. Per v1.7.9 retraction, `--restrict-late-to 4`
also SANITY_FAILed. v1.8.0 shipped adversarial trap categories: PASS
on workload validity (C2 lateMean=0.25, 20/20 seeds non-zero) but
mechanism characterisation was sign-only (C3 = C2 on all 20 seeds).

**(a) Source-read required before lock.**

- `benchmarks/sequential-learning/adapters/hippo.mjs` — confirm pushGoal
  / completeGoal hooks are actually invoked by the harness on the right
  events. Quote the relevant lines.
- `benchmarks/sequential-learning/run.mjs` — confirm `--use-goal-stack`
  routes correctly and that the budget knob is wired.
- Confirm what changed (if anything) in the harness between v1.8.0
  (PASS on workload validity) and current `master`.

**(b) 1-question dry-run before lock.** Run the v1.8.0 PASS workload
on `master`. Question: does C2 lateMean still ≥ 0.20 with 20/20 seeds
non-zero? If NO → workload regression; investigate before pre-reg.
If YES → mechanism FIRES; lock can proceed.

**Pre-reg gates (proposed; do not lock until (a) + (b) clear).**

- C3 lateMean STRICTLY_HIGHER than C2 on ≥ 12/20 seeds (paired
  permutation CI; minimal effect to detect)
- C3 - C2 lateMean delta ≥ +5pp (effect-size floor)
- Workload-validity preserved: C2 lateMean ≥ 0.20, 20/20 seeds non-zero

**Retraction conditions.**

- C3 NOT STRICTLY_HIGHER on ≥ 12/20 seeds → RETRACT mechanism-effect
  claim (mechanism CODE stays shipped per v1.7.9 precedent).
- This would be the 4th retraction on the goal-stack mechanism family
  — freeze the family per v1.8.1 retraction discipline.

**Recommendation.** This is the highest-EV card of the four. The v1.8.0
PASS gives a real workload to test against. The cost of a retraction is
high (4th in family freezes the line), so (b)'s dry-run is critical.

---

## Items NOT in this doc

- B3 dlPFC mechanism re-test of magnitude — explicitly retracted per
  v1.7.9. Do not re-open without a new mechanism design.
- B1 ACC EVC calibration — research track, days 91-180 per ROADMAP.
  Not pre-reg ready.
- Long-context retention benchmarks — covered by AIC-P1 grant scope;
  not appropriate to pre-reg against an unawarded grant.

## Decision form

For each card:

- Card 1 (vlPFC): [ ] LOCK → execute (a) source-read + (b) dry-run, return for lock | [ ] REJECT → reason: ___ | [x] DRAFT (default)
- Card 2 (Pineal): [ ] LOCK | [ ] REJECT → reason: ___ | [x] DRAFT (default — research seedling, not pre-reg ready)
- Card 3 (E2 decision/handoff): [ ] PROMOTE to `/plan-eng-review` track | [ ] REJECT → reason: ___ | [x] DRAFT (parked behind D3)
- Card 4 (sequential-learning re-run): [ ] LOCK → execute (a) source-read + (b) dry-run, return for lock | [ ] REJECT → reason: ___ | [x] DRAFT (default)
