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
- **Amendment 1 (2026-10-03, before the scored run).** The two latency bounds above are replaced; stdout, token and bytes bounds stay as written. Reason: an A/A run of `hook-latency.mjs` with the ledger off in both arms broke both latency bounds (p95 ratio up to 1.23, p50 delta +44.3 ms), so whole-process wall clock cannot decide them ([result](./2026-10-03-z10-ledger-slice1-result.md)). New bounds: the ledger's own time per turn, measured inside one process by `node scripts/ledger-overhead.mjs --memories 2000 --runs 200` (recorder creation, time inside observer calls net of the admit they wrap, `delivered`, and the event write on the token ledger's handle after its inject row), has p50 <= 15 ms (the old p50 bound) and p95 <= 30 ms (10% of the lowest ledger-off p95 measured on the quiet machine, 309 ms) in the fresh and steady modes for both promptRecall settings. Contention cells and dropped events are reported, not bounded. Smoke runs at 50 memories and 3 turns checked the script before this amendment; no 2000-memory run of it preceded the amendment.
- **Open.** Z0/H4 sample, corpus snapshot, unit of analysis and power, margins and multiplicity, readiness and stopping, the transcript join, application labels, session-end and tool-failure events, and Z12 links.

## Slice 2a: engineering scope (settled)

This section settles the engineering part of the two compaction hooks only: `hippo pre-compact` and `hippo compact-resume`. The task-level part above stays DRAFT / NOT REGISTERED. Slice 2a changes no schema and no hook output.

- **What each hook records.** Each accepted call writes one boundary row in `delivery_events`, with surface `hook`, no prompt hash, no candidate rows and every candidate count 0. `emitted_hash` and `injected_tokens` are set only in state `sent`. A boundary row is any row whose `event_type` is `pre-compact` or `compact-resume`.
- **pre-compact state.** The row is `sent` when the hook printed the summariser instruction, which needs the Claude Code runtime, a payload that is not a VS Code chat and a non-empty session id. Every other accepted call records `empty`, including every Copilot call. The row is written right after the instruction, before the snapshot work. The four silent early returns write no row: store not initialised, payload not received, VS Code payload handled by `hippo.json`, and the Copilot twin skip.
- **compact-resume state.** A call is a boundary when it is a manual run (no stdin, no timeout) or when the payload says `source: compact`. A timed-out empty read, malformed stdin and any other `source` write no row, so an older Claude Code that runs the hook on every session start leaves none. The row is `sent` when the snapshot text printed, `disabled` in a holdout session, and `empty` otherwise (no fresh snapshot, another session's snapshot, a caught store error).
- **Row version 2.** `ledger_version` 2 means a binary that can write boundary rows wrote the row, and `event_type` has four values. A version 1 reader that assumes two values would misread it. Version 2 does not mean "no boundary row, so no compaction": a missing row is a gap. Every row the new binary writes carries 2, prompt rows included. The legacy literal 1 stays valid.
- **One duplicate rule.** For both boundary types, an event matches an earlier numbered row of the same tenant, session and event type whose `ts` lies within 2000 ms. The rule ignores the host turn id and the prompt hash, so a second compaction inside one host turn is numbered. A match sets `duplicate_of` and leaves `turn_seq` null. The two prompt types keep their slice 1 rules.
- **Why 2000 ms is enough.** Hooks fire twice when they sit in both user and project settings. The two fires can differ by about one second, because `compact-resume` first runs the injection reset, which can wait up to 1000 ms (`HOOK_DB_WAIT_MS`) on a locked store. Two real compactions of one session cannot start within two seconds.
- **Numbering.** `turn_seq` counts per event type. A manual run with a session id from the environment is numbered, though no compaction happened. So "number N is the Nth compaction" holds only for rows with `session_state` `payload`. Rows with `env` or `missing` do not support it.
- **Sub-agents.** A sub-agent payload on `compact-resume` records `empty`, also in a holdout session, because the sub-agent check comes first and the holdout check is never reached. The prompt hook records `disabled` for the same case. The row's `session_state` `subagent` tells a reader which case it is. Neither hook numbers or de-duplicates a `subagent` row.
- **Per runtime.** "Unavailable" means no row can exist. A reader must not read its absence as "no compaction".

  | Runtime | `pre-compact` | `compact-resume` |
  |---|---|---|
  | Claude Code | recorded; `sent` with the instruction | recorded |
  | Codex | unavailable: no hook installed | recorded; runtime reads `claude-code` unless the payload has a turn id |
  | Copilot CLI, VS Code with `hippo.json` | recorded, runtime `copilot`, always `empty` | unavailable: no hook installed |
  | VS Code running Claude Code hooks, no `hippo.json` | recorded, runtime `claude-code`, state `empty` | unavailable |
  | OpenCode | unavailable | unavailable |
  | Remote-caller copies (`preCompactForCaller`, `compactResumeForCaller`) | unavailable: write no row | unavailable: write no row |

- **Loss windows.** (1) The host kills the hook between the print and the write: the row is lost, and the `token_ledger` reset row, written earlier, still stands. (2) The store stays locked past the 50 ms wait: the row is dropped with one `[hippo] delivery ledger write failed` stderr line. (3) A throw in the recorder or the `pre-compact` callback is caught, and stdout, saved rows and exit code do not change. (4) `process.exit(0)` before the write is closed, because a flush precedes every exit on a boundary path. One case remains: a throw before the callback on an accepted path (`snapshotJustSaved` reads the store at `src/capture/compact.ts:112`) lands in the `cmdPreCompact` catch and exits with no row. A missing row is never evidence that no compaction happened.
- **Accepted gap.** The Copilot CLI may run `preCompact` and `PreCompact` in turn. The second normally skips on the twin check and writes no row. If the first saved no snapshot and the gap exceeds two seconds, two numbered `pre-compact` rows result. A reader counting compactions on Copilot is affected; a reader treating a row as "the context was reset at or before here" is not. A loaded machine can also put two fires of any twice-registered hook more than 2 s apart, so they get two numbers.
- **Cost.** `pre-compact` writes once per compaction on the request handle after the instruction is out, against a 30 s hook limit. `compact-resume` writes a `sent` row on the token ledger's open handle. An `empty` or `disabled` row reuses the hook scope's handle, so the open count is the same with the ledger on and off on the common path. An extra open happens only when nothing opened the store earlier, such as a sub-agent payload. The limit is 10 s. Slice 2a sets no latency bound. The result document reports measured on/off medians.
- **Out of slice 2a.** A `session-end` event (a detached worker with a different failure shape); filling `recall_trace_id` and `query_hash`; tool-failure events and the other context paths; a `--runtime codex` flag. The Codex runtime label gap stays: the installed hook carries no runtime flag, and Codex asks for trust again on any changed hook entry.
- **Runner.** `npm run build && npm run test:delivery-ledger`, plus the built CLI driven through one session by hand. Result in `docs/evals/2026-10-08-z10-ledger-slice2a-result.md`.

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
