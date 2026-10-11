### Changed

- **Incident opens check linked ids in one query per chunk.** `openIncidentRow` no longer runs one SELECT per linked memory; the first unheld link in input order is still the one refused.
- **The sleep-cycle summary rebuild reads all children in one query per tenant chunk.** `rebuildDirtySummaries` calls `loadChildrenOfSummaries` once instead of `loadChildrenOfSummary` per summary; a summary whose child is itself queued is reread so it sees the rebuilt text.
