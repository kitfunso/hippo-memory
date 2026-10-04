### Changed

- **Tests whose file names start with a, b or c now type-check.** Fixtures pass the required `baseHalfLifeDays`, API contexts use the real `Context` type, and a test that passed a tenant string as `deleteEntry` options no longer does. No runtime behaviour moved.
