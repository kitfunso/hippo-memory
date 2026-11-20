### Added

- **Gemini CLI extension and Kiro power.** `gemini extensions install https://github.com/kitfunso/hippo-memory` adds hippo's MCP server to Gemini CLI, and the Gemini CLI extension gallery can now index the repo. Kiro users import `extensions/kiro-power` as a custom power.
- **Each npm release is listed in the official MCP Registry.** `npm-publish.yml` now runs `mcp-registry.yml` after a publish, which logs in by GitHub OIDC and publishes `server.json`; GitHub's MCP registry and other directories read from it. `gemini-extension.json` and `extensions/kiro-power/plugin.json` join the version lockstep.
- **VS Code extension.** `extensions/vscode` adds hippo's MCP server to VS Code through the MCP server provider API, so Copilot agent mode gets hippo's tools with no `mcp.json` edit. It is not on the VS Code Marketplace yet. Its `package.json` joins the version lockstep.
