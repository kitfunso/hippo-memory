# Hippo Memory for VS Code

One memory for every agent you'll ever use. Hippo writes what you teach a coding agent into a store in your repo, and your other agents read that same store.

This extension adds Hippo's MCP server to VS Code. Copilot agent mode, and any other VS Code chat that uses MCP tools, can then recall and store memories. You edit no `mcp.json`.

## Requirements

- VS Code 1.101 or later.
- Node.js 22.16 or later on your PATH. The extension starts the server with `npx -y hippo-memory mcp`.

## Set up a project

Hippo reads the `.hippo/` store in the folder you open, or the nearest one above it. Create one once per project:

```bash
npm install -g hippo-memory
cd your-project
hippo init
```

`hippo init` also sets up hooks for the agents it finds. The [main README](https://github.com/kitfunso/hippo-memory#what-hippo-init-changes) lists every file it writes. Without a project store, Hippo uses your global store if you have one.

## Tools

| Tool | What it does |
|------|--------------|
| `hippo_recall` | Search memories by relevance, strength and recency |
| `hippo_remember` | Store a memory |
| `hippo_outcome` | Report whether recalled memories helped |
| `hippo_context` | Context for the current git state |
| `hippo_status` | Memory health check |
| `hippo_learn` | Scan git commits for lessons |

The server has more tools; [the MCP guide](https://github.com/kitfunso/hippo-memory/blob/master/extensions/mcp/README.md) lists them all.

## Links

- Website: https://hippo-memory.com
- Source and issues: https://github.com/kitfunso/hippo-memory
