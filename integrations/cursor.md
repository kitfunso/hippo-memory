# Hippo + Cursor Integration

Add this to `AGENTS.md` in the project root. Cursor reads that file as an alternative to `.cursor/rules`, and its rules docs no longer mention `.cursorrules`.

---

## AGENTS.md snippet

```
## Memory System (Hippo)

This project uses Hippo for biologically-inspired memory across sessions.
Memories decay. Retrieval strengthens them. Errors stick longer. Sleep consolidates.

### Before each task

Check what the project remembers about this area:

  hippo recall "<describe the task>" --budget 2000

Read the output. These are things worth knowing before you start.

### When you learn something

If you discover something non-obvious about this codebase, an API, or a workflow:

  hippo remember "<the insight>"

Keep it to one or two sentences. Concrete. Specific.

### When you hit an error

If something fails unexpectedly:

  hippo remember "<what failed and why>" --error

The --error flag doubles retention. Failed things should be remembered longer.

### After each task

Report whether the recalled memories were useful:

  hippo outcome --good    # they were relevant and helpful
  hippo outcome --bad     # they were wrong or off-topic

This trains the memory system over time. Good memories survive. Stale ones fade.

### If .hippo/ doesn't exist

  hippo init

Then start remembering.
```

---

## Setup

1. Install Hippo globally: `npm install -g hippo-memory`
2. In your project root: `hippo init` (patches `AGENTS.md` if the project has one; it never creates the file)
3. Or add the snippet above to `AGENTS.md` yourself, or run `hippo hook install cursor` once the file exists
4. Optionally add `.hippo/` to `.gitignore` if you don't want to track memory in git (or commit it to share memory with your team)

Older hippo versions wrote their block to `.cursorrules`. `hippo hook uninstall cursor` removes it from there. In `AGENTS.md` it removes only Cursor's own unedited block; a block written for Codex or another agent stays, since Cursor reads it too, and so does an edited block, since hippo cannot tell whose it is. If that took Cursor's block out of `AGENTS.md`, run `hippo hook install cursor` to put it back.

## Token budget guidance

| Task type | Suggested budget |
|-----------|-----------------|
| Quick fix | `--budget 1000` |
| Feature work | `--budget 2000` |
| Full session | `--budget 4000` |
| Big refactor | `--budget 6000` |

Adjust based on how much context you want injected before starting work.
