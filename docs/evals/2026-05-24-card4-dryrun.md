# Card 4 dry-run — 2026-05-24

**Status:** WORKLOAD-VALIDITY GATE FAILED. Pre-reg lock BLOCKED pending
investigation. Card 4 stays DRAFT.

**Origin:** `docs/research-prereg/2026-05-24-v18x-prereg-drafts.md` Card 4
(sequential-learning adapter re-run, highest-EV of the 4 pre-reg drafts).

## v1.8.1 discipline rule

> No pre-commitment is binding without (a) source-read of code paths the
> design depends on, AND (b) a 1-question dry-run confirming the mechanism
> FIRES before pre-reg locks.

This document records (a) + (b) for Card 4.

## (a) Source-read — PASS

Mechanism wire-up confirmed clean across the call chain:

- `benchmarks/sequential-learning/adapters/interface.mjs:42-50` —
  optional v1.7.5 `pushGoal` / `completeGoal` hooks declared (paired contract,
  both-or-neither). `createAdapter` enforces pairing + type checks.
- `benchmarks/sequential-learning/adapters/hippo.mjs:135-158` —
  `pushGoal` invokes `hippo goal push <name>`, parses `g_<16hex>` from stdout,
  sets `this._sessionId` for subsequent recall calls (via `HIPPO_SESSION_ID`
  env var threaded through `hippoExec` line 60). `completeGoal` invokes
  `hippo goal complete <id> --outcome <1.0|0.0>`, clears `_sessionId`.
  v1.7.8 hardening moved counters from module-level `let` to per-instance
  fields so future `--workers N` parallel adapter consumers don't clobber
  each other.
- `benchmarks/sequential-learning/run.mjs:215` — `useGoalStack` gates on
  BOTH `opts.useGoalStack === true` AND `typeof adapter.pushGoal === 'function'`.
  Line 240-250 wires `pushGoal` at task start, line 291-298 wires
  `completeGoal` at task end with the matched/missed outcome.
- `--use-goal-stack` flag (run.mjs:70) + `--budget` flag (run.mjs:82) +
  `--n-seeds` flag (run.mjs:79) + `--eval-strict` flag (run.mjs:73) all wired.

**Mechanism IS plumbed end-to-end.** No regression at the wiring level since
v1.8.0 (which characterized the contract as PASS).

## (b) 1-question dry-run — FAIL

**Question.** Does the workload-validity baseline (`C2 lateMean ≥ 0.20`,
seeds non-zero) still hold on current master (v1.12.6)?

**Method.** 3 seeds of C2 condition (hippo-base, no goal-stack). Same first
3 seeds as the v1.8 baseline 20-seed run (deterministic seed derivation per
run.mjs:135 — `(Math.imul(0x9E3779B9, (1000 + i) >>> 0)) >>> 0` matches both).

**Setup.** `npm link` from repo root to make `hippo` CLI resolve to local
v1.12.6 build (was globally stale at 1.8.1). Confirmed `hippo --version` →
`1.12.6` before run. `node benchmarks/sequential-learning/run.mjs --adapter
hippo --n-seeds 3 --output /tmp/card4-dryrun`.

**Runtime:** 63.1 seconds total (21 seconds per seed).

### Result

| Metric | v1.8 baseline (2026-05-09, hippo 1.7.7) | Master 1.12.6 (2026-05-24) | Delta |
| --- | --- | --- | --- |
| overall_trap_hit_rate | 0.42 | 0.42 | 0.00 |
| phases.early | 0.77 | 0.88 | +0.11 |
| phases.mid | 0.09 | 0.21 | +0.12 |
| **phases.late** | **0.25** | **0.11** | **−0.14** |
| hook_failures.push | 0 | 0 | — (C2: no hooks) |
| hook_failures.complete | 0 | 0 | — (C2: no hooks) |

Per-seed late values (master): `[0.1111, 0.1111, 0.1111]` — identical across
the three seeds (matches v1.8's deterministic-given-seed-sequence behavior;
the 20/20-non-zero structure is preserved).

### Interpretation

- **Workload-validity FAILS.** `C2 lateMean = 0.1111 < 0.20` floor. The
  workload no longer satisfies the v1.8.0 PASS bar that Card 4's pre-reg
  hinges on.
- **Not seed variance.** Same deterministic seeds; the regression is in the
  recall path between hippo 1.7.7 → 1.12.6, not in the workload generator.
- **Not a wiring break.** Hook failures = 0 on push and complete (though
  C2 doesn't exercise them — the failure mode would surface on C3).
- **Phase shape changed.** early lift +0.11, mid lift +0.12, late drop
  −0.14. Recall is succeeding at early/mid trap encounters but failing on
  late ones. Suggests a shift in retrieval ranking (older episodic memories
  are being recalled less often), not a total recall break.

### Raw result artifact

Preserved at `docs/evals/2026-05-24-card4-dryrun-result.json` for the audit
trail. v1.8 baseline at `benchmarks/sequential-learning/results/v1.8-eval-C2-hippo-base/latest.json`.

## Decision

**Card 4 pre-reg lock: BLOCKED.** Per v1.8.1 discipline rule, dry-run
failure means do not lock. Card 4 stays DRAFT.

## Investigation paths (not pursued in this session)

Candidate hippo releases between 1.7.7 and 1.12.6 that could have shifted
recall-late behavior:

1. **v1.8.0** — adversarial trap categories. Different traps in
   `benchmarks/sequential-learning/traps.mjs` would change category-to-slot
   assignment. **Most likely cause** if traps.mjs changed shape.
2. **v1.11.0** — conflict-subsystem tenant isolation. Adds tenant-scoped
   conflict reads to recall path; unscoped readers may have shifted.
3. **v1.11.5** — Episode A/B/C critic-deferral hardening pass. Touched
   the recall path (`/v1/context`).
4. **v1.12.0 sub-1** — admin gate. No recall path change expected, but
   `Actor` interface promotion touched `Context.actor` shape.
5. **v1.12.1** — L9 tenant scoping. Plumbed `tenantId` through 8 background
   pipelines; recall-tenant boundary changes plausible.
6. **v1.12.6** — defensive `kind != 'archived'` filter (shipped TODAY).
   Shouldn't affect distilled-kind memories (which is what the bench
   writes), but a regression on the bench WAS introduced; cannot rule out
   without bisection.

**Recommended next step (if Card 4 stays prioritized):** git-bisect across
the 6 candidates above using the deterministic 3-seed dry-run as the
fitness function. Each bisect step costs ~1min of compute. 6 candidates
binary-bisected = 3 bisects ≈ 4 minutes. The version that drops lateMean
from 0.25 → 0.11 is the root cause.

If Card 4 is de-prioritized: leave DRAFT status + document the regression as
a separate `TODOS.md` follow-up. The goal-stack mechanism CODE remains
shipped (v1.7.4 ship is independent of the eval).

## Why the dry-run earned its keep

This is exactly the v1.8.1 discipline rule's purpose. Three prior
pre-registrations were retracted (v1.7.5, v1.7.6, v1.7.7 + v1.8.0 magnitude
+ v1.9 pre-commitment) because pre-reg locked first and dry-run-equivalent
work happened second. Today (b) caught the regression BEFORE lock. A 4th
retraction in this mechanism family would freeze the line per v1.8.1's
retraction-discipline rule — that's the catastrophic-cost outcome the
discipline rule guards against, and it was avoided here by ~3 minutes of
honest dry-run work.
