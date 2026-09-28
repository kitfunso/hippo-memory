# Installing hippo (for AI agents)

You are an AI agent asked to install hippo-memory for a developer or a team. Follow these steps in order, run every command yourself, and finish with the check in step 6. Stop and tell the user if a step fails; `hippo doctor` names the fix for each failure.

## 1. Check the prerequisite

```bash
node --version    # must be 22.16.0 or newer
```

If Node is older, stop and ask the user to upgrade Node. hippo has no other runtime dependency.

## 2. Install

```bash
npm install -g hippo-memory
```

No global installs allowed? Use `npx -y hippo-memory <command>` in place of `hippo <command>` everywhere below.

## 3. Create the project store and wire in the agent

In the root of the project the user works in:

```bash
hippo init
```

`hippo init` creates `.hippo/`, learns lessons from the repository's git history, and detects Claude Code, Codex, Cursor, OpenClaw, OpenCode and Pi. For each one it finds, it adds hippo to that tool's instruction file if the file exists, and it installs Claude Code's hooks and the OpenCode plugin. Codex session capture is opt-in: run `hippo hook install codex`. For many repositories at once: `hippo init --scan ~`.

For Claude Code, the plugin is an alternative to the hooks `hippo init` installs (use one, not both):

```bash
claude plugin marketplace add kitfunso/hippo-memory
claude plugin install hippo-memory@hippo-memory
```

## 4. Connect other MCP clients

Any MCP client can use hippo's MCP server over stdio. Claude Code:

```bash
claude mcp add hippo-memory -- hippo mcp
```

Other clients take a JSON entry like this in their MCP config file (for example `.cursor/mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hippo-memory": { "command": "npx", "args": ["-y", "hippo-memory", "mcp"] }
  }
}
```

The server exposes 13 tools; `hippo_context` at session start and `hippo_remember` for lessons are the two to use first.

## 5. Bring in what the team already knows (optional)

```bash
hippo import --claude CLAUDE.md          # existing Claude Code rules
hippo import --cursor .cursorrules       # existing Cursor rules
hippo import --markdown AGENTS.md        # any markdown notes; headings become tags
```

Each import supports `--dry-run`. Duplicates are skipped.

## 6. Verify

```bash
hippo doctor --json
```

`"ok": true` means the install works. Report any `warn` check to the user with its `fix`. A `fail` check exits with code 1; run its `fix` and check again.

## Rules while using hippo

- Never store secrets, API keys, tokens or personal data in a memory. hippo's secret detector blocks common formats; do not rely on it alone.
- Remember lessons, decisions and known dead ends, not transcripts.
- `hippo reject <memory-id>` marks a memory's value as wrong so it cannot come back; prefer it over deleting and re-deleting.
- `hippo tokens` shows how much memory text hippo has sent to agents.
