### Changed

- **Recall reads fewer rows and writes in batches.** The CLI no longer loads the whole index to mark global results, mirror sync pages through the store, recall traces use one multi-row insert, and the hot search queries reuse prepared statements.
