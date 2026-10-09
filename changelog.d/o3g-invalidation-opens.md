### Changed

- Internal: invalidation no longer opens the database itself; its batch write, its churn tagging and its confirmed-outcome read are store functions in `src/store/entry-writes.ts` and `src/store/audit.ts`. No behaviour change.
