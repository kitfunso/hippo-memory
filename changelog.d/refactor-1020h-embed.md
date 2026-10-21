### Changed

- **Domain code gets its embedder, its cross-encoder model and its HTTP through ports, and `src/infra` holds the adapters.** The embedding providers, the local embedder, the Transformers.js loaders and `fetchWithRetry` moved from `src/base` to `src/infra`; the rerankers and the judge take an `Http`, and an embedding target carries the `embedderFor` its root passed. `scripts/check-domain-io.mjs` now also fails a `src/domain` file that imports `src/infra` or an adapter module, or that calls `fetch`. Nothing a user runs behaves differently.
- **`Context.reach.globalTarget` carries `embedderFor`.** A host that builds its own `reach` may pass the resolver it wants; without one the context's embedder is used; a `Context` with no `reach` changes nothing.
