# Z10 delivery ledger: evaluation draft

**Date:** 2026-09-30  
**Status:** DRAFT / NOT REGISTERED / NOT RUN  
**Roadmap:** Z10 / S7, [Parts XVI-XVIII](../../ROADMAP.md)  
**Default policy:** No default change.

This is a planning draft. No corpus or implementation is frozen, no scored data is collected under this draft, and no result is claimed. Prior result documents have been read; their seen splits are development evidence, not independent confirmation. Resolve every item below and commit a locked registration before a scored run. This file does not amend an existing locked preregistration.

## Hypothesis

Extending the existing recall traces makes delivery and failure stages reconstructable without changing memory selection or task behaviour.

## Proposed arms

- A: current trace implementation.
- B: extended trace implementation with identical store, ranking, admission and rendered context.

## Primary metric and gates

Primary engineering metric: fraction of known fixture events reconstructed with the correct store, turn, IDs and stage. Task checks use the Z0 family for decision invariance and H4 overhead; no efficacy claim from trace completeness.

**Z0 family.** Use the applicable task/validity family from the current Z0 design or a fresh runtime/family extension registered before scoring. G1-G5 and H4 must explicitly pass before efficacy/default claims. A delivery or instrumentation fixture pass establishes mechanics only.

**Task/default gate.** [Z0](./2026-09-29-z0-built-in-memory-prereg.md) remains the task proof. Name the primary benefit and minimum useful effect before freeze. Promotion requires a valid win meeting that effect and explicit H4 pass, while preserving task quality and the recall floor where applicable. H4 retains the upper 95% cost-ratio bound below 1.10 and lower 95% resolve-rate-difference bound above -5 points. Cost per resolved task is secondary unless a new registration declares it primary.

## Slice 1: engineering scope (settled)

This section settles the engineering part of the per-prompt hook path only. The task-level part above stays DRAFT / NOT REGISTERED.

- **Fixture inventory.** F1 budget rejection and injected tokens; F2 gate rejection with scores and the 16-row rejected cap; F3 unchanged-block reuse; F4 duplicate events (Claude payload repeat, Codex `turn_id`); F5 concurrent sessions; F6 missing and sub-agent sessions; F7 fail-soft (rollback, busy lock, recorder fault, render throw); F8 flag off writes nothing; F9 byte-identical stdout on vs off; F10 no raw text. Event fields are the schema v50 `delivery_events` and `delivery_candidates` columns.
- **Runtime matrix.** Claude Code and Codex payload shapes as fixtures; live host versions are recorded at registration.
- **Decision invariance.** Zero tolerance: selected ids, `ContextResult` and stdout are byte-identical with the ledger off and on.
- **Trace completeness.** 100% of fixture events reconstructed with the correct store, session, turn, ids and stage.
- **Overhead bounds.** Stdout identical in 100% of turns and injected-token delta exactly 0; `p95_on/p95_off <= 1.10` in every arm and mode (H4's ratio borrowed as a latency proxy, not H4 itself); `p50_on - p50_off <= 15 ms`; mean bytes per turn <= 7168.
- **Arms.** The same binary with `deliveryLedger.enabled` off vs on, each crossed with `pinnedInject.promptRecall` off and on.
- **Runner.** `npm run build && npm run test:delivery-ledger && node scripts/hook-latency.mjs --ledger-compare --memories 2000 --runs 30`. Result in the PR body plus `docs/evals/2026-10-03-z10-ledger-slice1-result.md`.
- **Open.** Z0/H4 sample, corpus snapshot, unit of analysis and power, margins and multiplicity, readiness and stopping, the transcript join, application labels, compaction, resume, session-end and tool-failure events, and Z12 links.

## Controls and failure cases

- Fixture oracle includes rejected candidates, emitted-but-undelivered context, unknown application, concurrent turns, compaction, missing hooks and duplicate events.
- Freeze stage-specific denominators for capture, budgeted evidence, context availability and application. Include unchanged-block reuse and compaction resets; a new emission is not required when valid context persists. Do not infer truth or missed host events from the ledger alone; use known fixtures or independent labels.
- Link receipt/progress states to supported S6 recovery. Test pending/skipped/unavailable input and interruption before a write or progress commit.
- Compare selected IDs and rendered text byte-for-byte; logging failure is fail-soft and cannot alter selection.
- Application labels require an observation or registered judge; causal use remains unknown without supporting evidence.
- Correlate observable user/tool events, memory mutations, compaction/resume and check outcomes without assuming private model reasoning. Evaluation source snapshots require explicit authorised access, redaction/retention rules, outside-repo hashes and references. Missing/redacted events are gaps, not successful capture; raw trajectories never become automatic recall units.
- Label user correction, repeated explanation, legitimate new requirement, voluntary clarification, automatic injection and valid unchanged context separately. Replay correction counts cannot establish active human supervision time. Record bad-memory delivery separately from observed/judged/unknown downstream use.
- Link Z12 scale level, source-history identity and pre/post-store snapshots so a growth result can be attributed to its registered condition, not merely to row count.

## Required decisions before registration

- [ ] Fixture inventory, expected event fields and runtime/version matrix. Engineering part settled in slice 1; task part open.
- [ ] Decision-invariance and trace-completeness acceptance bounds; per-event latency and token overhead bounds. Engineering part settled in slice 1; task part open.
- [ ] Independent Z0/H4 sample or designated validity-fixture subset; measurement method and confidence intervals.
- [ ] Baseline/treatment commit hashes, feature flags, runtime/model versions and configuration. Engineering part settled in slice 1; task part open.
- [ ] Corpus snapshot location outside the repo where host transcripts are used; SHA-256, eligibility dates, exclusions and the development/held-out split. Copy it at registration; live host paths are not a reproducible corpus.
- [ ] Unit of analysis, paired design, minimum sample and power/calibration rule. Cluster repeated events by task/lesson family and session as appropriate; no per-turn pseudo-replication.
- [ ] Acceptance/equivalence/harm margins, interval method, multiplicity, scoring rubric and independent label agreement where a judge is used.
- [ ] Count-only readiness checks, stopping rule, failure/retry policy and blind-analysis procedure. Retire inspected held-out data; a new look needs the registered sequential rule or a committed amendment and fresh data.
- [ ] Exact runner command, environment isolation, result path, data retention and authorized plan/provider usage. No runner or resource spend is authorized by this draft.

## Reporting

Publish the locked hashes, all arms, counts/exclusions, uncertainty, guardrails, deviations and the applicable verdict: win, loss, tie, inconclusive or invalid. A validity failure is invalid, not a tie. Engineering checks publish pass/fail within their declared scope. Keep adverse results and do not convert a retrieval/delivery gain into a task-benefit claim.

**No default change.** A registration, fixture pass or ranker win alone does not change hook injection, extraction, embedders, outcome writes or live-store lifecycle settings.
