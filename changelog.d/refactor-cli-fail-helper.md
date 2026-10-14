### Changed

- **Internal:** the CLI's 180 `printError(...)` plus `throw new CliExit(1)` pairs are now one `fail(...)` call from `src/cli/exit.ts`, with the same stderr text and exit code. `scripts/check-cli-fail.mjs` fails CI if the pair comes back.
