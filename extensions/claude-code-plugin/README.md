# Hippo Memory - Claude Code Plugin

Biologically-inspired memory for Claude Code. Memories decay by default, retrieval strengthens them, errors stick longer, and sleep consolidation compresses episodes into patterns.

## Install

### From marketplace (when published)

```
/plugin marketplace add kitfunso/hippo-memory
/plugin install hippo-memory
```

### Local install (development)

```bash
claude --plugin-dir ./extensions/claude-code-plugin
```

Or copy to your plugins directory:

```bash
cp -r extensions/claude-code-plugin ~/.claude/plugins/hippo-memory
```

## Prerequisites

Install hippo CLI globally:

```bash
npm install -g hippo-memory
```

Initialize in your project:

```bash
cd your-project
hippo init
```

## What It Does

### Auto-context at session start

The `SessionStart` hook automatically runs `hippo context --auto --budget 1500` when you start a Claude Code session. Relevant memories from past sessions appear in context immediately.

### Auto-capture errors

The `PostToolUseFailure` hook captures tool failures as hippo error memories (2x half-life). Next time someone hits the same error, the memory surfaces automatically.

### Auto-outcome on stop

The `Stop` hook runs `hippo outcome --good` when a session ends, strengthening the memories that were recalled during the session.

### Memory skill

Use `/hippo-memory:memory` to manually invoke the memory skill, or Claude will auto-invoke it based on context.

## Plugin Structure

```
claude-code-plugin/
  .claude-plugin/
    plugin.json          # Plugin manifest
  skills/
    memory/
      SKILL.md           # Memory skill (auto-invoked)
  hooks/
    hooks.json           # SessionStart, PostToolUseFailure, Stop hooks
  scripts/
    capture-error.sh     # Error capture script
  README.md
```

## How It Differs from claude-mem

| | Hippo | claude-mem |
|---|---|---|
| Memory model | Decay + retrieval strengthening | Save everything |
| API calls | Zero (all local) | Uses Claude API for compression |
| Cross-tool | Works across Claude Code, Codex, Cursor, OpenClaw | Claude Code only |
| Token cost | ~1500 tokens/session (configurable) | Variable |
| Outcome feedback | Yes (strengthens/weakens memories) | No |
| Error priority | 2x half-life for errors | No distinction |
| Memecoin | No | Yes ($CMEM on Solana) |
