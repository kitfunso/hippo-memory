### Documentation

- **`evals/README.md` no longer tells you to set `embeddings.hybridWeight` in `.hippo/config.json`.** No command reads that key, so setting it changed nothing. The embedding weight is set per run with `hippo eval --embedding-weight`.

### Tests

- **Six test calls to `hippo recall` drop `--global`.** `recall` never read the flag and searches the global store anyway, so the tests check the same thing without the unknown-flag warning on stderr.
