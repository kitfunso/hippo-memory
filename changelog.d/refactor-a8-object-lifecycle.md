### Changed

- **Decisions and project briefs share one close, load-by-id and list.** Internal refactor: the new `src/objects/` holds the lifecycle once and each type describes itself as data; the other five typed objects follow. Function names, signatures, error text and audit rows are unchanged. One ordering change for direct SDK callers: `loadDecisions` with an unknown `status` now throws before the store is opened, as `loadProjectBriefs` already did (the HTTP route checks the status first, so its replies are unchanged).
