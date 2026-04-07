# Sequential Learning Benchmark

Does your memory system help agents learn from mistakes?

Most memory benchmarks (LongMemEval, MemGPT-eval) test **retrieval accuracy**: can the system find the right document given a query? That matters, but it misses the harder question: does the agent get *better over time*?

This benchmark tests **sequential learning** -- whether an agent's trap-hit-rate declines across a sequence of tasks as it accumulates lessons from past mistakes.

## What it measures

50 tasks in a simulated codebase scenario. 10 trap categories are embedded at fixed positions, each appearing 2-3 times across the sequence (25 total trap encounters). The tasks are ordered so that an agent encounters each trap category early, then encounters it again later.

The key metric is the **learning curve**: trap-hit-rate split into three phases (early, mid, late). A system that helps agents learn shows a declining curve. A system without learning shows a flat line.

Three conditions:

| Condition | Description | Expected behavior |
|-----------|-------------|-------------------|
| No memory | Agent has no recall capability | 100% hit rate, flat across phases |
| Static memory | All lessons pre-loaded before the sequence | Low hit rate, flat across phases |
| Hippo | Starts empty, learns from each trap hit | Declining hit rate over phases |

## The 10 trap categories

| Trap | What it catches |
|------|----------------|
| `overwrite_production` | Directly modifying production files |
| `bare_except` | Using `except: pass` instead of specific exception handling |
| `emoji_windows` | Using emoji in print statements (breaks cp1252 on Windows) |
| `powershell_chain` | Using `&&` instead of `;` to chain PowerShell commands |
| `sharpe_inflation` | Reporting walk-forward Sharpe without deflation |
| `constants_sync` | Changing frontend constants without updating backend |
| `slop_words` | Using AI slop words (comprehensive, robust, leverage) |
| `exit_code_trust` | Trusting exit code 0 without verifying actual data |
| `data_mining` | Feature selection on full dataset then claiming OOS results |
| `unverified_metrics` | Accepting claimed performance numbers without running the backtest |

## Running the benchmark

```bash
# Run all conditions
node benchmarks/sequential-learning/run.mjs

# Run a specific adapter
node benchmarks/sequential-learning/run.mjs --adapter hippo
node benchmarks/sequential-learning/run.mjs --adapter static
node benchmarks/sequential-learning/run.mjs --adapter none

# Custom output directory
node benchmarks/sequential-learning/run.mjs --output my-results/
```

Requirements:
- Node.js 22.5+
- For the hippo adapter: `hippo` CLI on PATH

No npm dependencies. Uses only Node.js built-in modules.

## Output

### Console

```
══ Sequential Learning Benchmark ═════════════════════════
50 tasks · 10 trap categories · 25 trap encounters
────────────────────────────────────────────────────────────
Condition      │ Overall │ Early │  Mid  │  Late │ Learns?
───────────────┼─────────┼───────┼───────┼───────┼────────
No memory      │  100%   │ 100%  │ 100%  │ 100%  │   No
Static memory  │    8%   │  11%  │   0%  │  14%  │   No
Hippo          │   40%   │  78%  │  22%  │  14%  │  Yes
════════════════════════════════════════════════════════════
```

### JSON

Results are written to `results/latest.json` and `results/benchmark-<timestamp>.json`:

```json
{
  "benchmark": "hippo-sequential-learning",
  "version": "1.0.0",
  "timestamp": "2026-04-07T...",
  "conditions": {
    "hippo": {
      "overall_trap_hit_rate": 0.40,
      "phases": { "early": 0.78, "mid": 0.22, "late": 0.14 },
      "learns": true,
      "improvement_pct": 64
    }
  },
  "tasks": 50,
  "traps": 10,
  "trap_encounters": 25
}
```

## Adding a custom adapter

To benchmark your own memory system:

1. Create a file in `adapters/` (e.g., `adapters/my-memory.mjs`)
2. Implement the adapter interface:

```javascript
import { createAdapter } from './interface.mjs';

export default createAdapter({
  name: 'My Memory System',

  async init() {
    // Set up your memory store (create temp dirs, connect to DB, etc.)
  },

  async store(content, tags) {
    // Store a lesson learned from a trap hit
    // content: the lesson text
    // tags: array of category tags
  },

  async recall(query) {
    // Retrieve memories relevant to the query
    // Return: Array<{ content: string, score: number }>
    // Return up to 5 results, sorted by relevance
  },

  async outcome(good) {
    // Feedback on the last recall
    // good=true: the recall helped avoid a trap
    // good=false: the recall missed, agent hit the trap
  },

  async cleanup() {
    // Tear down (remove temp dirs, close connections)
  },
});
```

3. Register it in `run.mjs`:

```javascript
import myMemoryAdapter from './adapters/my-memory.mjs';

const ADAPTERS = {
  none: baselineAdapter,
  static: staticAdapter,
  hippo: hippoAdapter,
  'my-memory': myMemoryAdapter,
};
```

4. Run: `node run.mjs --adapter my-memory`

## Interpreting results

**Learning detection**: A system "learns" if late-phase hit rate is at least 20 percentage points lower than early-phase hit rate.

**What good looks like**:
- Early hit rate ~70-100% (the system hasn't seen these traps yet)
- Late hit rate <20% (the system recalls lessons from earlier encounters)
- `improvement_pct` >= 50%

**What static memory looks like**:
- Roughly flat hit rate across phases
- May catch some traps through text matching, but the rate doesn't improve

**Red flags**:
- Late hit rate >= early hit rate (the system forgets or degrades)
- 100% hit rate everywhere (the system's recall is broken)
- 0% hit rate from the start (suspiciously perfect -- check for data leakage)

## Comparison with LongMemEval

| Dimension | LongMemEval | This benchmark |
|-----------|-------------|----------------|
| Tests | Retrieval accuracy | Learning over time |
| Memory model | Static corpus | Dynamic, accumulating |
| Key metric | Recall@k, F1 | Trap-hit-rate decline |
| Task structure | Independent queries | Sequential, with dependencies |
| Agent behavior | Retrieve and answer | Recall, act, learn from outcome |
| What it reveals | Can the system find memories? | Does the system make the agent smarter over time? |

LongMemEval answers: "Can your system retrieve the right memory?" This benchmark answers: "Does your system help agents avoid repeating mistakes?"

Both matter. LongMemEval is necessary but not sufficient. A system with perfect retrieval but no learning mechanism will score well on LongMemEval but show a flat line here.
