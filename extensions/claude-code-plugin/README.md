# Hippo Memory - Claude Code Plugin

One memory for every agent you'll ever use. Hippo writes what you teach a coding agent into a store in your repo, and your other agents read that same store.

The plugin keeps what comes up as you work, such as a rule you stated, a tool call that failed or a fact that changed, and puts it back in front of Claude Code in later sessions. It is the alternative to the hooks `hippo init` installs. Use one, not both.

## Install

### From the marketplace

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

Initialize in your project. `--no-hooks` leaves the hooks to the plugin:

```bash
cd your-project
hippo init --no-hooks
```

## What It Does

The per-prompt hook injects pinned rules and matching memories, so the plugin no longer runs a context call at session start.

### Pinned rules on every prompt

The `UserPromptSubmit` hook runs `hippo context --pinned-only --include-recent 5 --format additional-context`, so pinned memories stay in context through long sessions, with up to 5 memories that share words with the prompt. Set `{"pinnedInject":{"promptRecall":false}}` in `.hippo/config.json` for the five newest writes instead.

### Your rules at session start

The `SessionStart` hook runs `hippo session-rules`, which prints the rules you stated to this project as session context and nothing else. It prints nothing when there are none.

### Auto-capture errors

The `PostToolUseFailure` hook runs `hippo capture-error`, which reads the failure Claude Code sends on stdin and saves the tool name and error (first 200 characters) as an error memory (2x half-life), marked `observed` because nobody verified it. Routine failures are skipped: interrupts, permissions you declined, "permission denied" errors from the system, searches that found nothing, and `grep`/`find`/`diff`-style commands exiting 1. A failure already captured is not stored twice. Every failure, stored or skipped, is also logged for `hippo failures`: the session, the tool and hashes of the error, never its text. A hash is not anonymous, since anyone who guesses an error's text can check it against the hash. The log keeps 90 days. `hippo hook install claude-code` installs the same hook, so both install routes behave alike.

### Working state and memories across compaction

The `PreCompact` hook runs `hippo pre-compact` to record the compaction, snapshot the working state and ask the summariser to end its summary with a "Memories for hippo" list. After compaction, `hippo compact-resume` puts that snapshot back into context, and `hippo post-compact` (the `PostCompact` hook) saves the list as memories that sleep never deletes and tells you how many. `hippo sleep` finishes any save a busy store delayed.

### Sleep at session end

The `SessionEnd` hook runs `hippo session-end`, which starts a detached `hippo sleep` and `hippo capture --last-session` and writes their output to `~/.hippo/logs/last-sleep.log`. The next session start prints that log through `hippo last-sleep` on stderr, so the log stays out of the model's context. To see what was consolidated, start `claude --debug` and read `~/.claude/debug/<session-id>.txt`. When the last sleep failed or a compaction summary was set aside, you see one line on screen that points you to `hippo doctor`.

### MCP tools

The plugin's `.mcp.json` starts `hippo mcp` as the MCP server `hippo-memory`, so Claude can call `hippo_recall`, `hippo_context`, `hippo_remember` and the other hippo tools directly.

### Read-only mode

Start Claude Code with `HIPPO_READ_ONLY=1` to use a store without changing it, for example in the test phase of a benchmark. Recall, context, the prompt hook and the MCP read tools answer as before and write nothing. `hippo_remember`, `hippo_outcome`, `hippo_learn`, `hippo_resolve` and `hippo_share` return `read-only: not saved (HIPPO_READ_ONLY=1)`. The capture, compaction and session-end hooks log one line and do nothing, so no sleep starts.

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
  .mcp.json              # Starts hippo mcp as the hippo-memory MCP server
  README.md
```

## Model calls

Storing a memory makes no model call. The exception is `hippo sleep`, which sends text to Anthropic when `ANTHROPIC_API_KEY` is set, and `{"extraction":{"enabled":false}}` turns it off.
