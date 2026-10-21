### Changed

- **`MemoryConflict` in `hippo-memory/store-kit` names its fields in camelCase: `memoryAId`, `memoryBId`, `detectedAt` and `updatedAt`.** `hippo conflicts --json`, `hippo trace --json` and the conflict mirrors keep their snake_case keys. See docs/UPGRADING-3.0.md.
