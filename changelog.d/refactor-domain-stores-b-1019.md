### Breaking

- **A store built on `hippo-memory/store-kit` must add `GraphReads.storedGraph`.** Sleep's graph rebuild now reads the stored graph it diffs through the store instead of opening hippo.db by folder. `storedGraph(tenantId, memoryIds)` answers the tenant's entities and relations, each in id order, and the kind of each listed memory. `sqliteStore` already has it. `docs/UPGRADING-3.0.md` has the row.
