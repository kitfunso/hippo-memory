# F7 — LoCoMo baseline refresh (v1.25.0)

Status: Draft (episode 01KWRTTFCS36Y0VPSP9RMA353Z, plan stage)
Date: 2026-07-05
Branch: `feat/f7-locomo-baseline` (worktree off origin/master `f20d9e9`, v1.25.0)

## Goal

Establish the **publishable** LoCoMo retrieval baseline for current hippo
(master, v1.25.0) and close ROADMAP F7's success criterion: "numbers
published; comparison against Mem0 / Letta noted." Informational only —
this baseline gates no feature (ROADMAP F7 rule).

## Why a refresh, not a first run

ROADMAP F7 says "Never run before" — that is stale. `benchmarks/locomo/`
(run.py, score_evidence.py, analyze/audit/finalize tooling) is tracked in
git and was run extensively in April 2026 (v0.32–v0.34 era). But no
publishable current baseline exists:

- All judged (LLM-judge) aggregate scores were declared **contaminated**
  (1,377 + 528 `judge rc=1` failures; `LOCOMO_INVESTIGATION.md`).
- The only trustworthy April numbers are deterministic:
  **evidence recall@5 = 0.172748 (v0.32.0) / 0.172499 (v0.33.0)** on
  1,982 scored QAs (4 QAs have no gold evidence and are unscored).
- Everything predates v1.0; current master is v1.25.0 with a rebuilt
  retrieval stack (RRF fusion, graph stream, reranker, scope filters).

## Pre-registered protocol (frozen BEFORE the run; no peeking-then-choosing)

| Parameter | Value | Rationale |
|---|---|---|
| Data | `data/locomo10.json` (10 convs, 5,882 turns, 1,986 QAs) | same file as April (already on disk, sha to be recorded in results doc) |
| Binary under test | worktree build @ `f20d9e9` via `HIPPO_BIN="node <worktree>/bin/hippo.js"` | benchmarks exactly current master; global CLI (1.24.1) is stale |
| Store isolation | fresh `HIPPO_HOME` per conversation (run.py default) | no cross-conversation leakage |
| Ingestion | `hippo remember` per turn, tags `conv:/session:/speaker:/dia:` (run.py default) | identical to April |
| Retrieval | `hippo recall <q> --json --budget 4000`, top-k 5 | identical to April; run.py's budget preflight guard verifies not budget-capped |
| Scoring | `--score-mode evidence` (deterministic gold dia_id recall) | judged mode declared contaminated; evidence mode is the April-comparable metric |
| Scope of run | all 10 conversations, all QAs (no sampling) | timing smoke says ~1h total; partial runs are explicitly not benchmark scores (investigation doc) |
| Judge | none | no LLM in the scoring path; zero quota/noise risk |

Comparability note: `--budget 4000` is kept because it is the April
protocol. (The unrelated longmemeval guidance "never --budget 4000"
concerns a different benchmark's context budget; comparability governs
here.)

Discover-stage smoke (2026-07-05, this episode): init/remember/recall all
compatible with v1.25.0; recall JSON contract (`results[].content/tags/score`)
intact; `dia:` tags preserved (hippo adds `path:*` tags — harmless, the
scorer only reads `dia:`-prefixed tags); v39 scope default-deny does NOT
starve harness-written rows. Timing: 0.37 s/remember, 0.48 s/recall →
~36 min ingest + ~16 min recall.

## Tasks

- **T1 — benchmark run (orchestrator-operated command, background).**
  From the worktree: `HIPPO_BIN="node <worktree>/bin/hippo.js" python run.py
  --data data/locomo10.json --score-mode evidence --output-name
  hippo-v1.25.0-evidence` (+ `--resume` on interruption). Acceptance:
  ingested turns = 5,882/5,882 (per-conversation counts logged); scored
  QAs = 1,982; result JSON records score_mode/config.
- **T2 — scorer cross-check (verify-stage input).** Rescore the new result
  JSON with `score_evidence.py` post-hoc; aggregate must match run.py's
  inline evidence scoring exactly (they are separate implementations — the
  April numbers came from the post-hoc scorer, so agreement is required
  before any delta claim). Also re-run `score_evidence.py` on the two April
  result files to reconfirm 0.172748 / 0.172499 from disk (No-Fabrication:
  the baseline is re-derived, not quoted). **The April result JSONs are
  gitignored and exist ONLY in the main repo** — worktrees do not share
  ignored files — so first copy
  `C:/Users/skf_s/hippo/benchmarks/locomo/results/hippo-v0.32.0.json` and
  `C:/Users/skf_s/hippo/benchmarks/locomo/results/hippo-v0.34.0-no-salience.json`
  into the worktree's `benchmarks/locomo/results/` (they remain gitignored
  there; the main-repo originals are read-only reference and are never
  modified). Note for T4: the second file records `hippo_version: 0.33.0`
  internally despite the `v0.34.0` filename — the docs table must
  disambiguate. Additionally: stored-row-count spot-check — `remember`
  rc==0 does not prove a row exists (a write-time dedupe/merge would be
  invisible to gate 1), so for ≥2 conversations count rows in the store and
  compare to turns ingested; ANY mismatch escalates to a full 10/10
  `audit_matched_stores.py` pass (the April precedent).
