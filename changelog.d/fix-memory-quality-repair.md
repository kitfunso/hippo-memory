### Fixed

- **Automatic capture keeps whole sentences instead of cutting them at commas.** A decision such as "we use pnpm, never npm, because the lockfile is pnpm-lock.yaml" is now stored complete. A sentence over 500 characters is skipped rather than cut.
- **Automatic capture and sleep's derived memories refuse sentence fragments, raw tool output and routine build activity.** Sleep still merges, extracts and summarises short memories the checks are only unsure about.

### Added

- **`hippo audit repair` previews cleanup of memories hippo wrote itself and applies it with `--apply`.** Only capture, autolearn, git learning, compaction, consolidation and extracted rows are judged; hand-written and imported memories never are. `--apply` hides only certain defects, keeps dormant snapshots and a database backup, and lists uncertain ones for review.
