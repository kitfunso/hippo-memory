#!/usr/bin/env node
/**
 * Hippo Memory MCP Server
 *
 * Exposes hippo memory as MCP tools over stdio transport.
 * Uses the programmatic API directly (no child process spawning).
 *
 * Usage: hippo mcp (or npx hippo-memory mcp)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  createMemory,
  computeSchemaFit,
  Layer,
  applyOutcome,
  calculateStrength,
} from '../memory.js';
import { search, hybridSearch, physicsSearch, markRetrieved, estimateTokens } from '../search.js';
import { isRecallBoostAblated, evalNow } from '../ablation.js';
import { loadAllEntries, writeEntry, readEntry, initStore, loadActiveTaskSnapshot, listMemoryConflicts, resolveConflict, RECALL_DEFAULT_DENY_SCOPES } from '../store.js';
import { shareMemory, listPeers, getGlobalRoot } from '../shared.js';
import { consolidate } from '../consolidate.js';
import { execSync } from 'child_process';
import { fetchGitLog, extractLessons, deduplicateLesson, isGitRepo } from '../autolearn.js';
import { loadConfig } from '../config.js';
import { resolveConfidence } from '../memory.js';
import { resolveTenantId } from '../tenant.js';
import { recall as apiRecall, remember as apiRemember, outcome as apiOutcome, drillDown as apiDrillDown, assemble as apiAssemble, isPrivateScope, adminActor, buildSuppressionSummary, type Context as ApiContext } from '../api.js';
import { computePredictionBaserate } from '../predictions.js';
import { appendAuditEvent } from '../audit.js';
import { createHash } from 'node:crypto';
import {
  detectAnchoring,
  hashQueryText,
  buildSessionKey,
  getOrCreateRing,
  appendRecall,
  snapshotRing,
  RingBuffer,
  type AnchoringHint,
} from '../recall-history.js';
import { detectAvailabilityBias, type AvailabilityHint } from '../availability.js';

// v0.33 / J1 — Module-level per-(tenant, session) recall-history ring map
// for the MCP pipeline. Separate from CLI/HTTP rings per plan v3
// architecture (per-pipeline rings; no IPC).
const sessionRecallHistoryMcp = new Map<string, RingBuffer>();

/** Test-only: reset the module-level recall-history Map. Call from beforeEach. */
export function __resetSessionRecallHistoryMcp(): void {
  sessionRecallHistoryMcp.clear();
}
import { applyGoalStackBoost } from '../goals.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import { PACKAGE_VERSION } from '../version.js';

// ── Find hippo root ──

function findHippoRoot(): string | null {
  // Walk up from cwd
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.hippo');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Global fallback (respects $HIPPO_HOME / $XDG_DATA_HOME)
  const global = getGlobalRoot();
  if (fs.existsSync(global)) return global;
  return null;
}

// ── MCP protocol types ──

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export type { McpRequest, McpResponse };

/**
 * Optional execution context threaded from a non-stdio transport. When the
 * HTTP transport in src/server.ts calls handleMcpRequest, it knows the
 * server's bound hippoRoot and the auth-resolved tenantId/actor. Passing
 * those through here lets executeTool skip the findHippoRoot() walk and
 * the env-based resolveTenantId({}) fallback — both of which would
 * otherwise produce the wrong store and the wrong tenant for HTTP callers.
 *
 * Stdio callers pass nothing; behavior stays unchanged for that path.
 */
export interface McpContext {
  hippoRoot: string;
  tenantId: string;
  actor: string;
  /**
   * Per-client key for state isolation under HTTP-MCP. For stdio: 'stdio-${pid}'
   * (one process = one client). For HTTP-SSE / HTTP MCP: hash(bearer + remoteAddr)
   * built by src/server.ts when constructing McpContext for the request.
   * Optional for backwards compatibility; defaults to `${tenantId}:default`.
   */
  clientKey?: string;
}

