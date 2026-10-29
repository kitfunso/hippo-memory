### Changed

- **The prompt hook and `hippo context` print another session's task snapshot and handoff as one line.** The line names the session and the command that prints the full text (`hippo session latest --id <id>` or `hippo handoff latest --session <id>`). Your own session, a shared store, `--format json`, MCP `hippo_context` and the HTTP routes still print the full text. In the Z0 round 2 eval, a finished session's handoff was 2,407 of the 3,708 characters the hook added to each new session.
- **The Claude Code and Codex instruction blocks no longer ask for `hippo context --auto` on every task.** The prompt hook already injects pinned rules and matching memories, so the blocks ask for the call only when no hippo block appeared in the session. `hippo init` refreshes blocks it installed; hand-edited blocks stay as they are. The Claude Code plugin (0.6.2) drops its SessionStart context call for the same reason.
- **`hippo` no longer prints Node's SQLite ExperimentalWarning on each call.** An agent read that warning on every hippo command. Other warnings still print.
- **`ContextCost.snapshot` and `ContextCost.handoff` take a second `mode` argument.** Implementations written for the old signature still type-check, but a caller that invokes them must pass the mode.

### Added

- **`ContextOpts.continuity` and `PromptHookOpts.continuity` (`'full' | 'pointer'`, default `'full'`).** Library callers opt in to the one-line form. The remote hook route keeps the full text unless its caller opts in.
