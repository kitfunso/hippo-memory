### Fixed

- **`hippo import` waits for its embedding backfill, and reports a failed one, before it returns.** The command, and a caller that runs it in process through `runCli`, used to get control back while the backfill still ran, so the command's store runtime closed under it and, on Windows, the backfill held `hippo.db` open past the command.
