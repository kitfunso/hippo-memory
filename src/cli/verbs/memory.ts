// Store, recall and maintenance verbs; every verbs/ file keeps its rows in the order `hippo help` lists them.

import { DEFAULT_LOCAL_BUMP, DEFAULT_RECALL_BUDGET } from '../../core/search-types.js';
import { DEFAULT_EMBEDDING_WEIGHT, DEFAULT_MMR_LAMBDA } from '../../search/hybrid.js';
import { DEFAULT_GRAPH_HOPS, DEFAULT_GRAPH_SEED_COUNT } from '../../graph/stream.js';
import { type VerbSpec, verb } from '../verb-row.js';

export const MEMORY_VERBS = {
  init: verb(() => import('../init.js'), 'handleInit', {
    flags: { switches: ['global', 'no-hooks', 'no-learn', 'no-schedule'], values: ['scan'], numbers: ['days'] },
    usage: [`
  init                     Create .hippo/ structure in current directory
    --scan [dir]           Find all git repos under dir (default: ~) and init each
    --days <n>             Days of git history to seed (default: 365 for --scan, 30 for single)
    --global               Init the global store ($HIPPO_HOME or ~/.hippo/)
    --no-hooks             Skip auto-detecting and installing agent hooks
                           (HIPPO_SKIP_AUTO_INTEGRATIONS=1 does the same)
    --no-schedule          Skip auto-creating the machine-level daily runner
    --no-learn             Skip seeding memories from git history and importing
                           coding agents' own memories (every init imports those)`],
  }),
  remember: verb(() => import('../remember.js'), 'handleRemember', {
    flags: {
      switches: ['error', 'extract', 'force', 'global', 'inferred', 'observed', 'pin', 'verified'],
      values: ['artifact-ref', 'kind', 'layer', 'owner', 'scope'],
      lists: ['tag'],
    },
    usage: [`
  remember <text>          Store a memory
    --tag <tag>            Add a tag (repeatable)
    --error                Tag as error (boosts retention)
    --pin                  Pin memory (never decays)
    --verified             Set confidence: verified (default)
    --observed             Set confidence: observed
    --inferred             Set confidence: inferred
    --global               Store in global store ($HIPPO_HOME or ~/.hippo/)`],
  }),
  supersede: verb(() => import('../remember.js'), 'handleSupersede', {
    flags: { switches: ['pin'], values: ['layer'], lists: ['tag'] },
    usage: [`
  supersede <id> "<text>"  Replace a memory with a new version; the old one points at it
    --layer <layer>        Layer for the new memory (default: the old memory's layer)
    --tag <tag>            Tag for the new memory (repeatable; default: the old memory's tags)
    --pin                  Pin the new memory (default: pinned if the old one was)`],
  }),
  recall: verb(() => import('../recall.js'), 'handleRecall', {
    scoped: true,
    flags: {
      switches: ['classic', 'continuity', 'equal-sources', 'evc-adaptive', 'filter-conflicts', 'graph-stream',
        'include-superseded', 'json', 'multihop', 'no-mmr', 'physics', 'rerank-utility', 'value-aware', 'why'],
      values: ['as-of', 'budget', 'goal', 'graph-hops', 'graph-seeds', 'hops', 'layer', 'max-neighbors', 'outcome',
        'reranker', 'salience-threshold', 'scope', 'session-id'],
      numbers: ['limit', 'local-bump', 'min-results', 'mmr-lambda', 'reranker-top-k'],
    },
    usage: [`
  recall <query>           Search and retrieve memories (local + global)
    --budget <n>           Token budget for the whole printed block (default: ${DEFAULT_RECALL_BUDGET})
    --min-results <n>      Minimum results regardless of budget (default: 1)
    --json                 Output as JSON
    --why                  Show match reasons and source annotations
    --include-superseded   Also return memories a newer version replaced
    --as-of <iso-date>     Return the memories that were current on that date
    --multihop             Search a second time with the speaker: and topic: tags the
                           first pass found (also on when config multihop.enabled is true)
    --hops <n>             E3.2 multi-hop graph recall: also surface memories
                           reached by walking the entities/relations graph <n>
                           hops (0..3, default off) out from the lexical seeds.
                           Graph hits are tagged [graph: Nhop <rel>]. Today the
                           graph holds supersedes edges (E3.1); cross-object edges
                           light up the same traversal once extracted.
    --max-neighbors <n>    Per-hop fanout cap for --hops (1..200, default 25).
    --graph-stream         L1: fuse a graph-retrieval stream into RRF, re-ranking
                           in-pool results by graph proximity to the strong lexical
                           seeds. Implies rrf scoring (default is blend). Local store
                           only. Distinct from --hops (which injects out-of-pool
                           neighbours); this re-ranks within the candidate pool.
    --graph-hops <n>       Hops for --graph-stream (1..3, default ${DEFAULT_GRAPH_HOPS}).
    --graph-seeds <n>      Lexical anchors for --graph-stream (default ${DEFAULT_GRAPH_SEED_COUNT}). The stream
                           re-ranks the rank>seeds tail; on a pool with <= n candidates
                           every candidate is a seed and the stream is inert.
    --no-mmr               Disable MMR diversity re-ranking
    --mmr-lambda <f>       MMR balance 0..1 (default: ${DEFAULT_MMR_LAMBDA}, 1.0 = pure relevance)
    --evc-adaptive         ACC-style: when top-K shows high inter-item overlap
                           (= conflict cluster), expand pool and re-rank by
                           recency. Default off. RESEARCH.md §PFC.ACC.
    --filter-conflicts     vlPFC interference filter: drop superseded entries
                           and 0.3x-downweight entries flagged in an open
                           conflict with a peer in the same result set.
                           Uses recorded supersession + conflicts only — never
                           lexical inference. Default off. RESEARCH.md §PFC.vlPFC.
    --value-aware          vmPFC value attribution: boost memories with positive
                           cumulative outcomes and demote those with negative
                           outcomes during ranking. Multiplier
                           clip(1 + 0.3*tanh(pos - neg), 0.7, 1.3). Reuses
                           outcome_positive / outcome_negative; no schema
                           change. Default off. RESEARCH.md §PFC.vmPFC.
    --rerank-utility       OFC option-value re-ranker: combine relevance,
                           strength, and integration cost into a single utility
                           = score * (0.5 + 0.5 * strength) * (1 - cost_factor)
                           where cost_factor = min(0.3, tokens / 10000). Re-sorts
                           results by utility. Default off. RESEARCH.md §PFC.OFC.
    --reranker <name>      Apply a reranker pass after retrieval
                           (cross-encoder|jev|clef-flash|clef|llm). Looks up
                           the named reranker from src/rerankers/index.ts and
                           re-orders the top-K candidates. Default unset (no reranker).
                           jev calls the hosted TypeSafe Jev API: it needs
                           TYPESAFE_API_KEY, sends the query and candidate
                           text to that API, costs about 0.0004 USD a recall,
                           and falls back to cross-encoder on any failure.
                           clef-flash and clef send the same request to
                           Cloudflare Workers AI (CLOUDFLARE_ACCOUNT_ID and
                           CLOUDFLARE_API_TOKEN) or to HIPPO_CLEF_ENDPOINT, and
                           keep the native order on any failure.
                           See docs/evals/2026-09-19-jev-reranker.md and
                           docs/plans/2026-05-10-f6-reranker-hardening.md.
    --reranker-top-k <n>   Cap candidates passed to the reranker (default 50;
                           40 for jev, clef-flash and clef).
    --goal <tag>           dlPFC goal-conditioned recall: memories tagged with
                           the goal tag get a 1.5x score boost and results are
                           re-sorted. Default off. RESEARCH.md §PFC.dlPFC.
    --session-id <id>      Session identifier for dlPFC goal-stack boost.
                           Defaults to $HIPPO_SESSION_ID. When set and the
                           (tenant, session) has active goals (see
                           'hippo goal push'), recall auto-boosts memories
                           whose tags match an active goal name. Boost stacks
                           on top of base BM25 score, capped at 3.0x.
    --salience-threshold <n>
                           Pineal salience: down-weight memories whose
                           retrieval_count is below n. score *= max(0.5,
                           retrieval_count / n) for entries with count < n;
                           entries at or above n are unchanged. Salience emerges
                           from USE, not from lexical overlap. Default off.
                           RESEARCH.md §"AI Pineal Gland". (v1's creation-time
                           lexical gate destroyed LoCoMo 0.28 -> 0.02; this v2
                           is retrieval-side, opt-in only — see MEMORY.md
                           "Hippo salience gate destroys benchmark recall".)
    --continuity           Include continuity block (active task snapshot,
                           latest matching session handoff, last 5 session
                           events) above the memory list. Useful at agent
                           boot when you want both relevant memories AND
                           where you left off in one call. Anchored on the
                           active snapshot's session_id; no anchor = no
                           handoff/events (use 'hippo session resume' for
                           the explicit handoff-without-snapshot path).`],
  }),
  explain: verb(() => import('../explain.js'), 'handleExplain', {
    scoped: true,
    flags: {
      switches: ['classic', 'equal-sources', 'include-superseded', 'json', 'no-mmr', 'physics'],
      values: ['as-of', 'budget', 'scope'],
      numbers: ['limit', 'local-bump', 'mmr-lambda'],
    },
    usage: [`
  explain <query>          Show full score breakdown for each retrieved memory
    --budget <n>           Token budget, counted as recall prints (default: ${DEFAULT_RECALL_BUDGET})
    --limit <n>            Cap the number of results displayed
    --json                 Output as JSON
    --physics | --classic  Force search mode (default: from config)
    --no-mmr               Disable MMR diversity re-ranking
    --mmr-lambda <f>       MMR balance 0..1 (default: ${DEFAULT_MMR_LAMBDA}, 1.0 = pure relevance)`],
  }),
  trace: verb(() => import('../remember.js'), 'handleTrace', {
    flags: { switches: ['json'], values: ['outcome', 'session', 'source', 'steps', 'task'], lists: ['tag'] },
    usage: [`
  trace <id>               Memory dossier: content, decay trajectory, retrievals,
                           outcomes, consolidation parents, open conflicts
    --json                 Output as JSON`],
  }),
  refine: verb(() => import('../maintenance.js'), 'handleRefine', {
    flags: { switches: ['all', 'dry-run', 'json'], values: ['model'], numbers: ['limit'] },
    usage: [`
  refine                   Rewrite consolidated semantic memories with Claude
    --limit <n>            Cap the number of memories processed this run
    --all                  Ignore \`llm-refined\` tag and re-refine everything
    --dry-run              Call the API but don't write results back
    --model <id>           Override the default model (claude-sonnet-4-6)
    --json                 Output summary as JSON
    (requires ANTHROPIC_API_KEY in env)`],
  }),
  eval: verb(() => import('../eval.js'), 'handleEval', {
    flags: {
      switches: ['bootstrap', 'equal-sources', 'json', 'no-mmr', 'save-baseline', 'show-cases', 'suite'],
      values: ['baseline', 'compare', 'out'],
      numbers: ['embedding-weight', 'local-bump', 'max-cases', 'min-mrr', 'mmr-lambda'],
    },
    usage: [`
  eval [<corpus.json>]     Measure recall quality against a test corpus
    --bootstrap            Generate a synthetic corpus from current memories
    --out <path>           With --bootstrap, write to file instead of stdout
    --max-cases <n>        With --bootstrap, cap case count (default: 50)
    --show-cases           Print per-case details (query, R@10, missed, top 3)
    --compare <path>       JSON from a prior \`eval --json\` run; print deltas
    --no-mmr               Disable MMR for this eval run
    --mmr-lambda <f>       Override MMR lambda for this run
    --embedding-weight <f> Override cosine weight (default: ${DEFAULT_EMBEDDING_WEIGHT})
    --local-bump <f>       Local-over-global priority multiplier (default: ${DEFAULT_LOCAL_BUMP})
    --equal-sources        Shortcut for --local-bump 1.0
    --min-mrr <f>          Exit non-zero if mean MRR falls below this
    --json                 Output full summary as JSON`],
  }),
  context: verb(() => import('../context.js'), 'handleContext', {
    flags: {
      switches: ['auto', 'cross-project', 'pinned-only'],
      values: ['budget', 'format', 'framing', 'include-recent', 'runtime', 'scope'],
      numbers: ['limit'],
    },
    usage: [`
  context                  Smart context injection for AI agents
    --auto                 Auto-detect task from git state
    --budget <n>           Token budget for the whole printed block (default: 1500)
    --pinned-only          Only inject pinned memories (used by UserPromptSubmit hook)
    --include-recent <n>   With --pinned-only, also inject the last N writes regardless of pinning
    (the hook payload's "prompt" drives prompt recall instead of --include-recent when pinnedInject.promptRecall is on, the default)
    --format <fmt>         Output format: markdown (default), json, additional-context (Claude Code hook JSON),
                           or copilot (Copilot sessionStart hook JSON, from the store of the payload's cwd)
    --framing <mode>       Framing: observe (default), suggest, assert`],
  }),
  sleep: verb(() => import('../sleep.js'), 'handleSleep', {
    scoped: true,
    flags: { switches: ['dry-run', 'no-learn', 'no-share'], values: ['log-file'] },
    usage: [`
  sleep                    Run consolidation pass (auto-learns + dedup + auto-shares)
                           Runs at Claude Code and OpenCode session end and in the daily job.
                           With ANTHROPIC_API_KEY set it sends memory text to Anthropic for
                           fact extraction; {"extraction":{"enabled":false}} turns that off
    --dry-run              Preview without writing
    --no-learn             Skip auto git-learn and the agent memory import before consolidation
    --no-share             Skip auto-sharing to global store`],
  }),
  'daily-runner': verb(() => import('../setup.js'), 'handleDailyRunner', {
    flags: {},
    usage: [`
  daily-runner             Sweep registered workspaces and run daily learn+sleep`],
  }),
  dedup: verb(() => import('../maintenance.js'), 'handleDedup', {
    flags: { switches: ['dry-run'], numbers: ['threshold'] },
    usage: [`
  dedup                    Remove duplicate memories (keeps stronger copy)
    --dry-run              Preview without removing
    --threshold <n>        Ignored, kept for old scripts: a duplicate is the same text apart from spacing`],
  }),
} satisfies Record<string, VerbSpec>;
