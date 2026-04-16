# Hippo + OpenClaw Integration

## Native plugin (recommended)

Install the native OpenClaw plugin directly from npm:

```bash
openclaw plugins install hippo-memory
openclaw plugins enable hippo-memory
```

This loads Hippo as a real OpenClaw plugin instead of relying only on prompt hooks.
The plugin resolves memory from the active workspace by default, so it uses the
workspace `.hippo/` store and automatically merges your shared `~/.hippo/` memory
during `recall` and `context`.

If you enable `autoSleep` in the plugin config, OpenClaw session-end
consolidation now runs in a detached background worker. The session can end
immediately while `hippo sleep` finishes in the background.

Daily cadence is separate. `hippo init` registers the workspace and installs a
single machine-level daily runner that sweeps every registered Hippo project at
6:15am. OpenClaw retrieval stays query-driven: the current workspace store and
the shared global store are searched together.

Recommended split:

- `autoContext: true` for session-start retrieval
- `autoLearn: true` for filtered in-session error capture
- `autoSleep: false` if you prefer a daily scheduler and zero session-end work
- `autoSleep: true` if you want per-session consolidation without blocking exit

## Auto-install (recommended)

If your project has a `.openclaw` directory or `AGENTS.md`, `hippo init` auto-detects and patches `AGENTS.md` with the memory hook. No extra steps.

```bash
cd my-project
hippo init
# Auto-installed openclaw hook in AGENTS.md
```

## Manual install

```bash
hippo hook install openclaw
```

Use this hook path if you want lightweight prompt injection without installing the
native plugin.

This appends a `<!-- hippo:start -->` ... `<!-- hippo:end -->` block to `AGENTS.md`:

```markdown
## Project Memory (Hippo)

At the start of every session, run:
hippo context --auto --budget 1500

On errors or unexpected behaviour:
hippo remember "<description of what went wrong>" --error

On task completion:
hippo outcome --good

After significant coding sessions:
hippo learn --git
```

To remove: `hippo hook uninstall openclaw`

## OpenClaw Skill (alternative)

If you prefer using OpenClaw's skill system instead of patching AGENTS.md, create this file:

**`~/.openclaw/skills/hippo/SKILL.md`**

```markdown
# Hippo Memory Skill

Biologically-inspired memory for AI agents. Decay by default, retrieval strengthening, sleep consolidation.

## When to activate

Always. Every session.

## Session start (MANDATORY)

Before doing any work, load relevant context:

hippo recall "<task description from user message>" --budget 3000

Use the output as direct context. Do not summarize or skip it.

## During the session

When you learn something worth keeping:
hippo remember "<lesson in 1-2 sentences>"

When you hit an error or discover a gotcha:
hippo remember "<what failed, why, how fixed>" --error

When the user says "remember this" or "save this":
hippo remember "<what they said>" --pin

## Session end

After completing work:
hippo outcome --good   # if recalled memories helped
hippo outcome --bad    # if recalled memories were irrelevant

If 10+ new memories were created this session:
hippo sleep
```

## Multi-repo git learning (cron)

Set up a weekly cron to scan all your repos:

```bash
hippo learn --git --repos "~/repo1,~/repo2,~/repo3" --days 7
hippo sleep
```

This extracts lessons from fix/revert/bug commits across all repos and consolidates them.

## Global memory

To share memories across all projects:

```bash
hippo init --global
hippo remember "API key rotation happens quarterly" --global
hippo recall "api keys" # searches local + global automatically
```