// MCP stdio transport spec: messages are newline-delimited JSON-RPC, no embedded newlines.
// https://modelcontextprotocol.io/specification/.../basic/transports#stdio
function send(msg: McpResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Format helpers ──

import type { ContinuityBlock } from '../api.js';

function formatContinuityBlock(block: ContinuityBlock): string {
  const lines: string[] = ['## Continuity'];
  if (block.activeSnapshot) {
    lines.push('');
    lines.push('### Active Task Snapshot');
    lines.push(`- Task: ${block.activeSnapshot.task}`);
    lines.push(`- Summary: ${block.activeSnapshot.summary}`);
    lines.push(`- Next: ${block.activeSnapshot.next_step}`);
  }
  if (block.sessionHandoff) {
    lines.push('');
    lines.push('### Session Handoff');
    lines.push(`- Summary: ${block.sessionHandoff.summary}`);
    if (block.sessionHandoff.nextAction) {
      lines.push(`- Next action: ${block.sessionHandoff.nextAction}`);
    }
    if ((block.sessionHandoff.artifacts ?? []).length > 0) {
      lines.push(`- Artifacts: ${(block.sessionHandoff.artifacts ?? []).join(', ')}`);
    }
  }
  if (block.recentSessionEvents.length > 0) {
    lines.push('');
    lines.push('### Recent Session Trail');
    for (const e of block.recentSessionEvents) {
      const preview = e.content.length > 200 ? e.content.slice(0, 200) + '…' : e.content;
      lines.push(`- [${e.event_type}] ${preview}`);
    }
  }
  if (lines.length === 1) {
    lines.push('');
    lines.push('(no active task snapshot, handoff, or recent events for this tenant)');
  }
  return lines.join('\n');
}

function formatMemories(results: ReturnType<typeof search>, hippoRoot: string): string {
  if (results.length === 0) return 'No relevant memories found.';

  const config = loadConfig(hippoRoot);
  const lines: string[] = [`Found ${results.length} memories:\n`];

  for (const r of results) {
    const conf = resolveConfidence(r.entry);
    const tags = r.entry.tags.length > 0 ? ` tags: ${r.entry.tags.join(', ')}` : '';
    lines.push(`[${conf}]${tags} (strength=${r.entry.strength.toFixed(2)})`);
    lines.push(r.entry.content);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: 'hippo_recall',
    description:
      'Retrieve relevant memories from the project memory store. Returns memories ranked by relevance, strength, and recency within the token budget. Use at session start or when you need context about a topic. Pass include_continuity=true to also surface the active task snapshot, latest matching session handoff, and recent session events as a "## Continuity" appendix.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for in memory (natural language)' },
        budget: { type: 'number', description: 'Max tokens to return (default: 1500)' },
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
          description: 'Candidate pool size that api.recall evaluates. Affects fresh-tail / summarize-overflow appendix paths and continuity hits. Note: the primary ranked block over MCP is driven by a separate physics/hybrid scorer over the full tenant store, so scorer_window does NOT narrow the main results — only the appendix. Default 200. Rejected as RecallContractError code=invalid_scorer_window if 0/negative/non-finite/non-numeric.',
        },
        session_id: {
          type: 'string',
          maxLength: 256,
          description: 'Optional session id (v1.7.4). When set AND (tenant, session) has active goals, applies the dlPFC goal-stack boost to the primary physics/hybrid result band before formatting AND to api.recall\'s primary BM25 band (so the audit + appendix paths see the same session). Mirrors fresh_tail_session_id shape (256-char cap).',
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
          description: 'Token budget for the assembled context (default 4000). Eviction kicks in over budget.',
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
          description: 'Max children to return (default 50).',
        },
        budget: {
          type: 'number',
          description: 'Max total token cost (~ chars/4) of returned children. Truncates chronologically.',
        },
        depth: {
          type: 'number',
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
      'Smart context injection: auto-detects current task from git state and returns relevant memories plus the active task snapshot. Use at the start of any session. Memories and snapshot are scope-filtered: a no-scope caller does NOT see ANY <source>:private:* (slack, github, ...) or legacy-quarantine rows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        budget: { type: 'number', description: 'Max tokens (default: 1500)' },
        scope: {
          type: 'string',
          description: 'Restrict memories and snapshot to this scope exactly. When omitted, default-deny applies to ANY <source>:private:* (slack, github, ...) and unknown-legacy rows.',
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

// ── Track last recalled IDs for outcome feedback ──
//
// Keyed per-client so two HTTP-MCP clients hitting the same tenant cannot
// poison each other's outcome feedback. The key is `ctx.clientKey` when the
// transport supplies one (HTTP-MCP via src/server.ts builds
// hash(bearer+remoteAddr)); stdio and any caller without a clientKey falls
// back to `'stdio-${pid}'` (one process = one client) or
// `${tenantId}:default` if a McpContext is constructed in tests without a
// pid-bound transport.
const lastRecalledIds = new Map<string, string[]>();

function resolveClientKey(ctx: { clientKey?: string; tenantId: string } | undefined): string {
  if (ctx?.clientKey) return ctx.clientKey;
  if (ctx?.tenantId) return `stdio-${process.pid}:${ctx.tenantId}`;
  return `stdio-${process.pid}:default`;
}

// ── Tool execution ──

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: McpContext,
): Promise<string> {
  // When a transport hands us a context (HTTP path), trust it: the HTTP
  // server already resolved hippoRoot from its bound opts and tenantId
  // from the Bearer token (or the loopback fallback). The stdio path
  // continues to walk from cwd / fall back to the global root, and to
  // resolve tenant from HIPPO_TENANT.
  const hippoRoot = ctx?.hippoRoot ?? findHippoRoot();
  if (!hippoRoot) return 'No .hippo/ store found. Run: hippo init';

  const config = loadConfig(hippoRoot);
  // A5: every loadAllEntries() in this server returns to the caller and is
  // tenant-isolated. Resolved once per tool call: prefer the transport's
  // ctx.tenantId so an HTTP Bearer for tenant B doesn't drop to HIPPO_TENANT.
  const tenantId = ctx?.tenantId ?? resolveTenantId({});

  switch (name) {
    case 'hippo_recall': {
      const query = String(args.query || '');
      const budget = Number(args.budget) || config.defaultBudget;
      const includeContinuity = Boolean(args.include_continuity);
      const explicitScope = typeof args.scope === 'string' && args.scope.length > 0
        ? String(args.scope)
        : undefined;
      const freshTailCountArg = Number(args.fresh_tail_count);
      const freshTailCount = Number.isFinite(freshTailCountArg) && freshTailCountArg > 0
        ? freshTailCountArg
        : undefined;
      const freshTailSessionId = typeof args.fresh_tail_session_id === 'string' && args.fresh_tail_session_id.length > 0
        ? String(args.fresh_tail_session_id)
        : undefined;
      const summarizeOverflow = typeof args.summarize_overflow === 'boolean'
        ? args.summarize_overflow
        : undefined;
      // v1.7.2 T4 — scorer_window: Number-coerce so non-numeric input
      // (string 'abc', boolean, etc.) reaches api.recall() and produces
      // the same typed RecallContractError(code='invalid_scorer_window')
      // as HTTP. Codex CRITICAL[2]: do NOT use `typeof === 'number'` — that
      // would silently default-200 on string `"5"` while HTTP 400s on the
      // same value. Both transports must agree.
      const scorerWindow = args.scorer_window === undefined
        ? undefined
        : Number(args.scorer_window);
      // v1.7.4 -- session_id for the dlPFC goal-stack boost. Mirrors
      // fresh_tail_session_id shape: trim, 256-char cap. When set and the
      // (tenant, session) has active goals, the boost is applied (a) inside
      // api.recall on its primary BM25 band (so the audit + fresh-tail /
      // summary appendix paths see consistent ranking), and (b) below on the
      // physics/hybrid result list before formatMemories (since MCP's
      // user-visible primary ordering does NOT come from api.recall).
      const sessionIdRaw = typeof args.session_id === 'string' ? args.session_id.trim() : '';
      const sessionId = sessionIdRaw.length > 0 && sessionIdRaw.length <= 256
        ? sessionIdRaw
        : undefined;
      const apiCtx: ApiContext = {
        hippoRoot,
        tenantId,
        actor: adminActor('mcp'),
      };
      // Route through api.recall for audit + (when requested) continuity block.
      // api.recall already applies the same default-deny / exact-match rules
      // we want here, so its continuity output is the source of truth.
      // RecallContractError throws propagate raw to the MCP caller (per the
      // v1.6.5 F5 contract documented in mcp-recall-fresh-tail-policy.test.ts).
      const apiResult = apiRecall(apiCtx, {
        query,
        limit: 50,
        scope: explicitScope,
        includeContinuity,
        // v1.13.x / J2 — MCP computes its OWN availability hint over the
        // physics/hybrid result set below; suppress api.recall's BM25-band copy
        // so one MCP recall does not emit recall_availability_detected twice.
        suppressAvailabilityHint: true,
        ...(freshTailCount !== undefined ? { freshTailCount } : {}),
        ...(freshTailSessionId !== undefined ? { freshTailSessionId } : {}),
        ...(summarizeOverflow !== undefined ? { summarizeOverflow } : {}),
        ...(scorerWindow !== undefined ? { scorerWindow } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      });

      // Existing physics/hybrid scorer continues to drive user-visible
      // ordering and the strength bump on retrieval. Apply the same scope
      // rule as api.recall: explicit scope = exact match; no scope =
      // default-deny on ANY `<source>:private:*` AND 'unknown:legacy'.
      // v1.2.1: generic-private check via api.isPrivateScope.
      const allEntries = loadAllEntries(hippoRoot, tenantId);
      // v1.12.13 / C5 — WYSIATI counters for the MCP physics/hybrid pipeline.
      // Per the plan-eng-critic round 1 CRIT resolution: MCP's user-visible
      // memory list comes from THIS pipeline (loadAllEntries -> scope filter
      // -> physicsSearch/hybridSearch), NOT from apiResult. The MCP
      // suppressionSummary must describe what the user actually sees, so we
      // track filter activity here and replace apiResult.suppressionSummary
      // in the user-facing response.
      const totalCandidatesCountMcp = allEntries.length;
      const entries = explicitScope
        ? allEntries.filter((e) => e.scope === explicitScope)
        : allEntries.filter((e) => {
            const s = e.scope ?? null;
            if (s === null) return true;
            if (isPrivateScope(s)) return false;
            // v1.7.2: read from RECALL_DEFAULT_DENY_SCOPES (single source of truth
            // shared with SQL clause + passesScopeFilterForRecall).
            if ((RECALL_DEFAULT_DENY_SCOPES as readonly string[]).includes(s)) return false;
            return true;
          });
      const droppedPreRankCountMcp = allEntries.length - entries.length;
      const usePhysics = config.physics?.enabled !== false;
      let results = usePhysics
        ? await physicsSearch(query, entries, { budget, hippoRoot, physicsConfig: config.physics })
        : await hybridSearch(query, entries, { budget, hippoRoot });
      // v1.12.13 / C5 — droppedByBudget for MCP is an UPPER BOUND. The
      // difference (entries.length - results.length) lumps three things
      // together: rows hybridSearch/physicsSearch internally dropped because
      // they scored zero (didn't match the query at all), rows the search
      // engine filtered internally (e.g. superseded when --include-
      // superseded isn't set), and rows that genuinely didn't fit the
      // `budget` token cap. The honest fix needs hybridSearch/physicsSearch
      // to expose their pre-budget-cut scored-count. Until then this is an
      // upper bound that conflates "not relevant" with "no budget" on
      // no-match / sparse-match queries. Plan-eng-critic round 1 MED and
      // codex-review-critic P2 both flagged this; documented + tracked as
      // a v1.12.14 follow-up. Independent-review-critic and code-review-
      // critic both graded as non-blocking for v1.12.13 ship.
      // TODO(c5.1): expose scoredCount from hybridSearch/physicsSearch and
      // compute droppedByBudget = scoredCount - results.length, with the
      // remainder (entries.length - scoredCount) attributed to
      // droppedPreRank or a new "noQueryMatch" counter.
      const droppedByBudgetCountMcp = Math.max(0, entries.length - results.length);

      // v1.7.4 -- dlPFC goal-stack boost on the MCP physics/hybrid result
      // list BEFORE formatMemories. MCP's user-visible primary ordering does
      // NOT come from api.recall (apiResult above), so the boost has to run
      // here too. Helper signature accepts any { entry, score } shape; the
      // physics/hybrid result rows are already in that shape.
      if (sessionId !== undefined) {
        const dbForBoost = openHippoDb(hippoRoot);
        try {
          results = applyGoalStackBoost(dbForBoost, results, {
            sessionId,
            tenantId,
            limit: results.length,
          });
        } finally {
          closeHippoDb(dbForBoost);
        }
      }

      // Mark retrieved and persist
      const retrieved = markRetrieved(results.map((r) => r.entry));
      // EVAL-ONLY ablation (see ablation.ts): skip persistence under the recall
      // flag; ids below stay populated for outcome attribution.
      if (!isRecallBoostAblated()) {
        for (const entry of retrieved) writeEntry(hippoRoot, entry);
      }
      lastRecalledIds.set(resolveClientKey(ctx), retrieved.map((e) => e.id));

      // v0.33 / J1 — MCP per-pipeline anchoring detector. UNLIKE J3.2's
      // planningFallacyHint (which is pipeline-invariant because it
      // depends only on queryText + predictions table state), the
      // anchoring hint depends on (a) per-pipeline top-1 ranking (MCP's
      // physics/hybrid winner can differ from api.recall's BM25 winner)
      // and (b) per-pipeline ring buffer. So MCP computes its OWN hint
      // against MCP's own top-1, mirroring the C5 per-pipeline rule.
      let mcpAnchoringHint: AnchoringHint | null = null;
      if (process.env.HIPPO_ANCHORING !== 'off') {
        if (sessionId) {
          const ringKey = buildSessionKey(tenantId, sessionId);
          const ring = getOrCreateRing(sessionRecallHistoryMcp, ringKey);
          const queryHash = hashQueryText(query);
          const topId = results[0]?.entry.id ?? null;
          mcpAnchoringHint = detectAnchoring(snapshotRing(ring), queryHash, topId);
          appendRecall(ring, queryHash, topId, mcpAnchoringHint?.memoryId);
          // Pipeline-local audit emission (lockstep with CLI / api.recall).
          if (mcpAnchoringHint?.reason === 'memory_dominance') {
            const dbForAudit = openHippoDb(hippoRoot);
            try {
              appendAuditEvent(dbForAudit, {
                tenantId,
                actor: 'mcp',
                op: 'recall_anchor_detected_memory_dominance',
                targetId: mcpAnchoringHint.memoryId,
                metadata: {
                  memory_id: mcpAnchoringHint.memoryId,
                  query_count: mcpAnchoringHint.queryCount ?? null,
                },
              });
            } finally {
              closeHippoDb(dbForAudit);
            }
          } else if (mcpAnchoringHint?.reason === 'query_repeat') {
            const dbForAudit = openHippoDb(hippoRoot);
            try {
              appendAuditEvent(dbForAudit, {
                tenantId,
                actor: 'mcp',
                op: 'recall_anchor_detected_query_repeat',
                targetId: mcpAnchoringHint.memoryId,
                metadata: { memory_id: mcpAnchoringHint.memoryId },
              });
            } finally {
              closeHippoDb(dbForAudit);
            }
          }
        } else {
          // Telemetry: caller had no sessionId so ring tracking skipped.
          // Per the recall-audit convention at api.ts:854, use SHA-256/16
          // for prompt hashing (NOT hashQueryText which is FNV-1a 32-bit
          // for recall matching; brute-force trivial for low-entropy
          // queries). Codex round-2 P2 catch.
          const dbForAudit = openHippoDb(hippoRoot);
          try {
            appendAuditEvent(dbForAudit, {
              tenantId,
              actor: 'mcp',
              op: 'recall_anchor_skipped_no_session',
              targetId: undefined,
              metadata: {
                query_hash: createHash('sha256').update(query).digest('hex').slice(0, 16),
                query_length: query.length,
              },
            });
          } finally {
            closeHippoDb(dbForAudit);
          }
        }
      }

      // v0.32 / J3.2 — auto-injection of reference-class baserate hint
      // when the query carries a forward-prediction phrase. Read from
      // apiResult.planningFallacyHint (already computed inside api.recall
      // with actor='mcp' threaded through ctx.actor.subject). The hint is
      // pipeline-INVARIANT — same (hippoRoot, tenantId, query) inputs
      // produce the same hint regardless of which downstream search
      // pipeline (api.recall band vs physics/hybrid) renders the memory
      // list, so re-computing here would double the audit emission for
      // identical telemetry. C5 per-pipeline rule does NOT apply here
      // because the hint depends on queryText, not on the matched memory
      // set. Prepend BEFORE the memory list so the agent sees it first.
      // v0.33 / J1: Anchoring hint goes ABOVE planning-fallacy hint
      // (anchoring is the stronger cognitive-pull warning).
      // v1.13.3 / C5 follow-up — Build MCP-pipeline suppressionSummary BEFORE
      // the response is assembled so the Cutoff block can render at TOP
      // alongside the other Track J hints. The dogfood
      // (docs/dogfood/2026-05-27-track-j-warnings.md) showed the v1.13.0-v1.13.2
      // bottom-placement was dark: a fresh sub-agent summarised the visible
      // memories with zero mention of the dropped pool. Top-placement + plain-
      // English rewrite fixes the read-rate without any system-prompt addendum.
      const physicsIds = new Set(results.map((r) => r.entry.id));
      const tailOrSummary = apiResult.results.filter(
        (r) => (r.isFreshTail || r.isSummary) && !physicsIds.has(r.id),
      );
      const freshTailAddedMcp = tailOrSummary.filter((r) => r.isFreshTail && !r.isSummary).length;
      const summarySubsAddedMcp = tailOrSummary.filter((r) => r.isSummary).length;
      // v0.33 / J1: suppressedByInterference bumped on MCP's R2 fire.
      const mcpSuppressedByInterference = mcpAnchoringHint?.reason === 'memory_dominance' ? 1 : 0;
      const mcpSuppressionSummary = buildSuppressionSummary({
        totalCandidates: totalCandidatesCountMcp,
        droppedPreRank: droppedPreRankCountMcp,
        droppedByBudget: droppedByBudgetCountMcp,
        summarySubstitutionsAdded: summarySubsAddedMcp,
        freshTailAdded: freshTailAddedMcp,
        suppressedByInterference: mcpSuppressedByInterference,
      });

      // v1.13.x / J2 — MCP per-pipeline availability/recency-bias detector.
      // Like the anchoring hint above (and unlike J3.2's pipeline-invariant
      // planningFallacyHint), this depends on MCP's OWN returned top-K and the
      // scope-filtered candidate pool (entries) it was drawn from, so MCP
      // computes its own hint here. Soft warning only. Gated by
      // HIPPO_AVAILABILITY=off; audit emission is pipeline-local (actor='mcp').
      let mcpAvailabilityHint: AvailabilityHint | null = null;
      if (process.env.HIPPO_AVAILABILITY !== 'off') {
        mcpAvailabilityHint = detectAvailabilityBias({
          topK: results.map((r) => ({ id: r.entry.id, created: r.entry.created })),
          pool: entries.map((e) => ({ id: e.id, created: e.created })),
        });
        if (mcpAvailabilityHint) {
          const dbForAudit = openHippoDb(hippoRoot);
          try {
            appendAuditEvent(dbForAudit, {
              tenantId,
              actor: 'mcp',
              op: 'recall_availability_detected',
              metadata: {
                recent_fraction: mcpAvailabilityHint.recentFraction,
                older_passed_over: mcpAvailabilityHint.olderCandidatesPassedOver,
                returned_count: mcpAvailabilityHint.returnedCount,
              },
            });
          } finally {
            closeHippoDb(dbForAudit);
          }
        }
      }

      let response = '';
      if (mcpAnchoringHint) {
        response =
          `## Anchoring hint\n` +
          `${mcpAnchoringHint.summary}\n` +
          `[anchored_on: ${mcpAnchoringHint.memoryId}]\n` +
          `\n---\n\n`;
      }
      // v1.13.x / J2 — availability/recency-bias hint, rendered below the
      // anchoring hint and above the planning-fallacy hint. Soft warning only.
      if (mcpAvailabilityHint) {
        response += `## Availability bias\n${mcpAvailabilityHint.summary}\n\n---\n\n`;
      }
      if (apiResult.planningFallacyHint) {
        const h = apiResult.planningFallacyHint;
        const safePhrase = JSON.stringify(h.detectedPhrase);
        response +=
          `## Planning fallacy hint\n` +
          `Class: ${h.classTag}\n` +
          `${h.baserateSummary}\n` +
          `(detected: ${safePhrase})\n` +
          `\n---\n\n`;
      } else if (apiResult.planningFallacyWatching) {
        // v1.13.4 / J3.2 follow-up — surface the watching variant when
        // the regex matched but no baserate could be produced
        // (no_class_match / tiebreak). Mutually exclusive with the hint
        // block above. Suggestion text directs the user toward an action
        // (typically: tag a prediction class) that would unblock the
        // hint next time.
        const w = apiResult.planningFallacyWatching;
        const safePhrase = JSON.stringify(w.detectedPhrase);
        response +=
          `## Planning fallacy watch\n` +
          `Reason: ${w.reason}\n` +
          `${w.suggestion}\n` +
          `(detected: ${safePhrase})\n` +
          `\n---\n\n`;
      }

      // v1.13.3 / C5 follow-up — Cutoff block (was "WYSIATI:" line at bottom
      // in v1.13.0-v1.13.2). Top placement so the agent reads the cutoff
      // before scrolling the result list. "Cutoff" is plain English; the old
      // "WYSIATI:" acronym was opaque to agents without Kahneman context per
      // the 2026-05-27 dogfood Trial 1.
      const sMcp = mcpSuppressionSummary;
      const cutoffClauses: string[] = [];
      if (sMcp.droppedByBudget > 0) cutoffClauses.push(`${sMcp.droppedByBudget} dropped to fit limit`);
      if (sMcp.droppedPreRank > 0) cutoffClauses.push(`${sMcp.droppedPreRank} filtered pre-rank`);
      if (sMcp.summarySubstitutionsAdded > 0) cutoffClauses.push(`${sMcp.summarySubstitutionsAdded} summary substitutions added`);
      if (sMcp.freshTailAdded > 0) cutoffClauses.push(`${sMcp.freshTailAdded} fresh-tail added`);
      if (sMcp.suppressedByInterference > 0) cutoffClauses.push(`${sMcp.suppressedByInterference} suppressed by interference`);
      if (cutoffClauses.length > 0) {
        response +=
          `## Cutoff\n` +
          `Showing ${results.length} of ${sMcp.totalCandidates} candidates; ${cutoffClauses.join('; ')}.\n` +
          `\n---\n\n`;
      }

      response += formatMemories(results, hippoRoot);

      // v1.6.3 codex P2 fix. The physics/hybrid scorer drives the primary
      // ranked block above, so user-visible ordering is preserved. But
      // when the v1.5.0+/v1.5.2 RecallOpts are passed, we MUST also surface
      // the fresh-tail and substituted-summary items apiRecall produced —
      // otherwise the advertised MCP fields are silently ignored. Append
      // them as their own section, deduplicated against the physics ranking.
      if (tailOrSummary.length > 0) {
        const lines: string[] = ['', '## Fresh tail / substituted summaries'];
        for (const r of tailOrSummary) {
          const tag = r.isSummary ? '[summary]' : '[tail]';
          const head = r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content;
          if (r.isSummary && r.substitutedFor && r.substitutedFor.length > 0) {
            lines.push(`- ${tag} ${r.id} (covers ${r.substitutedFor.length} rows): ${head}`);
          } else {
            lines.push(`- ${tag} ${r.id}: ${head}`);
          }
        }
        response += '\n' + lines.join('\n');
      }

      if (includeContinuity && apiResult.continuity) {
        response += '\n\n' + formatContinuityBlock(apiResult.continuity);
      }

      return response;
    }

    case 'hippo_assemble': {
      const sessionId = String(args.session_id || '');
      if (!sessionId) return 'No session_id provided.';
      const budget = Number(args.budget);
      const freshTailCount = Number(args.fresh_tail_count);
      const summarizeOlder = args.summarize_older !== false;
      const apiCtx: ApiContext = {
        hippoRoot,
        tenantId,
        actor: adminActor('mcp'),
      };
      const explicitScope = typeof args.scope === 'string' && args.scope.length > 0
        ? String(args.scope)
        : undefined;
      const r = apiAssemble(apiCtx, sessionId, {
        ...(Number.isFinite(budget) && budget > 0 ? { budget } : {}),
        ...(Number.isFinite(freshTailCount) && freshTailCount >= 0 ? { freshTailCount } : {}),
        summarizeOlder,
        ...(explicitScope !== undefined ? { scope: explicitScope } : {}),
      });
      const lines: string[] = [];
      lines.push(`Session ${r.sessionId} — ${r.items.length} items, ${r.tokens} tokens (raw=${r.totalRaw}, summarized=${r.summarized}, evicted=${r.evicted})`);
      for (const it of r.items) {
        const prefix = it.isSummary ? '[summary]' : it.isFreshTail ? '[tail]' : '[older]';
        lines.push(`  ${prefix} ${it.createdAt} ${it.id} - ${it.content}`);
      }
      return lines.join('\n');
    }

    case 'hippo_drill': {
      const summaryId = String(args.summary_id || '');
      if (!summaryId) return 'No summary_id provided.';
      const limit = Number(args.limit);
      const budget = Number(args.budget);
      // v0.30 / E5: depth walks N levels (default 1, hard cap 10).
      // independent-review MED #5 fold: reject out-of-range explicitly
      // (no silent clamp) so MCP callers see the constraint at their layer.
      let depth: number | undefined;
      if (args.depth !== undefined) {
        const depthRaw = Number(args.depth);
        if (!Number.isFinite(depthRaw) || depthRaw < 1 || depthRaw > 10) {
          return `depth must be an integer between 1 and 10 (got ${args.depth})`;
        }
        depth = depthRaw;
      }
      const apiCtx: ApiContext = {
        hippoRoot,
        tenantId,
        actor: adminActor('mcp'),
      };
      const r = apiDrillDown(apiCtx, summaryId, {
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(Number.isFinite(budget) && budget > 0 ? { budget } : {}),
        ...(depth !== undefined ? { depth } : {}),
      });
      if ('failure' in r) {
        // v1.6.4: only not_drillable is caller-actionable. not_found
        // intentionally collapses cross-tenant + scope-blocked + missing
        // (codex round 3 P1: distinguishing scope_blocked would leak
        // private-row existence on this surface).
        if (r.failure === 'not_drillable') {
          return `Id ${summaryId} is a leaf row, not a level-2+ summary; nothing to drill into.`;
        }
        return `No drillable summary at id=${summaryId}.`;
      }
      const lines: string[] = [];
      lines.push(`Summary ${r.summary.id} — ${r.summary.descendantCount} descendants${r.summary.earliestAt ? ` (${r.summary.earliestAt} -> ${r.summary.latestAt})` : ''}`);
      lines.push(`  ${r.summary.content}`);
      lines.push('');
      lines.push(`Children (${r.children.length}/${r.totalChildren}${r.truncated ? ', truncated' : ''}):`);
      for (const c of r.children) {
        lines.push(`  [L${c.dagLevel}] ${c.id} - ${c.content}`);
      }
      return lines.join('\n');
    }

    case 'hippo_predict_baserate': {
      // J3 reference-class / planning-fallacy detector. Reads from the E2
      // predictions table; returns text-only response matching the existing
      // MCP tool convention (no structured JSON over the wire). Direct call
      // to computePredictionBaserate; helper opens its own db + emits audit
      // (single source of truth, no caller-site drift).
      const classTag = String(args.class_tag || '').trim();
      if (!classTag) return 'No class_tag provided. Usage: pass class_tag matching a class used in past predictions (e.g. "migration-effort").';
      const baserate = computePredictionBaserate(hippoRoot, tenantId, classTag, 'mcp');
      if (baserate.nClosed === 0) {
        return `No closed predictions in class "${classTag}" yet. Create one via hippo_predict (or 'hippo predict ...' CLI) and close it with hippo_predict_close once the actual outcome is known. Base rates need closed predictions with numeric actual_value to compute.`;
      }
      const lines: string[] = [baserate.summary, ''];
      lines.push(`n_closed:         ${baserate.nClosed}`);
      lines.push(`n_ratio_eligible: ${baserate.nRatioEligible}`);
      if (baserate.meanEstimate !== null) lines.push(`mean_estimate:    ${baserate.meanEstimate.toFixed(3)}`);
      if (baserate.meanActual !== null)   lines.push(`mean_actual:      ${baserate.meanActual.toFixed(3)}`);
      if (baserate.meanRatio !== null)    lines.push(`mean_ratio:       ${baserate.meanRatio.toFixed(3)}x`);
      if (baserate.p50Ratio !== null)     lines.push(`p50_ratio:        ${baserate.p50Ratio.toFixed(3)}x`);
      if (baserate.mae !== null)          lines.push(`mae:              ${baserate.mae.toFixed(3)}`);
      return lines.join('\n');
    }

    case 'hippo_remember': {
      const text = String(args.text || '');
      if (!text) return 'No text provided.';
      const tags: string[] = [];
      if (args.error) tags.push('error');
      if (args.tag) tags.push(String(args.tag));
      // Route through api.ts so audit_log captures actor='mcp' uniformly with
      // CLI/REST. api.ts.remember writes the memory + audit row in one
      // transaction-friendly path; we re-read the entry to surface the
      // half-life used in the MCP human-readable response.
      const apiCtx: ApiContext = {
        hippoRoot,
        tenantId,
        actor: adminActor('mcp'),
      };
      const result = apiRemember(apiCtx, {
        content: text,
        tags,
      });
      const entry = readEntry(hippoRoot, result.id, tenantId);

      // Auto-sleep check
      if (config.autoSleep.enabled) {
        const allEntries = loadAllEntries(hippoRoot, tenantId);
        const recentCount = allEntries.filter((e) => {
          const age = (Date.now() - new Date(e.created).getTime()) / (1000 * 60 * 60);
          return age < 24; // created in last 24 hours
        }).length;
        if (recentCount >= config.autoSleep.threshold) {
          consolidate(hippoRoot);
        }
      }

      const halfLife = entry?.half_life_days ?? config.defaultHalfLifeDays;
      const tagStr = entry?.tags.join(', ') || tags.join(', ') || 'none';
      return `Remembered [${result.id}] (half-life: ${halfLife}d, tags: ${tagStr})`;
    }

    case 'hippo_outcome': {
      const good = Boolean(args.good);
      const clientKey = resolveClientKey(ctx);
      const ids = lastRecalledIds.get(clientKey) ?? [];
      if (ids.length === 0) return 'No recent recalls to apply outcome to.';

      // Route through src/api.ts so audit_log captures actor='mcp' and
      // tenant scoping is enforced uniformly (same surface as recall/remember).
      // outcome() also handles cross-tenant id skip silently.
      const apiCtx: ApiContext = {
        hippoRoot,
        tenantId,
        actor: adminActor('mcp'),
      };
      const { applied } = apiOutcome(apiCtx, ids, good);
      return `Applied ${good ? 'positive' : 'negative'} outcome to ${applied} memories`;
    }

    case 'hippo_context': {
      const budget = Number(args.budget) || config.defaultContextBudget;
      const explicitScope = typeof args.scope === 'string' && args.scope.length > 0
        ? String(args.scope)
        : undefined;
      // Auto-detect query from git
      let query = '';
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
        const diff = execSync('git diff --cached --stat 2>/dev/null', { encoding: 'utf-8' }).trim();
        const log = execSync('git log -1 --pretty=format:"%s" 2>/dev/null', { encoding: 'utf-8' }).trim();
        query = [branch, log, diff].filter(Boolean).join(' ');
      } catch { /* not a git repo */ }

      if (!query) query = 'project context general';

      // v1.2 codex audit: same scope filter as hippo_recall on BOTH the memory
      // results and the snapshot. Pre-v1.2 this surface returned all memories
      // and the snapshot unfiltered, which would have leaked private-channel
      // content to no-scope MCP callers once scope writers shipped.
      // v1.2.1: source-agnostic via api.isPrivateScope.
      const passesScopeFilter = (s: string | null): boolean => {
        if (explicitScope !== undefined) return s === explicitScope;
        if (s === null) return true;
        if (isPrivateScope(s)) return false;
        // v1.7.2: read from RECALL_DEFAULT_DENY_SCOPES (single source of truth
        // shared with SQL + api.passesScopeFilterForRecall).
        if ((RECALL_DEFAULT_DENY_SCOPES as readonly string[]).includes(s)) return false;
        return true;
      };
      const allEntries = loadAllEntries(hippoRoot, tenantId);
      const entries = allEntries.filter((e) => passesScopeFilter(e.scope ?? null));
      const usePhysicsCtx = config.physics?.enabled !== false;
      const results = usePhysicsCtx
        ? await physicsSearch(query, entries, { budget, hippoRoot, physicsConfig: config.physics })
        : await hybridSearch(query, entries, { budget, hippoRoot });
      const retrieved = markRetrieved(results.map((r) => r.entry));
      // EVAL-ONLY ablation (see ablation.ts): skip persistence under the recall
      // flag; ids below stay populated for outcome attribution.
      if (!isRecallBoostAblated()) {
        for (const entry of retrieved) writeEntry(hippoRoot, entry);
      }
      lastRecalledIds.set(resolveClientKey(ctx), retrieved.map((e) => e.id));

      const rawSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId);
      const snapshot = rawSnapshot && passesScopeFilter(rawSnapshot.scope)
        ? rawSnapshot
        : null;
      const snapshotText = snapshot
        ? [
            '## Active Task Snapshot',
            `- Task: ${snapshot.task}`,
            `- Status: ${snapshot.status}`,
            `- Updated: ${snapshot.updated_at}`,
            '',
            '### Summary',
            snapshot.summary,
            '',
            '### Next step',
            snapshot.next_step,
            '',
          ].join('\n')
        : '';

      const memoryText = formatMemories(results, hippoRoot);
      return snapshotText ? `${snapshotText}\n${memoryText}` : memoryText;
    }

    case 'hippo_status': {
      const entries = loadAllEntries(hippoRoot, tenantId);
      const now = evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
      let atRisk = 0;
      let totalStrength = 0;
      for (const e of entries) {
        const s = calculateStrength(e, now);
        totalStrength += s;
        if (s < 0.1 && !e.pinned) atRisk++;
      }
      const avgStrength = entries.length > 0 ? (totalStrength / entries.length).toFixed(2) : '0';
      const pinned = entries.filter((e) => e.pinned).length;
      const errors = entries.filter((e) => e.tags.includes('error')).length;
      const conflicts = listMemoryConflicts(hippoRoot, 'open', tenantId).length;
      return [
        `Memories: ${entries.length} (${pinned} pinned, ${errors} errors)`,
        `Avg strength: ${avgStrength}`,
        `At risk (<0.1): ${atRisk}`,
        `Open conflicts: ${conflicts}`,
        `Half-life default: ${config.defaultHalfLifeDays}d`,
      ].join('\n');
    }

    case 'hippo_learn': {
      const days = Number(args.days) || 7;
      if (!isGitRepo(process.cwd())) return 'No git history found.';
      const gitLog = fetchGitLog(process.cwd(), days);
      if (!gitLog.trim()) return 'No fix/revert/bug commits found in the specified period.';
      const lessons = extractLessons(gitLog, config.gitLearnPatterns);
      let added = 0;
      let skipped = 0;
      for (const lesson of lessons) {
        if (deduplicateLesson(hippoRoot, lesson, 0.7, tenantId)) { skipped++; continue; }
        const entry = createMemory(lesson, {
          layer: Layer.Episodic,
          tags: ['git-learned'],
          source: 'git',
          confidence: 'observed',
          baseHalfLifeDays: config.defaultHalfLifeDays,
          tenantId,
        });
        writeEntry(hippoRoot, entry);
        added++;
      }
      return `Git learn: ${added} new, ${skipped} duplicates skipped (scanned ${days} days)`;
    }

    case 'hippo_conflicts': {
      const conflicts = listMemoryConflicts(hippoRoot, 'open', tenantId);
      if (conflicts.length === 0) return 'No open conflicts.';
      return conflicts.map((c) =>
        `conflict_${c.id}: ${c.memory_a_id} <-> ${c.memory_b_id} (score=${c.score.toFixed(2)}) — ${c.reason}`
      ).join('\n');
    }

    case 'hippo_resolve': {
      const conflictId = Number(args.conflict_id);
      const keepId = String(args.keep || '');
      const forget = Boolean(args.forget);
      if (isNaN(conflictId) || !keepId) return 'Required: conflict_id and keep.';
      const result = resolveConflict(hippoRoot, conflictId, keepId, forget, tenantId);
      if (!result) return 'Could not resolve. Check the conflict ID and --keep value.';
      const action = forget ? 'deleted' : 'weakened';
      return `Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${result.loserId}`;
    }

    case 'hippo_share': {
      const shareId = String(args.id || '');
      if (!shareId) return 'Required: id (memory ID to share).';
      const force = Boolean(args.force);
      // Pass tenantId so shareMemory's readEntry filters by tenant. Without
      // this, a Bearer for tenant A could call hippo_share with tenant B's
      // id and copy the row to the global store. The 'Memory not found'
      // error matches the cross-tenant deny shape elsewhere in the code.
      const shared = shareMemory(hippoRoot, shareId, { force, tenantId });
      if (!shared) return 'Transfer score too low. Use force=true to override.';
      return `Shared [${shared.id}] to global store. Source: ${shared.source}`;
    }

    case 'hippo_peers': {
      // D4 v1.12.10: tenant-scope the cross-project peer discovery.
      // tenantId is the caller's tenant (matches hippo_share above);
      // passing undefined would restore the pre-D4 host-wide behaviour.
      const peers = listPeers(undefined, tenantId);
      if (peers.length === 0) return 'No peers found.';
      return peers.map((p) => `${p.project}: ${p.count} memories (latest: ${p.latest.slice(0, 10)})`).join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Request handling ──

/**
 * Transport-agnostic MCP dispatcher. Both the stdio loop (below) and the
 * HTTP/SSE transport in src/server.ts route every incoming JSON-RPC message
 * through this single function. Returns null for notifications (no response
 * expected) and a McpResponse otherwise. Errors thrown by `executeTool` are
 * the caller's problem — wrap with try/catch on the transport side.
 */
export async function handleMcpRequest(
  req: McpRequest,
  ctx?: McpContext,
): Promise<McpResponse | null> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hippo-memory', version: PACKAGE_VERSION },
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const toolName = (params as any)?.name;
      const toolArgs = (params as any)?.arguments ?? {};
      const output = await executeTool(toolName, toolArgs, ctx);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: output || 'Done.' }],
        },
      };
    }

    default:
      // Notifications (no id) must not receive a response
      if (method.startsWith('notifications/')) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ── Stdio transport ──

