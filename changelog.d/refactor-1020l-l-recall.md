### Changed

- **`hippo recall` rejects a bad `--hops`, `--max-neighbors`, `--reranker`, `--reranker-top-k`, `--salience-threshold`, `--outcome` or `--layer` before it ranks.** It prints only the flag error and writes no goal-stack recall log row. Recall and context now keep each client's last-shown ids in the api, keyed by the new `Context.clientKey`; see `docs/UPGRADING-3.0.md`.
