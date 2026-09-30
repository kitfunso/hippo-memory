# Z12 supervision burden and memory growth: evaluation draft

**Date:** 2026-09-30

**Status:** DRAFT / NOT REGISTERED / NOT RUN

**Roadmap:** Z12 / Z10 / Z1d / S9, [Parts XVI-XVIII](../../ROADMAP.md)

**Default policy:** No default change.

This is a fresh planning extension. It does not amend [Z0's locked protocol](./2026-09-29-z0-built-in-memory-prereg.md), Z1c or any other registration. No runner, implementation, corpus, intervention policy, sample or acceptance bound is frozen and no scored run has occurred. Prior seen data is development evidence only.

## Questions and proposed endpoints

1. **Supervision benefit:** Does Hippo reduce correction/re-teaching burden beyond built-in memory at preserved task quality and bounded cost?
2. **Growth reliability:** With applicable source evidence fixed, does correct task execution within the interaction/cost budget remain reliable as unrelated histories accumulate?
3. **Human pilot:** Do real users spend less active time supervising comparable work? This requires its own prospective pilot registration; replay/simulated corrections cannot answer it.

Proposed primary confirmatory burden endpoint: mean correction/re-teaching turns per assigned apply task, including unresolved tasks, under a fixed intervention and stopping protocol. Distinguish repeating an established applicable requirement from a new requirement, legitimate clarification and unrelated follow-up. Do not choose between turns, tokens and time after seeing scored data.

Use objective acceptance and lesson checks as quality guardrails. A task with zero corrections because the user gave up is not successful autonomous work. Keep assigned-task completion, unresolved/abandoned tasks, timeouts and intervention-limit events explicit; register censoring and joint burden/quality reporting. Asking the user to repeat an already taught applicable lesson counts as re-teaching. Declare total user-intervention/clarification burden as a guardrail so fewer correction labels cannot hide more user work. Counts from a standardised user driver establish only a proxy under that driver.

The growth endpoint is the share of assigned tasks that satisfy both acceptance and applicable-lesson checks within the registered interaction/time/cost budget at each scale. Report the system-by-scale effect and intervals, not just aggregate recall. Scope any claimed usable-scale boundary to the tested model, runtime, task family, source mix and budget; actual-age/retention claims need longitudinal evidence.

## Proposed arms and conditions

- A: agent built-in memory under frozen shipping settings.
- B: A plus frozen shipping Hippo.
- C: A plus one frozen experimental Hippo component; name the component before registration and keep other settings identical.
- N: memory-off reference with all memory surfaces disabled and isolated.
- O: perfect-memory positive control providing the applicable scoped lesson through a verified delivery route.
- A separately registered matched-channel placebo/ablation may test attribution. Do not silently add it or reuse Z0's IDs with different meanings.

Compare B with A for installation benefit and C with B for a component claim. Preserve mandatory scope/validity admission in every arm. Perfect memory is a feasibility/positive control, not a deployment comparator. A failed positive control makes a null uninterpretable for memory benefit.

Cross the selected system arms with registered growth levels. Give systems the same permitted relevant and distractor source histories; use each system's declared ingestion path rather than assuming equal row counts imply equal evidence access. Freeze relevance labels, noise mix, duplication, language, timestamps, scopes and effective-time changes. The no-memory arm cannot gain access to history through another route. Measure captured evidence as well as final use so ingestion and retrieval failures are distinguishable.

## Sequence and isolation

Teach through ordinary interaction, apply in later sessions, interleave no-match/distractor tasks, reverse a supported fact, interrupt or compact, then resume. Include on-topic wrong/stale/conflicting memories, absent evidence and wrong-project/tenant traps. Any misleading-note construction is fresh and equally scoped across compared systems; it does not amend Z0's deferred misleading-memory arm.

Reset task workspaces identically while carrying only the arm's intended memory. Use separate homes, stores, instruction files, transcripts and caches/derived indexes as applicable; verify both permitted delivery and forbidden access. Record whether project files reveal the lesson without memory. Within matched sequences rotate arm order, pin model/runtime/harness versions and declare sampling settings. Do not switch arms inside one shared live store.

Use fresh repository/lesson sequences and seeds or independent replicates. Model sampling remains stochastic even when settings match. Freeze the entire harness for a memory comparison; a tool/retry/model change is a separate arm or registration.

## Diagnostic measurements

| Stage or quantity | Numerator and denominator / reporting rule |
|---|---|
| Capture | Correct durable lessons saved within the registered delay / eligible labelled lessons; write precision separately. |
| Retrieval/delivery | Useful evidence confirmed available / relevant opportunities; new blocks and valid unchanged-block reuse separately. |
| Bad-memory delivery | Unsupported or invalid claims presented as applicable instructions / all delivered claims; also harmful-delivery turns / eligible turns, by category. |
| Bad-memory use | Check/action evidence of following a labelled bad claim / all eligible bad-memory task opportunities; observed/judged/unknown and coverage reported separately. Do not treat unknowns as correct use. |
| Abstention | False-confident use on unsupported/conflicting cases and needless abstention on answerable cases, with useful coverage. Admission abstention, refusal and clarification are distinct. |
| Human burden proxy | Correction/re-teaching turns and explanation tokens / all assigned apply tasks; counts of new requirements, clarifications, abandonment and failures separately. |
| Real human effort | Prospectively measured active supervision time in a separately registered pilot, with measurement coverage; no inference from time between prompts or replay counts. |
| Efficiency | Priced input cache reads/writes or misses where exposed, uncached input, output, extraction, embedding, maintenance and retries; total cost and time-to-first-token/end-to-end latency distributions. |
| Growth | Source history/item/token counts and captured relevant evidence at each level; budget-compliant task reliability and tail memory-call burden. |

Register a rubric for assertion, scope, effective time and epistemic status: explicitly uncertain evidence and requested historical versions are not bad delivery merely because they conflict with a current fact. Register capture/maintenance measurement horizons and cost amortisation across assigned tasks; background processing cannot disappear from the total.

Use existing Z10 correlation and immutable permitted source snapshots; raw trajectories are evidence, not automatic recall units. Missing/redacted events remain unknown. Source-presence, delivered context and outcome correlation do not establish causal use. Independent blinded labels or objective checks calibrate the judge; report agreement and label coverage.

## Acceptance and analysis to freeze

- Choose one primary supervision benefit and a minimum useful effect; specify the estimand, paired analysis and multiplicity for any confirmatory growth contrasts before scoring.
- Require explicit task-quality and total user-intervention non-inferiority, plus no-lesson cost/latency harm bounds. A non-significant quality difference is not a non-inferiority pass. Freeze margins, intervals and sample/power rules on development data; retain existing applicable H4 requirements.
- An always-empty, always-refusing or prematurely stopped arm cannot pass without useful coverage, quality and completion guardrails.
- Cluster by independent repository/lesson sequence, preserving shared-store dependence and repeated tasks/replicates. Register analysis of the system-by-scale interaction and any scale selection; no per-prompt pseudo-replication.
- A live pilot randomises independent projects or teams with separate memory/access boundaries. Shared users, repositories or team stores are spillover risks to settle before allocation; questionnaires supplement behavioural outcomes.
- Any default promotion still needs the governing Z0 benefit/validity/harm gates and applicable store/ranker recall floor. Z12 alone does not promote defaults or weaken a locked gate.

## Required decisions before registration

- [ ] Primary endpoint, meaningful effect, task-quality/completion and harm margins, growth levels and family-specific gates.
- [ ] Baseline/component/model/runtime/harness hashes, memory flags, budgets, cache/provider conditions and pricing date.
- [ ] Task and source eligibility, fixed intervention policy, prompt categories, user-driver behaviour, stopping/abandonment/censoring rules.
- [ ] Development calibration and fresh held-out task families; corpus snapshots outside the repo for host transcripts, SHA-256, scope/access, redaction and retention.
- [ ] Paired/clustered design, sample and power, replicates, intervals, multiplicity, positive-control validity and blind-analysis rules.
- [ ] Distractor construction, equal permitted evidence access, supported capture/delivery checks and no-leak/no-contamination fixtures.
- [ ] Objective task/lesson check inventory, independent label agreement, uncertain-use handling and latency-tail quantiles.
- [ ] Separate prospective human-pilot allocation and active-time instrumentation if a human-time claim is intended.
- [ ] Exact commands, result paths and resource/plan/provider authorisation before any run. No runner or research spend is authorised by this draft.

## Reporting

Publish all arms and scale levels, locked hashes, event/label coverage, exclusions, failures, abandonment, cost breakdowns, uncertainty and deviations. Report win, loss, tie, inconclusive or invalid under the frozen rules. Keep adverse results and ceiling effects; do not convert QA/retrieval scores, simulator corrections or satisfied users into measured human-time savings.

**No default change.** This draft changes no hooks, extraction, embedders, feedback, retention, permissions or runtime behaviour, and implies no completed evaluation.
