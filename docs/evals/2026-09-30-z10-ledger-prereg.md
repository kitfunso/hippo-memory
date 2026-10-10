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

- **Loss windows.** (1) The host kills the hook between the print and the write: the row is lost, and the `token_ledger` reset row, written earlier, still stands. (2) The store stays locked past the 50 ms wait: the row is dropped with one `[hippo] delivery ledger write failed` stderr line. (3) A throw in the recorder or the `pre-compact` callback is caught, and stdout, saved rows and exit code do not change. (4) `process.exit(0)` before the write is closed, because a flush precedes every exit on a boundary path. One case remains: a throw before the callback on an accepted path (`snapshotJustSaved` reads the store at `src/capture/compact.ts:111`) lands in the `cmdPreCompact` catch and exits with no row. A missing row is never evidence that no compaction happened.
- **Accepted gap.** The Copilot CLI may run `preCompact` and `PreCompact` in turn. The second normally skips on the twin check and writes no row. If the first saved no snapshot and the gap exceeds two seconds, two numbered `pre-compact` rows result. A reader counting compactions on Copilot is affected; a reader treating a row as "the context was reset at or before here" is not. A loaded machine can also put two fires of any twice-registered hook more than 2 s apart, so they get two numbers.
- **Cost.** `pre-compact` writes once per compaction on the request handle after the instruction is out, against a 30 s hook limit. `compact-resume` writes a `sent` row on the token ledger's open handle. An `empty` or `disabled` row reuses the hook scope's handle, so the open count is the same with the ledger on and off on the common path. An extra open happens only when nothing opened the store earlier, such as a sub-agent payload. The limit is 10 s. Slice 2a sets no latency bound. The result document reports measured on/off medians.
- **Out of slice 2a.** A `session-end` event (a detached worker with a different failure shape); filling `recall_trace_id` and `query_hash`; tool-failure events and the other context paths; a `--runtime codex` flag. The Codex runtime label gap stays: the installed hook carries no runtime flag, and Codex asks for trust again on any changed hook entry.
- **Runner.** `npm run build && npm run test:delivery-ledger`, plus the built CLI driven through one session by hand. Result in `docs/evals/2026-10-08-z10-ledger-slice2a-result.md`.

## Slice 2b: engineering scope (settled)

This section settles the engineering part of two more calls: the SessionEnd hook (`hippo session-end`) and `hippo context` run without `--pinned-only`. The task-level part above stays DRAFT / NOT REGISTERED. Slice 2b changes no schema, no hook output and no command output.

