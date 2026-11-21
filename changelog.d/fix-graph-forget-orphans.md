### Fixed

- **Deleting a memory now deletes the graph rows that only that memory backed.** Such a row used to lose its memory link and show in `GET /v1/graph` to callers who could not read the memory. Every relation that ends at a deleted entity goes too, whoever backs that relation, as a graph rebuild drops it. Core's own graph rebuild anchors every row to an object, so this reaches only rows written another way. Rows an older version left behind are hidden from every scoped reader, with no migration.

### Added

- **`hippo-memory/store-kit` exports `canReadScope`, `ScopeActor` and `GRAPH_ID_BATCH`.** An add-on store's graph view applies hippo.db's read rule and batch size with core's own code.
