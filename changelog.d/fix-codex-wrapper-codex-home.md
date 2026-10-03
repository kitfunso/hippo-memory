### Fixed

- **The Codex wrapper now captures sessions when `CODEX_HOME` is set.** It read history and transcripts from `~/.codex` whatever Codex itself used, so a custom `CODEX_HOME` logged "skip capture"; it now resolves the folder at each launch.
