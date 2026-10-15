### Changed

- **`stats.json` can now lag the database by up to one second.** The counters in the database update at once; the mirror file is rewritten at most once a second per store and flushed when the store closes and when the process exits.
- **Near-duplicate and invalidation checks read candidate rows through the full-text index** instead of scanning every row's text, and quality repair reads a store's rows once per plan.
- **`runWatched` no longer takes a `shell` option; `hippo watch --shell` uses the new `runWatchedLine`.** The `RunWatchedOptions` type is gone.
