# 🦛 Hippo

**The secret to good memory isn't remembering more. It's knowing what to forget.**

[![npm](https://img.shields.io/npm/v/hippo-memory)](https://npmjs.com/package/hippo-memory)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```
Works with:  Claude Code, Codex, Cursor, OpenClaw, any CLI agent
Imports from: ChatGPT, Claude (CLAUDE.md), Cursor (.cursorrules), any markdown
Storage:     SQLite backbone + markdown/YAML mirrors. Git-trackable and human-readable.
Dependencies: Zero runtime deps. Requires Node.js 22.5+. Optional embeddings via @xenova/transformers.
```

---

## The Problem

AI agents forget everything between sessions. Existing solutions just save everything and search later. That's a filing cabinet, not a brain.

Your memories are also trapped. ChatGPT knows things Claude doesn't. Cursor rules don't travel to Codex. Switch tools and you start from zero.

---

## Who Is This For

- **Multi-tool developers.** You use Claude Code on Monday, Cursor on Tuesday, Codex on Wednesday. Context doesn't carry over. Hippo is the shared memory layer across all of them.
- **Teams where agents repeat mistakes.** The agent hit the same deployment bug last week. And the week before. Hippo's error memories and decay mechanics mean hard lessons stick and noise fades.
- **Anyone whose CLAUDE.md is a mess.** Your instruction file grew to 400 lines of mixed rules, preferences, and stale workarounds. Hippo gives that structure: tags, confidence levels, automatic decay of outdated info.
- **People who want portable AI memory.** No vendor lock-in. Markdown files in your repo. Import from ChatGPT, Claude, Cursor. Export by copying a folder.

---

## Quick Start

```bash
npm install -g hippo-memory

hippo init
hippo remember "FRED cache silently dropped the tips_10y series" --tag error
hippo recall "data pipeline issues" --budget 2000
```

That's it. You have a memory system.

### What's new in this build

- **SQLite-first storage** with markdown/JSON mirrors for humans and git
- **Active task snapshots** for bare `continue` recovery
- **Persistent stale-memory lifecycle** during `hippo sleep`
- **Conflict tracking** with `hippo conflicts` and `.hippo/conflicts/` mirrors

### Zero-config agent integration

`hippo init` auto-detects your agent framework and wires itself in:

```bash
cd my-project
hippo init

# Initialized Hippo at /my-project
#    Directories: buffer/ episodic/ semantic/ conflicts/
#    Auto-installed claude-code hook in CLAUDE.md
```

If you have a `CLAUDE.md`, it patches it. `AGENTS.md` for Codex/OpenClaw. `.cursorrules` for Cursor. No manual `hook install` needed. Your agent starts using Hippo on its next session.

It also sets up a daily cron job (6:15am) that runs `hippo learn --git` and `hippo sleep` automatically. Memories get captured from your commits and consolidated every day without you thinking about it.

To skip: `hippo init --no-hooks --no-schedule`

---

## Cross-Tool Import

Your memories shouldn't be locked inside one tool. Hippo pulls them in from anywhere.

```bash
# ChatGPT memory export
hippo import --chatgpt memories.json

# Claude's CLAUDE.md (skips existing hippo hook blocks)
hippo import --claude CLAUDE.md

# Cursor rules
hippo import --cursor .cursorrules

# Any markdown file (headings become tags)
hippo import --markdown MEMORY.md

# Any text file
hippo import --file notes.txt
```

All import commands support `--dry-run` (preview without writing), `--global` (write to `~/.hippo/`), and `--tag` (add extra tags). Duplicates are detected and skipped automatically.

### Conversation Capture

Extract memories from raw conversation text. No LLM needed: pattern-based heuristics find decisions, rules, errors, and preferences.

```bash
# Pipe a conversation in
cat session.log | hippo capture --stdin

# Or point at a file
hippo capture --file conversation.md

# Preview first
hippo capture --file conversation.md --dry-run
```

### Active task snapshots

Long-running work needs short-term continuity, not just long-term memory. Hippo can persist the current in-flight task so a later `continue` has something concrete to recover.

```bash
hippo snapshot save \
  --task "Ship SQLite backbone" \
  --summary "Tests/build/smoke are green, next slice is active-session recovery" \
  --next-step "Implement active snapshot retrieval in context output"

hippo snapshot show
hippo context --auto --budget 1500
hippo snapshot clear
```

`hippo context --auto` includes the active task snapshot before long-term memories, so agents get both the immediate thread and the deeper lessons.

---

## How It Works

Input enters the buffer. Important things get encoded into episodic memory. During "sleep," repeated episodes compress into semantic patterns. Weak memories decay and disappear.

```
New information
      |
      v
+-----------+
|  Buffer   |  Working memory. Current session only. No decay.
| (session) |
+-----+-----+
      |  encoded (tags, strength, half-life assigned)
      v
+-----------+
|  Episodic |  Timestamped memories. Decay by default.
|   Store   |  Retrieval strengthens. Errors stick longer.
+-----+-----+
      |  consolidation (hippo sleep)
      v
+-----------+
|  Semantic |  Compressed patterns. Stable. Schema-aware.
|   Store   |  Extracted from repeated episodes.
+-----------+

         hippo sleep: decay + replay + merge
```

---

## Key Features

### Decay by default

Every memory has a half-life. 7 days by default. Persistence is earned.

```bash
hippo remember "always check cache contents after refresh"
# stored with half_life: 7d, strength: 1.0

# 14 days later with no retrieval:
hippo inspect mem_a1b2c3
# strength: 0.25  (decayed by 2 half-lives)
# at risk of removal on next sleep
```

---

### Retrieval strengthens

Use it or lose it. Each recall boosts the half-life by 2 days.

```bash
hippo recall "cache issues"
# finds mem_a1b2c3, retrieval_count: 1 -> 2
# half_life extended: 7d -> 9d
# strength recalculated from retrieval timestamp

hippo recall "cache issues"   # again next week
# retrieval_count: 2 -> 3
# half_life: 9d -> 11d
# this memory is learning to survive
```

---

### Error memories stick

Tag a memory as an error and it gets 2x the half-life automatically.

```bash
hippo remember "deployment failed: forgot to run migrations" --error
# half_life: 14d instead of 7d
# emotional_valence: negative
# strength formula applies 1.5x multiplier

# production incidents don't fade quietly
```

---

### Confidence tiers

Every memory carries a confidence level: `verified`, `observed`, `inferred`, or `stale`. This tells agents how much to trust what they're reading.

```bash
hippo remember "API rate limit is 100/min" --verified
hippo remember "deploy usually takes ~3 min" --observed
hippo remember "the flaky test might be a race condition" --inferred
```

When context is generated, confidence is shown inline:

```
[verified] API rate limit is 100/min per the docs
[observed] Deploy usually takes ~3 min
[inferred] The flaky test might be a race condition
```

Agents can see at a glance what's established fact vs. a pattern worth questioning.

Memories unretrieved for 30+ days are automatically marked `stale` during the next `hippo sleep`. If one gets recalled again, Hippo wakes it back up to `observed` so it can earn trust again instead of staying permanently stale.

### Conflict tracking

Hippo now detects obvious contradictions between overlapping memories and keeps them visible instead of silently letting both masquerade as truth.

```bash
hippo sleep       # refreshes open conflicts
hippo conflicts   # inspect them
```

Open conflicts are stored in SQLite, mirrored under `.hippo/conflicts/`, and linked back into each memory's `conflicts_with` field.

---

### Observation framing

Memories aren't presented as bare assertions. By default, Hippo frames them as observations with dates, so agents treat them as context rather than commands.

```bash
hippo context --framing observe   # default
# Output: "Previously observed (2026-03-10): deploy takes ~3 min"

hippo context --framing suggest
# Output: "Consider: deploy takes ~3 min"

hippo context --framing assert
# Output: "Deploy takes ~3 min"
```

Three modes: `observe` (default), `suggest`, `assert`. Choose based on how directive you want the memory to be.

---

### Sleep consolidation

Run `hippo sleep` and episodes compress into patterns.

```bash
hippo sleep

# Running consolidation...
#
# Results:
#    Active memories:    23
#    Removed (decayed):   4
#    Merged episodic:     6
#    New semantic:        2
```

Three or more related episodes get merged into a single semantic memory. The originals decay. The pattern survives.

---

### Outcome feedback

Did the recalled memories actually help? Tell Hippo. It tightens the feedback loop.

```bash
hippo recall "why is the gold model broken"
# ... you read the memories and fix the bug ...

hippo outcome --good
# Applied positive outcome to 3 memories
# half_life +5d on each

hippo outcome --bad
# Applied negative outcome to 3 memories
# half_life -3d on each
# irrelevant memories decay faster
```

---

### Token budgets

Recall only what fits. No context stuffing.

```bash
# fits within Claude's 2K token window for task context
hippo recall "deployment checklist" --budget 2000

# need more for a big task
hippo recall "full project history" --budget 8000

# machine-readable for programmatic use
hippo recall "api errors" --budget 1000 --json
```

Results are ranked by `relevance * strength * recency`. The highest-signal memories fill the budget first.

---

### Auto-learn from git

Hippo can scan your commit history and extract lessons from fix/revert/bug commits automatically.

```bash
# Learn from the last 7 days of commits
hippo learn --git

# Learn from the last 30 days
hippo learn --git --days 30

# Scan multiple repos in one pass
hippo learn --git --repos "~/project-a,~/project-b,~/project-c"
```

The `--repos` flag accepts comma-separated paths. Hippo scans each repo's git log, extracts fix/revert/bug lessons, deduplicates against existing memories, and stores new ones. Pair with `hippo sleep` afterwards to consolidate.

Ideal for a weekly cron:

```bash
hippo learn --git --repos "~/repo1,~/repo2" --days 7
hippo sleep
```

---

### Watch mode

Wrap any command with `hippo watch` to auto-learn from failures:

```bash
hippo watch "npm run build"
# if it fails, Hippo captures the error automatically
# next time an agent asks about build issues, the memory is there
```

---

## CLI Reference

| Command | What it does |
|---------|-------------|
| `hippo init` | Create `.hippo/` + auto-install agent hooks |
| `hippo init --global` | Create global store at `~/.hippo/` |
| `hippo init --no-hooks` | Create `.hippo/` without auto-installing hooks |
| `hippo remember "<text>"` | Store a memory |
| `hippo remember "<text>" --tag <t>` | Store with tag (repeatable) |
| `hippo remember "<text>" --error` | Store as error (2x half-life) |
| `hippo remember "<text>" --pin` | Store with no decay |
| `hippo remember "<text>" --verified` | Set confidence: verified (default) |
| `hippo remember "<text>" --observed` | Set confidence: observed |
| `hippo remember "<text>" --inferred` | Set confidence: inferred |
| `hippo remember "<text>" --global` | Store in global `~/.hippo/` store |
| `hippo recall "<query>"` | Retrieve relevant memories (local + global) |
| `hippo recall "<query>" --budget <n>` | Recall within token limit (default: 4000) |
| `hippo recall "<query>" --json` | Output as JSON |
| `hippo context --auto` | Smart context injection (auto-detects task from git) |
| `hippo context "<query>" --budget <n>` | Context injection with explicit query (default: 1500) |
| `hippo context --budget 0` | Skip entirely (zero token cost) |
| `hippo context --framing <mode>` | Framing: observe (default), suggest, assert |
| `hippo context --format <fmt>` | Output format: markdown (default) or json |
| `hippo import --chatgpt <path>` | Import from ChatGPT memory export (JSON or txt) |
| `hippo import --claude <path>` | Import from CLAUDE.md or Claude memory.json |
| `hippo import --cursor <path>` | Import from .cursorrules or .cursor/rules |
| `hippo import --markdown <path>` | Import from structured markdown (headings -> tags) |
| `hippo import --file <path>` | Import from any text file |
| `hippo import --dry-run` | Preview import without writing |
| `hippo import --global` | Write imported memories to `~/.hippo/` |
| `hippo capture --stdin` | Extract memories from piped conversation text |
| `hippo capture --file <path>` | Extract memories from a file |
| `hippo capture --dry-run` | Preview extraction without writing |
| `hippo sleep` | Run consolidation (decay + merge + compress) |
| `hippo sleep --dry-run` | Preview consolidation without writing |
| `hippo status` | Memory health: counts, strengths, last sleep |
| `hippo outcome --good` | Strengthen last recalled memories |
| `hippo outcome --bad` | Weaken last recalled memories |
| `hippo outcome --id <id> --good` | Target a specific memory |
| `hippo inspect <id>` | Full detail on one memory |
| `hippo forget <id>` | Force remove a memory |
| `hippo embed` | Embed all memories for semantic search |
| `hippo embed --status` | Show embedding coverage |
| `hippo watch "<command>"` | Run command, auto-learn from failures |
| `hippo learn --git` | Scan recent git commits for lessons |
| `hippo learn --git --days <n>` | Scan N days back (default: 7) |
| `hippo learn --git --repos <paths>` | Scan multiple repos (comma-separated) |
| `hippo promote <id>` | Copy a local memory to the global store |
| `hippo sync` | Pull global memories into local project |
| `hippo hook list` | Show available framework hooks |
| `hippo hook install <target>` | Install hook (claude-code, codex, cursor, openclaw) |
| `hippo hook uninstall <target>` | Remove hook |
| `hippo mcp` | Start MCP server (stdio transport) |

---

## Framework Integrations

### Auto-install (recommended)

`hippo init` detects your agent framework and patches the right config file automatically:

| Framework | Detected by | Patches |
|-----------|------------|---------|
| Claude Code | `CLAUDE.md` or `.claude/settings.json` | `CLAUDE.md` |
| Codex | `AGENTS.md` or `.codex` | `AGENTS.md` |
| Cursor | `.cursorrules` or `.cursor/rules` | `.cursorrules` |
| OpenClaw | `.openclaw` or `AGENTS.md` | `AGENTS.md` |

No extra commands needed. Just `hippo init` and your agent knows about Hippo.

### Manual install

If you prefer explicit control:

```bash
hippo hook install claude-code   # patches CLAUDE.md
hippo hook install codex         # patches AGENTS.md
hippo hook install cursor        # patches .cursorrules
hippo hook install openclaw      # patches AGENTS.md
```

This adds a `<!-- hippo:start -->` ... `<!-- hippo:end -->` block that tells the agent to:
1. Run `hippo context --auto --budget 1500` at session start
2. Run `hippo remember "<lesson>" --error` on errors
3. Run `hippo outcome --good` on completion

To remove: `hippo hook uninstall claude-code`

### What the hook adds (Claude Code example)

```markdown
## Project Memory (Hippo)

Before starting work, load relevant context:
hippo context --auto --budget 1500

When you hit an error or discover a gotcha:
hippo remember "<what went wrong and why>" --error

After completing work successfully:
hippo outcome --good
```

### MCP Server

For any MCP-compatible client (Cursor, Windsurf, Cline, Claude Desktop):

```bash
hippo mcp   # starts MCP server over stdio
```

Add to your MCP config (e.g. `.cursor/mcp.json` or `claude_desktop_config.json`):

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

Exposes 6 tools: `hippo_recall`, `hippo_remember`, `hippo_outcome`, `hippo_context`, `hippo_status`, `hippo_learn`.

### OpenClaw Plugin

Native plugin with auto-context injection at session start. See [extensions/openclaw-plugin/](extensions/openclaw-plugin/).

### Claude Code Plugin

Plugin with SessionStart/Stop hooks and error auto-capture. See [extensions/claude-code-plugin/](extensions/claude-code-plugin/).

Full integration details: [integrations/](integrations/)

---

## The Neuroscience

Hippo is modeled on seven properties of the human hippocampus. Not metaphorically. Literally.

**Why two stores?** The brain uses a fast hippocampal buffer + a slow neocortical store (Complementary Learning Systems theory, McClelland et al. 1995). If the neocortex learned fast, new information would overwrite old knowledge. The buffer absorbs new episodes; the neocortex extracts patterns over time.

**Why does decay help?** New neurons born in the dentate gyrus actively disrupt old memory traces (Frankland et al. 2013). This is adaptive: it reduces interference from outdated information. Forgetting isn't failure. It's maintenance.

**Why do errors stick?** The amygdala modulates hippocampal consolidation based on emotional significance. Fear and error signals boost encoding. Your first production incident is burned into memory. Your 200th uneventful deploy isn't.

**Why does retrieval strengthen?** Recalled memories undergo "reconsolidation" (Nader et al. 2000). The act of retrieval destabilizes the trace, then re-encodes it stronger. This is the testing effect. Hippo implements it mechanically via the half-life extension on recall.

**Why does sleep consolidate?** During sleep, the hippocampus replays compressed versions of recent episodes and "teaches" the neocortex by repeatedly activating the same patterns. Hippo's `sleep` command runs this as a deliberate consolidation pass.

The 7 mechanisms in full: [PLAN.md#core-principles](PLAN.md#core-principles)

For how these mechanisms connect to LLM training, continual learning, and open research problems: **[RESEARCH.md](RESEARCH.md)**

---

## Comparison

| Feature | Hippo | Mem0 | Basic Memory | Claude-Mem |
|---------|-------|------|-------------|-----------|
| Decay by default | Yes | No | No | No |
| Retrieval strengthening | Yes | No | No | No |
| Outcome tracking | Yes | No | No | No |
| Confidence tiers | Yes | No | No | No |
| Cross-tool import | Yes | No | No | No |
| Conversation capture | Yes | No | No | No |
| Auto-hook install | Yes | No | No | No |
| MCP server | Yes | No | No | No |
| Native plugins | OpenClaw + Claude Code | No | No | No |
| Multi-repo git learn | Yes | No | No | No |
| Zero dependencies | Yes | No | No | No |
| Git-friendly | Yes | No | Yes | No |
| Framework agnostic | Yes | Partial | Yes | No |

Mem0, Basic Memory, and Claude-Mem all implement "save everything, search later." Hippo is the only one that models what memories are worth keeping, and the only one that lets you bring memories from other tools.

---

## Contributing

Issues and PRs welcome. Before contributing, run `hippo status` in the repo root to see the project's own memory.

The interesting problems:
- Better consolidation heuristics (what makes a good semantic memory?)
- Embedding-based search (currently BM25 only)
- MCP server wrapper
- Conflict detection between semantic memories
- Schema acceleration (fast-track memories that fit existing patterns)
- Multi-agent shared memory with attribution

## License

MIT
