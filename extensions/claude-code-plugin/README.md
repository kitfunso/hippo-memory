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

### Pinned rules on every prompt

The `UserPromptSubmit` hook runs `hippo context --pinned-only --include-recent 5 --format additional-context`, so pinned memories and the five newest writes stay in context through long sessions.

### Auto-capture errors

The `PostToolUseFailure` hook runs `hippo capture-error`, which reads the failure Claude Code sends on stdin and saves the tool name and error (first 200 characters) as an error memory (2x half-life), marked `observed` because nobody verified it. Routine failures are skipped: interrupts, permissions you declined, "permission denied" errors from the system, searches that found nothing, and `grep`/`find`/`diff`-style commands exiting 1. A failure already captured is not stored twice. Every failure, stored or skipped, is also logged for `hippo failures`: the session, the tool and hashes of the error, never its text. A hash is not anonymous, since anyone who guesses an error's text can check it against the hash. The log keeps 90 days. `hippo hook install claude-code` installs the same hook, so both install routes behave alike.

### Working state across compaction

The `PreCompact` hook runs `hippo pre-compact` to snapshot the working state before the transcript is summarised. After compaction, `hippo compact-resume` puts that snapshot back into context, and `hippo post-compact` (the `PostCompact` hook) tells you what was saved.

### Sleep at session end

The `SessionEnd` hook runs `hippo session-end`, which starts a detached `hippo sleep` and `hippo capture --last-session` and writes their output to `~/.hippo/logs/last-sleep.log`. The next session start prints that log through `hippo last-sleep`, so you see what was consolidated.

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
    hooks.json           # SessionStart, UserPromptSubmit, PreCompact, PostCompact, PostToolUseFailure, SessionEnd
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
