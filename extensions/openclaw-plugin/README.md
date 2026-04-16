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
          autoLearn: true,       // auto-capture errors (filtered, deduplicated, rate-limited)
          autoSleep: false,      // queue detached hippo sleep after heavy sessions
          framing: "observe"     // observe | suggest | assert
          // root: "C:/path/to/workspace/.hippo" // optional override
        }
      }
    }
  }
}
```

Restart the gateway after enabling.

`autoSleep` is off by default so consolidation does not compete with the live
session. If you turn it on, the plugin schedules `hippo sleep` in a detached
background process on `session_end` once the session has created at least 10 new
memories, then returns immediately to OpenClaw.

Strict daily consolidation does not depend on `autoSleep`. `hippo init` /
`hippo setup` install one machine-level daily runner that sweeps every
registered Hippo workspace and runs `hippo learn --git --days 1` followed by
`hippo sleep`.

## What It Does

### Auto-context injection

At every session start, hippo automatically injects relevant project memories into the system prompt. No manual `hippo context` needed. The agent sees memories from past sessions without any explicit tool calls.

By default the plugin runs Hippo from the current agent workspace, so Hippo uses that
workspace's local `.hippo/` store and automatically merges any global `~/.hippo/`
store during `recall` / `context`. You only need `config.root` if you want to
override workspace auto-detection.

### Session-end auto-sleep

When `autoSleep` is enabled, Hippo does not block OpenClaw shutdown waiting for
consolidation. The plugin records the session end event, spawns a detached
`hippo sleep` worker, and returns. If detached spawn fails, it falls back to the
old inline `sleep` path so consolidation still happens.

### Agent tools

The plugin registers these tools for the agent to call:

| Tool | Description |
|------|-------------|
| `hippo_recall` | Search memories by topic (always available) |
| `hippo_remember` | Store a new memory (always available) |
| `hippo_outcome` | Report if recalled memories helped (always available) |
| `hippo_status` | Check memory health (optional) |
| `hippo_context` | Smart context from git state (optional) |
| `hippo_conflicts` | List open memory conflicts (optional) |
| `hippo_resolve` | Resolve a conflict by keeping one memory (optional) |
| `hippo_share` | Share a memory to global store with transfer scoring (optional) |
| `hippo_peers` | List projects contributing to global store (optional) |

### Error capture filtering

When `autoLearn` is enabled, the plugin captures tool errors as memories. To prevent memory pollution from repetitive infrastructure noise, three filters are applied:

1. **Noise pattern filter.** Known transient errors (browser timeouts, image path restrictions, `ECONNREFUSED`, `ENOENT`, `Navigation timeout`, etc.) are silently skipped.
2. **Per-session rate limit.** Maximum 5 error memories per session. Prevents runaway error storms from flooding the store.
3. **Per-session deduplication.** The same error from the same tool is only captured once per session, even if it fires repeatedly.

Only genuinely novel, domain-specific errors make it through to `hippo remember`.

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
