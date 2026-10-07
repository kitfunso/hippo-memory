### Added

- **The hook commands now read GitHub Copilot payloads, from the Copilot CLI and from VS Code.** `hippo context --format copilot` answers a sessionStart hook with the reply the sender reads: top-level `additionalContext` for a camelCase payload, the nested `hookSpecificOutput` for VS Code's snake_case one. It sends the whole block on every session start, as that is the only injection Copilot gets. `capture-error`, `pre-compact` and `session-end` take `--runtime copilot`.
- **A Copilot hook uses the store of the payload's `cwd`.** VS Code runs user-level hooks in the home folder, so the folder a hook starts in says nothing about the project.
- **Every hook verb maps Copilot's camelCase fields to the snake_case keys hippo reads** (`sessionId`, `transcriptPath`, `toolName`, `hookEventName`, `customInstructions`, and `toolArgs` parsed into `tool_input`). Claude Code and Codex payloads pass through byte for byte.
- **Session capture and the pre-compact snapshot read Copilot's `events.jsonl` line by line**, skipping sub-agent lines and prompts a skill, another agent or autopilot wrote. `session-end --runtime copilot` finds the Copilot CLI log at `<COPILOT_HOME>/session-state/<id>/events.jsonl`. `pre-compact --runtime copilot` saves the snapshot and opens no compaction record, since Copilot has no PostCompact hook to close one.
- **A failed Copilot or VS Code search, or a quiet `grep` exit 1 in their shell tools, no longer becomes an error memory**, as the same failure from Claude Code's tools does not.
- The delivery ledger books Copilot calls with runtime `copilot`.
