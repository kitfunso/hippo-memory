### Changed

- **Internal:** sleep reads the whole store once after consolidation and shares that read, with the set of rows backing an object, between dedup, the quality audit and the ambient summary. A sleep now makes 2 whole-store reads, down from 3.
- **Internal:** `invalidateMatching` with `onlyId` reads that one row, scoped to the tenant, instead of every row the tenant holds.
- **Internal:** DAG fact clustering compares a fact only with facts that share an entity tag, through the overlap index, and returns the same clusters as the all-pairs scan.
- **Internal:** syncing the global store down reads id, tenant, text and source to decide what to copy, reads only those rows whole, and commits every copy in one transaction on one handle per store. A rejected value still skips only its own row and keeps its refusal audit row.
