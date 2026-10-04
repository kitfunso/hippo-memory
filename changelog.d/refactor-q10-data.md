### Changed

- **The 22 longest functions in the connectors, store, importers, capture and predictions code are split into named stages, each 80 lines or fewer.** This covers the Slack and GitHub webhooks, the DLQ replays, ingest and backfill, `resolveConflict`, `batchWriteAndDelete`, `applyRebuildResult`, `hippo capture`, the PreCompact hook, the importers and the prediction store. Behaviour does not change: the same SQL, transaction boundaries, write order, secret veto and retry rules. Their entries leave `.size-baseline.json`.
