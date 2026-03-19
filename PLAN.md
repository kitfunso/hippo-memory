# Hippo  - Architecture Plan

## Tagline
"Every AI memory tool remembers everything. The brain doesn't. That's why it works."

## What It Is
A biologically-inspired memory system for AI agents. Not a filing cabinet with search. A system that learns what to forget.

## Core Principles (from neuroscience)
1. **Two-speed storage**  - Fast episodic buffer + slow semantic store (CLS theory)
2. **Decay by default**  - Every memory has a half-life. Persistence is earned.
3. **Retrieval strengthens**  - Using a memory boosts it. Ignoring it lets it die.
4. **Emotional tagging**  - Errors and breakthroughs get priority encoding.
5. **Sleep consolidation**  - Background process compresses episodes into patterns.
6. **Schema acceleration**  - Info fitting existing patterns consolidates faster.
7. **Interference detection**  - Conflicting memories get flagged, not accumulated.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    hippo CLI / API                       │
│                                                         │
│  remember()  recall()  consolidate()  status()  forget() │
└──────┬──────────┬──────────┬──────────┬──────────┬──────┘
       │          │          │          │          │
┌──────▼──────────▼──────────▼──────────▼──────────▼──────┐
│                    Memory Engine                         │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   Buffer     │  │   Episodic   │  │   Semantic    │  │
│  │  (Working)   │──▶│   Store      │──▶│    Store     │  │
│  │             │  │              │  │              │  │
│  │ Raw input   │  │ Timestamped  │  │ Consolidated │  │
│  │ No decay    │  │ Decaying     │  │ Patterns     │  │
│  │ Current     │  │ Retrievable  │  │ Stable       │  │
│  │ session     │  │ Strengthens  │  │ Schema-aware │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Consolidation Engine                 │   │
│  │  • Replay (compress episodes → patterns)          │   │
│  │  • Decay (reduce strength of unretrieved)         │   │
│  │  • Merge (combine related semantic entries)        │   │
│  │  • Conflict detection (flag contradictions)        │   │
│  │  • Garbage collection (remove fully decayed)       │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Signal Tracker                       │   │
│  │  • Error tagging (boost on failure context)        │   │
│  │  • Retrieval counting (strengthen on use)          │   │
│  │  • Outcome feedback (did this memory help?)        │   │
│  │  • Novelty scoring (how different from schema?)    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Data Model

SQLite is the source of truth. Markdown + frontmatter remain as compatibility mirrors, still git-trackable and human-readable.

### Memory Entry (single unit)

```markdown
---
id: mem_a1b2c3
created: 2026-03-15T10:00:00Z
last_retrieved: 2026-03-15T14:00:00Z
retrieval_count: 3
strength: 0.82
half_life_days: 7
layer: episodic
tags: [error, production, data-pipeline]
emotional_valence: negative
schema_fit: 0.4
source: session
outcome_score: null
conflicts_with: [mem_d4e5f6]
---

FRED cache silently dropped the tips_10y series during daily refresh,
breaking the gold model. Always verify cache contents after refresh failures.
```

### Strength Formula

```
strength(t) = base_strength * (0.5 ^ (days_since_last_retrieval / half_life))
              * retrieval_boost
              * emotional_multiplier

where:
  base_strength = 1.0 (at creation)
  half_life = 7 days (default, adjusted by signals)
  retrieval_boost = 1 + (0.1 * log2(retrieval_count + 1))
  emotional_multiplier = 1.0 (neutral) | 1.5 (error) | 1.3 (success) | 2.0 (critical)
```

### Half-life Adjustments

| Signal | Half-life Modifier |
|--------|-------------------|
| Each retrieval | +2 days |
| Error-tagged | x2 base half-life |
| High schema fit (>0.7) | x1.5 (consolidates faster) |
| Low schema fit (<0.3) | x0.5 (novel, keep in buffer longer but decay faster if unused) |
| Positive outcome feedback | +5 days |
| Negative outcome feedback | -3 days |
| Manual pin by user | infinite (no decay) |

## File Structure

```
.hippo/
├── config.yaml          # Settings, half-life defaults, thresholds
├── buffer/              # Working memory (current session, auto-cleared)
│   └── session-*.md
├── episodic/            # Timestamped memories with decay
│   └── mem_*.md
├── semantic/            # Consolidated patterns (stable)
│   └── sem_*.md
├── conflicts/           # Detected contradictions needing resolution
│   └── conflict_*.md
├── hippo.db             # Source of truth: SQLite backbone
├── index.json           # Derived compatibility mirror for fast lookup
└── stats.json           # Derived compatibility mirror for stats/history
```

## CLI Interface

```bash
# Initialize in a project
hippo init

# Store a memory (auto-classifies layer, tags, novelty)
hippo remember "FRED cache can silently drop series"
hippo remember "FRED cache can silently drop series" --tag error --tag data-pipeline

# Recall relevant memories (returns within token budget)
hippo recall "data pipeline issues" --budget 2000
hippo recall "why is gold model broken" --budget 1000

# After a task, report outcome (strengthens/weakens retrieved memories)
hippo outcome --good    # last retrieved memories helped
hippo outcome --bad     # last retrieved memories were irrelevant
hippo outcome --id mem_a1b2c3 --good  # specific memory helped

# Run consolidation (the "sleep" cycle)
hippo sleep              # full consolidation pass
hippo sleep --dry-run    # show what would be consolidated/decayed/merged

# Inspect memory health
hippo status             # total memories, decay stats, conflicts
hippo inspect mem_a1b2c3 # full detail on one memory
hippo conflicts          # list unresolved contradictions

# Manual controls
hippo pin mem_a1b2c3     # prevent decay (important permanent memory)
hippo forget mem_a1b2c3  # force removal
hippo boost mem_a1b2c3   # manual strength increase
```

