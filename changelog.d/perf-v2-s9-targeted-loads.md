### Changed

- **Share, import and sync read text keys, not whole rows.** `autoShare` and the importers call `loadEntryTextKeys` (now takes an optional tenant) instead of loading every entry of the store.
- **`listMemories` reads a page at a time.** It returns the same rows in the same order, 1000 rows per query by default; `opts.pageSize` is new and additive.
- **Context candidates skip the decay sort under the cap.** `loadContextCandidates` counts the matches first and runs the julianday rank only when more rows match than the cap.
- **Recall writes go out one statement per 100 rows.** `strengthenRetrieved` updates the retrieval columns with one `UPDATE ... FROM` per chunk inside the same write scope.
- **Rejecting a value reads text columns first.** `applyRejection` finds holders from `id, content, source, scope` and reads whole rows only for the matches.
