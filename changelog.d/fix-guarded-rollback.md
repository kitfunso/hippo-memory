### Fixed

- **Original error survives a failed transaction.** Ten catch-side rollback calls could themselves throw when SQLite had already discarded the transaction or savepoint, masking the real failure (disk full, I/O error) with `cannot rollback - no transaction is active` or `no such savepoint`. Each now uses the guarded form already used elsewhere in the codebase. The savepoint case reached `archiveRawMemory`, the GDPR raw-memory archive path.
