### Changed

- **Walks over every row no longer sort the whole store for each page.** Sleep, the half-life move, auto-share, global sync, the eval loader and the every-tenant memory listing read each tenant's rows on the tenant index and merge them, so each page holds the same rows in the same order as before. A full re-embed, the vector backfill and a particle reset need each row once, not time order, so they now page by memory id on the primary key. On a store with many rows these walks no longer slow down with the square of the row count.
