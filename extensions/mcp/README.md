# Hippo Memory MCP Server

MCP (Model Context Protocol) server for hippo memory. Works with any MCP-compatible client: Cursor, Windsurf, Cline, Claude Desktop, VS Code, etc.

## Setup

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hippo-memory": {
      "command": "hippo",
      "args": ["mcp"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hippo-memory": {
      "command": "hippo",
      "args": ["mcp"]
    }
  }
}
```

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "hippo-memory": {
      "command": "hippo",
      "args": ["mcp"]
    }
  }
}
```

### Windsurf / Cline / Any MCP Client

Same pattern: point at `hippo mcp` as the command.

## Tools

| Tool | Description |
|------|-------------|
| `hippo_recall` | Search memories by relevance, strength, and recency |
| `hippo_remember` | Store a memory (supports --error, --pin, --tag) |
| `hippo_outcome` | Report if recalled memories helped or not |
| `hippo_context` | Smart context from git state |
| `hippo_status` | Memory health check |
| `hippo_learn` | Scan git commits for lessons |
| `hippo_conflicts` | List detected memory conflicts |
| `hippo_resolve` | Resolve a conflict (keep winner, weaken/delete loser) |
| `hippo_share` | Share a memory to global store with transfer scoring |
| `hippo_peers` | List projects contributing to global store |
| `hippo_assemble` | Build an ordered context window for a session within a token budget |
| `hippo_drill` | Open a topic summary to see the memories it replaced |
| `hippo_predict_baserate` | Past track record for a class of predictions, to check an estimate |

## Prerequisites

```bash
npm install -g hippo-memory
cd your-project && hippo init
```
