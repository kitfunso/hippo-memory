### Changed

- **Internal: connector ingest and deletion run on the request's store.** The Slack and GitHub entry points read the event log, tenant routing and the dead-letter queue through an optional `connectorEvents` group on the store port, so a served store that has both connector groups takes webhook traffic. No behaviour changes on hippo.db.
