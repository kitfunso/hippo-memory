### Added

- **`consolidate()` on the package root takes a `HippoStore` as well as a folder.** An integrator's store is the store the pass changes; with no `options.config` it runs on the default config.

### Changed

- **`compactResumeForCaller` and `sessionEndHandoffForCaller` on `hippo-memory/server` return Promises.** They read and write through `ctx.store`'s `sessions` group, as `preCompactForCaller` already does; await them. See `docs/UPGRADING-3.0.md`.
- **Package-root `sleep(ctx)` auto-shares only into `ctx.reach.globalTarget`.** A `Context` without it skips the share; `hippo sleep` and `serve()` set it, so their behaviour is unchanged.
