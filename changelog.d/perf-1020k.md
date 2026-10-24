### Fixed

- **A graph hop over more than 400 entities now returns at most `limit` relations in total, newest first, not `limit` for each batch of 400.** The delivery-event prune also deletes at most 1,000 rows per run, like the recall-trace prune.
