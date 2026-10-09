### Changed

- **The day length and the strength coefficients are named once.** Every inline milliseconds-per-day literal now reads `DAY_MS`, and `calculateStrength` and `strengthSql` share one set of coefficients. No behaviour change.
- **Recall, graph, compaction and agent-memory helpers take one options object instead of up to nine positional arguments.** Internal only; the published `loadRecallSearchEntries` keeps its signature. No behaviour change.
