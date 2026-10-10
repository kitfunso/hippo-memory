### Changed

- **A failed Slack signature check on `hippo slack dlq replay` now counts as a retry, like GitHub.** Both connectors now bump `retry_count` by one and stamp `retried_at` on every failed replay; Slack used to leave `retried_at` empty and skip the bump on `sig_fail`.
- **Internal:** the failed-replay bump lives once in `src/connectors/dlq.ts` (`failAndBump`), and each connector supplies only its table's `bump`.
