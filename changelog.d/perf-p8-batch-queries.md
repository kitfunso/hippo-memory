### Changed

- **Store passes that touched one row at a time now open the store once and read rows in batches.** `outcome`, `quarantineList`, `drillDown`, `importEntries`, `invalidateMatching`, churn tagging and dedupe used to open the store, or run a read, once per row. At 200 rows, `outcome` went from 401 store opens to 1 and from 18,639 SQL statements to 2,042, and `drillDown` went from 202 opens and 202 row reads to 1 open and 3 reads. The sleep conflict pass now updates and rewrites mirror files only for memories whose conflict list changed, where before it rewrote every row and every mirror file. `resolveConflict` rewrites two mirror files instead of all of them. Results, order, errors and per-row transactions are unchanged.

### Tests

- **`tests/per-row-query-counts.test.ts` counts the SQL each of those passes runs on a real store at 10 and 200 rows.** The counts must stay flat as rows grow, and all nine count tests fail against the previous code.
