### Changed

- **BREAKING: a malformed `config.json` now stops hippo with the file path and the parse error.** It used to log one warning and run on the defaults, which dropped settings such as `sharedStore` without a trace. Fix the file or delete it; see `docs/UPGRADING-2.0.md`.

### Fixed

- **Silent failures now say so.** A session worker that cannot queue its request no longer runs unlocked, and a refused queue rename is logged. A reply from the Anthropic API with no text is a failure, not an empty success. Uninstalling hooks reports a settings file it cannot read. A local embedding or judge reply that fails logs a warning once. A memory that could not be indexed for search is logged and reported in the result of a local remember.
- **A fire-and-forget embed no longer re-embeds the whole store under the embed lock after a model change.** It leaves the old index and warns once; `hippo embed` does the rebuild.
- **Transport failures are classified by error class and syscall code, not by message text.**
- **The stdio MCP deadline now cancels a call's next step.** An aborted request stops before it reads or writes the store; a step already running is not interrupted.
- **Mirror files are written through a temp file and a rename,** so a crash cannot leave a half-written mirror.
