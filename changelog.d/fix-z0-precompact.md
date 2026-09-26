### Fixed

- **Background-agent notices no longer become the session task.** User lines Claude Code writes for itself (`promptSource: "system"`: task notifications, cross-session messages, scheduled prompts) are now skipped like meta and sidechain lines, so they stay out of the pre-compact snapshot's Task and Summary and out of SessionEnd capture mining.
- **Pre-compact only saves a working-state snapshot; it no longer writes memories.** What it extracted was mostly fragments (2 useful of the last 45). SessionEnd capture still extracts, from the last 20 user and 10 assistant turns, so a decision made only before a compaction and outside that tail is no longer captured.
- **compact-resume only restores a snapshot written for this compaction.** A snapshot older than 15 minutes is skipped as stale, even when its session id matches.
