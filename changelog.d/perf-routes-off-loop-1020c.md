### Added

- **An add-on route can set `loop: 'off'`.** Its handler then answers from the store's worker threads under `serve()`'s default store, and a hippo.db open on the server thread answers 501. Unset keeps the old behaviour. See `docs/UPGRADING-3.0.md`.

### Changed

- **`ambientCandidates` and `summaryWithDescendants` take their admission as data, so a store on a worker thread can answer them.** `hippo-memory/store-kit` exports `AmbientAdmission`, `DescendantAdmission` and the rules that apply them, `ambientRefusal` and `descendantAdmits`; `ambientCandidates` answers the rows it refused beside the rows it kept. See `docs/UPGRADING-3.0.md`.
- **Drill, outcome, context, sleep, both connector webhooks, `POST /mcp`, `GET /mcp/stream`, `/health` and `/ready` run no SQLite on the server thread.** Every store method but hippo.db's local files now has a worker, and the operator's global store a request reaches is served from worker threads too. `POST /v1/memories/:id/promote` and the `hippo_share`, `hippo_peers` and `hippo_resolve` MCP tools still run on the server thread.
