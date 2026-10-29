# Another session's state prints as a pointer; hooked sessions drop the per-task context call

Date: 2026-10-29
Status: accepted
Links: PR #1103; plan `docs/plans/2026-10-28-token-diet-plan.html`; `changelog.d/feat-token-diet.md`; `tests/continuity-pointer.test.ts`

## Context
The Z0 round 2 eval failed its cost gate (H4): on tasks with no lesson, hippo cost 1.119 times the arm without it [1.065, 1.175], over the 1.10 limit. Hippo's injected text was the cost this change could cut.

## Constraints and evidence
- The prompt hook sent 3,708 characters to each new session; 2,407 were a finished session's handoff (plan page, Z0 round 2).
- The Claude Code block asked for `hippo context --auto` on each task, on top of what the hook already sent.
- MCP `hippo_recall include_continuity` reads `continuityAt` (`src/store/sqlite/store.ts:423`), which loads a handoff only for the active snapshot's session. `hippo context` falls back to the unfinished-handoff read (`src/api/context.ts:394`). So an MCP pointer could not reach every row.
- `hippo handoff latest` with no `--session` returns the newest handoff, not the one context chose. `SESSION_ID_RE` accepts ids such as `--help`.

## Decision
- The prompt hook and the text formats of `hippo context` print another session's snapshot and handoff as one line. The line names the command that prints the full text. `continuityModeFor` decides, and a pointer prints only when its command returns the same row.
- The caller's own session, a shared store, `--format json`, MCP and the HTTP routes print the full text. So does an id that a shell or the flag parser could misread.
- The Claude Code and Codex blocks ask for `hippo context --auto` only when no hippo block appeared. The Claude Code plugin drops its SessionStart context call.

## Alternatives considered
- Pointers in MCP too (the first plan answer): narrowed, because the MCP follow-up read cannot reach every row.
- A pointer for the handoff only: rejected in the plan answers; the snapshot shrinks too.
- Fallback commands for ids that are not safe: replaced after review, because the fallback could return a different row.

## Consequences
- Another session's hook output fell from 858 to 375 characters, and `hippo context --auto` from 982 to 540 (verify evidence, 4d078af84 against eb5f72823).
- Hooked sessions lose the per-task call's retrieval strengthening and last-recall attribution, because the pinned-only path is read-only (`src/api/context.ts:213-216`). They also lose the git-aware recall at session start.
- A pointer's command finds its store from the agent shell's folder. A shell inside another hippo project gets "not found".

## Reconsider when
- A Z0 rerun shows the cost ratio still over 1.10, or a lower repeat-mistake gain.
- The MCP continuity read gains the unfinished-handoff fallback.