- **session-end row.** `hippo session-end` writes one boundary row: event type `session-end`, surface `hook`, state `empty`, no prompt facts, no candidate rows, every count 0. It writes the row only for a host payload that `readSessionEnd` accepts as `received` and not `manual`. The hook sends nothing into the model's context, so the row marks where the session ended in the ledger's id order; it is not a delivery. A manual run (empty stdin), a timed-out read, a malformed payload and every `--turn` call write no row. A `--turn` call (VS Code Stop, the Copilot CLI's `agentStop`) ends a reply, not the session.
- **session-end order.** The recorder starts as soon as the payload is read, so two fires of one hook carry close timestamps. The row is written after the detached worker is spawned, or after the inline fallback returns, so a locked store never delays the worker. If the host kills the hook between the spawn and the write, the worker still runs and only the row is lost.
- **session-end duplicates.** `session-end` joins the boundary duplicate rule: an earlier numbered row of the same tenant, session and event type within 2000 ms. A host fires SessionEnd once per session run, so two fires inside two seconds are one hook registered twice. A resumed session keeps its id, so a session that ends, resumes and ends again has two numbered `session-end` rows, 1 and 2. A reader counting sessions counts distinct session ids, never `session-end` rows.
- **context row.** `hippo context` without `--pinned-only` writes one row with event type `context` and surface `context`, behind the same `deliveryLedger.enabled` flag. This is the call the instruction block tells an agent to run (`hippo context --auto`), and its stdout reaches the agent as a tool result. The state is `sent` when stdout carried a block, `empty` when it carried nothing, and `disabled` in a holdout session or at a zero budget. A call that stops before it renders, such as a folder with no store, writes no row.
- **Trace link.** On a `context` row, `query_hash` equals the `recall_traces.query_hash` of the query the call ran (the same function: sha256, first 16 hex digits), and `recall_trace_id` is the id of the trace that same call wrote. Both are set when the call returned rows; the trace id comes back from the write that also saves the last recall (`SqliteLocal.finishLastRecall`). A call that returned nothing has `query_hash` set and `recall_trace_id` null. It still writes an empty trace when it loaded something to rank, and a reader joins that trace by query hash, session and time. The empty trace goes through the store port, whose `finishRecall` answers no id, and changing the port is out of this slice. An empty trace holds no result rows, so the id would add little. A store with nothing to load and no task sections returns before any trace is written (the early return in `getContext`, `src/api/context.ts`). A failed trace write also leaves `recall_trace_id` null. So does a call on a served store other than SQLite (`ctx.store`), whose stand-in answers no id; no call that writes a ledger row runs on a served store today. Pinned-only rows and boundary rows keep both null: the per-prompt hook is read-only and writes no trace (`src/api/context.ts`), so there is nothing to link.
- **Candidates on a context row.** Search and strength ranking report no rejected candidates in this slice. A `context` row lists its returned rows, with pool `search` for a query and `strength` for no query (`*`), and its limit and duplicate cuts. A reader cannot tell a memory that was never retrieved from one the budget rejected on this surface; the trace's result rows hold the same returned set.
- **Numbering.** `turn_seq` counts per event type, as before. An agent's `hippo context` run inside Claude Code takes its session id from the environment (`session_state` `env`), so its rows count that session's context pulls. A sub-agent inherits the parent's environment, so its `hippo context` runs count in the parent session's numbers. With no session id the row is `missing` and unnumbered, and is never a duplicate. A `context` row keeps no prompt hash, so it matches an earlier `context` row only on a host turn id, which only a hook payload carries (a Codex turn id). An agent's run reads no payload, so its row is never a duplicate.
- **Runtime.** A `context` row with no hook payload reads `unknown`, since the call cannot tell which host ran it. A `session-end` row reads `copilot` under `--runtime copilot` and `claude-code` from a Claude Code payload.
- **Row version 3.** `ledger_version` 3 means a binary that can write `session-end` and `context` rows wrote the row, so `event_type` has six values and `surface` can be `context`. Slice 1 declared the `context` surface (`DeliverySurface` in `src/store/delivery-recorder.ts`) but wrote `hook` on every row, so the new event types are the reason for the bump. A version 2 reader that assumes four event types or a `hook` surface would misread a version 3 store. Every row the new binary writes carries 3, earlier types included; 1 and 2 stay valid.
- **Per runtime.** "Unavailable" means no row can exist. A reader must not read its absence as "no session end" or "no context call".

  | Runtime | `session-end` | `context` |
  |---|---|---|
  | Claude Code | recorded, always `empty` | recorded; runtime `unknown` when run without a payload |
  | Copilot CLI `sessionEnd` | recorded, runtime `copilot` | as Claude Code |
  | VS Code Stop, Copilot CLI `agentStop` (`--turn`) | unavailable: a reply ended, not the session | n/a |
  | Codex | unavailable: its session end runs in the Codex wrapper | as Claude Code |
  | OpenCode | unavailable: `session.idle` runs `hippo session-end` with no payload, a manual run | as Claude Code |
  | MCP `hippo_context`, HTTP `/v1/context` | n/a | unavailable: server surfaces write no row |

- **Loss windows.** The four of slice 2a, plus: the host kills `session-end` after the spawn and before the write; a `context` call whose trace write fails records its row with a null trace id. A missing row is never evidence that a session did not end.
- **Out of slice 2b.** Tool-failure events. `hippo capture-error` sends nothing to the model, and `failure_log` already keeps the time, session, tool and signature hash of every failure, so a ledger row would add only its place in the id order. Linking that row to its `failure_log` row, and telling two failures apart by tool call (parallel tool calls can fail within the same second, so a time window would merge real failures), each need a column, which is a schema change. Tool failures wait for that change, or for a failure hook that delivers memories. Also out: turn-end rows, the Codex wrapper's session end, the server context surfaces, `hippo recall` (it writes a trace but no row), a salted prompt hash, and the measured lock wait.
- **Runner.** `npm run build && npm run test:delivery-ledger`. The call sequence that slice 2a drove by hand is a test here, so the result cites tests and the squash commit only. Result in `docs/evals/2026-10-10-z10-ledger-slice2b-result.md`.

## Exit check: engineering scope (settled)

This section settles the engineering part of the Z10 exit. It covers three checks: known fixture events reconstructed end to end, recall decisions unchanged, and the ledger's overhead measured. The task-level part above stays DRAFT / NOT REGISTERED. The exit check changes no schema, no hook output and no command output.

- **Question.** For one store, session and lesson, which ROADMAP class holds? The classes are not-written, not-retrieved, rejected (not injected), delivery-unconfirmed, delivered with application unknown, applied-but-wrong, and applied with a supporting outcome. When the evidence cannot decide, the answer is `indeterminate` with a reason.
- **Reader.** `scripts/z10-reconstruct.mjs`, which is not shipped. It opens the store read-only. It joins five sources for one tenant and session: `memories` (local and global), `delivery_events`, `delivery_candidates`, the host transcript, and an application-label file. A memory is present at a turn when `memories.created` is not later than the row's `ts`. Both are ISO 8601 UTC.
- **Turns.** A turn is a numbered `prompt-submit` row. A duplicate joins its original. A sub-agent row carries the parent's session id but no number, and it is reported beside the turns, never as one. A row with another store's hash, as in a copied store, is reported and never used. A `context` or `pinned-manual` row is a turn of a surface with no verified host join, so its delivery stays unconfirmed.
- **Delivery confirmation.** Each hook's output is its own `hook_additional_context` attachment under the user prompt, and one prompt can carry several. A turn pairs with a transcript prompt in three ways:
  - by the blockHash of the prompt text against `prompt_hash`;
  - for a row that printed, by an attachment hash against its `emitted_hash`;
  - between two pairs already made, by order, but only when the unpaired turns equal the unpaired user prompts and task notifications there, quiet ones included.

  A turn's delivery is confirmed when an attachment under its own prompt has the row's `emitted_hash`. A prompt that fired hooks and pairs with no row is a gap. A line that fired no hook, such as a slash command or shell input, is never a gap and never pairs. `context` and `pinned-manual` rows never pair. A live Claude Code 2.1.288 session on a scratch store matched both hashes before this section was written.
- **Reuse and compaction.** A `reused` candidate takes the delivery of the latest earlier `sent` turn that emitted it with the same static block hash. If the transcript shows a compaction between the two, or the ledger holds a `pre-compact` or `compact-resume` row between them, the delivery stays unconfirmed. Both of hippo's compaction hooks reset injection, so the prompt after a compaction hippo saw is always sent again. Reuse across a compaction happens only when hippo missed it, so the ledger-row case is checked with rows built by the real writer, not through the CLI.
- **Undecided rows.** The recent load offers a window of up to 32 rows, but only five are judged with prompt recall off, and only the recall pool with it on. A row that is offered and never judged writes no candidate row and only adds to `rejected_unlisted`. So in a store with more than five unpinned rows, the ledger cannot tell "never loaded" from "loaded and never judged" for a memory that was not emitted. The reader returns `undecided` when fewer than 16 rejected rows are listed, and `unlisted` when 16 are, since overflow is then also possible. Not-retrieved is provable only for a memory the loader never offers, such as another project's memory. A later slice can close this gap by recording the window cut as a `limit` rejection.
- **Indeterminate.** Besides `undecided` and `unlisted`, the reader returns `indeterminate` in six more cases:
  - `no-ledger-table`: a store from before the ledger;
  - `no-event-row`: a gap, or a session with no rows;
  - `context-surface`: a `context` row without the memory, since that surface cannot tell never-retrieved from rejected;
  - `outcome-unknown`: the lesson was applied, but no outcome is known;
  - `forgotten`: the memory was deleted at an unknown point relative to the turns;
  - `key-ambiguous`: the content key matches more than one memory.

  A session's class is the furthest stage any turn proved, unless an indeterminate turn could have reached further.
- **Labels.** A label names a session and a memory. Application is `observed`, `judged` or `unknown`, and is never inferred from delivery. The signal is one of six: resolved check, failed check, explicit correction, revert, repeated error, or unknown. Observed or judged evidence needs a reference. A label acts only on a confirmed delivery. A label on any other case is reported and changes nothing. An invalid label is reported and ignored.
- **Fixtures and denominators.** The fixtures are driven through the built CLI on scratch stores. Each transcript is built from the hook's real stdout, with three things added: a decoy attachment from another hook, slash-command and shell lines, and a task-notification line. Each case asserts its raw ledger rows before it calls the reader, so the oracle never depends on the reader. The 33 class reads are frozen by stage:
  - capture: 3 (never written, written after the turn, forgotten before it);
  - budgeted evidence: 10 (another project's memory never loaded, undecided past the judged five, gate rejection, budget rejection, an unlisted and a listed row in an overflowing list, gate max items, a duplicate dropped at load, a limit cut on `hippo context`, a holdout session);
  - context availability: 16 (attachment missing, no transcript, delivered, unchanged-block reuse, reuse across a compaction hippo missed, re-send after a compaction hippo saw, a duplicate fire, two interleaved sessions, a gap with and without a delivery elsewhere, an agent `hippo context` call, a prompt-recall block beside a reused static block, a hand-run pinned call, a prompt whose text differs from the payload when sent and when reused, a global-store pin);
  - application: 3 (applied-but-wrong, applied and supported, applied with outcome unknown);
  - boundary evidence: 1 (a session-end row).

  The 11 negative controls are reported separately:
  - a label on a rejected memory;
  - another session's label;
  - one changed character in the attachment;
  - the ledger off;
  - an invalid application value;
  - the attachment under the wrong prompt;
  - a copied store;
  - another tenant's row in the session;
  - a sub-agent row under the parent session;
  - a transcript of command, shell and notification lines;
  - a lost row, then a compaction, then a quiet reused turn whose text differs from the payload, which must never read confirmed.

  Every stage and reason value is also checked against rows built with the real writer.
- **Metric and bound.** Every case matches its oracle on class, reason, store hash, tenant, session, turn (event id and number), candidate stage and memory id. The bound is 100% in every stage.
- **Joins carry weight.** Ten reader mutants must each fail at least one case:
  - no session filter;
  - no hash compare;
  - `rejected_unlisted` ignored;
  - labels applied before delivery;
  - transcript compaction ignored;
  - attachments matched under any prompt;
  - store hash ignored;
  - no tenant filter;
  - sub-agent rows treated as turns;
  - gaps counted on lines that fired no hook.
- **Real host.** The parser runs on a copy of a real transcript from this machine, with its SHA-256 recorded, and its per-kind counts must equal an independent count. The reader runs on a copy of the live scratch session. The expected class there is delivered with application unknown, and a second live turn adds a reused turn.
- **Recall decisions.** On the exit commit, three surfaces must show identical decisions with the ledger off and on:
  - the pinned prompt hook: F9, plus `hook-latency.mjs --ledger-compare` with identical stdout and a zero token delta at 2000 memories;
  - `hippo context` with a query, with results and with none: markdown and json stdout, the trace's result rows, and retrieval counts;
  - the `pre-compact`, `compact-resume` and `session-end` hooks: stdout and exit code, with non-empty stdout asserted for the two hooks that print, so empty output on both sides cannot pass.
- **Overhead.** `node scripts/ledger-overhead.mjs --memories 2000 --runs 200` is checked against Amendment 1 by its `pass` field, since the script exits 0 when a bound fails. Bytes per turn must stay at or under 7168, from `hook-latency.mjs`. That script's two latency bounds were replaced by Amendment 1, so they are reported but not gated. The bound met is Amendment 1's latency proxy. H4 itself, the Z0 cost ratio and resolve rate, is not measured here.
- **Machine load.** Before each overhead run, `cmd /c exit` is timed five times. A median over 100 ms makes the run void, not failed. The load is cleared and the script is run again. The first run that is not void decides, and every run is reported.
- **Limits.** A deleted memory keeps no text, so a content key cannot tell never-written from deleted. The sub-agent's own transcript is not joined, and neither are Codex transcripts. A missing row is a gap, never evidence.
- **Out.** Three things stay out:
  - tool-failure rows, which need a schema change;
  - the server context surfaces;
  - listing undecided rows, which is a src change.
- **Pass means.** The events the ledger records today can be reconstructed. Z10's exit stays open until tool-failure rows exist. No task-benefit claim.
- **Runner.** The scored commands are `npm run build && npm run test:delivery-ledger`, the overhead scripts above, and the mutant script and two host checks outside the repo. If a fixture's construction does not produce its stated rows, this list is amended before any scored run. Result in `docs/evals/<run date>-z10-exit-check-result.md`.
- **Amendment 1, before any scored run: queued prompts.** The build review read two real transcripts from this machine. A prompt sent while the agent is busy (typed text, a task notification or a message from another session) is never written as a user line. Claude Code writes it as a `queued_command` attachment that carries the prompt text, and that prompt's hook attachments follow it. The two transcripts hold 62 such prompts, and 41 of them are followed by a hook attachment. The parser treated only user lines as prompts, so it gave those hook attachments to the prompt before them. The independent count had the same blind spot, so the per-kind check could not catch it. Changes:
  - The parser treats a `queued_command` attachment as a prompt. Its kind comes from its text, as for a user line, and `cross-session-message` joins `task-notification` as a kind that fires hooks. A queued command with another command mode fires no hook.
  - The independent count also counts queued prompts, by kind.
  - Context availability gains one read: a queued prompt that was sent and whose attachment confirms delivery. That makes 17 in that stage and 34 class reads in all.
  - A twelfth control checks that a queued prompt's attachment is never given to the prompt before it. Turn 1 is sent with its attachment missing, a `pre-compact` resets the block, and turn 2, a queued prompt, sends the same block with its attachment present. Turn 1 must stay unconfirmed.
  - An eleventh mutant ignores queued prompts.
  - Not verified: whether the hook's payload prompt equals the queued text. A turn that printed still pairs by its attachment hash.

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
