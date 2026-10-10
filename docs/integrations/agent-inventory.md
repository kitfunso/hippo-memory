# Agent inventory

`agent-inventory.json` lists every agent surface hippo names. For each one it records what hippo hooks into today, and, per mode, whether hippo saves a checkpoint and lessons before the host drops context. CI runs `node scripts/check-agent-inventory.mjs` on every PR.

The inventory is the AZ6 backlog in `ROADMAP.md`. It replaces no other document; it is the one place the per-agent status lives.

## Statuses

Each mode carries two statuses. `checkpointBeforeLoss` covers working state: the task, a summary and the next step, so the session can resume. `lessonsBeforeLoss` covers durable memories. They differ today: Claude Code saves a checkpoint inside PreCompact, but it saves lessons only after compaction, from the summary.

| Status | Meaning | The check requires |
|---|---|---|
| `verified` | A recorded live run on the real host saved and restored it | `liveEvidence`, and a `preLossSave` route |
| `shipped` | The code is released and fixture tests prove it | `fixtureEvidence`, and a `preLossSave` route |
| `planned` | A route is known and owned, not built | `owner` and `nextAction` |
| `blocked` | No authorised source exists yet | `owner` and `nextAction` |
| `unknown` | Nobody has checked | nothing; it never counts as a pass |

Four rules decide a status:

- Fixture evidence and live evidence stay apart. Fixtures can never make a mode `verified`.
- Unknown is not a pass. A `null` field means unknown, never "not needed".
- Items read from a post-compaction summary are not saved before loss. They do not make `lessonsBeforeLoss` shipped.
- Local setup does not prove a cloud mode. Cloud and remote modes get their own row.

## Fields

| Field | What it holds |
|---|---|
| `id`, `names` | A stable id, and every name the docs use for the agent. The check matches claims against `names`, ignoring case. |
| `checked` | The date someone last checked the entry against source. |
| `integration` | Any of `native-hooks`, `native-plugin`, `wrapper`, `instruction-file`, `mcp-recipe`; or `none` alone. |
| `sources`, `claims` | Repo paths of the integration code, and of the pages that claim support. Every path must exist. |
| `routes` | What hippo does today for each of six moments, or `null`: prompt context, tool failure, pre-loss save, post-compaction extract, session end, compact resume. |
| `upstream` | The host's pre-loss event and its before-trim or reset event, as named in the ROADMAP AZ4 table, or `null`. |
| `interface`, `setup`, `store`, `maxSaveDelay` | The host interface hippo uses, how setup and trust happen, which store and scope saves land in, and the longest gap between a turn and its save. `null` is unknown. |
| `modes` | One object per mode: `name`, the two statuses, `fixtureEvidence` and `liveEvidence`. |
| `owner`, `nextAction`, `roadmap` | Who moves it next, what that step is, and the ROADMAP item it belongs to. |

`nonAgentKeywords` lists the npm keywords that name no agent, so every other keyword must match an entry.

## What the check enforces

- The schema: types, enums, unique ids, a date on every entry, and every path present on disk.
- The status rules in the table above.
- Every agent named in the README framework table, the MCP recipe's client sentence, its `## Setup` headings, and `package.json` keywords maps to an entry. The table must keep at least six rows and the client sentence must exist, so moving either fails loudly instead of passing empty.
- Every `integrations/*.md` file and `extensions/*` directory is cited in some entry's `sources`.
- `tests/agent-inventory-check.test.ts` also checks that every tool `hippo setup` detects has an entry with the matching integration kind.

Website pages are listed in `claims` but not parsed, since they hold no structured agent list. Keep them in step by hand.

## Adding an agent

1. Add an entry with every field. Use `null` for anything you have not checked.
2. Add one mode per surface that behaves differently: local, cloud, remote host, CLI, SDK.
3. Set statuses from evidence only. A new adapter starts at `planned`; it moves to `shipped` with a fixture test, and to `verified` with a recorded live run.
4. Run `node scripts/check-agent-inventory.mjs`.

## The capture contract

