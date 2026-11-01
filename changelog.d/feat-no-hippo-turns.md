### Changed

- **The Claude Code instruction block no longer asks the agent to run `hippo remember --error` mid-task.** The failure hook and session capture already store failures and corrections, and each agent call is an extra turn that re-reads the whole context. In Z0 round 2 Amendment 8, those agent calls were 118 of 159 hippo calls on no-lesson tasks, and sessions with any hippo call cost 1.141 of the no-memory arm against 0.998 without. `hippo init` refreshes an unedited 2.2.0 block; the context fallback is unchanged.
