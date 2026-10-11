### Changed

- **`hippo recall` with a global store reads each store once.** The ranking reuses the candidates it already loaded instead of loading both stores a second time. Results are unchanged.
- **The ambient context backfill stops reading once it has enough rows.** When the newest rows are refused, it reads older rows in growing pages until it keeps the number it needs, instead of reading every remaining row. The rows it injects are unchanged.
- **The legacy store import keeps the newest 50 sleep runs,** the same cap every `hippo sleep` already applies, so `stats.json` matches the table from the first open.
- **Internal:** goal policies load in one query, the stats rewrite on every remember and recall reads at most 50 sleep runs, and a recall's audit rows, trace and retrieval updates commit in one transaction.
