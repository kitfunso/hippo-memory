# Hippo Memory for Cursor

One memory for every agent you'll ever use. Hippo writes what you teach a coding agent into a store in your repo, and your other agents read that same store.

## What it adds

- **MCP server.** `mcp.json` starts `npx -y hippo-memory mcp`, which gives the agent hippo's 13 memory tools. You need Node.js 22.16 or later.
- **Rule.** `rules/hippo-memory.mdc` always applies. It tells the agent to call `hippo_context` at the start of a task, `hippo_remember` when it learns something or hits an error, and `hippo_outcome` at the end.

The plugin has no hooks. Claude Code gets hooks that load memories into each prompt and save lessons at session end. In Cursor the agent calls the tools itself, as the rule tells it to.

## Store

Memories stay on your machine. If the project has no store, the MCP server makes a global store in `~/.hippo`. To keep the store in the repo, run this once in the project root:

```bash
npx -y hippo-memory init
```

## Test it locally

1. Copy this folder to `~/.cursor/plugins/local/hippo-memory`.
2. Run **Developer: Reload Window**.
3. Open **Customize** and check that the `hippo-memory` rule and MCP server are there.

## Other routes

`integrations/cursor.md` in this repo shows the `AGENTS.md` block and the `.cursor/mcp.json` entry, for a setup without the plugin.
