### Changed

- **Internal:** `hippo recall` now reads the store, the search helpers, the reranker registry and the global store through `src/api/recall-cli.ts`, and takes its tenant from the dispatch context. No output, exit code or written row changes.
