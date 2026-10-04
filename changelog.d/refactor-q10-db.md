### Changed

- **The nine longest functions in `src/db/` now fit under 80 lines.** `ensureContinuityTables` and the v30 and v32 to v38 migration `up` functions keep their SQL in named module constants, and v38 runs its table rebuild and its guard triggers as two helpers. Every migration sends the same SQL in the same order, and a fresh store's schema is unchanged.
