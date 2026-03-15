# 🦛 Hippo

**Every AI memory tool remembers everything. The brain doesn't. That's why it works.**

[![npm](https://img.shields.io/npm/v/hippo-memory)](https://npmjs.com/package/hippo-memory)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## The Problem

AI agents forget everything between sessions. Existing solutions just save everything and search later. That's a filing cabinet, not a brain.

---

## Quick Start

```bash
npm install -g hippo-memory

hippo init
hippo remember "FRED cache silently dropped the tips_10y series" --tag error
hippo recall "data pipeline issues" --budget 2000
```

That's it. You have a memory system.

---

## How It Works

Input enters the buffer. Important things get encoded into episodic memory. During "sleep," repeated episodes compress into semantic patterns. Weak memories decay and disappear.

```
New information
      │
      ▼
┌─────────────┐
│   Buffer    │  Working memory. Current session only. No decay.
│  (session)  │
└──────┬──────┘
       │  encoded (tags, strength, half-life assigned)
       ▼
┌─────────────┐
│   Episodic  │  Timestamped memories. Decay by default.
│    Store    │  Retrieval strengthens. Errors stick longer.
└──────┬──────┘
       │  consolidation (hippo sleep)
       ▼
┌─────────────┐
│   Semantic  │  Compressed patterns. Stable. Schema-aware.
│    Store    │  Extracted from repeated episodes.
└─────────────┘

         💤  hippo sleep: decay + replay + merge
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
# finds mem_a1b2c3, retrieval_count: 1 → 2
# half_life extended: 7d → 9d
# strength recalculated from retrieval timestamp

hippo recall "cache issues"   # again next week
# retrieval_count: 2 → 3
# half_life: 9d → 11d
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

### Sleep consolidation

Run `hippo sleep` and episodes compress into patterns.

```bash
hippo sleep

# 💤 Running consolidation...
#
# 📊 Results:
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
# 👍 Applied positive outcome to 3 memories
# half_life +5d on each

hippo outcome --bad
# 👎 Applied negative outcome to 3 memories
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

## CLI Reference

| Command | What it does |
|---------|-------------|
| `hippo init` | Create `.hippo/` in current directory |
| `hippo remember "<text>"` | Store a memory |
| `hippo remember "<text>" --tag <t>` | Store with tag (repeatable) |
| `hippo remember "<text>" --error` | Store as error (2x half-life) |
| `hippo remember "<text>" --pin` | Store with no decay |
| `hippo recall "<query>"` | Retrieve relevant memories |
| `hippo recall "<query>" --budget <n>` | Recall within token limit (default: 4000) |
| `hippo recall "<query>" --json` | Output as JSON |
| `hippo sleep` | Run consolidation (decay + merge + compress) |
| `hippo sleep --dry-run` | Preview consolidation without writing |
| `hippo status` | Memory health: counts, strengths, last sleep |
| `hippo outcome --good` | Strengthen last recalled memories |
| `hippo outcome --bad` | Weaken last recalled memories |
| `hippo outcome --id <id> --good` | Target a specific memory |
| `hippo inspect <id>` | Full detail on one memory |
| `hippo forget <id>` | Force remove a memory |

---

## Framework Integrations

### Claude Code (CLAUDE.md)

```markdown
## Memory

Before starting work:
`hippo recall "<describe the task>" --budget 3000`

When you learn something important:
`hippo remember "<the lesson>"`

When you hit an error:
`hippo remember "<what failed and why>" --error`

After completing work:
`hippo outcome --good` (memories helped) or `hippo outcome --bad` (they didn't)
```

### Cursor (.cursorrules)

```
Before each task, check project memory:
  Run: hippo recall "<task description>" --budget 2000
  Inject the output as context before writing code.

After learning something worth keeping:
  Run: hippo remember "<the insight>"

After hitting an error:
  Run: hippo remember "<what went wrong>" --error
```

### OpenClaw

See [integrations/openclaw.md](integrations/openclaw.md) for the full SKILL.md.

```yaml
# Short version: add to your OpenClaw skill
on_session_start: hippo recall "{{task}}" --budget 3000
on_error: hippo remember "{{error_summary}}" --error
on_session_end: hippo outcome --good  # or --bad
```

### Generic MCP

```json
{
  "tools": [
    {
      "name": "memory_recall",
      "description": "Retrieve relevant memories for the current task",
      "command": "hippo recall {query} --budget {budget} --json"
    },
    {
      "name": "memory_store",
      "description": "Store a new memory",
      "command": "hippo remember {text} {--error if error}"
    }
  ]
}
```

Full integration files: [integrations/](integrations/)

---

## The Neuroscience

Hippo is modeled on seven properties of the human hippocampus. Not metaphorically. Literally.

**Why two stores?** The brain uses a fast hippocampal buffer + a slow neocortical store (Complementary Learning Systems theory, McClelland et al. 1995). If the neocortex learned fast, new information would overwrite old knowledge. The buffer absorbs new episodes; the neocortex extracts patterns over time.

**Why does decay help?** New neurons born in the dentate gyrus actively disrupt old memory traces (Frankland et al. 2013). This is adaptive: it reduces interference from outdated information. Forgetting isn't failure. It's maintenance.

**Why do errors stick?** The amygdala modulates hippocampal consolidation based on emotional significance. Fear and error signals boost encoding. Your first production incident is burned into memory. Your 200th uneventful deploy isn't.

**Why does retrieval strengthen?** Recalled memories undergo "reconsolidation" (Nader et al. 2000). The act of retrieval destabilizes the trace, then re-encodes it stronger. This is the testing effect. Hippo implements it mechanically via the half-life extension on recall.

**Why does sleep consolidate?** During sleep, the hippocampus replays compressed versions of recent episodes and "teaches" the neocortex by repeatedly activating the same patterns. Hippo's `sleep` command runs this as a deliberate consolidation pass.

The 7 mechanisms in full: [PLAN.md#core-principles](PLAN.md#core-principles)

---

## Comparison

| Feature | Hippo | Mem0 | Basic Memory | Claude-Mem |
|---------|-------|------|-------------|-----------|
| Decay by default | ✅ | ❌ | ❌ | ❌ |
| Retrieval strengthening | ✅ | ❌ | ❌ | ❌ |
| Outcome tracking | ✅ | ❌ | ❌ | ❌ |
| Zero dependencies | ✅ | ❌ | ❌ | ❌ |
| Git-friendly | ✅ | ❌ | ✅ | ❌ |
| Framework agnostic | ✅ | Partial | ✅ | ❌ |

Mem0, Basic Memory, and Claude-Mem all implement "save everything, search later." Hippo is the only one that models what memories are worth keeping.

---

## Contributing

Issues and PRs welcome. Before contributing, run `hippo status` in the repo root to see the project's own memory.

The interesting problems:
- Better consolidation heuristics (what makes a good semantic memory?)
- Embedding-based search (currently BM25 only)
- MCP server wrapper
- Conflict detection between semantic memories
- Schema acceleration (fast-track memories that fit existing patterns)

## License

MIT
