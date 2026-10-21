### Changed

- **`KeyAudit` and `LastRecall` in `hippo-memory/store-kit` drop the methods only tests called.** `keyAudit.auditEventsAfter`, `keyAudit.auditHighId` and `lastRecall.applyTracedOutcome` are gone, with the `ListAuditAfterOpts` type, so a store built on store-kit no longer has to implement them; `docs/UPGRADING-3.0.md` lists what to use instead.

### Fixed

- **A by-id read now returns every id it is given.** `store.entriesByIds` read only the first 500 ids of a list, with no error, on hippo.db and on the memory store; both now read the whole list, so an outcome, a graph walk or a summary parent read over more than 500 ids no longer drops the rest.
