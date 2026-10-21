### Added

- **A `Context` from `hippo-memory/server` takes an optional `infra`: the machine, the model and the embedder its calls use.** A `Context` without one gets the real ones, as before, so existing integrators change nothing; a test or host can pass its own model or embedder instead of the Anthropic API and the configured provider.

### Changed

- **Domain code reaches git, the LLM and the embedder through ports, and a new `src/infra` layer holds the adapters.** The git runner, the machine and the Anthropic adapter moved from `src/base/util` to `src/infra`; `layers.json` places `infra` above `domain` and below `api`, so domain code cannot import an adapter. `scripts/check-domain-io.mjs` now has no exempt file: any `src/domain` or `src/api` file that imports `fs` or `child_process` fails it.
- **`hippo-memory`'s `consolidate` keeps its `fetcher` option.** It now builds the model from `ANTHROPIC_API_KEY` and `fetcher` at the package edge and hands the domain an `Llm`.

### Fixed

- **A failed local embedding stays visible.** The first failure for a model warns, and every 100th repeat warns again with its count; before, the repeats went to debug only.
- **Every LLM failure kind logs its own fields.** An HTTP failure logs its status and a transport failure its error class, cause chain and errno name; before, only the transport kind logged any fields.
