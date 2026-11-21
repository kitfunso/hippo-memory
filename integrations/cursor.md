# Hippo + Cursor Integration

The hippo-memory Cursor plugin (`extensions/cursor-plugin`) installs the rule and MCP server below for you. Use this page for a setup without the plugin.

Add this to `AGENTS.md` in the project root. Cursor reads that file as an alternative to `.cursor/rules`, and its rules docs no longer mention `.cursorrules`. Cursor gets this instruction block and hippo's memory tools over MCP. That is lighter than the hooks Claude Code gets, and MCP access alone doesn't capture a session.

---

## AGENTS.md snippet

```
## Memory System (Hippo)

One memory for every agent you'll ever use. Hippo writes what you teach a coding agent into a store in your repo, and your other agents read that same store.
Unused memories fade, each recall keeps one longer, and errors last twice as long.

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

The --error flag doubles the half-life, so the lesson lasts twice as long.

### After each task

Report whether the recalled memories were useful:

  hippo outcome --good    # they were relevant and helpful
  hippo outcome --bad     # they were wrong or off-topic

Good marks make a memory last longer, and bad marks make it fade faster.

### When a stored fact is no longer true

  hippo supersede <id> "<the new fact>"

The old memory leaves recall but stays on record.

### If .hippo/ doesn't exist

  hippo init

Then start remembering.
```

---

## Setup

1. Install Hippo globally: `npm install -g hippo-memory`
2. In your project root: `hippo init` (patches `AGENTS.md` if the project has one; it never creates the file)
3. Or add the snippet above to `AGENTS.md` yourself, or run `hippo hook install cursor` once the file exists
4. Add hippo to `.cursor/mcp.json` for the memory tools:

   ```json
   {
     "mcpServers": {
       "hippo-memory": {
         "command": "hippo",
         "args": ["mcp"]
       }
     }
   }
   ```

   With no global install, `"command": "npx", "args": ["-y", "hippo-memory", "mcp"]` works too. The [MCP server docs](../extensions/mcp/README.md) list all 13 tools.
5. Optionally add `.hippo/` to `.gitignore` if you don't want to track memory in git (or commit it to share memory with your team)

Older hippo versions wrote their block to `.cursorrules`. `hippo hook uninstall cursor` removes it from there. In `AGENTS.md` it removes only Cursor's own unedited block; a block written for Codex or another agent stays, since Cursor reads it too, and so does an edited block, since hippo cannot tell whose it is. If that took Cursor's block out of `AGENTS.md`, run `hippo hook install cursor` to put it back.

## Bring your Cursor rules

```bash
hippo import --cursor .cursor/rules --dry-run
hippo import --cursor .cursor/rules
```

The import reads every `.mdc` and `.md` file under `.cursor/rules`, and an older single `.cursorrules` file, and turns them into memories your other agents can recall. Run the dry run first to see what it would add.

## Token budget guidance

| Task type | Suggested budget |
|-----------|-----------------|
| Quick fix | `--budget 1000` |
| Feature work | `--budget 2000` |
| Full session | `--budget 4000` |
| Big refactor | `--budget 6000` |

Adjust based on how much context you want injected before starting work. The budget counts
everything recall prints, headings and tags included.
