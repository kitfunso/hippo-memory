### Added

- **`createMemory` takes camelCase option keys.** The package-root `createMemory(content, options)` now accepts `emotionalValence`, `schemaFit`, `traceOutcome`, `sourceSessionId`, `validFrom`, `extractedFrom`, `dagLevel`, `dagParentId` and `artifactRef`, the spellings the rest of hippo uses; when both spellings are set, the camelCase one wins.

### Changed

- **The snake_case `createMemory` keys, the root `physicsSearch` export and the root SQLite handle exports are removed in 3.0.** The nine snake_case option keys (`emotional_valence` and the rest) keep working in 2.x and are marked `@deprecated` in the types, as are `physicsSearch` (physics ranking stays available by setting `physics.enabled` to `'auto'` or `true` in config) and `openHippoDb`, `openHippoDbReadOnly`, `closeHippoDb` and `DatabaseSyncLike`.
