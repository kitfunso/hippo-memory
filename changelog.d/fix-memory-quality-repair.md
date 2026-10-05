### Fixed

- **Automatic capture keeps whole sentences instead of cutting them at commas.** A decision such as "we use pnpm, never npm, because the lockfile is pnpm-lock.yaml" is now stored complete. A sentence over 500 characters is skipped rather than cut.
- **Automatic capture stores one statement per line and never joins two turns.** Questions, quotes, table rows and indented code are skipped, and a capitalised line starts a new statement.
- **Automatic capture and sleep's derived memories refuse sentence fragments, raw tool output and routine build activity.** Sleep still merges, extracts and summarises short memories the checks are only unsure about, including a sentence that may or may not be cut off ("the branch it merges into").
- **Recent context holds rows hippo wrote to the same check.** Rows a person wrote keep the older, looser floor.
- **Git learning holds its lessons to the same check,** so a stripped release commit such as "bump build 78 for testflight deploy" is no longer stored.
- **A keyword inside brackets no longer makes a sentence a memory.** "The fallback (never used in prod) is slow" is not a rule; a keyword outside the brackets still counts.
- **A short rule or preference that names its object counts as specific,** so "Prefer pnpm" and "never use --force" are kept.
- **Sleep no longer extracts facts from trace rows or auto-promoted rows,** which hold structured records rather than statements.
- **The pre-compaction snapshot keeps the end of a long reply.** It no longer cuts each user turn at 500 characters and each reply at 2,000 before applying its overall cap, which keeps the newest text.

### Added

- **`hippo audit repair` previews cleanup of memories hippo wrote itself and applies it with `--apply`.** Only capture, git learning, compaction, consolidation and extracted rows are judged; hand-written, imported and person-edited memories never are. `--apply` moves only certain defects to dormant storage after writing a database backup, and lists uncertain ones for review. It writes no rejection records, so a person can still store the same text. Recovery is `hippo dormant restore <id>`, and a restored row is left alone on later runs.
