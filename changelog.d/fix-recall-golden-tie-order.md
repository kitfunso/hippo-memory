### Tests

- **`tests/recall-surface-parity-golden.test.ts` no longer flakes on tied rows.** Its seed wrote rows with `updated_at` from SQLite's real clock, and recall breaks bm25 ties on `updated_at`, so the order of near-identical rows depended on where the seed loop crossed a second boundary. It failed in CI on macOS, Windows and Linux, blocked an npm publish, and failed 4 of 30 local runs. The seeded stores now give every row one fixed `updated_at`, the snapshots are unchanged, and 60 of 60 local runs pass.