- **T2b — determinism repeat-check (concrete owner for the Risks item).**
  Run conversation 1 twice end-to-end (`--conversations 1 --score-mode
  evidence`, two distinct `--output-name`s, fresh HIPPO_HOME each) and diff
  per-QA `judge_verdict` + `retrieved_dia_ids`. Identical ⇒ determinism
  holds; any diff ⇒ STOP, root-cause before the full-run numbers are
  trusted (retrieval is local BM25 + local embedder + RRF; no legitimate
  nondeterminism source).
- **T3 — Mem0 / Letta comparison research (sonnet sub-agent, web).**
  Collect their published LoCoMo numbers WITH primary-source citations
  (paper/blog URLs + metric definitions). Hard framing: their numbers are
  LLM-judge QA accuracy on their own harnesses — NOT comparable to
  deterministic evidence recall@5. The deliverable is a clearly-caveated
  "context" table, never an apples-to-apples claim.
- **T4 — docs publish (sonnet executor).**
  - `benchmarks/LOCOMO_INVESTIGATION.md`: new dated section — v1.25.0
    refresh results, protocol, regeneration command, delta vs April.
  - `benchmarks/README.md`: LoCoMo section alongside the LongMemEval one
    (question it answers, current number, how to reproduce).
  - `ROADMAP.md` F7 entry: `[next]` → baseline-established note with date +
    pointer; fix the stale "Never run before" claim.
  - Result JSONs stay gitignored (existing convention); docs cite the exact
    regeneration command instead.
- **T5 — ship.** Single PR (docs only, no src/, no version bump, no npm
  publish). Deploy = squash-merge.

## Success criteria (falsifiable)

1. Result JSON exists with 1,982 scored QAs and 5,882/5,882 ingested turns.
2. run.py inline aggregate == score_evidence.py post-hoc aggregate (exact).
3. April baselines reconfirmed from disk by re-running the scorer.
4. Docs updated in all three places; ROADMAP F7 stale claim corrected.
5. Mem0/Letta table has ≥1 primary-source citation each + explicit
   non-comparability caveat.
6. No file under `src/` changes. If a harness bug blocks the run, the fix
   is scoped to `benchmarks/locomo/` and called out in the PR.
7. Determinism repeat-check (T2b): conversation 1 run twice produces
   identical per-QA verdicts and retrieved dia_ids.
   **Outcome note (post-execution):** the check FIRED — runs are NOT
   identical (185/199 retrieved sets differed). The mandated STOP happened
   and the cause was characterized before any number was trusted:
   within-store recall is deterministic, no RNG exists in the code path,
   and the variance comes from wall-clock-derived state flipping order among
   near-duplicate score plateaus. Criterion amended to "determinism
   characterized + variance quantified": n=4 conversation-1 repeats, mean
   0.3630, stdev 0.0175. Follow-up (stable tie-break key) filed in TODOS.md.
   Full detail: `benchmarks/LOCOMO_INVESTIGATION.md` Update 2026-07-05.

## Risks / falsifiers

- **Mid-run subprocess failures** (Windows): run.py logs and continues;
  `--resume` recovers. Acceptance gate 1 catches silent turn loss.
- **Scorer divergence** (run.py inline vs score_evidence.py): gate 2 blocks
  any delta claim until resolved.
- **Determinism**: retrieval is local BM25 + local embedder + RRF — no
  network, no LLM; enforced by T2b / success criterion 7 (conversation 1
  run twice, per-QA diff).
- **Result interpretation**: if recall@5 moves sharply vs 0.1727 either way,
  the write-up must distinguish retrieval-stack change from harness artifact
  (e.g. scope filters, salience default) before claiming improvement or
  regression — Honest Reporting rule; the investigation doc's salience
  collapse (0.279→0.020) is the cautionary precedent.

## Out of scope

Retrieval improvements (temporal anchoring, list aggregation — the known
miss patterns), judged-mode reruns, LoCoMo-driven feature gating, changes
to `src/`.
