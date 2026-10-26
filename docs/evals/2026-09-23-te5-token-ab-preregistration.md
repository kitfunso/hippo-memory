# TE5 paired agent A/B on task sequences: pre-registration

**Date:** 2026-09-23
**Roadmap:** ROADMAP Part IX, Track TE, TE5
**Research record:** `docs/plans/2026-09-23-token-savings-eval-research.md`
**Analyzer:** `scripts/token-eval/ab-analyze.mjs` (tested in `tests/eval/token-eval-ab-analyze.test.ts`)
**Status:** registered before any run. No result exists yet. Thresholds below do not move after the first run; a changed threshold is a new registration with its own date.

## Question

On a sequence of related coding tasks, where earlier tasks can teach lessons that later tasks need, does an agent with hippo resolve tasks at lower cost per resolved task than the same agent without memory? And is any gain due to hippo's selection, rather than to extra context or to memory in general?

## Hypotheses

- **H1 (cost):** hippo as shipped has a lower cost per resolved task than no memory. The 95% CI of the relative difference lies below zero.
- **H2 (quality):** hippo's resolve rate is not lower than no memory. Non-inferiority margin: the lower end of the 95% CI of the paired difference is above -3pp.
- **H3 (mechanism):** hippo beats random repository text at the same token budget on cost per resolved task, with the CI below zero.
- **H4 (harm check):** stale or irrelevant memories raise cost per resolved task compared with hippo, with the CI above zero. If they do not, the eval cannot tell good memory from bad, and H1 is not reported.

"Smarter" (a higher resolve rate, with the CI excluding zero) is exploratory. It is reported but not claimed from this run.

## Arms

All arms use the same agent harness, model version, system prompt, tools and task order. Model and harness versions are recorded in the run log.

| Arm | Memory given to the agent |
|---|---|
| `no-memory` | none (control) |
| `hippo` | hippo as shipped: hooks installed, default config, the store built only from earlier tasks in the same sequence |
| `dump-all` | every memory in that store, unranked, up to the model's context limit |
| `naive-topk` | top-k by BM25 over the same store, at hippo's token budget |
| `random-text` | random repository text at hippo's mean injected tokens per prompt |
| `stale-memory` | memories from a different repository's sequence, at hippo's budget |

## Tasks

- **Sources:**
  - SWE-ContextBench related-task pairs (arXiv 2602.08316).
  - Fresh issues from hippo's own history.
  - Public repositories with issues created after the model's training cutoff. This limits contamination ("The SWE-Bench Illusion", arXiv 2506.12286).
- **Structure:** sequences of 5-10 related tasks per repository. The memory store is empty at the start of each sequence and is never shared across sequences.
- **Size:** at least 100 scored tasks (non-first tasks) across at least 10 repositories. Each task in each arm runs with 3 seeds.
- **Leakage guard:** no memory may contain a gold patch, a test body or a task's expected answer. Memories are grepped against gold patches before a run, and a hit invalidates the sequence.

## Grading

- **Resolved:** the task's own tests pass after the agent's change. This is execution-based; there is no LLM judge on the headline.
- **Majority rule across seeds:** a task counts as resolved in an arm when most of its seeds resolve it. pass@1 and pass^3 are reported too.

## Measurements (per task, per arm, per seed)

- `usage`: input, cache-write, cache-read and output tokens, summed from the provider's usage fields over every call in the task. A run without usage data is excluded and reported. It is never zero-filled.
- `turns`, `fileReads`, `toolCalls`, `repeatedErrors`, taken from the agent transcript. A repeated error is the same failing command or error signature seen earlier in the sequence.
- Hippo's own overhead: `hippo tokens --json` after each sequence (TE0 ledger), plus sleep and consolidation calls if an LLM is used for them.

## Analysis

- **Cost:** list-price dollars from the provider's price page on the run date, stored with the results. Headline: cost per resolved task, with a paired bootstrap over tasks (5000 resamples, seed 1), comparing each arm with `no-memory` (`costPerResolvedDelta`).
- **Resolve rate:** paired difference with a cluster bootstrap by repository (`clusteredPairedBootstrap`).
- **Work metrics:** paired differences with the same cluster bootstrap.
- **Multiple comparisons:** H1-H4 are the only confirmatory tests. Everything else is descriptive.
- **Net ROI:** reported with hippo's overhead included in the hippo arm's usage, never computed on gross savings.

## What gets published, whatever the result

- The run log (JSONL in the analyzer's input format) and the analyzer output.
- Harness code and every arm's configuration.
- Model and harness versions, and the price table used.
- A null or negative result is published the same way. A failed H4 means the headline is withheld and the eval design is revised in a new registration.

## Implementation notes (2026-09-24, before any scored run)

These choices were made while building the runner (`scripts/token-eval/ab-run.mjs`). They were fixed before the first scored run.

- **Workspaces hold history only up to each task's base commit.** The fix commit is never present. Hidden tests are written from the fix commit after the agent finishes.
- **Arm isolation.**
  - `--setting-sources project` and `--strict-mcp-config`: the user's own hooks and MCP servers never load.
  - One `HIPPO_HOME` per run, and hippo run from the checkout under test.
  - hippo's LLM extraction is disabled, so all of the hippo arm's spend appears in Claude Code's usage.
- **Usage source.** Usage is taken from `modelUsage` in Claude Code's JSON result, the per-model billing aggregate whose costs sum to `total_cost_usd`. A real run showed the top-level `usage` can read zero when the budget cap stops a run.
- **Cache order.** One unrecorded warm-up call is made before the first run, and hippo and no-memory alternate which runs first across seeds.
- **Task selection.** Tasks are drafted from history by `make-tasks.mjs`, kept only if the hidden tests fail at the base and pass at the fix, and have their prompts rewritten by hand as problem statements before use.
- **Arms deferred to a later registration.** `dump-all` and `naive-topk` are not implemented yet. H1 to H4 only need `no-memory`, `hippo`, `random-text` and `stale-memory`.

## Related work noted after registration (2026-09-24, no threshold change)

RRSI ("Regularized Recursive Self-Improvement of Agent Harnesses", arXiv 2609.24972, Google Cloud AI Research and others, September 2026) tunes an agent's harness in a loop. It found that gains on tuning tasks mostly do not carry over to held-out ones. It accepts a change only when the gain clears a noise floor and when extra tokens are paid for by measured gains. Read through its README and two write-ups; the paper itself was blocked from the sandbox.

Two consequences for this registration, neither of which changes it:
- H1 to H4 already require the 95% interval to exclude zero, and TE5's headline is cost per resolved task, which is RRSI's token rule. RRSI is cited here as related work.
- A minimum-effect floor measured from seed-to-seed spread would be a changed threshold, so under this file's own rule it belongs to a new registration (ROADMAP SI2), not this one.
- Any hippo setting tuned on E1, such as the decay half-life (`2026-09-24-decay-default-prereg.md`), is not proven by E1. TE5's repositories act as the held-out check, so none of them may be used to tune a setting before its scored run.

## Not in scope for this registration

- Enterprise tenant replays: that is EI12, which uses the same analyzer.
- Latency.
- Any claim about a model or harness other than the one run.
