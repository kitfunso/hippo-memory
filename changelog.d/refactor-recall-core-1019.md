### Breaking

- **`graphExpandRecall` now takes `{ store, global? }` in place of `{ hippoRoot, globalRoot? }` and returns a promise.** Recall now ranks on the store it is given: the candidate pool, graph expansion and goal boosts read through it instead of opening hippo.db by folder. A store built on `hippo-memory/store-kit` must add three `GraphReads` methods: `entitiesForMemories`, `entitiesByIds` and `neighborRelations`. `docs/UPGRADING-3.0.md` has the row.
