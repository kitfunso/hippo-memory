# Hippo + Cursor Integration

Add this to your `.cursorrules` file in the project root.

---

## .cursorrules snippet

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
2. In your project root: `hippo init`
3. Add the `.cursorrules` snippet above
4. Optionally add `.hippo/` to `.gitignore` if you don't want to track memory in git (or commit it to share memory with your team)

## Token budget guidance

| Task type | Suggested budget |
|-----------|-----------------|
| Quick fix | `--budget 1000` |
| Feature work | `--budget 2000` |
| Full session | `--budget 4000` |
| Big refactor | `--budget 6000` |

Adjust based on how much context you want injected before starting work.
