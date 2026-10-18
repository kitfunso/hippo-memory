### Changed

- **3.0 break: `Context.config` is required, and the api reads no `config.json` of its own.** Each composition root (the CLI, `serve()`, the stdio and HTTP MCP servers) loads the config once per command or request and puts it on the `Context`; `reach.global` carries the global store's config beside its store. `hippo-memory/store-kit` now exports `loadConfig` and the `HippoConfig` type so an integrator can build one. `docs/UPGRADING-3.0.md` has the row.
