### Changed

- **`hippo audit --limit` refuses a value that is not a whole number, like every other list verb.** `--limit 1e3` used to read as 1 and `--limit 12.5` as 12; both now exit with the shared "Must be a positive integer" message. The default (100) and the ceiling (10000) are unchanged.
- **`hippo slack backfill` waits for the backfill and exits 3 on failure through the normal exit path.** `--since` is still accepted; the command now prints one note that the backfill resumes from the saved cursor and ignores it.