## Framework Integrations

### Claude Code (CLAUDE.md injection)
```markdown
## Memory
Before starting work, run: `hippo recall "<task description>" --budget 3000`
After completing work, run: `hippo outcome --good` or `hippo outcome --bad`
When you learn something important, run: `hippo remember "<lesson>"`
When you hit an error, run: `hippo remember "<what went wrong>" --tag error`
```

### OpenClaw (Skill)
```yaml
# .openclaw/skills/hippo/SKILL.md
- On session start: inject `hippo recall` output into context
- On session end: run `hippo sleep --quick` if >10 new memories
- On error: auto-tag with `hippo remember --tag error`
```

### Cursor (.cursorrules)
```
Before each task, consult project memory: `hippo recall "<task>" --budget 2000`
After learning something, save it: `hippo remember "<insight>"`
```

### MCP Server
Exposed as an MCP tool server for MCP-compatible clients, with active task snapshot parity in `hippo_context` and conflict counts in `hippo_status`.

## Consolidation Engine ("Sleep")

Runs as `hippo sleep` (manually or via cron). Steps:

1. **Decay pass:** Calculate current strength of all episodic memories. Remove any below threshold (default 0.05).

2. **Replay pass:** For each episodic memory above threshold:
   - Find related episodic memories (embedding similarity > 0.7)
   - If 3+ related episodes exist, extract the common pattern
   - Create a semantic memory from the pattern
   - Reduce strength of source episodes (they've been "taught" to neocortex)

3. **Conflict detection:** Compare live non-semantic memories for strong overlap plus contradictory polarity (for example enabled vs disabled, true vs false, always vs never). Store open/resolved conflicts in SQLite, mirror them under `.hippo/conflicts/`, and link them back through each memory's `conflicts_with` field.

4. **Schema indexing:** Update the schema map (topic clusters) so future novelty scoring works.

5. **Stats update:** Log consolidation run (memories decayed, merged, conflicts found).

## Retrieval Engine ("Recall")

1. Compute embedding of query
2. Search episodic + semantic stores by similarity
3. Rank by: `relevance_score * strength * recency_boost`
4. Apply token budget: fill up to N tokens, prioritizing highest-ranked
5. For each retrieved memory: increment retrieval_count, update last_retrieved
6. Return formatted context block

## Tech Stack

- **Language:** TypeScript (npm ecosystem, `npx hippo` works everywhere)
- **Embeddings:** Local model (transformers.js or ONNX) for zero-API-key mode. Optional OpenAI/Anthropic for better quality.
- **Search:** BM25 (keyword) + cosine similarity (embedding) hybrid. BM25 as fallback for zero-dependency mode.
- **Storage:** SQLite source of truth with markdown/frontmatter + JSON compatibility mirrors.
- **CLI:** Commander.js
- **Package:** Published to npm as `hippo-memory` (or `@hippo/core`)

## MVP Scope (v0.1)

Ship the smallest thing that demonstrates the core insight (decay + retrieval strengthening).

### In (all shipped):
- [x] `hippo init` (with auto-hook detection for claude-code, codex, cursor, openclaw)
- [x] `hippo remember <text>` (with auto-tagging: error/success/neutral)
- [x] `hippo recall <query> --budget N` (BM25 search, strength-ranked)
- [x] `hippo sleep` (decay pass + basic merge)
- [x] `hippo status`
- [x] `hippo outcome --good/--bad`
- [x] Strength formula with decay + retrieval boost
- [x] Markdown storage, git-friendly
- [x] Zero external dependencies mode (BM25, no embeddings)

### Shipped since v0.1:
- [x] Cross-tool import (ChatGPT, Claude, Cursor, markdown, any text file)
- [x] Conversation capture (pattern-based, no LLM needed)
- [x] Confidence tiers (verified, observed, inferred, stale)
- [x] Observation framing (observe, suggest, assert)
- [x] `hippo learn --git` (auto-learn from commit history)
- [x] `hippo learn --git --repos` (multi-repo scanning)
- [x] `hippo watch` (auto-learn from command failures)
- [x] `hippo context --auto` (smart context injection from git state)
- [x] `hippo init` auto-detects and installs framework hooks
- [x] Framework integrations: Claude Code, Codex, Cursor, OpenClaw
- [x] SQLite-first storage backbone with migration scaffolding
- [x] Packaged install smoke test (`npm run smoke:pack`)
- [x] Active task snapshots (`hippo snapshot save|show|clear`)
- [x] Persistent stale-memory lifecycle during `hippo sleep`
- [x] Conflict detection + `hippo conflicts`
- [x] MCP server parity for snapshots/status

### Out (v0.2+):
- [ ] Embedding-based search (optional, needs model)
- [ ] Schema acceleration
- [ ] Web UI / dashboard
- [ ] Multi-agent shared memory
- [ ] Richer session/event history on top of the SQLite backbone
- [ ] Explicit conflict resolution workflows beyond open/resolved auto-refresh

## Name Availability

- `hippo` on npm: check
- `hippo-memory` on npm: check
- github.com/hippo-memory: check
- hippo.dev / hippo-memory.dev: check

## Success Metrics

1. 500 stars in first month (Show HN + Reddit)
2. 10+ contributors in first quarter
3. At least 3 framework integrations by community
4. Used in production by us for 2+ weeks before launch
