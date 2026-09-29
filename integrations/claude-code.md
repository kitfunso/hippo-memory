# Hippo + Claude Code Integration

Add this block to your `CLAUDE.md` (project root or `~/.claude/CLAUDE.md` for global).

---

## CLAUDE.md snippet

```markdown
## Memory (Hippo)

Hippo manages project memory across sessions. It decays old memories, strengthens
retrieved ones, and compresses episodes into patterns during sleep cycles.

### At session start

Run this before starting any task:

```bash
hippo recall "<describe what you're about to work on>" --budget 3000
```

Inject the output into your working context. These are things worth knowing.

### During work

When you learn something non-obvious:

```bash
hippo remember "<the lesson in one or two sentences>"
```

When you hit an error or unexpected failure:

```bash
hippo remember "<what failed, why, and how you fixed it>" --error
```

The `--error` flag doubles the half-life. Production incidents don't quietly disappear.

When something is permanent and should never decay:

```bash
hippo remember "<important fact>" --pin
```

### At session end

After completing work, apply outcome feedback to the memories you retrieved:

```bash
hippo outcome --good   # the recalled memories were useful
hippo outcome --bad    # the recalled memories were irrelevant or wrong
```

This tightens the feedback loop. Good memories strengthen; irrelevant ones decay faster.

### Periodic maintenance

Consolidation runs automatically when Claude Code exits (via a `SessionEnd` hook in `~/.claude/settings.json`). This is installed by `hippo init`, `hippo setup`, or `hippo hook install claude-code`.

The hook runs `hippo session-end --log-file <path>`, which spawns a detached child process that runs `hippo sleep` then `hippo capture --last-session` in sequence and writes their output to `~/.hippo/logs/claude-code-sleep.log`. Detaching is the only way to survive the TUI teardown — otherwise Claude Code SIGTERM's the hook before consolidation finishes.

A companion `SessionStart` hook (installed automatically) prints that log on your next session start between `=== Previous session hippo consolidation ===` banners and clears it. It prints on stderr: Claude Code adds SessionStart stdout to the model's context, and the log is for you, not the model. To read it, start `claude --debug` and open `~/.claude/debug/<session-id>.txt`.

> **Migration from 0.22.x:** earlier releases installed two parallel SessionEnd entries (one for `sleep`, one for `capture`). They ran simultaneously and were both killed by the TUI before completion, so the log rarely had the `[hippo] sleep complete` / `[hippo] capture complete` lines. Re-running `hippo hook install claude-code` (or `hippo setup`) collapses them into the single detached `hippo session-end` entry. Also covers the pre-0.20.2 `Stop` hook that ran `hippo sleep` after every turn.

If you prefer manual control:

```bash
hippo sleep
```

This decays unretrieved memories, merges related episodes into one memory, and
moves faded memories to a dormant store, deleted after 180 days unless restored.

### Check memory health

```bash
hippo status
```
```

---

## Auto-install (recommended)

If your project already has a `CLAUDE.md`, just run:

```bash
hippo init
```

Hippo auto-detects Claude Code and:
1. Patches `CLAUDE.md` with hippo's own block, which is shorter than the snippet above
2. Adds 7 hooks to `~/.claude/settings.json`; the `SessionEnd` one runs `hippo sleep` on session exit

No copy-paste needed, no cron required.

To skip auto-detection: `hippo init --no-hooks`

## Notes

- Hippo stores everything in `.hippo/` in your project root. It's markdown on disk. Commit it or gitignore it, your call.
- `--budget 3000` is a good default for Claude Code sessions. Increase for larger context tasks.
- If the project has no `.hippo/` yet, run `hippo init` first.
- For global memory across projects, run `hippo init --global`. The global store defaults to `~/.hippo/` but respects `$HIPPO_HOME` and `$XDG_DATA_HOME/hippo`.
