### Changed

- **Internal:** `hippo audit --fix` and the sleep audit delete their error rows in one transaction after one read of the id set, with the same forget rows and reasons as before.
- **Internal:** git learn builds the schema-fit tag counts once per batch instead of once per lesson; scores are unchanged.
- **Internal:** the vector arm and a new `physicsSearchIn` take the store as a required argument; only the exported `hybridSearch` and `physicsSearch` still fall back to hippo.db under `hippoRoot`.
