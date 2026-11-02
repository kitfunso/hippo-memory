### Added

- **Capture stores the rules you give in reply to the agent.** A sentence in a later user turn is stored as your pinned rule, tagged `follow-up` and `from-user`, when it names code (a backtick, a path, a flag, a call) or limits a choice ("not", "only", "instead", "before") in 4 words or more. It needs no rule word such as "never" or "always", and no model call. The opening request of a session is not a rule. Thanks, questions and pasted output stay out. A capture after each reply (`--turn`) reads a later slice of the session as replies.
- **Claude Code gets your rules again at session start.** `hippo hook install claude-code` and the plugin now add a `SessionStart` hook that runs `hippo session-rules`. It prints every rule you stated to the current project, from the project store and the global store, oldest first, as session context. In a replay, agents followed these rules in 16 of 16 sessions with this hook and in 0 of 16 with the per-prompt hook alone. The hook prints nothing when there is no rule, in a pilot holdout session, or when `pinnedInject.enabled` is off, and it needs no `hippo init`. Run `hippo hook install claude-code` again to add it.
- **A rule prints without the reply lead you typed.** `No:` and `Yes, keep doing that:` are cut from the front of a line under `## Rules from the user`, in the per-prompt hook, `hippo context` and `hippo session-rules`. The stored row is unchanged.

### Changed

- **Every rule capture pins from your words is now your rule.** A rule such as "Never commit directly to `main`" that capture pins from a user turn also gets the `from-user` tag. So it prints under `## Rules from the user` and at session start, in the first turn as in a reply. Rows stored before this release keep their tags.
- **Capture skips the user lines Claude Code writes for `!` shell commands and task notices.** `<bash-input>`, `<bash-stdout>`, `<bash-stderr>` and `<task-notification>` lines are no longer read as your words.
