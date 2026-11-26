# Connector command runner: one published entry runs the slack and github verbs on a handed store

Date: 2026-11-26
Status: accepted
Links: `docs/decisions/2026-11-20-server-tier-exports.md`; `changelog.d/feat-connector-cli-runners.md`; `src/server.ts` (`runConnectorCommand`); `src/cli.ts` (`runConnectorCommandIn`); `src/surface/cli/connector-source.ts`; `tests/connectors/slack-cli.test.ts`; `tests/store/github-cli.test.ts`; `tests/server/server-subpath-exports.process.test.ts`

## Context
hippo-enterprise serves hippo from Postgres. Its webhooks park dead letters there, and Slack workspaces and backfill cursors live there too. The operator verbs `slack backfill`, `slack dlq list|replay`, `slack workspaces add|list|remove`, `github backfill` and `github dlq list|replay` each built their store from the CLI's folder, so they only ever opened hippo.db. On a Postgres install an operator could not list, replay or backfill.

## Constraints and evidence
- The 2026-11-20 record keeps `hippo-memory/server` to the add-on API and the worker embed, and says each name is a semver promise.
- The handlers print with `console.log` and stop with `CliExit`. A caller that runs one needs the CLI's flag table, help text and exit-code table with it.
- A verb's actor is its own CLI admin actor (`cli:slack-backfill`, `cli:github-backfill`, `cli:github-dlq-replay`). Audit rows should read the same on every store.

## Decision
- `hippo-memory/server` adds `runConnectorCommand(ctx, argv)` and the type `ConnectorCommandContext`. This amends the 2026-11-20 record, which listed `embedAll` and `folderIndex` as the last server additions.
- `ctx` carries `tenantId`, `store`, `config`, and optionally `infra`, `callers` and `detached`. It has no actor. The runner resolves to the exit code the CLI would set. A store without `connectorWrites` or `connectorEvents` rejects with `StoreNotPortedError`, as the verb table already says the verbs need them.
- The handlers take a `ConnectorSource` in place of a folder. `cliConnectorSource` opens hippo.db lazily, on the line that opened it before. `entryConnectorSource` hands back the caller's store.
- `server` imports `cli.js` on the first call to the runner, so importing `server` does not load `cli.js`.
- The same PR makes GitHub dead-letter replay route the tenant again from the payload's installation and repository, as the webhook and Slack replay do. This is listed under Fixed in the changelog.

## Guards the runner skips on purpose
The CLI's `main` and `runCli` run these before or around a verb. The runner runs the others (`parseArgs`, `--help` before any store is touched, the flag checks and the `--dry-run` refusal, the group check) through the same functions `main` calls.
- `--version` and the empty command: they are not connector verbs.
- `maybeRepairCodexWrapper`: it edits the user's Codex install, which a library call must not.
- The `HIPPO_READ_ONLY` stop: the slack and github rows set no `readOnly`, so `main` skips it for them too.
- `cliRequest` scoping: neither row is `scoped`.
- `runCliCommand`: it owns hippo.db's store runtime, and the caller's store has its own.
- `envTenant()`: the tenant is `ctx.tenantId`.
- `warnUnknownFlagValues`: it warns once per process about on/off variables with an unknown spelling, which is the CLI's start-up, not a call a host makes many times.
- The `isStoreBusy` to `STORE_BUSY_MESSAGE` mapping in `runCli`: the runner lets every error but `CliExit` reject as it was thrown, so the host decides how to show a busy store.

## Alternatives considered
- **Hippo-enterprise copies the verbs:** no new promise here, but the copy forks the parser, the help text and the exit codes, and each fix is made twice.
- **Export each handler and `ConnectorContext`:** the caller keeps control, but it publishes nine handlers and a context type that carries the actor and reach, each one a semver promise. The caller must also rebuild the flag checks to get the CLI's exit codes.

## Why one runner
One parser, one help text and one exit-code table serve the CLI and every host that embeds it. A change to a flag or an exit code lands once, and the host sees it on its next core pin.

## Consequences
- `runConnectorCommand` is a semver promise: the argv shape, the output text and the exit codes 0, 1, 2 and 3.
- Output goes to the process console. A host that wants it elsewhere must capture the console.
- A write starts auto-sleep only when `ctx.callers` carries an auto-sleep host. No CLI write starts one, since the CLI's callers start empty.

## Reconsider when
- A third connector, or another verb family, needs a handed store: widen the runner to a table of verbs instead of the two names.
