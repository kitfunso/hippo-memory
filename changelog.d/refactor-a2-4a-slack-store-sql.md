### Changed

- **The Slack connector's SQL now lives in `src/store/connectors/slack.ts`.** Internal: the connector files call store functions with plain data and no longer open hippo.db themselves. No behaviour change.
