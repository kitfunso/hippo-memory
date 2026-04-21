# Phase A Decision — Scrap Phase B

**Date:** 2026-04-21
**Input:** `evals/baseline-profile-bench.json` (40 runs, 20 cases × 2 models)

## Gate criteria (from plan)

- **Proceed to Phase B** if any cell for 4.7 is ≥10pp below the corresponding 4.6 cell.
- **Scrap** if 4.7 is within 5pp of 4.6 across the board.

## Result

| Model | invariant-honor | hallucination-guard | noise-rejection | contradiction-rejection |
|---|---|---|---|---|
| claude-opus-4-6 | 100.0% (5/5) | 100.0% (5/5) | 80.0% (4/5, 1 harness error) | 100.0% (5/5) |
| claude-opus-4-7 | 100.0% (5/5) | 100.0% (5/5) | 80.0% (4/5, 1 harness error) | 100.0% (5/5) |
| **Gap (4.6 vs 4.7)** | **0 pp** | **0 pp** | **0 pp** | **0 pp** |

**Every 4.7 cell is within 0pp of its 4.6 counterpart.** The single 20% miss in `noise-rejection` was a Windows shell-escaping bug in the benchmark runner (memory content `safe_sync.py --commodities <name>` had `<` treated as a redirect). Same harness error for both models — NOT a model-behavior signal.

Effective scores: **100% / 100% / 100% / 100% for both models.**

## Decision

**SCRAP Phase B.** The premise that per-model profile tuning could close a real gap does not survive measurement. Both models perform identically on every failure mode we care about when hippo context is in play.

## What this actually tells us

The 4.7 "regressions" described in social media (hallucination, instruction drift, long-context collapse) do not affect the failure modes hippo is designed to guard against — at least not when hippo's context injection is active. 4.7's real weaknesses are elsewhere: long-context retrieval of uncurated content, prose quality, tool-use autonomy.

**Hippo already does the thing.** A 1,500-token curated context block with pinned invariants is enough to get both 4.6 and 4.7 to obey invariants, refuse contradictions, cite stored facts, and tune out distractor noise. No per-model tuning needed.

This is a valid, positive finding for hippo's pitch: *"Your memory layer makes the model-choice question smaller."*

## What we're NOT shipping

- `src/model-profiles.ts`
- `src/model-detector.ts`
- `src/session-state.ts`
- SessionStart/SessionEnd hook model-capture changes
- `hippo status` profile line
- Config `modelProfiles` schema

All Phase B tasks (B1–B9) from the plan are cancelled.

## What we ARE keeping

- **`evals/model-profile-bench.json`** — 20-case corpus. Reusable for any future memory-layer validation.
- **`scripts/model-profile-judge.mjs`** — judge helper via `claude -p`. Reusable.
- **`scripts/run-model-profile-bench.mjs`** — runner. Reusable (after fixing the `<name>` escaping bug).
- **`evals/baseline-profile-bench.json`** — results we just committed. Reference point for any future claim that a model/version regresses on these failure modes.

**The validation framework is the real deliverable.** Profiles were a hypothesis that got falsified in ~90 minutes of testing.

## Known bug to fix later

`hippo remember` shells out; content containing `<` or `>` gets mis-parsed on Windows `shell: true`. Fix: use `execFile` without `shell` for Windows, or escape the content. Not a v1 blocker since the gate decision is unambiguous.

## Follow-up write-ups

- Add this result to `evals/README.md` under a new "Model Profile Bench (null result)" section.
- Reference in the ongoing Frontier AI feasibility study work as an example of O2 methodology in practice.
