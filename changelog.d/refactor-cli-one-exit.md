### Changed

- **Internal:** a CLI command that stops early now throws one typed error (`CliExit`) and `runCli` is the one place that turns it into the exit code, so every caller's cleanup runs on the way out. Output, streams and exit codes are unchanged. A new CI check, `scripts/check-process-exit.mjs`, fails on a `process.exit` call in `src/` outside a short list of files.
