### Added

- **Gemini CLI extension and Kiro power.** `gemini extensions install https://github.com/kitfunso/hippo-memory` adds hippo's MCP server to Gemini CLI, and the repo is now listed in the Gemini CLI extension gallery. Kiro users import `extensions/kiro-power` as a custom power.
- **Each npm release is listed in the official MCP Registry.** `npm-publish.yml` now runs `mcp-registry.yml` after a publish, which logs in by GitHub OIDC and publishes `server.json`; GitHub's MCP registry and other directories read from it. `gemini-extension.json` and `extensions/kiro-power/plugin.json` join the version lockstep.
