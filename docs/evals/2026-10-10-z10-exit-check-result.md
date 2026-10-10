# Z10 exit check result: delivery reconstruction, invariance and overhead

**Date:** 2026-10-10  
**Scope:** the engineering part of the Z10 exit, as registered in the [Z10 draft](./2026-09-30-z10-ledger-prereg.md) under "Exit check: engineering scope", with Amendments 1 and 2. No task or efficacy claim.  
**Verdict:** the engineering part passes at `639be66a`. All 34 class reads and 12 negative controls match their oracles on all eight fields, and each of the 11 reader mutants fails at least one case. The parser's counts match an independent count on three real transcripts, and a live session reads as delivered with application unknown. Recall decisions are unchanged on three surfaces. The ledger's in-process cost meets Amendment 1.  
**Status:** the delivery ledger stays off by default behind `deliveryLedger.enabled`. Z10's exit stays open until tool-failure rows exist, which need a schema change.

## What was built

No change under `src/`, no schema change, and no change to any hook or command output.

- **Reader.** `scripts/z10-reconstruct.mjs`, a development tool that is not shipped (`package.json` `files` leaves `scripts/` out). It opens a store read-only and returns one delivery class for one tenant, session and lesson, or `indeterminate` with a reason. It joins the memory (local and global), `delivery_events`, `delivery_candidates`, the host transcript and an application-label file.
- **Transcript parser.** `scripts/z10/transcript.mjs` reads a Claude Code transcript: which lines are prompts, which `UserPromptSubmit` attachments fired under each, and where the compactions are. It pairs ledger turns with prompts by prompt hash, then by attachment hash, then by position.
- **Fixtures.** `tests/delivery-ledger-exit.test.ts` drives the built CLI on scratch stores and builds each transcript from the hook's real stdout. Every case asserts its raw ledger rows before it calls the reader, then checks eight fields: class, reason, store hash, tenant, session, turn, candidate stage and memory id. `tests/delivery-ledger-exit-controls.test.ts` holds the negative controls. `tests/delivery-ledger-exit-reader.test.ts` checks every stage and reason value on rows built by the real writer, plus the parser, the pairing and the command line.
- **Invariance tests.** I1 and I2 in `tests/delivery-ledger-context.test.ts` (`hippo context` with a query, markdown and JSON), I3 in `tests/delivery-ledger-boundary.test.ts` (the three boundary hooks).

## What ran

Run at `639be66a` on node v24.13.0. Both amendments were committed before the scored fixture run.

```
npm --prefix C:/Users/skf_s/hippo-wt-z10x run build
npm --prefix C:/Users/skf_s/hippo-wt-z10x run test:delivery-ledger
```

- `npm run test:delivery-ledger`: 10 files, 213 tests, all pass.
- The three exit files, by stage, all pass:

| Stage | Registered reads | Cases | Eight-field checks |
|---|---|---|---|
| capture | 3 | 3 | 3 |
| budgeted evidence | 10 | 9 | 10 |
| context availability | 17 | 17 | 19 |
| application | 3 | 3 | 3 |
| boundary evidence | 1 | 1 | 1 |
| negative controls | 12 | 12 | 12 |

  X5 reads an unlisted and a listed row, which the registration counts as two reads. X13 reads both interleaved sessions, and X17 reads both the recall memory and the pin, which the registration counts as one read each. The 28 reader tests on writer-built rows also pass.
- The CI check scripts, each exit 0: agent inventory, CLI recall writes, comment history, env reads, error text, expiring keys floor, floating promises, graph writes, import cycles, layers, lint ratchet, manifest versions, open core, openclaw dist, process exit, request-path timing, roadmap, size ratchet, store port, test-only exports. `npm run typecheck:tests` is clean.
- The full suite, `npm test`: 797 files, 9740 pass, 24 skipped, 4 fail. The four failures are in three Z0 token-eval files, under the machine load above. Run again alone, `token-eval-z0-leaks` and `token-eval-z0-surfaces` pass, and both `token-eval-z0-timeout` tests fail again: each hits its 120 s limit, and then Windows refuses to delete the hung session's directory (EPERM). This branch changes no file under `src/` and nothing those tests import. The Token eval workflow passes on master in CI.

## Mutants

Script: `C:/hippo-tmp/z10x/mutate.mjs`, outside the repo. It edits one source string in a clean worktree at `639be66a`, runs the three exit files, records the failing tests, and restores the file. Every mutant failed at least one case:

