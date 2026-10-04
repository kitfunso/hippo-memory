### Fixed

- **Physics recall honours `--as-of`.** `physicsSearch` never applied the point-in-time filter to rows that had physics state or that the vector arm added, so `hippo recall --physics --as-of <date>` and `hippo explain` could return memories written after that date. Physics state holds only current positions and masses, so a query with `asOf` now ranks through the hybrid path, as it does without physics. Without `asOf`, superseded rows now leave the physics pool unless `includeSuperseded` is set, matching hybrid search.
