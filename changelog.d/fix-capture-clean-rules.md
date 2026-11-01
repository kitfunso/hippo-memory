### Fixed

- **Capture no longer stores a rule cut inside a bold label or an aside.** A line such as `- **Volume data.** Never backfill them.` now stores "Never backfill them", not "** Never backfill them". Text that still starts after the closing `**` of a bold span, or after the `)` of an aside, is refused as a sentence fragment.
- **The next daily run or `hippo sleep` sets the cut rows you already have aside once.** It takes a backup first, keeps pinned rows, and lists doubtful rows for review again with `hippo audit repair`. Bring one back with `hippo dormant restore <id>`.
