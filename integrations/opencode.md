# Hippo + OpenCode Integration

Four integration methods, from easiest to most powerful.

---

## 1. Auto-install (recommended)

```bash
hippo setup
```

Detects OpenCode at `~/.config/opencode/` and installs a plugin at `~/.config/opencode/plugins/hippo.ts`:

- When a session goes idle, the plugin runs `hippo session-end`. This spawns a detached child that runs `hippo sleep`, so the TUI teardown cannot SIGTERM it mid-consolidation. OpenCode passes no transcript, so hippo does not read OpenCode's conversation.
- When a session is created, the plugin runs `hippo last-sleep`.

To install manually: `hippo hook install opencode`. To also patch `AGENTS.md` in a project, run `hippo init` inside the project.

---

## 2. MCP Server

Add hippo as an MCP server in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hippo-memory": {
      "type": "local",
      "command": ["hippo", "mcp"]
    }
  }
}
```

This exposes 13 tools, listed in the [MCP server README](../extensions/mcp/README.md#tools).

---

## 3. Skill (progressive discovery)

Create a skill so the agent can invoke hippo recall on demand when stuck:

```bash
mkdir -p .opencode/skills/memory
```

Create `.opencode/skills/memory/SKILL.md`:

```markdown
---
name: memory
description: Search project memory for past errors, decisions, and lessons when stuck or hitting repeated failures
---

# Memory Recall

When you're stuck, repeating yourself, or hitting unexpected errors, search project memory:

\```bash
hippo recall "<describe what's going wrong>" --budget 2000 --why
\```

When you learn something important:

\```bash
hippo remember "<lesson>" --error
\```

When you make an architectural decision:

\```bash
hippo decide "<decision>" --context "<why>"
\```

After completing work:

\```bash
hippo outcome --good
\```
```

---

## Notes

- Hippo stores everything in `.hippo/` in your project root. Commit it or gitignore it.
- `--budget 1500` is a good default. Increase for larger context tasks.
- Run `hippo init` first if the project has no `.hippo/` yet.
- For global memory: `hippo init --global`
