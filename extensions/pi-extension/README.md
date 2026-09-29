# Hippo Memory - Pi Extension

Biologically-inspired memory for [Pi coding agent](https://github.com/badlogic/pi-mono). Memories decay by default, retrieval strengthens them, errors stick longer, and sleep consolidation merges related episodes into one memory.

## Install

```bash
# Install hippo CLI
npm install -g hippo-memory

# Init hippo in your project (or scan all repos)
hippo init
# or: hippo init --scan ~

# Copy extension to Pi's extensions directory
cp -r extensions/pi-extension ~/.pi/agent/extensions/hippo-memory
```

Or for project-level:
```bash
cp -r extensions/pi-extension .pi/extensions/hippo-memory
```

## What it does

| Automatic | When |
|---|---|
| Injects memory context | Session start |
| Captures tool errors | After any failed tool call |
| Learns from git | On `hippo sleep` (session end) |
| Consolidates memories | On `hippo sleep` (session end) |
| Shares to global store | On `hippo sleep` (session end) |

Error capture has three filters to prevent memory pollution:
1. Noise pattern filter (timeouts, ECONNREFUSED, etc.)
2. Per-session rate limit (max 5 error memories)
3. Per-session deduplication

## Tools

The extension registers 5 tools for the LLM:

| Tool | Description |
|---|---|
| `hippo_recall` | Search memories by topic |
| `hippo_remember` | Store a new memory |
| `hippo_outcome` | Report if memories were helpful |
| `hippo_status` | Check memory health |
| `hippo_context` | Smart context from git state |

## Config

Edit the `DEFAULT_CONFIG` object at the top of `index.ts`:

```typescript
const DEFAULT_CONFIG = {
  budget: 4000,           // Token budget for recall
  contextBudget: 1500,    // Token budget for auto-context
  framing: 'observe',     // observe | suggest | assert
  autoContext: true,       // Inject context at session start
  autoLearn: true,         // Capture tool errors
  autoSleep: true,         // Run consolidation on exit
  maxErrorsPerSession: 5,  // Error capture rate limit
};
```

## Requirements

- `hippo-memory` CLI installed globally: `npm install -g hippo-memory`
- `.hippo/` initialized in your project: `hippo init`
- Pi coding agent

## How it differs from the OpenClaw plugin

Sleep timing differs: the Pi extension runs `hippo sleep` on every exit (`autoSleep` is on by default), while the OpenClaw plugin's `autoSleep` is off by default and queues a sleep only after a session with 10 or more new memories. The Pi extension uses Pi's event system (`session_start`, `tool_result`, `session_shutdown`) instead of OpenClaw's hook system. Both use `execFileSync` with args arrays (no shell injection).
