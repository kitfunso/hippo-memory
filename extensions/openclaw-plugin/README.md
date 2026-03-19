# Hippo Memory - OpenClaw Plugin

Biologically-inspired memory for OpenClaw agents. Memories decay by default, retrieval strengthens them, errors stick longer, and sleep consolidation compresses episodes into patterns.

## Install

```bash
# Install directly from npm
openclaw plugins install hippo-memory
openclaw plugins enable hippo-memory

# Or link the local plugin folder for development
openclaw plugins install -l ./extensions/openclaw-plugin
```

If you prefer manual file copy instead of the plugin installer:

```bash
cp -r extensions/openclaw-plugin ~/.openclaw/extensions/hippo-memory
```

## Configure

Add to `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "hippo-memory": {
        enabled: true,
        config: {
          budget: 1500,          // token budget for context injection
          autoContext: true,     // auto-inject memory at session start
          autoLearn: true,       // auto-capture errors
          autoSleep: false,      // auto-consolidate after heavy sessions
          framing: "observe"     // observe | suggest | assert
          // root: "C:/path/to/workspace/.hippo" // optional override
        }
      }
    }
  }
}
```

Restart the gateway after enabling.

## What It Does

### Auto-context injection

At every session start, hippo automatically injects relevant project memories into the system prompt. No manual `hippo context` needed. The agent sees memories from past sessions without any explicit tool calls.

By default the plugin runs Hippo from the current agent workspace, so Hippo uses that
workspace's local `.hippo/` store and automatically merges any global `~/.hippo/`
store during `recall` / `context`. You only need `config.root` if you want to
override workspace auto-detection.

### Agent tools

The plugin registers these tools for the agent to call:

| Tool | Description |
|------|-------------|
| `hippo_recall` | Search memories by topic (always available) |
| `hippo_remember` | Store a new memory (always available) |
| `hippo_outcome` | Report if recalled memories helped (always available) |
| `hippo_status` | Check memory health (optional, enable in tools.allow) |
| `hippo_context` | Smart context from git state (optional, enable in tools.allow) |

### How it differs from claude-mem

| | Hippo | claude-mem |
|---|---|---|
| Decay | Yes, 7-day half-life | No, saves everything |
| Retrieval strengthening | Yes | No |
| Outcome feedback | Yes | No |
| Cross-tool | Claude Code, Codex, Cursor, OpenClaw | Claude Code only |
| API calls | Zero | Uses Claude API for compression |
| Token cost | ~1500 tokens/session (configurable) | Variable |
| Memecoin | No | Yes ($CMEM on Solana) |

## Requirements

- `hippo-memory` CLI installed globally: `npm install -g hippo-memory`
- A `.hippo/` directory in your workspace: `hippo init`
- Optional shared global store: `hippo init --global`
