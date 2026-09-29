### Fixed

- **OpenCode's idle hook no longer saves another project's Claude Code session.** The hook runs `hippo session-end` with no payload, and an empty stdin made session end look like a manual run, so it captured the newest transcript under `~/.claude/projects/`, usually a different project's session. Session end now never scans for a transcript and logs `skip capture: no transcript for this session` instead. Only a manual `hippo capture --last-session` scans.
