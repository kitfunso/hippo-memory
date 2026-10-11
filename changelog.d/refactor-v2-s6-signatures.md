### Changed

- **BREAKING: `resolveConflict`, `writeSessionEndHandoff` and the recall loader take options objects, and `afterWrite` leaves the published write options.** `loadRecallSearchEntries` is replaced at the root by `loadRecallEntries(hippoRoot, query, options)`. `hippo decide` and `hippo predict` now reject ids like `12abc` and `0x1`. `docs/UPGRADING-2.0.md` lists each change.
