### Added

- **`runConnectorCommand(ctx, argv)` on `hippo-memory/server` runs the `slack` and `github` CLI verbs on a store the caller hands in.** It takes the argv without the program name, such as `['github', 'dlq', 'replay', '12', '--force']`, and uses the CLI's own flags, help, output and exit codes. It resolves to that exit code. A store without the connector groups rejects with `StoreNotPortedError`. The type `ConnectorCommandContext` names what it takes: `tenantId`, `store`, `config`, and optionally `infra`, `callers` and `detached`.

### Fixed

- **GitHub dead-letter replay routes the tenant from the payload's installation and repository, as the webhook does.** Replay used to ingest every row into the caller's tenant. On an install with route rows, a replayed row now lands in the tenant today's routes name, or stays parked as `unroutable` (the retry count rises and nothing is ingested) unless `GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK` is set. An install with no route rows replays into the caller's tenant, as before.
