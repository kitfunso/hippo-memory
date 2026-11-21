### Fixed

- **`llms-install.md` names each client's own MCP config file.** Step 4 now lists Cline's `cline_mcp_settings.json` (`CLINE_MCP_SETTINGS_PATH`, then `CLINE_DATA_DIR`, and the IDE panel) beside Cursor and Claude Desktop, and tells the agent to write the file of the client it runs in. The step is now titled "Connect the client you are running in" and says it is required outside Claude Code. Before, Cline following the guide wrote hippo into `.cursor/mcp.json`, or skipped the step as optional, so Cline itself never got hippo's tools.
