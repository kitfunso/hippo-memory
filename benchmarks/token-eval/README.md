# Token-efficiency evals (ROADMAP Part IX, Track TE)

Three harnesses, from cheapest to most convincing. Build first with `npm run build`.

| Harness | Roadmap | Needs | What it answers |
|---|---|---|---|
| `scripts/token-eval/replay.mjs` | TE4 | nothing (no LLM) | What does hippo's per-prompt hook add to a session, and how much does skipping unchanged blocks save? |
| `scripts/token-eval/budget-curve.mjs` | TE3 | a LongMemEval-format JSON | How many tokens of memory does an agent need to see the evidence, with hippo against recency, full context and no memory? |
| `scripts/token-eval/ab-analyze.mjs` | TE5 | run records from an agent A/B | Cost per resolved task, resolve rate and work avoided, with bootstrap CIs. Protocol: `docs/evals/2026-09-23-te5-token-ab-preregistration.md` |

Shared statistics and four-bucket cost accounting are in `src/eval-stats.ts`.

## What is and is not established

- **Established, with records:** on the bundled synthetic traces, skipping unchanged hook blocks cuts the text hippo itself injects by 85-90% (the cache-priced cost of that text by 84-89%, the table below). The run is deterministic: two runs give identical per-prompt counts, and the record is `replay-results.json`.
- **Not established:** that hippo saves anyone tokens or money. The replay prices only hippo's own text (tens of tokens per prompt in these traces), and its token counts are an estimate (characters / 4). For comparison, one long Claude Code session in the container this was built in recorded about 207 million cache-read tokens, as counted by the API. Cutting hippo's overhead is housekeeping. A saving claim needs the paired A/B (TE5) on real tasks.
- **Needs checking on a real machine:** that Claude Code keeps hook `additionalContext` in the transcript, which the cache model assumes. `claude-usage.mjs` below reads the real records.

## Measure on your own machine

Claude Code writes every session to `~/.claude/projects/<project>/<session>.jsonl`, including the API's billed usage for every message. The TE0 ledger records hippo's session id from the hook payload, and that id is the transcript file name.

```bash
npm run build
node scripts/token-eval/claude-usage.mjs --days 30                 # all sessions, joined to ~/.hippo's ledger
node scripts/token-eval/claude-usage.mjs --hippo-root path/to/project/.hippo --prices prices.json --out usage.json
```

It reports, per session:
- uncached input, cache writes, cache reads and output, as billed;
- the same totals priced in dollars, if you give prices;
- how many tokens hippo sent and skipped;
- hippo's share of the new context written.

Usage is counted once per API message id. One message spans several transcript lines, so summing lines would roughly double the totals. Subagent transcripts count towards their parent session.

This measures cost and hippo's share of it. It does not measure savings, because a session without hippo is a different session. A before-and-after comparison across weeks is confounded by different work, so the saving claim still needs TE5.

## Session replay (TE4)

```bash
node scripts/token-eval/replay.mjs            # bundled synthetic traces
node scripts/token-eval/replay.mjs --traces my-traces/ --out my-results.json
```

It replays each trace through the real hook in two arms:
- `every-turn`: the behaviour before TE2;
- `skip-unchanged`: the default.

It prices only hippo's injected text: written to the cache once at 1.25x, then re-read at 0.1x on every later prompt until a compaction drops it. `tests/token-eval-replay.test.ts` runs a short trace in CI.

**Latest run, `replay-results.json`, on synthetic traces:**

| Trace | Prompts | Every-turn cost | Skip-unchanged cost | Saving |
|---|---|---|---|---|
| steady | 40 | 8,704 | 952 | 89.1% |
| learning (4 lessons) | 40 | 13,921 | 2,235 | 83.9% |
| long-compact (2 lessons, 1 compaction) | 80 | 24,040 | 2,943 | 87.8% |

- Costs are in uncached-equivalent tokens.
- An unchanged block rendered byte-identically in 100% of cases.
- The traces are synthetic, with three short pinned rules, so the absolute numbers are small. Real stores inject more per block, and the TE0 ledger (`hippo tokens`) measures what real sessions send.

## Token-at-accuracy curve (TE3)

```bash
node scripts/token-eval/budget-curve.mjs --data benchmarks/longmemeval/data/longmemeval_s_cleaned.json
```

- **Data:** download `longmemeval_s_cleaned.json` from the LongMemEval release into `benchmarks/longmemeval/data/`.
- **Default without data:** it runs on the bundled `synthetic_smoke.json`. Each of those haystacks is about 200 tokens, so every arm reaches the evidence at every budget. That run checks the mechanics and says nothing about hippo.
- **Tests:** `tests/token-eval-budget-curve.test.ts` checks the scoring on a haystack built so that recency and relevance disagree.
- **Deferred:** an LLMLingua-2 compression arm.

## A/B on your machine (TE5)

This is the only harness that can support a savings claim. It runs real Claude Code sessions, with your subscription or API key, on the same coding tasks with and without hippo.

