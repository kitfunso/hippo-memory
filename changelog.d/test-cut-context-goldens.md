### Tests

- **`getContext` is pinned once, by ids a reader can check.** `tests/context-store-path-parity.test.ts` lists for each of its eight cases the entry ids in order, the token total, the blocks returned, the trace row count, the recall count in `stats.json` and the global-store rows counted as retrieved. The eight generated files in `tests/fixtures/context-store-path/` are gone, and so is the second pass that compared hippo.db with itself.
- **`tests/request-path-output-snapshot.test.ts` keeps only its MCP rows.** Its nine `getContext` snapshots stored every score to nine places on a generated store. Each option they covered has a named test elsewhere, and the snapshot file drops from 3,465 lines to 328.
