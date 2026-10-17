### Added

- **`scripts/token-eval/z0-author.mjs` runs one blind Z0 author.** It starts a `claude -p` session with an empty config, no hooks, no MCP servers, no hippo on PATH and no hippo or Codex env, and routes every request through the log proxy. The author's output is discarded when a request or the output names hippo, Z0 or the eval scripts (stage 2 plan D3). The launcher refuses a work or out path that names them, since Claude Code puts its working directory in the prompt.

### Fixed

- **The Z0 no-build dry-run test copies the whole `scripts/` tree.** It copied only `scripts/token-eval/`, so the runner's import of a shared script library failed in that test alone.
