### Fixed

- **Automatic capture keeps whole sentences instead of cutting them at commas.** A decision such as "we use pnpm, never npm, because the lockfile is pnpm-lock.yaml" is now stored complete. A sentence over 500 characters is skipped rather than cut.
- **Automatic capture stores one statement per line and never joins two turns.** Questions, quotes, table rows and indented code are skipped, and a capitalised line starts a new statement.
- **Automatic capture and sleep's derived memories refuse sentence fragments, raw tool output and routine build activity.** Sleep still merges, extracts and summarises short memories the checks are only unsure about, including a sentence that may or may not be cut off ("the branch it merges into").
- **Recent context holds rows hippo wrote to the same check.** Rows a person wrote keep the older, looser floor.

### Added

- **`hippo audit repair` previews cleanup of memories hippo wrote itself and applies it with `--apply`.** Only capture, git learning, compaction, consolidation and extracted rows are judged; hand-written, imported and person-edited memories never are. `--apply` hides only certain defects, keeps dormant snapshots and a database backup, and lists uncertain ones for review. It writes no rejection records, so a person can still store the same text. Recovery is `hippo dormant restore <id>`, and a restored row is left alone on later runs.
