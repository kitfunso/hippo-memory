# S0 compact retrieval units: evaluation draft

**Date:** 2026-09-30  
**Status:** DRAFT / NOT REGISTERED / NOT RUN  
**Roadmap:** S0 / S9, [Parts XVI-XVIII](../../ROADMAP.md)  
**Default policy:** No default change.

This is a planning draft. No corpus or implementation is frozen, no scored data is collected under this draft, and no result is claimed. Prior result documents have been read; their seen splits are development evidence, not independent confirmation. Resolve every item below and commit a locked registration before a scored run. This file does not amend an existing locked preregistration.

## Hypothesis

Structured compact claims preserve more useful evidence within a fixed context budget than existing rows, beyond the gain from simple sentence/turn chunking.

## Proposed arms

- A: existing memory units and packing.
- B: deterministic sentence/turn chunks from the same allowed source evidence.
- C: structured claims on the existing store, carrying assertion, reason, conditions, scope and provenance; ranking fixed.

## Primary metric and gates

Primary representation metric: paired complete-evidence coverage within the frozen token budget. Existing exact-source R@5 remains the release floor; source IDs alone do not prove a claim retained the answer.

**Recall-script floor.** Before distributing a store/ranker/hygiene flag, run the existing LongMemEval scripts and actual `hippo recall` evaluation at their frozen original budgets/settings. The paired R@5 point difference must be at least -1 percentage point against the frozen shipping baseline. Report uncertainty and counts; this fixed-corpus check is not a population non-inferiority claim. Freeze corpus, scorer, candidate limits, embedder, tokenizer and baseline commit. Returning all candidates is a ranking diagnostic, not the budgeted result.

**Task/default gate.** [Z0](./2026-09-29-z0-built-in-memory-prereg.md) remains the task proof. Name the primary benefit and minimum useful effect before freeze. Promotion requires a valid win meeting that effect and explicit H4 pass, while preserving task quality and the recall floor where applicable. H4 retains the upper 95% cost-ratio bound below 1.10 and lower 95% resolve-rate-difference bound above -5 points. Cost per resolved task is secondary unless a new registration declares it primary.

## Controls and failure cases

- Use identical source access, ranking, query set and budgets; freeze render overhead and tokenizer.
- Gold source spans must be present in the returned text. Do not inherit credit for all evidence in a parent session.
- Exercise actual new-unit writes, not only readable legacy rows. Test short rules, exceptions, multi-evidence questions, false extraction, pins, closed rows, no-match and isolation.
- A 40-120-token target never pads a short rule or truncates an applicability condition.

## Required decisions before registration

- [ ] Gold evidence spans and annotation rubric; independent labelling and acceptable agreement.
- [ ] Claim/chunk construction, overlength policy, writing/extraction costs and separate CLI/hook budgets.
- [ ] Sample rule, paired interval, completeness margin, per-category guardrails and representation-only freeze.
- [ ] Baseline/treatment commit hashes, feature flags, runtime/model versions and configuration.
- [ ] Corpus snapshot location outside the repo where host transcripts are used; SHA-256, eligibility dates, exclusions and the development/held-out split. Copy it at registration; live host paths are not a reproducible corpus.
- [ ] Unit of analysis, paired design, minimum sample and power/calibration rule. Cluster repeated events by task/lesson family and session as appropriate; no per-turn pseudo-replication.
- [ ] Acceptance/equivalence/harm margins, interval method, multiplicity, scoring rubric and independent label agreement where a judge is used.
- [ ] Count-only readiness checks, stopping rule, failure/retry policy and blind-analysis procedure. Retire inspected held-out data; a new look needs the registered sequential rule or a committed amendment and fresh data.
- [ ] Exact runner command, environment isolation, result path, data retention and authorized plan/provider usage. No runner or resource spend is authorized by this draft.

## Reporting

Publish the locked hashes, all arms, counts/exclusions, uncertainty, guardrails, deviations and the applicable verdict: win, loss, tie, inconclusive or invalid. A validity failure is invalid, not a tie. Engineering checks publish pass/fail within their declared scope. Keep adverse results and do not convert a retrieval/delivery gain into a task-benefit claim.

**No default change.** A registration, fixture pass or ranker win alone does not change hook injection, extraction, embedders, outcome writes or live-store lifecycle settings.
