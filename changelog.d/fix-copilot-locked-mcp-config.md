### Fixed

- **`hippo setup`, `hippo hook install copilot` and `hippo hook uninstall copilot` no longer stop when another program holds a Copilot or VS Code `mcp.json` open.** They now report that file as left unchanged and install the rest, as they already did for other file errors. Before, the command exited with an error and skipped the instructions. The cause was hippo's fallback write, which dropped the file error's code when it failed too.
