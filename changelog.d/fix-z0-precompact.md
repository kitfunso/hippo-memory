### Fixed

- **Background-agent notices no longer become the session task.** User lines Claude Code writes for itself (`promptSource: "system"`: task notifications, cross-session messages, scheduled prompts) are now skipped like meta and sidechain lines, so they stay out of the pre-compact snapshot's Task and Summary and out of SessionEnd capture mining.
- **Pre-compact only saves a working-state snapshot; it no longer writes memories.** What it extracted from the transcript tail was mostly fragments, and SessionEnd capture already reads the whole transcript.
- **compact-resume only restores a snapshot written for this compaction.** A snapshot older than 15 minutes is skipped as stale, even when its session id matches.
