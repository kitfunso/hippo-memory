### Changed

- **Internal:** Slack and GitHub dead-letter queues now share one insert, list, get and mark-retried module (`src/store/connectors/dlq.ts`); SQL behaviour is unchanged.
- **Internal:** compaction replay steps take one options object and share one deadline-bounded loop.
