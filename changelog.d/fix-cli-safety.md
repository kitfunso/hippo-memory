### Fixed

- **A mistyped flag no longer runs a delete.** The CLI dropped flags it did not know, so `hippo forget <id> --dryrun` forgot the memory. An unknown flag on `audit`, `dedup`, `forget`, `invalidate`, `reject`, `resolve`, `sleep` or `supersede` now stops the run with exit code 2 and changes nothing. Other commands print a warning to stderr and run as before; a later release will reject the flag there too.
- **`--dry-run` on a command that has no dry run stops the run.** `hippo reject <id> --dry-run` rejected for real. Only `audit`, `capture`, `dedup`, `forget`, `import`, `invalidate`, `refine`, `setup` and `sleep` accept it, and `share`, `brief` and `project-brief` accept it only as `share --auto`, `brief refresh` and `project-brief refresh`. Any other command or form exits 2 and changes nothing.
- **`hippo forget --dry-run` previews.** It ignored the flag and deleted the memory. It now prints `Would forget <id>`, or `Would archive <id>` with `--archive`, and refuses in the same places the real run does: a missing id, a raw memory without `--archive`, a non-raw memory with it.
- **`hippo audit --fix --dry-run` previews.** It deleted every error-severity memory. It now lists them and prints `Would remove N error-severity memories`.
- **`hippo init --no-hooks` no longer repairs the Codex wrapper.** The check looked for `--no-hooks` among the positional arguments, where the parser never puts it, so the repair ran anyway.

### Changed

- **Importing `dist/cli.js` no longer runs the CLI.** The module ran whatever command line the importing process had. `bin/hippo.js` now calls the exported `runCli()`, and `node dist/cli.js` still runs as before.
- **`serve()` installs SIGINT and SIGTERM handlers only when asked.** It used to skip them by checking for `VITEST` in the environment. The new `handleSignals` option decides, and `hippo serve` is the one caller that sets it.

### Documentation

- **`HIPPO_REQUIRE_SERVER` guards four commands.** It stops the CLI from falling back to direct mode only for the writes the CLI sends to a running server: `remember`, `forget`, `forget --archive` and `promote`. Every other command opens the store directly, whether the knob is set or not.

### Internal

- **Removed six HTTP client calls nothing used.** `src/client.ts` now holds only those four writes.