| Mutant | Caught by |
|---|---|
| M1 no session filter | N2, R2, R19, X13 |
| M2 no hash compare | N3, N6, N12, R17, X6, X11b, X17 |
| M3 `rejected_unlisted` ignored | R7, X2b, X5 |
| M4 labels applied before delivery | N1 |
| M5 transcript compaction ignored | N11, X11 |
| M6 attachments matched under any prompt | N6, N12, X11b |
| M7 store hash ignored | N7, R21 |
| M8 no tenant filter | N8 |
| M9 sub-agent rows treated as turns | N9, R23 |
| M10 gaps counted on lines that fired no hook | N3, N6, N10, R15, X6, X12, X13, X21 |
| M11 queued prompts ignored | N12, R16, X22 |

M9's first run was invalid, not a survivor. Its edit replaced an `else if` with a bare `else`, and the reader has had a later `else` branch since the review fixes, so the file no longer parsed and no test loaded. The edit now reads `else if (true)`, which still sends sub-agent rows into the turns. M9 was then run again on its own. The script now reports a run that loads no test as invalid.

## Real host

- **Parser on real transcripts.** Three transcripts copied from this machine, outside the repo, with SHA-256 checked at the run:

| Copy | SHA-256 | Prompts | Fired | Queued | Task notifications | Other kinds |
|---|---|---|---|---|---|---|
| real-a | `06f8bd5b…c106900a` | 65 | 122 | 58 | 119 | 4 cross-session, 2 command, 2 command stdout, 2 shell input, 2 shell stdout |
| real-b | `18ff8b5f…4fdfc1bd` | 21 | 13 | 4 | 1 | 1 image, 2 command, 1 command stdout |
| real-c | `211a528f…e3186e4b` | 10 | 22 | 16 | 13 | 1 cross-session, 2 agent message, 2 command, 2 command stdout |

  Each count equals the independent count in `C:/hippo-tmp/z10x/tally.mjs`. The reader reads each one against a store whose ledger was never on as `indeterminate` `no-event-row`, with one gap per fired prompt.
- **Live session.** Claude Code on a scratch store with the ledger on, two turns, the second with an unchanged block. Transcript SHA-256 `e909b74d…f1fe7bb9`. The reader returns `application-unknown`: turn 1 `sent`, paired by prompt and confirmed on its attachment; turn 2 `reused`, paired by prompt and confirmed through turn 1. The read at `639be66a` is byte-identical to the first read, taken at `cfeefd0f` before the review fixes.

## Recall decisions

- **Pinned prompt hook.** F9 in `tests/delivery-ledger-hook.test.ts` passes, and `hook-latency.mjs --ledger-compare --memories 2000 --runs 30` shows identical stdout in every turn and a zero token delta in all four cells.
- **`hippo context` with a query.** I1 (results, markdown and JSON) and I2 (no results, both formats) pass: same bytes, same trace result rows, same retrieval counts.
- **Boundary hooks.** I3 passes: `pre-compact`, `compact-resume` and `session-end` give the same stdout and exit status with the ledger off and on, and the two hooks that print are asserted non-empty.

## Overhead

Before each run, `cmd /c exit` was timed five times. Another session's model-training job held the machine at about 90% CPU. Lowering it to below-normal priority, and later to idle, did not stop the probe spiking, so hook-latency attempts 2 and 3 waited for two passing probes in a row. The job was set back to normal priority after the runs.

**`ledger-overhead.mjs --memories 2000 --runs 200`**, run 1, probe median 91 ms before and 86 ms after: not void, so it decides. In-process milliseconds for the ledger's share of one turn:

| Arm | Mode | p50 | p95 | Dropped |
|---|---|---|---|---|
| promptRecall off | fresh | 0.50 | 0.80 | 0 |
| promptRecall off | steady | 0.51 | 0.76 | 0 |
| promptRecall off | contention | 0.45 | 8.18 | 1 |
| promptRecall on | fresh | 0.58 | 0.86 | 0 |
| promptRecall on | steady | 0.59 | 0.88 | 0 |
| promptRecall on | contention | 0.65 | 4.82 | 0 |

`pass` is true: the worst gated p50 is 0.59 ms against 15 ms, and the worst gated p95 is 0.88 ms against 30 ms. The contention mode is reported, not gated. In it a second process takes the database's write lock for 30 ms at a time, which explains its 8 ms p95 and its one dropped event.

