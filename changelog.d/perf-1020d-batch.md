### Changed

- **An outcome now updates its memories' markdown files just after it answers, not before.** `hippo outcome` and `POST /v1/outcome` (up to 1000 ids) no longer write one file per memory while other writes wait; the files follow within about a second, at store close, or at process exit. If the process dies first, the store's next open rewrites them.

### Added

- **`hippo-memory/testing` exports `embedMemory(hippoRoot, entry)`.** It is the eval kit's folder form of the embedder, so a frozen eval script that holds a store folder can index a memory without building an embed target.