**1. Draft tasks from a repository's history** (small bug-fix commits with tests make the best tasks):

```bash
node scripts/token-eval/make-tasks.mjs --repo ../some-repo --cluster some-repo \
  --test-cmd "npx vitest run {files}" --setup "npm ci" --verify > tasks.json
```

- `--verify` keeps only commits whose tests fail before the fix and pass after it. A candidate whose setup fails or whose test command times out is dropped as an error, not scored as a fail or a pass.
- **The scope gate skips bundled commits before they cost a test run.** A candidate is skipped when it touches more than `--max-test-files` runnable test files (default 4) or changes more than `--max-code-lines` lines outside tests (default 400); each skip is printed with its reason. Pass `0` to either flag to disable it.
- **`--run-exclude REGEX`** (default matches `fixtures?/`, `__fixtures__/`, `__snapshots__/`, `conftest.py`) marks hidden test files that are support files, not files the agent must produce: they are still written from the fix commit for the hidden test run, but never appear in the test command or count toward the scope gate. An `e2e/` spec is excluded from both tests and code entirely; it needs a running app, so it is never run as a hidden test.
- **Then edit every prompt.** A drafted prompt is the commit message, which usually describes the fix. Rewrite each one as the problem a user would report, then delete `needsReview`. The runner refuses tasks that still have it.
- Use at least two repositories: the stale-memory arm borrows another repository's store.

**2. Check the plan, then run:**

```bash
node scripts/token-eval/ab-run.mjs --tasks tasks.json --out eval-runs --model <model id> --seeds 3 --dry-run
node scripts/token-eval/ab-run.mjs --tasks tasks.json --out eval-runs --model <model id> --seeds 3 --max-budget-usd 3
```

`--dry-run` only validates the tasks file and prints the plan: it needs no `npm run build` and no `dist/`. A real run needs `dist/` (`npm run build` first) and fails fast with a clear message if it is missing.

**One cluster, still want stale-memory?** `--donor-runs DIR` points at another `ab-run.mjs --out` directory. The stale-memory arm first looks for a hippo store finished earlier in this same run (another cluster with `hippo` in `--arms`); failing that, it reads `DIR/runs.jsonl` for a `hippo` arm record from a different cluster and copies its `.hippo` directory. Missing either source throws before the first Claude Code session, not partway through the run.

**3. Analyze:**

```bash
node scripts/token-eval/ab-analyze.mjs --runs eval-runs/runs.jsonl --prices prices.json
```

What the runner does to keep the comparison fair:
- **No future history.** Each workspace contains the repository's history only up to the task's base commit, so neither the agent nor hippo's git learning can read the fix from `git log`. Hidden tests are written in after the agent finishes.
- **Your own setup is excluded.** Runs use `--setting-sources project` and `--strict-mcp-config`, so your `~/.claude` hooks, hippo's included, and your MCP servers do not load. Each arm gets only its own hooks.
- **Hippo is isolated and fully counted.** Each run has its own `HIPPO_HOME`, and `hippo` on PATH is this checkout. Hippo's optional LLM extraction is off, so hippo spends nothing outside Claude Code's recorded usage.
- **Every cost comes from Claude Code's own JSON result.** It uses `modelUsage` for the four token buckets and `total_cost_usd` at list price. Work metrics (tool calls, file reads, repeated errors) are read from the session transcript.
- **Cache effects are balanced.** One warm-up call happens before the first recorded run, and hippo and no-memory swap order between seeds.
- **Failures are recorded, not hidden.** A run with no result is recorded as invalid and excluded, never zero-filled. A task whose setup fails is recorded `invalid: 'setup'` and skipped entirely: no Claude Code session, no hidden-test run, never graded as a genuine "not resolved". The first task of each sequence is run but not scored.
- **Permissions.** Runs use `--permission-mode bypassPermissions` inside throwaway clones. Claude Code refuses that as root; there, use `--permission-mode acceptEdits`, which allows edits but not shell commands.

**Checked so far.** The runner was exercised end to end with a stand-in for Claude Code in `tests/token-eval-ab-run.test.ts`. It was also run once with real Claude Code (Haiku) on a two-task toy repository, in the no-memory and hippo arms: four real sessions, about $0.08, with usage, cost, turns, tool calls and file reads recorded from the real output and transcripts. That run tests the plumbing and says nothing about hippo: one scored task, one seed, and a repository with no history for hippo to learn from.

## A/B analysis (TE5)

```bash
node scripts/token-eval/ab-analyze.mjs --runs runs.jsonl --prices prices.json
```

- `runs.jsonl` holds one record per task, arm and seed; the input format is in the script header.
- `prices.json` holds `{inputPerMTok, cacheWritePerMTok, cacheReadPerMTok, outputPerMTok}`, taken from the provider's current price page for the exact model.
- Records written by `ab-run.mjs` carry `scored` and `invalid`. Unscored first tasks and invalid runs are excluded and counted in the output.
