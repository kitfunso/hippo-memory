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

Run the consolidation pass occasionally (or set it on a cron):

```bash
hippo sleep
```

This decays unretrieved memories, merges related episodes into patterns, and
removes entries below the strength threshold.

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

Hippo auto-detects Claude Code and patches `CLAUDE.md` with the hook block above. No copy-paste needed.

To skip auto-detection: `hippo init --no-hooks`

## Notes

- Hippo stores everything in `.hippo/` in your project root. It's markdown on disk. Commit it or gitignore it, your call.
- `--budget 3000` is a good default for Claude Code sessions. Increase for larger context tasks.
- If the project has no `.hippo/` yet, run `hippo init` first.
- For global memory across projects, initialize in `~/.hippo/` and call with `hippo --root ~/.hippo recall "..."`.