`src/core/capture-contract.ts` is the shape every adapter turns a host payload into. It has no imports, so any adapter can use it without pulling in the store.

| Type | Role | Stored today as |
|---|---|---|
| `CaptureInput` | What hippo read from one payload, before any write | not stored |
| `CaptureReceipt` | `received`, `skipped` with a reason, or `unavailable` | the `compactions` row is the receipt record for Claude Code PreCompact; skips go to the pre-compact log, and post-compact skips go to the same log |
| `Checkpoint` | Working state saved before loss; not a lesson | `task_snapshots` |
| `ProgressCursor` | How far capture has read a session's source, so a retry resumes | `~/.hippo/sessions/<session id>.cursor.json`, for VS Code's capture after each reply |

The receipt has no `pending` or `processed` states yet. Those belong to the write side, and AZ4 adds them when a second runtime writes through the contract.

Four payload readers exist: `readClaudeCodePreCompact`, `readVscodeStop`, `readClaudeCodePostCompact` and `readSessionEnd`. `hippo pre-compact` calls the first and logs each skip reason word for word. `readVscodeStop` decides whether `hippo session-end --turn` acts on a payload; any skip ends the run silently, since the Copilot CLI's `agentStop` shares the hook line. After a skip, `hippo post-compact` logs the reason, saves nothing and still replays earlier leftovers. After a skip, `hippo session-end` still runs sleep but captures no transcript.

## Conformance fixtures

Fixtures live in `tests/fixtures/capture/<runtime>/<event>/*.json`. Each holds `{ "stdin", "timedOut", "expect" }`, where `expect` is the exact receipt, skip reasons included. `tests/capture-contract-conformance.test.ts` runs every fixture through its runtime's reader. A fixture directory with no reader fails the suite, so new fixtures cannot sit unexercised.

## Store-level fixtures

`tests/copilot-hooks-cli.test.ts` runs the built CLI against a real store, for the hazards a payload fixture cannot show.

- **Busy store.** While another process holds the store's write lock, a VS Code reply saves no memory and no progress cursor. The next reply in that chat saves the lesson once. Copilot's pre-compact waits once, warns once and saves no snapshot.
- **Crash and retry.** A worker killed after it wrote the memories and before it saved the progress cursor leaves one copy. The next reply finds the lesson already stored and saves the cursor.
- **Two sessions at once.** A reply that ends while the last reply's worker still runs is saved by that worker. A second chat that ends a reply while the first chat's worker still runs saves its own lesson and its own progress cursor. The test holds the first chat's worker open before the second chat starts. The whole second save then happens while that worker is alive and holds its session lock.
- **Wrong project.** The lesson goes to the project the payload names, also when the hook runs from another project. A project folder with no store saves to the global store under that project. When the named transcript is not on disk and the Copilot CLI has no log for that session, the reply saves nothing, also with another chat's transcript beside it. A payload folder that no longer exists makes the hook warn and save into the store of the folder it ran in.

Limits found in one-off runs of the built CLI while these tests were written. No test pins the third. The busy-store test covers only the retry in the first, and the crash test sees the second only right after the kill:

- A capture that meets a busy store is not queued. Only the next reply in the same chat retries a VS Code reply, and nothing retries a full session end. The spool that keeps a busy post-compact does not cover these two paths.
- A worker killed during the progress cursor save leaves its `<session id>.cursor.json.<pid>.tmp` file in `~/.hippo/sessions`.
- Two sessions that save the same sentence at the same moment both write it. One after the other in one project, the second save is skipped. The next sleep drops one copy and adds one consolidated memory made from the pair, so two rows still hold the sentence.

## Next steps (AZ4)

- Move the tool-failure payload reader onto the contract.
- Spool a session-end capture that meets a busy store, as post-compact does, so a chat's last reply is not lost.
- Check for an existing copy inside the write, so two sessions that save one sentence at the same moment write it once.
- Save Claude Code lessons before compaction, not only after it.
- Record live save-and-resume runs, so modes can reach `verified`.
