### Added

- **Hippo is a Cursor plugin.** `extensions/cursor-plugin` holds a `.cursor-plugin/plugin.json`, an `mcp.json` that starts `npx -y hippo-memory mcp`, and an always-on rule that tells the agent when to call `hippo_context`, `hippo_remember` and `hippo_outcome`. `.cursor-plugin/marketplace.json` at the repo root points Cursor's marketplace and cursor.directory at it. The plugin manifest follows the package version, like the Kiro power.

### Fixed

- **The Claude Code marketplace entry now says plugin version 0.7.0.** `.claude-plugin/marketplace.json` still said 0.6.2 after the plugin moved to 0.7.0. A test now fails when the two differ.
