# Hippo + OpenClaw Integration

This is an OpenClaw skill that wires Hippo into your agent sessions automatically.

Place this file at: `~/.openclaw/skills/hippo/SKILL.md`

---

## SKILL.md

```markdown
# Hippo Memory Skill

Hippo is a biologically-inspired memory system for AI agents. It decays old
memories, strengthens retrieved ones, and compresses repeated episodes into
patterns during consolidation passes.

## When to activate

Activate this skill when:
- The user starts a new coding or research session
- The user hits an error or production incident
- The user asks what the agent remembers
- The user asks you to save, remember, or note something
- The session is ending and there are things worth keeping

## Session start protocol

At the beginning of any session with a defined task, run:

```bash
hippo recall "<task description from user>" --budget 3000
```

Inject the output into your working context before responding. Do not summarize it.
Use it as direct context for the task.

If Hippo is not initialized yet:
```bash
hippo init
hippo recall "<task description>" --budget 3000
```

## During the session

When you discover something worth remembering:

```bash
hippo remember "<the lesson in 1-2 sentences>"
```

When the user hits an error:

```bash
hippo remember "<error: what failed, why, how it was fixed>" --error
```

The `--error` flag gives the memory 2x half-life. Production failures should
outlast routine facts.

When the user explicitly says "remember this" or "save this":

```bash
hippo remember "<exactly what they said>" --pin
```

`--pin` means no decay. Use it for permanent facts and preferences.

## Session end protocol

After completing work, apply feedback on the memories retrieved at session start:

```bash
hippo outcome --good   # if recalled memories were relevant
hippo outcome --bad    # if recalled memories were irrelevant or wrong
```

If the session produced 10 or more new memories, run a quick consolidation:

```bash
hippo sleep
```

## Checking memory state

```bash
hippo status           # overview: counts, strengths, last sleep
hippo inspect <id>     # full detail on one memory
```

## Manual controls

```bash
hippo pin <id>         # prevent a memory from decaying
hippo forget <id>      # force remove
hippo boost <id>       # manual strength increase
hippo sleep --dry-run  # preview consolidation without writing
```

## Storage

Hippo stores everything in `.hippo/` in the current project directory.
All files are markdown with YAML frontmatter. Git-trackable.

## Install check

If `hippo` is not in PATH:
```bash
npm install -g hippo-memory
```
```

---

## Optional: Global memory

To share memory across all projects (not per-project), initialize at the home level:

```bash
mkdir ~/.hippo
hippo init --root ~/.hippo
```

Then call with explicit root:

```bash
hippo recall "task description" --root ~/.hippo --budget 3000
```

This is useful for agent-level preferences and lessons that span projects.
