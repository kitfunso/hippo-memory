### Changed

- BREAKING: **`hippo-memory/server` no longer exports `withSqliteAllowed`, `OtherStoreFolderError` or `__resetSessionRecallHistoryHttp`.** The reset hooks moved to the new `hippo-memory/testing` subpath, which is not for production code. The synchronous sqlite store (`sqliteSyncStore`, `storeFor`) is no longer reachable from a package entry. See `docs/UPGRADING-2.0.md`, "Server entry and test seams".
