### Changed

- **A flag that a command does not use now prints a warning.** `hippo recall "deploy" --archive` still runs and exits as before, and prints `hippo: ignoring unknown flag --archive. A later release will reject it.` on stderr. Nothing is refused that was accepted before, with one exception: `hippo last-sleep --keep=<value>` and `hippo embed --status=<value>` (or a bare `true` or `false` after either flag) now stop with `takes no value`, as every other switch already did. Before, `--keep=false` kept the log and `--status=false` showed the status.
