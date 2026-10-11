### Changed

- **Timing guard widened.** `tests/elapsed-time-upper-bounds.test.ts` now flags any `.ms`, `*Ms` or `*_ms` name in an upper-bound matcher; the `t.wait.ms < 5000` check in the Codex session test became a lower bound on the timeout.
- **No-throw-only checks replaced.** The continuity self-heal, rollback guard and memory-value fit tests now assert the healed tables, the schema and floor meta, and finite in-range retention.
