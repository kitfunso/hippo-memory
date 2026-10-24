### Fixed

- **OpenCode's session end now keeps a log.** The plugin hippo installs runs `hippo session-end --runtime opencode`, so the detached worker writes its sleep and capture lines, warnings included, to `~/.hippo/logs/last-sleep.log`, the file the plugin's `hippo last-sleep` shows at the next session start. Run `hippo hook install opencode` (or `hippo setup`) once to rewrite the plugin.