**`hook-latency.mjs --ledger-compare --memories 2000 --runs 30`**, three attempts:

| Attempt | Probe before | Status | Stdout identical | Token delta | Worst bytes per turn | Worst p95 ratio | Worst p50 delta |
|---|---|---|---|---|---|---|---|
| 1 | 117 ms | void | 100% | 0 | 2731 | 0.74 | +45.0 ms |
| 2 | 108 ms | void | 100% | 0 | 2607 | 1.20 | -8.2 ms |
| 3 | 71 ms | decides | 100% | 0 | 2731 | 1.13 | +17.7 ms |

Attempt 3 passes the bounds it is gated on: identical stdout, a zero token delta, and 2731 bytes per turn against 7168. The script's own `pass` field is false, because its two latency bounds failed: a p95 ratio of 1.13 against 1.10, and a p50 delta of 17.7 ms against 15 ms. Amendment 1 replaced those two bounds with the in-process check above, so they are reported and not gated. They time a whole spawned CLI process, median about 300 ms, and they swing both ways between attempts. In attempt 3, the ledger-on arm had the lower p95 in three of the four cells. The probe after attempt 3 read 528 ms, so the load returned during or just after the run.

Attempt 2 started on a probe that passed two seconds before a fresh probe that read 108 ms. Attempt 3 used its passing gate probe as the registered probe, with no gap between them.

## Findings

1. **Not-retrieved is provable only for a memory the loader refuses.** The recent load offers a window of up to 32 rows but judges only five with prompt recall off, and only the recall pool with it on. A row that is offered and never judged writes no candidate row and only adds to `rejected_unlisted`. In a store with more than five unpinned rows, the ledger cannot tell "never loaded" from "loaded and never judged". The reader returns `indeterminate` `undecided` there (X2b), and `unlisted` when the rejected list is full (X5). A later slice can close this by recording the window cut as a `limit` rejection.
2. **Claude Code writes a prompt sent while the agent is busy as an attachment, not a user line.** A typed prompt, a task notification or a message from another session arrives as a `queued_command` attachment, and its hook attachments follow it. Two real transcripts held 62 such prompts, 41 followed by a hook attachment. The first parser gave those attachments to the prompt before them, and the independent count shared the blind spot. Amendment 1 recorded the fix before any scored run.
3. **A duplicate row's hash could confirm a lesson it never emitted.** A `reused-recall-sent` row prints only its recall block, so its `emitted_hash` is that block's hash. When a `sent` duplicate of it emitted a pin, the first reader confirmed the pin on the recall block's attachment. The execute review failed on this at 74, and Amendment 2 recorded the fix before the scored run. The invariant now is: a lesson is confirmed at class level only by an attachment from this session whose hash is the `emitted_hash` of a row whose own candidate emitted that lesson.
4. **System notices fire the prompt hook.** Hippo's other transcript readers skip `promptSource: 'system'` lines because they want human prompts. This reader wants hook firings: in 18 distinct transcripts on this machine, 430 of 547 such lines were followed by a hook attachment, so the parser keeps them.
5. **A missing forget row does not prove a memory never existed.** Several delete paths write no forget audit row. The reader returns `indeterminate` `forgotten` when the id appears in any candidate or trace row, and `not-written` only otherwise (R19).

## Limits

- Pass 1 pairs a row with the first unpaired prompt of the same text. A repeated prompt plus a lost row can pair a turn too early. The class stays safe under the invariant above, but one turn's delivery can read confirmed across a compaction it missed.
- The parser gives each hook attachment to the latest prompt before it.
- Whether the hook's payload prompt equals the queued text is not checked. A turn that printed still pairs by its attachment hash.
- Sidechain lines are not skipped. None occur in the 18 transcripts above; Claude Code writes sub-agent transcripts to their own files.
- On a `key-ambiguous` read, two valid labels for two different memories report `label-error:duplicate`. The class stays indeterminate.
- When no row in a duplicate group emitted the lesson, the turn's stage comes from the main row only, so a parallel fire's rejection is not shown.
- The sub-agent's own transcript and Codex transcripts are not joined. A missing row is a gap, never evidence.

## Out

- Tool-failure rows, which need a schema change and wait on an explicit yes.
- The server context surfaces and `hippo recall`.
- Listing undecided rows, which is a `src` change.
