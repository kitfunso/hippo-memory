### Changed

- **Ambient context, dedupe, the sleep cycle and status reports no longer read the whole store.** Each of these reads now asks SQLite for the rows it needs, so the rows read follow the result and not the store size. Results are the same as before.
- **New memories store their `created` time as a UTC instant.** A time with an offset or with no zone is turned into the same moment in UTC when the row is written, so the newest-first ambient read stays on its index. Text that is not a date is kept as written.
- **Dedupe deletes its copies in batches.** Each batch is one transaction, and each deleted memory still gets its own audit row.
- **`hippo status` skips the per-particle read on a large physics store.** It counts the particles and averages their speed from one column, and loads each particle only while the energy line can still be printed.
