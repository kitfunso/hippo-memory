### Changed

- **3.0 break: `Context.config` is required, and the api reads no `config.json` of its own.** Each composition root (the CLI, `serve()`, the stdio and HTTP MCP servers) loads the config once per command or request and puts it on the `Context`; `reach.global` and `reach.globalTarget` carry the global store's config beside its store, and `getContext` takes the caller's project from its surface instead of reading the working folder. `hippo-memory/store-kit` now exports `loadConfig` and the `HippoConfig` type so an integrator can build one. `docs/UPGRADING-3.0.md` has the row.
