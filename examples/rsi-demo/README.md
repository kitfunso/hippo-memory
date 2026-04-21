# Recursive Self-Improvement Demo

A minimal agent that learns from prior runs using hippo's sequence-bound
traces. The demo proves — with a pass/fail bar — that an agent which
records and recalls `A -> B -> C -> outcome` strategies self-improves
over a sequence of tasks.

## What it does

50 tasks, 8 categories (api-call, parse-csv, db-write, rotate-key, ...).
Each category has a hidden trap: the task only succeeds on its first
attempt if the agent invokes the correct hint (e.g. `USE:wrap-in-transaction`
for db-write). On first encounter the agent has no hint in memory, fails,
reads the trap observation, retries with the hint, and records a
successful trace. On every subsequent encounter it recalls the prior
trace, extracts the hint, and succeeds on first attempt.

The measured metric is **first-attempt success rate** — "did the agent
come prepared?" — not "did it eventually succeed". That cleanly separates
learned vs. unlearned behavior.

## Run

```bash
node agent.mjs
```

Expected output:

```
RSI demo - seed=1337, gap-threshold=0.2, sandbox=/tmp/hippo-rsi-demo-...

Tasks 1-10  first-attempt success rate: 20%
Tasks 41-50 first-attempt success rate: 100%
Learning gap:                           0.80
PASS: learning gap 0.80 >= 0.2
```

Exit code: `0` on the default seed. The demo exits non-zero if the
learning gap is below the threshold, making it CI-runnable.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--seed <n>` | `1337` | Seeds the demo's RNG for reproducibility. |
| `--gap <0..1>` | `0.20` | Required pp improvement from early to late window. |

To confirm the pass bar is real, raise it beyond the observed gap:

```bash
node agent.mjs --gap 0.99
# Exit code: 1
```

## Isolation

The demo creates a fresh tmp sandbox under the OS temp dir, inits a
local `.hippo/` inside it, and points `HIPPO_HOME` at a subdirectory of
the same sandbox. It never reads or writes the user's real
`~/.hippo/` or any project-local store. The sandbox is removed on exit
(success, failure, SIGINT, or SIGTERM).

## How it uses hippo

1. Before each task, `hippo recall "<task description>" --outcome success --layer trace --json --budget 800`
   returns prior successful traces. The agent extracts a `USE:<hint>`
   token from the highest-ranked trace's markdown content.
2. After each task, `hippo trace record --task ... --steps ... --outcome <success|failure>`
   persists the sequence as a first-class trace memory. Success traces
   embed the hint; failure traces capture the stumble.
3. On subsequent encounters of the same category, step 1 finds the
   prior success and the agent applies the hint deterministically.

No network, no LLM calls, no external dependencies beyond Node 22.5+
and the hippo CLI (which the demo resolves from the local checkout at
`../../bin/hippo.js`, falling back to a PATH-installed `hippo`).

## Limitations

The task mechanics are intentionally simple: hint-matching is binary
and deterministic. This is a demonstration of the memory contract, not
a realistic agent. For a more nuanced evaluation with stochastic
execution, an adapter interface, and comparison against no-memory and
static-memory baselines, see `benchmarks/sequential-learning/`.
