### Fixed

- **A crash or a full disk in the middle of a config write no longer leaves a truncated file.** `opencode.json`, the opencode plugin file, the workspace registry, `copilot-instructions.md`, the VS Code instructions file, the Codex wrapper files and the `AGENTS.md` / `CLAUDE.md` hook blocks were written in place, so an interrupted write left half a file that the tool could not parse. They now go through the temp-file-and-rename helper `settings.json` already used, so a reader sees the old file or the new one.
