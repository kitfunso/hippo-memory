### Changed

- **`hippo audit --limit` checks its value like every other list verb.** `12abc` and a bare `--limit` are now refused, and the ceiling is 1000 rows, the shared list limit, where it was 10000.
- **`hippo slack backfill` waits for the backfill and exits 3 on failure through the normal exit path.** `--since` is still accepted; the command now prints one note that the backfill resumes from the saved cursor and ignores it.
