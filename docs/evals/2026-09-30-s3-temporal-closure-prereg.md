# S3 closure and temporal history: evaluation draft

**Date:** 2026-09-30  
**Status:** DRAFT / NOT REGISTERED / NOT RUN  
**Roadmap:** S3, [Parts XVI-XVIII](../../ROADMAP.md)  
**Default policy:** No default change.

This is a planning draft. No corpus or implementation is frozen, no scored data is collected under this draft, and no result is claimed. Prior result documents have been read; their seen splits are development evidence, not independent confirmation. Resolve every item below and commit a locked registration before a scored run. This file does not amend an existing locked preregistration.

## Hypothesis

Evidence-based reversible closure preserves current recall and historical recoverability without leaking later knowledge into an earlier recorded-time view.

## Proposed arms

- A: current valid_from/successor and public --as-of behaviour.
- B: explicit closure contract using the existing store and preserving public --as-of semantics.
- C: optional recorded-time view, only if separately specified and frozen; do not label B bitemporal without both time axes.

## Primary metric and gates

Primary integrity metric: correctness against a timestamped oracle for current and historical fact selection. Current-fact/stale intrusion and the retrieval floor guard the release; automatic-correction task benefit belongs to Z3b.

**Recall-script floor.** Before distributing a store/ranker/hygiene flag, run the existing LongMemEval scripts and actual `hippo recall` evaluation at their frozen original budgets/settings. The paired R@5 point difference must be at least -1 percentage point against the frozen shipping baseline. Report uncertainty and counts; this fixed-corpus check is not a population non-inferiority claim. Freeze corpus, scorer, candidate limits, embedder, tokenizer and baseline commit. Returning all candidates is a ranking diagnostic, not the budgeted result.

**Task/default gate.** [Z0](./2026-09-29-z0-built-in-memory-prereg.md) remains the task proof. Name the primary benefit and minimum useful effect before freeze. Promotion requires a valid win meeting that effect and explicit H4 pass, while preserving task quality and the recall floor where applicable. H4 retains the upper 95% cost-ratio bound below 1.10 and lower 95% resolve-rate-difference bound above -5 points. Cost per resolved task is secondary unless a new registration declares it primary.

## Controls and failure cases

- Distinguish when a fact applied from when it was recorded or corrected; test late/backdated facts.
- Include chains, gaps, reversals, duplicate events, conditional branch facts and separate scopes.
- Closure and successor writes are atomic and reversible; legacy CLI/API meanings and evidence links survive.
- No age-only archival or loss of memories that back an object in this experiment. (Compaction items were protected when this draft was written; since 1.53.1 they fade like any memory.)

## Required decisions before registration

- [ ] Exact effective-time and recorded-time semantics, boundary conventions and legacy expectations.
- [ ] Oracle fixtures, eligible closure evidence, rollback and migration plan if fields change.
- [ ] Integrity acceptance bounds, corpus/sample definition, retrieval comparison and failure reporting.
- [ ] Baseline/treatment commit hashes, feature flags, runtime/model versions and configuration.
- [ ] Corpus snapshot location outside the repo where host transcripts are used; SHA-256, eligibility dates, exclusions and the development/held-out split. Copy it at registration; live host paths are not a reproducible corpus.
- [ ] Unit of analysis, paired design, minimum sample and power/calibration rule. Cluster repeated events by task/lesson family and session as appropriate; no per-turn pseudo-replication.
- [ ] Acceptance/equivalence/harm margins, interval method, multiplicity, scoring rubric and independent label agreement where a judge is used.
- [ ] Count-only readiness checks, stopping rule, failure/retry policy and blind-analysis procedure. Retire inspected held-out data; a new look needs the registered sequential rule or a committed amendment and fresh data.
- [ ] Exact runner command, environment isolation, result path, data retention and authorized plan/provider usage. No runner or resource spend is authorized by this draft.

## Reporting

Publish the locked hashes, all arms, counts/exclusions, uncertainty, guardrails, deviations and the applicable verdict: win, loss, tie, inconclusive or invalid. A validity failure is invalid, not a tie. Engineering checks publish pass/fail within their declared scope. Keep adverse results and do not convert a retrieval/delivery gain into a task-benefit claim.

**No default change.** A registration, fixture pass or ranker win alone does not change hook injection, extraction, embedders, outcome writes or live-store lifecycle settings.
