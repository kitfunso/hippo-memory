# Hippo: Generic Agent Integration

Instructions any AI agent can follow to use Hippo memory.

Copy these into your system prompt, agent instructions, or tool configuration.

---

## System prompt / agent instructions block

```
## Memory System

You have access to a memory system called Hippo. It stores information between
sessions. Memories decay over time unless they are retrieved. Errors are
remembered longer. You can strengthen memories by using them.

Memory is stored in .hippo/ in the current working directory (markdown files,
no database required).

### How to use it

**Recall before working:**
Run this at the start of any task:
  hippo recall "<describe the task in plain language>" --budget 3000

Read the output. These are things the project has learned. Use them.

**Store what you learn:**
When you discover something non-obvious:
  hippo remember "<the lesson>"

When you hit an error or failure:
  hippo remember "<what failed and why>" --error

For permanent facts that should never decay:
  hippo remember "<fact>" --pin

**Give outcome feedback:**
After completing work, run one of:
  hippo outcome --good    (recalled memories were useful)
  hippo outcome --bad     (recalled memories were irrelevant)

This is how the system learns what to keep.

**Run consolidation periodically:**
  hippo sleep

This removes weak memories, merges related episodes into patterns, and
keeps the store clean. Run it at end of session or via cron.

### What NOT to do

- Do not store everything. Only store things that aren't obvious or that you'd
  want to know at the start of the next session.
- Do not recall without providing a specific query. Generic recalls return noise.
- Do not skip outcome feedback. Without it, the signal loop doesn't work.

### Memory health check

  hippo status

Shows total memories, average strength, at-risk entries, and last consolidation run.
```

---

## Tool definitions (JSON format)

For agents that accept structured tool definitions:

```json
[
  {
    "name": "memory_recall",
    "description": "Retrieve memories relevant to the current task. Returns top memories within the token budget, ranked by relevance × strength × recency. Call this at the start of any task.",
    "parameters": {
      "query": {
        "type": "string",
        "description": "Natural language description of the task or question"
      },
      "budget": {
        "type": "integer",
        "description": "Maximum tokens to return (default: 3000)",
        "default": 3000
      }
    },
    "command": "hippo recall {query} --budget {budget} --json"
  },
  {
    "name": "memory_store",
    "description": "Store a new memory. Use after learning something non-obvious, discovering an error, or completing work. Keep to 1-2 sentences. Specific and concrete.",
    "parameters": {
      "text": {
        "type": "string",
        "description": "The memory to store"
      },
      "error": {
        "type": "boolean",
        "description": "True if this memory is about a failure or error (doubles half-life)",
        "default": false
      },
      "pin": {
        "type": "boolean",
        "description": "True if this memory should never decay",
        "default": false
      },
      "tag": {
        "type": "string",
        "description": "Optional tag for categorization"
      }
    },
    "command": "hippo remember {text} [--error] [--pin] [--tag {tag}]"
  },
  {
    "name": "memory_outcome",
    "description": "Report whether recalled memories were helpful. Call after completing a task. Strengthens helpful memories, weakens irrelevant ones.",
    "parameters": {
      "good": {
        "type": "boolean",
        "description": "True if recalled memories were useful, false if they were not"
      }
    },
    "command": "hippo outcome --good | --bad"
  },
  {
    "name": "memory_consolidate",
    "description": "Run the consolidation pass. Decays weak memories, merges related episodes into patterns, removes entries below threshold. Run at end of session.",
    "parameters": {},
    "command": "hippo sleep"
  },
  {
    "name": "memory_status",
    "description": "Check memory health. Returns counts, average strength, at-risk memories, and last consolidation time.",
    "parameters": {},
    "command": "hippo status"
  }
]
```

---

## MCP server configuration

If you're using MCP-compatible clients, you can wrap Hippo as an MCP server.
A native MCP wrapper is on the roadmap. For now, use the shell tool above.

---

## Decay model reference

Agents that want to understand what they're working with:

- Default half-life: 7 days
- Each retrieval: +2 days to half-life
- Error tag (`--error`): 2x base half-life
- Positive outcome: +5 days to half-life
- Negative outcome: -3 days to half-life
- Pin: no decay
- Consolidation removes memories below strength 0.05

Strength at any point: `base * (0.5 ^ (days_since_retrieval / half_life)) * retrieval_boost`

The formula favors memories that are used regularly and associated with significant outcomes.
