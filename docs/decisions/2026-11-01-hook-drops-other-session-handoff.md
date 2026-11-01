# The per-prompt hook stops printing another session's handoff

Date: 2026-11-01
Status: accepted
Links: plan `docs/plans/2026-11-01-hook-drop-handoff-plan.html`; `changelog.d/feat-hook-drop-handoff.md`; `tests/continuity-pointer.test.ts`; supersedes the hook part of `docs/decisions/2026-10-29-continuity-pointers.md`

## Context
The 2026-10-29 record cut the hook's cost by printing another session's handoff as a one-line pointer. Its "Reconsider when" section named a Z0 rerun with the cost ratio still over 1.10. That rerun is Z0 Amendment 9: H4 read 1.060 [1.011, 1.112], and the upper end of the interval is above the 1.10 limit. The pointer is the part of the hook text this change removes.

## Constraints and evidence
- Source for the Z0 figures: the Amendment 9 entries of `docs/evals/z0-scored-set-record.md` on branch `feat/z0-fixed-repo` (commits `42f5f2a3b` and `708242f65`).
- Z0 Amendment 9, set N: 249 of 252 hook injections carried a Session Handoff pointer. The mean injection was 1,657 characters.
- One pointer block is 194 characters: the `## Session Handoff` heading plus the one-line pointer. Measured as the length of that section in `hippo context --pinned-only --include-recent 5 --format additional-context` output on a store holding one unfinished handoff from another session, hippo 2.3.0.
- That is about 50 tokens, or about 12% of the mean injection, on each prompt where another session's unfinished handoff exists.
- A Z0 rerun must confirm the saving. This record makes no cost claim before it.
- Claude Code and Codex install the same UserPromptSubmit command (`src/hooks/json-hooks.ts:217-218`), so one change covers both.

## Decision
- The hook text (`hippo context --pinned-only --format additional-context`) prints no handoff that belongs to another session, pointer or full. The CLI sets `ownHandoffOnly` for that one flag pair (`src/cli/context.ts`).
- The hook still prints its own session's handoff in full.
- The omitted handoff still hides its session's transcript-digest row, so the digest does not take its place.
- Another session's snapshot pointer and trail stay in the hook. Z0 showed no snapshot in 252 injections.
- The Claude Code and Codex hooks change. Copilot's sessionStart (`--format copilot`) keeps the pointer, because it is the only injection Copilot gets.
- JSON, markdown, the HTTP route, MCP and the default of `promptHookContext` keep the handoff. A caller of `promptHookContext` opts in with `ownHandoffOnly: true`.
- Resume path: `hippo context --auto`. It shows the other session's id, which `hippo handoff latest --session=<id>` then takes.

## Alternatives considered
- Drop the handoff in every text format: rejected, because Copilot would then never see one.
- Change the default of `promptHookContext`: rejected, because it is a published default. The caller opts in.
- Keep the owner's handoff in the hook on a shared store: rejected, to keep one rule for every store. The owner runs `hippo context` to resume.

## Consequences
- Limit 1: with no fresh snapshot, the read returns the newest unfinished handoff of any session (`src/api/context.ts:392-398`). A newer handoff from another session hides the caller's own, and now neither prints. A fresh snapshot from another session does the same, because the read then takes that session's handoff. A test pins the first case (`tests/continuity-pointer.test.ts`). Follow-up: read the caller's own row under `ownHandoffOnly`, and keep the other session's row for the digest hide.
- Limit 2: with no session id, the hook drops every handoff, the caller's own included.
- Limit 3: a shared store drops the owner's handoff from the hook too. The owner runs `hippo context` to resume.
- Limit 4: the freed budget can admit one more memory. `obs.sections` counts the omitted handoff as neither shown nor dropped.
- Ledger: the handoff is part of the hashed static block (`src/api/prompt-hook.ts:180`), so after the upgrade the hash changes and a session gets the new block once.
- Another session's work reaches the model only if the agent runs a resume command. The Claude Code and Codex blocks keep their words.

## Reconsider when
- A Z0 rerun shows no cost change.
- Users report lost resumes.
