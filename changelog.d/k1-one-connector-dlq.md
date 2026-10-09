### Changed

- **The Slack and GitHub connectors now park failed webhooks through one dead-letter module.** `src/connectors/dlq.ts` holds the payload redaction, the unroutable-tenant value, the defaults and the replay result that each connector used to copy. Internal only, no behaviour change.
