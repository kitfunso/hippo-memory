### Changed

- **`forget` with no served store now checks reach and deletes under one write lock.** It used one database handle for the reach check and a second for the delete, so another writer could change the row between them. The check and the delete now share one handle and one transaction, as they already did through a served store.
- **`archiveRaw` with no served store now checks reach inside the write lock.** The reach check and the read of the raw row ran before the lock was taken. Both now run inside the archive's transaction, with or without an `afterArchive` hook.
- **`forget`, `supersede` and `archiveRaw` each have one implementation.** One body runs on the served store or on hippo.db through the `onStore` carrier. A served store still refuses `afterArchive`, because the hook writes on hippo.db's own handle inside the archive's transaction. Exported names and signatures are unchanged.
- **The store-port ratchet now counts the carrier's own store branch.** `scripts/check-store-port.mjs` counts a ternary on a local named `store` as well as on `ctx.store`, so the one branch left in `src/api/on-store.ts` shows in `storeBranches`.
