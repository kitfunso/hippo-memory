# Z1d scoped trigger and admission gate: evaluation draft

**Date:** 2026-09-30  
**Status:** DRAFT / NOT REGISTERED / NOT RUN  
**Roadmap:** Z1d, [Parts XVI-XVIII](../../ROADMAP.md)  
**Default policy:** No default change.

This is a planning draft. No corpus or implementation is frozen, no scored data is collected under this draft, and no result is claimed. Prior result documents have been read; their seen splits are development evidence, not independent confirmation. Resolve every item below and commit a locked registration before a scored run. This file does not amend an existing locked preregistration.

## Hypothesis

Scoped conversational intent and path/error/test/command triggers with a relevance gate reduce repeated mistakes relative to the current pinned + newest 5 hook, while preserving no-lesson task quality and overhead.

## Proposed arms

- A: built-in memory plus Hippo with the current hook.
- B: the same setup with the preregistered trigger-and-gate arm.
- C: a matched no-relevance/placebo arm for admission/judge validity; define construction before freeze.

## Primary metric and gates

Primary confirmatory metric: Z0 H1 repeat-mistake rate on fresh lesson families. Useful delivered coverage, irrelevant injection, judged applicability, tokens and latency are diagnostic or declared gates, not substitutes for task success.

**Z0 family.** Use the applicable task/validity family from the current Z0 design or a fresh runtime/family extension registered before scoring. G1-G5 and H4 must explicitly pass before efficacy/default claims. A delivery or instrumentation fixture pass establishes mechanics only.

**Task/default gate.** [Z0](./2026-09-29-z0-built-in-memory-prereg.md) remains the task proof. Name the primary benefit and minimum useful effect before freeze. Promotion requires a valid win meeting that effect and explicit H4 pass, while preserving task quality and the recall floor where applicable. H4 retains the upper 95% cost-ratio bound below 1.10 and lower 95% resolve-rate-difference bound above -5 points. Cost per resolved task is secondary unless a new registration declares it primary.

## Controls and failure cases

- Use Z10 delivery evidence, relevant/no-match/wrong-project cases, pins retained and identical budgets.
- Include conversational task intent and indirect references without a path/error/test name. Freeze current-prompt, recent-context and task-state query construction, source access and bounds. A technical trigger is an additional route, not a prerequisite for all useful memory.
- Keep the 2026-09-26 promptRecall arm off; do not inspect or alter Z1c's locked held-out window.
- Declare the trigger match, gate, abstention rule, denominator and judge protocol before freeze. Do not transfer Z1c's 0.15 helpfulness threshold to a different metric.
- Distinguish no-memory admission from agent uncertainty/clarification. Label missing evidence, conflicts, stale/wrong claims and wrong-project matches; measure false-confident memory use and needless abstention at useful coverage. An always-empty or always-refusing arm cannot pass.
- Report new injection events, valid reused context and user correction/re-teaching separately. Fewer blocks or input tokens are not a benefit unless task quality and applicable-memory coverage hold; use the fresh Z12 registration for a supervision claim.

## Required decisions before registration

- [ ] Fresh teach/apply families, corpus snapshots and independence from all prior seen splits.
- [ ] Trigger definitions, threshold calibration on development data, smallest useful H1 effect and false-injection bound.
- [ ] Task-family sample/power rule, paired analysis, multiplicity and stopping rule; explicit H4 pass.
- [ ] Baseline/treatment commit hashes, feature flags, runtime/model versions and configuration.
- [ ] Corpus snapshot location outside the repo where host transcripts are used; SHA-256, eligibility dates, exclusions and the development/held-out split. Copy it at registration; live host paths are not a reproducible corpus.
- [ ] Unit of analysis, paired design, minimum sample and power/calibration rule. Cluster repeated events by task/lesson family and session as appropriate; no per-turn pseudo-replication.
- [ ] Acceptance/equivalence/harm margins, interval method, multiplicity, scoring rubric and independent label agreement where a judge is used.
- [ ] Count-only readiness checks, stopping rule, failure/retry policy and blind-analysis procedure. Retire inspected held-out data; a new look needs the registered sequential rule or a committed amendment and fresh data.
- [ ] Exact runner command, environment isolation, result path, data retention and authorized plan/provider usage. No runner or resource spend is authorized by this draft.

## Reporting

Publish the locked hashes, all arms, counts/exclusions, uncertainty, guardrails, deviations and the applicable verdict: win, loss, tie, inconclusive or invalid. A validity failure is invalid, not a tie. Engineering checks publish pass/fail within their declared scope. Keep adverse results and do not convert a retrieval/delivery gain into a task-benefit claim.

**No default change.** A registration, fixture pass or ranker win alone does not change hook injection, extraction, embedders, outcome writes or live-store lifecycle settings.
