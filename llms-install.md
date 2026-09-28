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

Tell the user what `hippo init` changes before you run it:

- `.hippo/` in the project, seeded on the first run with lessons from the last 30 days of git history.
- A hippo block in each instruction file that already exists, such as `CLAUDE.md` or `AGENTS.md`. It never creates one.
- When the project uses Claude Code, 7 hook entries in `~/.claude/settings.json`. When it uses OpenCode, a plugin at `~/.config/opencode/plugins/hippo.ts`.
- A daily 6:15am run, a crontab line on Linux and macOS or a scheduled task on Windows. It learns from each registered project's commits and runs `hippo sleep` there.
- On the first run, an import of this project's Claude Code auto memory, from its folder under `~/.claude/projects/`.

`--no-hooks` leaves out the instruction-file blocks and hooks, `--no-schedule` the daily run, and `--no-learn` the git history and auto memory import. Codex session capture is opt-in: run `hippo hook install codex`.

Run `hippo init --scan <folder>` only if the user asks to set up many repositories at once, and say first what it changes: every git repo in the folder and up to three levels below gets its own `.hippo/` store, seeded from a year of its git history, and the same user-level hooks and daily run go in. It patches no instruction file.

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
