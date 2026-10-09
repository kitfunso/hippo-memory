// Tool definitions and input schemas served by tools/list.

import type { ToolInputSchema } from './tool-args.js';
import { DEFAULT_RECALL_BUDGET } from '../core/search-types.js';
import { DEFAULT_ASSEMBLE_BUDGET } from '../api/assemble.js';
import { MAX_ID_LEN } from '../http-util.js';

// ── Tool definitions ──

// HTTP sets no budget cap; 25x the recall default leaves room for large-context clients while bounding one call's work.
const MAX_BUDGET_TOKENS = 25 * DEFAULT_RECALL_BUDGET;
// Same ceiling as the HTTP list routes' parseListLimit.
const MAX_LIST_LIMIT = 1000;

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export const TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'hippo_recall',
    description:
      'Retrieve relevant memories from the project memory store. Returns memories ranked by relevance, strength, and recency within the token budget. Use at session start or when you need context about a topic. Pass include_continuity=true to also surface the active task snapshot, latest matching session handoff, and recent session events as a "## Continuity" appendix.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for in memory (natural language)' },
        budget: {
          type: 'number',
          minimum: 0,
          maximum: MAX_BUDGET_TOKENS,
          description: `Max tokens to return (default: config.defaultBudget, ${DEFAULT_RECALL_BUDGET}; max ${MAX_BUDGET_TOKENS})`,
        },
        include_continuity: {
          type: 'boolean',
          description: 'Append continuity context (active snapshot + handoff + last 5 session events) below the memory results. Useful at session boot.',
        },
        scope: {
          type: 'string',
          description: 'Restrict results and continuity to memories/rows matching this scope exactly. When omitted, default-deny applies to ANY <source>:private:* (slack, github, ...) and unknown-legacy rows.',
        },
        fresh_tail_count: {
          type: 'number',
          description: 'When > 0, surface the last N kind=raw rows tagged isFreshTail=true regardless of query match. Useful for "what did I just see" continuity. Capped at 200.',
        },
        fresh_tail_session_id: {
          type: 'string',
          description: 'Restrict the fresh-tail window to a specific session. Without this, fresh-tail is tenant-wide (legacy v1.5.2 behaviour, pre-v1.6.3 default).',
        },
        summarize_overflow: {
          type: 'boolean',
          description: 'When true (default), entries that overflow the limit and share a level-2 parent summary cause that summary to be appended in their place. Set false for strict-limit behaviour.',
        },
        scorer_window: {
          type: 'number',
          description: 'How many of the top-ranked memories the fresh-tail and summarize-overflow appendix is worked out against. The main list ranks the whole tenant store, so scorer_window does not narrow it. Default 200. Rejected as RecallContractError code=invalid_scorer_window if 0/negative/non-finite/non-numeric.',
        },
        session_id: {
          type: 'string',
          maxLength: MAX_ID_LEN,
          description: `Optional session id (v1.7.4). When set AND (tenant, session) has active goals, applies the dlPFC goal-stack boost to the ranked memories before formatting. Mirrors fresh_tail_session_id shape (${MAX_ID_LEN}-char cap).`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'hippo_assemble',
    description:
      'Build a chronologically-ordered context window for a session. Returns ordered items: fresh-tail raw rows + level-2 summary substitutions for older rows + budget-fit. Hippo-additive vs lossless-claw: eviction picks lowest-strength non-fresh-tail items first instead of oldest-first. Tenant-scoped; default-deny on private scopes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session identifier. Returns clean empty result if no kind=raw rows match.',
        },
        budget: {
          type: 'number',
          minimum: 0,
          maximum: MAX_BUDGET_TOKENS,
          description: `Token budget for the assembled context (default ${DEFAULT_ASSEMBLE_BUDGET}; max ${MAX_BUDGET_TOKENS}). Eviction kicks in over budget.`,
        },
        fresh_tail_count: {
          type: 'number',
          description: 'Recent raw rows always kept verbatim (default 10). These are never evicted.',
        },
        summarize_older: {
          type: 'boolean',
          description: 'When true (default), older raws sharing a level-2 parent summary get substituted. Set false to keep every older raw as-is.',
        },
        scope: {
          type: 'string',
          description: 'Restrict to memories whose scope matches exactly. When omitted, default-deny applies to ANY <source>:private:* scope and unknown:legacy rows. Pass an explicit scope to assemble a private session with consent.',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'hippo_drill',
    description:
      'Walk one step down the DAG from a level-2+ topic summary to its direct children. Companion to hippo_recall: when recall returns an item with isSummary=true and substitutedFor=[ids], pass the summary id here to recover the original detail. Tenant-scoped; default-deny on private scopes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary_id: {
          type: 'string',
          description: 'ID of the level-2 (or higher) summary to drill into. Must be a summary, not a leaf — leaves are not drillable.',
        },
        limit: {
          type: 'number',
          minimum: 0,
          maximum: MAX_LIST_LIMIT,
          description: `Max children to return (default 50; max ${MAX_LIST_LIMIT}).`,
        },
        budget: {
          type: 'number',
          minimum: 0,
          maximum: MAX_BUDGET_TOKENS,
          description: `Max total token cost (~ chars/4) of returned children (max ${MAX_BUDGET_TOKENS}). Truncates chronologically.`,
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'v0.30 / E5: walk N levels down (default 1 = direct children only). Higher values include children of children. Token budget remains GLOBAL across levels. Hard cap 10.',
        },
      },
      required: ['summary_id'],
    },
  },
  {
    name: 'hippo_remember',
    description:
      'Store a new memory. Use when you learn something non-obvious, hit an error, or discover a useful pattern. Memories decay over time unless retrieved. Errors get 2x half-life.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The memory to store (1-2 sentences, specific and concrete)',
        },
        error: { type: 'boolean', description: 'Mark as error memory (doubles half-life)' },
        pin: { type: 'boolean', description: 'Pin memory (never decays)' },
        tag: { type: 'string', description: 'Optional tag for categorization' },
        personal: { type: 'boolean', description: 'Store it as your own private memory: only you can recall it, in every project. Needs a key you minted or a sign-in.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'hippo_outcome',
    description:
      'Report whether recalled memories were useful. Strengthens good memories (+5 days half-life) and weakens bad ones (-3 days). Call after completing work.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        good: {
          type: 'boolean',
          description: 'true = memories helped, false = memories were irrelevant',
        },
      },
      required: ['good'],
    },
  },
  {
    name: 'hippo_context',
    description:
      'Smart context injection: auto-detects current task from git state and returns relevant memories plus the active task snapshot, session handoff and recent session trail (the same bundle as GET /v1/context). Use at the start of any session. Memories and those sections are scope-filtered: a no-scope caller does NOT see ANY <source>:private:* (slack, github, ...) or legacy-quarantine rows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        budget: {
          type: 'number',
          minimum: 0,
          maximum: MAX_BUDGET_TOKENS,
          description: `Max tokens (default: config.defaultContextBudget, 3000; max ${MAX_BUDGET_TOKENS})`,
        },
        scope: {
          type: 'string',
          description: 'Restrict memories, snapshot, handoff and trail to this scope exactly. When omitted, default-deny applies to ANY <source>:private:* (slack, github, ...) and unknown-legacy rows.',
        },
      },
    },
  },
  {
    name: 'hippo_status',
    description:
      'Check memory health: counts, strengths, at-risk memories, last consolidation time.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'hippo_learn',
    description:
      'Scan recent git commits for lessons from fix/revert/bug/refactor/perf patterns. Run after coding sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Days to scan back (default: 7)' },
      },
    },
  },
  {
    name: 'hippo_conflicts',
    description:
      'List open memory conflicts — contradictory memories that need resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'hippo_resolve',
    description:
      'Resolve a memory conflict by keeping one memory and weakening or deleting the other.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        conflict_id: { type: 'number', description: 'The conflict ID to resolve' },
        keep: { type: 'string', description: 'ID of the memory to keep' },
        forget: { type: 'boolean', description: 'Delete the loser instead of weakening (default: false)' },
        rejectLoser: { type: 'boolean', description: 'Tombstone the loser\'s value too, so it refuses re-ingestion (implies removal; default: false)' },
        reason: { type: 'string', description: 'Reason recorded on the tombstone when rejectLoser is set (default: a conflict-context string)' },
      },
      required: ['conflict_id', 'keep'],
    },
  },
  {
    name: 'hippo_share',
    description:
      'Share a memory to the global store for cross-project use with transfer scoring.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memory ID to share' },
        force: { type: 'boolean', description: 'Share even if transfer score is low' },
      },
      required: ['id'],
    },
  },
  {
    name: 'hippo_peers',
    description:
      'List all projects that have contributed memories to the global shared store.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'hippo_predict_baserate',
    description:
      'J3 reference-class / planning-fallacy detector. Get base-rate stats for closed predictions in a class. Call this when you make a forward-looking claim (effort estimate, rollout risk, deadline) to anchor on the past track record rather than the inside view. Returns count + mean estimate + mean actual + mean ratio + median ratio + MAE + a human-readable summary. Tenant-scoped.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        class_tag: {
          type: 'string',
          description: 'Cohort label, e.g. "migration-effort", "rollout-risk", "deadline-week". Must match the class_tag used when the predictions were created via hippo_predict (or `hippo predict ...`).',
        },
      },
      required: ['class_tag'],
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// api.retrieve rejects these itself, so MCP and HTTP callers get the same typed error code for the same bad value.
export const ARGS_CHECKED_BY_API = new Map<string, ReadonlySet<string>>([['hippo_recall', new Set(['scorer_window'])]]);
