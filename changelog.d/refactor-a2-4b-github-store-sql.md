### Internal

- **The GitHub connector's SQL now lives in the store layer.** `src/store/connectors/github.ts` owns the event log, dead-letter queue, tenant routing and backfill cursor queries; the connector files hold no `.prepare(` call and open no database. No behaviour change.
