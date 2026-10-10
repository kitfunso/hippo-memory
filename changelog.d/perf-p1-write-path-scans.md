### Changed

- **Internal:** the schema-fit check on every local remember reads only the tenant's newest 2000 rows instead of every row twice.
- **Internal:** invalidation writes its weakened rows in one transaction instead of one per row.
- **Internal:** project repair and the refine command fetch rows by id in one query instead of scanning all rows or reading one parent at a time.
