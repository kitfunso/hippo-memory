### Changed

- **Every store group is now required except `localFiles`, `vectorViews`, `readiness` and `lastRecall`.** A `HippoStore` missing any other group is a type error, so routes and MCP tools no longer gate on those groups and only the paths that need hippo.db's local files answer 501 on another store. `narrowStore`, `StoreWith<G>` and `ContextWith<G>` are gone from `hippo-memory/store-kit`: use `HippoStore`, `StoreContext` and, for the four optional groups, `requireGroup`. `docs/UPGRADING-3.0.md` has the rows.
