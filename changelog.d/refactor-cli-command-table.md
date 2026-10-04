### Changed

- **The CLI dispatches from a command table.** Each verb's handler, aliases and help text now sit in one entry, and `hippo --help`, `hippo <verb> --help` and the unknown-command message are built from it. Output is byte-for-byte the same, pinned by new golden snapshots of every help form. One edge case changes: `hippo hippo --help` printed the examples list and now prints the full usage, like any other unknown verb.
