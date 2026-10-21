### Added

- **`hippo-memory/testing` exports `memoryStore()`, a second store adapter that keeps every required group in memory.** An add-on's tests can run the store port with no folder, and one conformance suite runs each required group, and the store's own methods, on hippo.db and on `memoryStore` alike.