import { parseFrame } from './framing.js';

let buffer: Buffer = Buffer.alloc(0);

function dispatch(body: string): void {
  let req: McpRequest;
  try {
    req = JSON.parse(body) as McpRequest;
  } catch {
    return; // skip malformed
  }
  if (!req.method) return;
  if (req.method.startsWith('notifications/')) {
    handleMcpRequest(req).catch(() => {});
    return;
  }
  handleMcpRequest(req).then((resp) => { if (resp) send(resp); }).catch((err) => {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err?.message ?? 'Internal error' } });
  });
}

/**
 * Wire stdin/stdout to the dispatcher. Idempotent — only the entrypoint
 * (cli.ts `hippo mcp`, or running this file directly) should call this.
 * src/server.ts imports `handleMcpRequest` without invoking this, so the
 * HTTP daemon does not steal stdin or exit when its parent closes a pipe.
 */
export function startStdioLoop(): void {
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const result = parseFrame(buffer);
      if (result.kind === 'incomplete') break;
      buffer = result.rest;
      if (result.kind === 'message') dispatch(result.body);
    }
  });

  process.stdin.on('end', () => process.exit(0));

  process.on('uncaughtException', (err) => {
    process.stderr.write(`hippo-mcp uncaught: ${err?.message ?? err}\n`);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`hippo-mcp unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

// Auto-start when invoked as the main module (node dist/mcp/server.js or via
// the cli's `import('./mcp/server.js')`). Importing this file from another
// module (e.g. src/server.ts wiring up the HTTP/SSE transport) will NOT
// trigger the stdio loop. The cli imports this file specifically to start
// stdio; that import is also `import.meta.url === main`-equivalent because
// it's executed as the program, so we keep a fallback: if HIPPO_MCP_STDIO=1
// or argv1 ends in /mcp/server.js we start.
const isMainModule = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    if (argv1.endsWith('mcp/server.js') || argv1.endsWith('mcp\\server.js')) return true;
    if (process.env.HIPPO_MCP_STDIO === '1') return true;
    // ESM main-module check
    const mainUrl = `file://${argv1.replace(/\\/g, '/')}`;
    return import.meta.url === mainUrl || import.meta.url === `file:///${argv1.replace(/\\/g, '/')}`;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  startStdioLoop();
}
