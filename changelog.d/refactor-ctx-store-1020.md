### Changed

- **3.0 break: `Context.store` is required, and `HippoDbContext` and `StoreContext` are gone.** An api caller builds its store once and puts it on the `Context`; `sleep` on the package root and `authCreate`, `authCreateSelf`, `authRevoke` and `promptHookContext` on `hippo-memory/server` no longer open hippo.db under `hippoRoot` for a `Context` without one. Use `Context` where either name stood. `docs/UPGRADING-3.0.md` has the rows.
