### Changed

- **Pattern invalidation reads only rows that could match.** `hippo invalidate` and git learn prefilter rows in SQL on the pattern's words and tag, then run the same exact match, so a large store no longer decodes every row to weaken a few.
- **Internal:** the sleep-cycle summary rebuild reads one row past its cap instead of every dirty summary, and the maintenance store count is a SQL `COUNT(*)` instead of a full id list.
