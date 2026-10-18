### Added

- **`hippo-memory/testing` now carries an eval kit: `initStore`, `writeEntry`, `loadAllEntries`, `loadEmbeddingIndex` and `ambientSecretAdmit`.** An eval seeds a store folder and reads it back through the published entry; `loadAllEntries` returns every tenant's rows.

### Changed

- **Only the SQLite adapter opens hippo.db from a folder.** The store openers moved from `dist/store/open.js` to `dist/store/sqlite/handles.js`, and folder forms such as `writeEntry`, `loadAllEntries` and `readEntry` left their `dist/store/*` modules. A script that imported them from there now imports the eval kit or `dist/store/sqlite/folder-forms.js`, and `scripts/check-store-port.mjs` fails on a new folder form above the adapter.
- **A session digest writes through the store the session-end hook holds, and reads its half-life from that hook's config.** An import writes each chunk through its target store and still refuses one chunk at a time.

### Fixed

- **`scripts/z1-replay.mjs` loads again.** It imported `ambientSecretAdmit` from an entry that no longer exported it; it now imports it from the eval kit.
