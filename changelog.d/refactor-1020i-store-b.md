### Changed

- **Each store read now lives on one group of `hippo-memory/store-kit`.** `entriesByIds`, `entriesPage`, `objectBackedAmong` and `textsHolding` were each declared on two to four groups with different argument orders, and `embeddingIndex.entryIdsPage` shared a name with a walk in another order; a store now sets each once, as `docs/UPGRADING-3.0.md` lists.
