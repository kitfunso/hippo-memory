# 🦛 Hippo

**The secret to good memory isn't remembering more. It's knowing what to forget.**

[![npm](https://img.shields.io/npm/v/hippo-memory)](https://npmjs.com/package/hippo-memory)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```
Works with:  Claude Code, Codex, Cursor, OpenClaw, OpenCode, any CLI agent
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

### What's new in v0.13.0

- **Security: command injection fixed.** OpenClaw plugin now uses `execFileSync` (no shell). All user input is passed as array args, eliminating shell injection vectors.
- **17 bug fixes** across search, embeddings, physics, MCP server, store, and CLI. See CHANGELOG for details.

### What's new in v0.12.0

- **Configurable global store.** Set `$HIPPO_HOME` or use XDG (`$XDG_DATA_HOME/hippo`) to put the global store wherever you want. Falls back to `~/.hippo/` if neither is set.

### What's new in v0.11.2

- **Cross-platform path fix.** OpenClaw plugin now correctly resolves `.hippo` paths on Unix when given Windows-style backslash paths. Uses `path/posix` instead of platform-dependent `path.basename`.

### What's new in v0.11.1

- **OpenClaw error capture filtering.** The `autoLearn` hook now applies three filters before storing tool errors: a noise pattern filter for known transient errors, per-session rate limiting (max 5), and per-session deduplication. Prevents memory pollution from infrastructure noise.

### What's new in v0.11.0

- **Reward-proportional decay.** Outcome feedback now modulates decay rate continuously instead of fixed half-life deltas. Memories with consistent positive outcomes decay up to 1.5x slower; consistent negatives decay up to 2x faster. Mixed outcomes converge toward neutral. Inspired by R-STDP in spiking neural networks. `hippo inspect` now shows cumulative outcome counts and the computed reward factor.
- **Public benchmarks.** Two benchmarks in `benchmarks/`: a [Sequential Learning Benchmark](benchmarks/sequential-learning/) (50 tasks, 10 traps, measures agent improvement over time) and a [LongMemEval integration](benchmarks/longmemeval/) (industry-standard 500-question retrieval benchmark, R@5=74.0% with BM25 only). The sequential learning benchmark is unique: no other public benchmark tests whether memory systems produce learning curves.

### What's new in v0.10.0

- **Active invalidation.** `hippo learn --git` detects migration and breaking-change commits and actively weakens memories referencing the old pattern. Manual invalidation via `hippo invalidate "REST API" --reason "migrated to GraphQL"`.
- **Architectural decisions.** `hippo decide` stores one-off decisions with 90-day half-life and verified confidence. Supports `--context` for reasoning and `--supersedes` to chain decisions when the architecture evolves.
- **Path-based memory triggers.** Memories auto-tagged with `path:<segment>` from your working directory. Recall boosts memories from the same location (up to 1.3x). Working in `src/api/`? API-related memories surface first.
- **OpenCode integration.** `hippo hook install opencode` patches AGENTS.md. Auto-detected during `hippo init`. Integration guide with MCP config and skill for progressive discovery.
- **`hippo export`** outputs all memories as JSON or markdown.
- **Decision recall boost.** 1.2x scoring multiplier for decision-tagged memories so they surface despite low retrieval frequency.

### What's new in v0.9.1

- **Auto-sleep on session exit.** `hippo hook install claude-code` now installs a Stop hook in `~/.claude/settings.json` so `hippo sleep` runs automatically when Claude Code exits. `hippo init` does this too when Claude Code is detected. No cron needed, no manual sleep.

### What's new in v0.9.0

- **Working memory layer** (`hippo wm push/read/clear/flush`). Bounded buffer (max 20 per scope) with importance-based eviction. Current-state notes live separately from long-term memory.
- **Session handoffs** (`hippo handoff create/latest/show`). Persist session summaries, next actions, and artifacts so successor sessions can resume without transcript archaeology.
- **Session lifecycle** with explicit start/end events, fallback session IDs, and `hippo session resume` for continuity.
- **Explainable recall** (`hippo recall --why`). See which terms matched, whether BM25 or embedding contributed, and the source bucket (layer, confidence, local/global).
- **`hippo current show`** for compact current-state display (active task + recent session events), ready for agent injection.
- **SQLite lock hardening**: `busy_timeout=5000`, `synchronous=NORMAL`, `wal_autocheckpoint=100`. Concurrent plugin calls no longer hit `SQLITE_BUSY`.
- **Consolidation batching**: all writes/deletes happen in a single transaction instead of N open/close cycles.
- **`--limit` flag** on `hippo recall` and `hippo context` to cap result count independently of token budget.
- **Plugin injection dedup guard** prevents double context injection on reconnect.

### What's new in v0.8.0

- **Hybrid search** blends BM25 keywords with cosine embedding similarity. Install `@xenova/transformers`, run `hippo embed`, recall quality jumps. Falls back to BM25 otherwise.
- **Schema acceleration** auto-computes how well new memories fit existing patterns. Familiar memories consolidate faster; novel ones decay faster if unused.
- **Multi-agent shared memory** with `hippo share`, `hippo peers`, and transfer scoring. Universal lessons travel between projects; project-specific config stays local.
- **Conflict resolution** via `hippo resolve <id> --keep <mem_id>`. Closes the detect-inspect-resolve loop.
- **Agent eval benchmark** validates the learning hypothesis: hippo agents drop from 78% trap rate to 14% over a 50-task sequence.

### Zero-config agent integration

`hippo init` auto-detects your agent framework and wires itself in:

```bash
cd my-project
hippo init

# Initialized Hippo at /my-project
#    Directories: buffer/ episodic/ semantic/ conflicts/
#    Auto-installed claude-code hook in CLAUDE.md
```

If you have a `CLAUDE.md`, it patches it. `AGENTS.md` for Codex/OpenClaw/OpenCode. `.cursorrules` for Cursor. No manual `hook install` needed. Your agent starts using Hippo on its next session.

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

### Session event trails

Manual snapshots are useful, but real work also needs a breadcrumb trail. Hippo can now store short session events and link them to the active snapshot so context output shows the latest steps, not just the last summary.

```bash
hippo session log \
  --id sess_20260326 \
  --task "Ship continuity" \
  --type progress \
  --content "Schema migration is done, next step is CLI wiring"

hippo snapshot save \
  --task "Ship continuity" \
  --summary "Structured session events are flowing" \
  --next-step "Surface them in framework hooks" \
  --session sess_20260326

hippo session show --id sess_20260326
hippo context --auto --budget 1500
```

Hippo mirrors the latest trail to `.hippo/buffer/recent-session.md` so you can inspect the short-term thread without opening SQLite.

### Session handoffs

When you're done for the day (or switching to another agent), create a handoff so the next session knows exactly where to pick up:

```bash
hippo handoff create \
  --summary "Finished schema migration, tests green" \
  --next "Wire handoff injection into context output" \
  --session sess_20260403 \
  --artifact src/db.ts

hippo handoff latest              # show the most recent handoff
hippo handoff show 3              # show a specific handoff by ID
hippo session resume              # re-inject latest handoff as context
```

### Working memory

Working memory is a bounded scratchpad for current-state notes. It's separate from long-term memory and gets cleared between sessions.

```bash
hippo wm push --scope repo \
  --content "Investigating flaky test in store.test.ts, line 42" \
  --importance 0.9

hippo wm read --scope repo        # show current working notes
hippo wm clear --scope repo       # wipe the scratchpad
hippo wm flush --scope repo       # flush on session end
```

The buffer holds a maximum of 20 entries per scope. When full, the lowest-importance entry is evicted.

### Explainable recall

See why a memory was returned:

```bash
hippo recall "data pipeline" --why --limit 5

# --- mem_a1b2c3 [episodic] [observed] [local] score=0.847
#     BM25: matched [data, pipeline]; cosine: 0.82
#     ...memory content...
```

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

### Active invalidation

When you migrate from one tool to another, old memories about the replaced tool should die immediately. Hippo detects migration and breaking-change commits during `hippo learn --git` and actively weakens matching memories.

```bash
hippo learn --git
# feat: migrate from webpack to vite
#    Invalidated 3 memories referencing "webpack"
#    Learned: migrate from webpack to vite
```

You can also invalidate manually:

```bash
hippo invalidate "REST API" --reason "migrated to GraphQL"
# Invalidated 5 memories referencing "REST API".
```

---

### Architectural decisions

One-off decisions don't repeat, so they can't earn their keep through retrieval alone. `hippo decide` stores them with a 90-day half-life and verified confidence so they survive long enough to matter.

```bash
hippo decide "Use PostgreSQL for all new services" --context "JSONB support"
# Decision recorded: mem_a1b2c3

# Later, when the decision changes:
hippo decide "Use CockroachDB for global services" \
  --context "Need multi-region" \
  --supersedes mem_a1b2c3
# Superseded mem_a1b2c3 (half-life halved, marked stale)
# Decision recorded: mem_d4e5f6
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
# reward factor increases, decay slows

hippo outcome --bad
# Applied negative outcome to 3 memories
# reward factor decreases, decay accelerates
```

Outcomes are cumulative. A memory with 5 positive outcomes and 0 negative has a reward factor of ~1.42, making its effective half-life 42% longer. A memory with 0 positive and 3 negative has a factor of ~0.63, decaying nearly twice as fast. Mixed outcomes converge toward neutral (1.0).

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
| `hippo recall "<query>" --limit <n>` | Cap result count |
| `hippo recall "<query>" --why` | Show match reasons and source buckets |
| `hippo recall "<query>" --json` | Output as JSON |
| `hippo context --auto` | Smart context injection (auto-detects task from git) |
| `hippo context "<query>" --budget <n>` | Context injection with explicit query (default: 1500) |
| `hippo context --limit <n>` | Cap memory count in context |
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
| `hippo conflicts` | List detected open memory conflicts |
| `hippo conflicts --json` | Output conflicts as JSON |
| `hippo resolve <id>` | Show both conflicting memories for comparison |
| `hippo resolve <id> --keep <mem_id>` | Resolve: keep winner, weaken loser |
| `hippo resolve <id> --keep <mem_id> --forget` | Resolve: keep winner, delete loser |
| `hippo promote <id>` | Copy a local memory to the global store |
| `hippo share <id>` | Share with attribution + transfer scoring |
| `hippo share <id> --force` | Share even if transfer score is low |
| `hippo share --auto` | Auto-share all high-scoring memories |
| `hippo share --auto --dry-run` | Preview what would be shared |
| `hippo peers` | List projects contributing to global store |
| `hippo sync` | Pull global memories into local project |
| `hippo invalidate "<pattern>"` | Actively weaken memories matching an old pattern |
| `hippo invalidate "<pattern>" --reason "<why>"` | Include what replaced it |
| `hippo decide "<decision>"` | Record architectural decision (90-day half-life) |
| `hippo decide "<decision>" --context "<why>"` | Include reasoning |
| `hippo decide "<decision>" --supersedes <id>` | Supersede a previous decision |
| `hippo hook list` | Show available framework hooks |
| `hippo hook install <target>` | Install hook (claude-code also adds Stop hook for auto-sleep) |
| `hippo hook uninstall <target>` | Remove hook |
| `hippo handoff create --summary "..."` | Create a session handoff |
| `hippo handoff latest` | Show the most recent handoff |
| `hippo handoff show <id>` | Show a specific handoff by ID |
| `hippo session latest` | Show latest task snapshot + events |
| `hippo session resume` | Re-inject latest handoff as context |
| `hippo current show` | Compact current state (task + session events) |
| `hippo wm push --scope <s> --content "..."` | Push to working memory |
| `hippo wm read --scope <s>` | Read working memory entries |
| `hippo wm clear --scope <s>` | Clear working memory |
| `hippo wm flush --scope <s>` | Flush working memory (session end) |
| `hippo dashboard` | Open web dashboard at localhost:3333 |
| `hippo dashboard --port <n>` | Use custom port |
| `hippo mcp` | Start MCP server (stdio transport) |

---

## Framework Integrations

### Auto-install (recommended)

`hippo init` detects your agent framework and patches the right config file automatically:

| Framework | Detected by | Patches |
|-----------|------------|---------|
| Claude Code | `CLAUDE.md` or `.claude/settings.json` | `CLAUDE.md` + Stop hook in `settings.json` |
| Codex | `AGENTS.md` or `.codex` | `AGENTS.md` |
| Cursor | `.cursorrules` or `.cursor/rules` | `.cursorrules` |
| OpenClaw | `.openclaw` or `AGENTS.md` | `AGENTS.md` |
| OpenCode | `.opencode/` or `opencode.json` | `AGENTS.md` |

No extra commands needed. Just `hippo init` and your agent knows about Hippo.

### Manual install

If you prefer explicit control:

```bash
hippo hook install claude-code   # patches CLAUDE.md + adds Stop hook to settings.json
hippo hook install codex         # patches AGENTS.md
hippo hook install cursor        # patches .cursorrules
hippo hook install openclaw      # patches AGENTS.md
hippo hook install opencode      # patches AGENTS.md
```

This adds a `<!-- hippo:start -->` ... `<!-- hippo:end -->` block that tells the agent to:
1. Run `hippo context --auto --budget 1500` at session start
2. Run `hippo remember "<lesson>" --error` on errors
3. Run `hippo outcome --good` on completion

For Claude Code, it also adds a Stop hook to `~/.claude/settings.json` so `hippo sleep` runs automatically when the session exits.

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

Exposes tools: `hippo_recall`, `hippo_remember`, `hippo_outcome`, `hippo_context`, `hippo_status`, `hippo_learn`, `hippo_wm_push`.

### OpenClaw Plugin

Native plugin with auto-context injection, workspace-aware memory lookup, and
tool hooks for auto-learn / auto-sleep.

```bash
openclaw plugins install hippo-memory
openclaw plugins enable hippo-memory
```

Plugin docs: [extensions/openclaw-plugin/](extensions/openclaw-plugin/). Integration guide: [integrations/openclaw.md](integrations/openclaw.md).

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

**Why does reward modulate decay?** In spiking neural networks, reward-modulated STDP strengthens synapses that contribute to positive outcomes and weakens those that don't. Hippo's reward-proportional decay (v0.11.0) implements this: memories with consistent positive outcomes decay slower, negatives decay faster, with no fixed deltas. Inspired by [MH-FLOCKE](https://github.com/MarcHesse/mhflocke)'s R-STDP architecture for quadruped locomotion, where the same mechanism produces stable learning with 11.6x lower variance than PPO.

**Prior art in agent memory simulation.** The idea that human-like memory produces human-like behavior as an emergent property was explored in IEEE research from 2010-2011 ([5952114](https://ieeexplore.ieee.org/document/5952114), [5548405](https://ieeexplore.ieee.org/document/5548405), [5953964](https://ieeexplore.ieee.org/document/5953964)). Walking between rooms and forgetting why you went there doesn't need direct simulation; it emerges naturally from a memory system with capacity limits and decay. Hippo's design follows the same principle: implement the mechanisms, and the behavior follows.

**Related work:** [HippoRAG](https://arxiv.org/abs/2405.14831) (Gutierrez et al., 2024) applies hippocampal indexing to RAG via knowledge graphs. [MemPalace](https://github.com/milla-jovovich/mempalace) (Sigman & Jovovich, 2026) organizes memory spatially (wings/halls/rooms) with AAAK compression, achieving 100% on [LongMemEval](https://arxiv.org/abs/2410.10813). [MH-FLOCKE](https://github.com/MarcHesse/mhflocke) (Hesse, 2026) uses spiking neurons with R-STDP for embodied cognition. Each system tackles a different facet: HippoRAG optimizes retrieval quality, MemPalace optimizes retrieval organization, MH-FLOCKE optimizes embodied learning, and Hippo optimizes memory lifecycle.

---

## Comparison

| Feature | Hippo | MemPalace | Mem0 | Basic Memory |
|---------|-------|-----------|------|-------------|
| Decay by default | Yes | No | No | No |
| Retrieval strengthening | Yes | No | No | No |
| Reward-proportional decay | Yes | No | No | No |
| Hybrid search (BM25 + embeddings) | Yes | Embeddings + spatial | Embeddings only | No |
| Schema acceleration | Yes | No | No | No |
| Conflict detection + resolution | Yes | No | No | No |
| Multi-agent shared memory | Yes | No | No | No |
| Transfer scoring | Yes | No | No | No |
| Outcome tracking | Yes | No | No | No |
| Confidence tiers | Yes | No | No | No |
| Spatial organization | No | Yes (wings/halls/rooms) | No | No |
| Lossless compression | No | Yes (AAAK, 30x) | No | No |
| Cross-tool import | Yes | No | No | No |
| Auto-hook install | Yes | No | No | No |
| MCP server | Yes | Yes | No | No |
| Zero dependencies | Yes | No (ChromaDB) | No | No |
| LongMemEval R@5 (retrieval) | 74.0% (BM25 only) | 96.6% (raw) / 100% (reranked) | ~49-85% | N/A |
| Git-friendly | Yes | No | No | Yes |
| Framework agnostic | Yes | Yes | Partial | Yes |

Different tools answer different questions. Mem0 and Basic Memory implement "save everything, search later." MemPalace implements "store everything, organize spatially for retrieval." Hippo implements "forget by default, earn persistence through use." These are complementary approaches: MemPalace's retrieval precision + Hippo's lifecycle management would be stronger than either alone.

---

## Benchmarks

Two benchmarks testing two different things. Full details in [`benchmarks/`](benchmarks/).

### LongMemEval (retrieval accuracy)

[LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025) is the industry-standard benchmark: 500 questions across 5 memory abilities, embedded in 115k+ token chat histories.

**Hippo v0.11.0 results (BM25 only, zero dependencies):**

| Metric | Score |
|--------|-------|
| Recall@1 | 50.4% |
| Recall@3 | 66.6% |
| Recall@5 | 74.0% |
| Recall@10 | 82.6% |
| Answer in content@5 | 46.6% |

| Question Type | Count | R@5 |
|---------------|-------|-----|
| single-session-assistant | 56 | 94.6% |
| knowledge-update | 78 | 88.5% |
| temporal-reasoning | 133 | 73.7% |
| multi-session | 133 | 72.2% |
| single-session-user | 70 | 65.7% |
| single-session-preference | 30 | 26.7% |

For context: MemPalace scores 96.6% (raw) using ChromaDB embeddings + spatial indexing. Hippo achieves 74.0% using BM25 keyword matching alone with zero runtime dependencies. Adding embeddings via `hippo embed` (optional `@xenova/transformers` peer dep) enables hybrid search and should close the gap.

Hippo's strongest categories (knowledge-update 88.5%, single-session-assistant 94.6%) are the ones where keyword overlap between question and stored content is highest. The weakest (preference 26.7%) involves indirect references that need semantic understanding.

```bash
cd benchmarks/longmemeval
python ingest_direct.py --data data/longmemeval_oracle.json --store-dir ./store
python retrieve_fast.py --data data/longmemeval_oracle.json --store-dir ./store --output results/retrieval.jsonl
python evaluate_retrieval.py --retrieval results/retrieval.jsonl --data data/longmemeval_oracle.json
```

### Sequential Learning Benchmark (agent improvement over time)

No other public benchmark tests whether memory systems produce learning curves. LongMemEval tests retrieval on a fixed corpus. This benchmark tests whether an agent with memory *performs better on task 40 than task 5*.

50 tasks, 10 trap categories, each appearing 2-3 times across the sequence.

**Hippo v0.11.0 results:**

| Condition | Overall | Early | Mid | Late | Learns? |
|-----------|---------|-------|-----|------|---------|
| No memory | 100% | 100% | 100% | 100% | No |
| Static memory | 20% | 33% | 11% | 14% | No |
| Hippo | 40% | 78% | 22% | 14% | Yes |

The hippo agent's trap-hit rate drops from 78% to 14% as it accumulates error memories with 2x half-life. Static pre-loaded memory helps from the start but doesn't improve. Any memory system can run this benchmark by implementing the [adapter interface](benchmarks/sequential-learning/adapters/interface.mjs).

```bash
cd benchmarks/sequential-learning
node run.mjs --adapter all
```

---

## Contributing

Issues and PRs welcome. Before contributing, run `hippo status` in the repo root to see the project's own memory.

The interesting problems:
- **Improve LongMemEval score.** Current R@5 is 74.0% with BM25 only. Adding embeddings (`hippo embed`) and hybrid search should close the gap toward MemPalace's 96.6%.
- Better consolidation heuristics (LLM-powered merge vs current text overlap)
- Web UI / dashboard for visualizing decay curves and memory health
- Optimal decay parameter tuning from real usage data
- Cross-agent transfer learning evaluation
- **MemPalace-style spatial organization.** Could spatial structure (wings/halls/rooms) improve hippo's semantic layer?
- **AAAK-style compression for semantic memories.** Lossless token compression for context injection.

## License

MIT
