### Fixed

- **A caught error keeps its class, cause and errno in the log.** No `catch` in `src` swallows an error it did not name: a best-effort probe goes through one named helper, and a failed `res.end()` is logged once per request. A stored JSON column or a pidfile that does not parse is read through a shape check, not a cast.

### Changed

- **A no-query context read pages the strongest rows its budget can pay for, not up to 2000 per store.** At 10,000 memories in each of two stores it reads about 700 rows instead of about 4,100, and the churn pass reads good-outcome times from a time range instead of a tenant's whole audit history. The graph viewer's layout looks at the nodes near each node, not every pair, so a 500-node graph needs about 17 times fewer pair visits.

### Security

- **The Slack replay window survives a restart.** The webhook held the signatures it had seen in memory, so a restart let a captured request through again. The hold now lives in hippo.db, one `meta` row per signature, and a claim deletes the rows that ran out. A store built on `store-kit` adds two `connectorEvents` methods; see `docs/UPGRADING-3.0.md`.
- **The previous Slack signing secret can expire.** Set `SLACK_SIGNING_SECRET_PREVIOUS_UNTIL` to an ISO date (`2026-12-01` means 00:00 UTC that day) or timestamp. From then on a request signed with `SLACK_SIGNING_SECRET_PREVIOUS` gets a 401 and the log carries one warning. A value that is no date closes the window too. With the variable unset, nothing changes.
- **A new API caller always gets a bucket of its own.** When the rate limiter's table is full, it drops the least recently used key, not the one that was asking, and no longer sends every unseen key through one shared bucket that one caller could drain. A caller that keeps asking stays throttled; one that goes quiet while 10,000 other keys arrive starts over.

### Removed

- **`hippo watch --shell` is gone.** No text you type reaches a shell now. A command line that passes `--shell` exits 1 and names the removal. To run a shell line, name the shell: `hippo watch -- sh -c "<line>"`, or `hippo watch -- cmd /c "<line>"` on Windows. `runWatchedLine` is deleted with it. See `docs/UPGRADING-3.0.md`.
