### Added

- **`consolidate()` on the package root takes a `HippoStore` as well as a folder.** An integrator's store is the store the pass changes; with no `options.config` it runs on the default config.

### Changed

- **`compactResumeForCaller` and `sessionEndHandoffForCaller` on `hippo-memory/server` return Promises.** They read and write through `ctx.store`'s `sessions` group, as `preCompactForCaller` already does; await them. See `docs/UPGRADING-3.0.md`.
- **`bindSessionOwner` on `hippo-memory/server` returns a Promise and binds through `ctx.store.sessions`.** `bindSessionOwnerOn` is now a second name for it.
- **A store fills a written entry's missing `origin_project` itself.** The api no longer stamps the served folder's project first; `sqliteStore` already did this on every write, and now on a dormant restore too. Add-on stores: see `docs/UPGRADING-3.0.md`.
- **`keyWrites.listApiKeys` takes a null tenant for every tenant's keys**, which `hippo auth list` now reads through the port.
- **A store's `localFiles` group drops `hippoRoot` and `globalStore()`.** The caller names the folder, and the global store comes from `ctx.reach.globalTarget`. See `docs/UPGRADING-3.0.md`.
- **Package-root `sleep(ctx)` auto-shares only into `ctx.reach.globalTarget`.** A `Context` without it skips the share; `hippo sleep` and `serve()` set it, so their behaviour is unchanged.
