### Changed

- **`hippo serve` writes a per-start key to `server.key` for the CLI on its machine, and no request is let in without a key.** `HIPPO_ALLOW_KEYLESS_LOCAL` and `HIPPO_REQUIRE_AUTH` are gone; connector text is always framed as untrusted, the GitHub replay hold outlives the event log's keys, a repository two tenants registered routes to neither, a POST is not retried on 5xx, and text log values with spaces are quoted. See `docs/UPGRADING-3.0.md`.
