// Outcome feedback on recalled memories.

import { closeHippoDb } from '../db.js';
import { openStore } from '../store/open.js';
import { writeEntryOn } from '../store/entry-writes.js';
import { selectEntriesByIds } from '../store/entry-reads.js';
import { loadIndex } from '../store/index-and-stats.js';
import { applyOutcome, CHURN_STALE_TAG } from '../memory.js';
import { appendAuditEvent } from '../audit.js';
import { recordTraceOutcome } from '../recall-trace.js';
import type { Context } from './types.js';

// ---------------------------------------------------------------------------
// outcome
// ---------------------------------------------------------------------------

/**
 * Apply a positive/negative outcome to a list of recently-recalled memory ids.
 * Used by the MCP `hippo_outcome` tool and the HTTP `POST /v1/outcome` route.
 * Tenant-scoped: ids that don't belong to ctx.tenantId are silently skipped
 * (matches the prior MCP semantics — a stale id from another tenant doesn't
 * crash the call). Each successful outcome emits one audit_log row with
 * op='outcome' tagged with ctx.actor.subject.
 *
 * Returns `{applied, appliedIds}`. `appliedIds` is the tenant-filtered subset
 * of input ids that actually had `applyOutcome` run on them (i.e. ids found
 * in ctx.tenantId). Callers that surface the id list
 * over a multi-tenant boundary (HTTP /v1/outcome last-recall path, Python SDK)
 * MUST return `appliedIds` instead of the raw input list — otherwise the
 * non-applied (cross-tenant) ids leak to the caller.
 *
 * `opts.traceId`:
 * OPTIONAL additive opt so a programmatic caller can link this outcome to
 * the recall_traces row it judges. NOT applied unconditionally — an SDK
 * caller passing explicit ids with no preceding CLI/context recall would
 * otherwise get linked to a stale, unrelated trace. `outcomeForLastRecall`
 * supplies this automatically from `last_trace_id`; every other caller
 * (server.ts explicit-ids path, MCP hippo_outcome) omits it and gets no
 * linkage, which is correct.
 */
export interface OutcomeResult {
  applied: number;
  appliedIds: string[];
}
export function outcome(
  ctx: Context,
  ids: ReadonlyArray<string>,
  good: boolean,
  opts?: { traceId?: number },
): OutcomeResult {
  const appliedIds: string[] = [];
  const db = openStore(ctx.hippoRoot);
  try {
    const live = selectEntriesByIds(db, ids, ctx.tenantId);
    for (const id of ids) {
      const entry = live.get(id);
      if (!entry) continue;
      let updated = applyOutcome(entry, good);
      if (good && updated.tags.includes(CHURN_STALE_TAG)) { // a good outcome reconfirms the entry
        updated = { ...updated, tags: updated.tags.filter((t) => t !== CHURN_STALE_TAG) };
      }
      writeEntryOn(db, ctx.hippoRoot, updated, { actor: ctx.actor.subject });
      live.set(id, updated); // a repeated id builds on its first outcome, as a fresh read would
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor.subject,
        op: 'outcome',
        targetId: id,
        metadata: { good },
      });
      appliedIds.push(id);
    }
    // Link the outcome to its trace, recording only the ids actually
    // credited (post tenant-filtering, matches appliedIds). Lives in its own
    // append-only table so audit_log pruning can never erase training data.
    if (opts?.traceId !== undefined && appliedIds.length > 0) {
      recordTraceOutcome(db, {
        traceId: opts.traceId,
        tenantId: ctx.tenantId,
        outcome: good ? 'positive' : 'negative',
        memoryIds: appliedIds,
      });
    }
  } finally {
    closeHippoDb(db);
  }
  return { applied: appliedIds.length, appliedIds };
}

// ---------------------------------------------------------------------------
// outcomeForLastRecall (last-recall wrapper around outcome)
// ---------------------------------------------------------------------------

/**
 * Apply an outcome to the ids most recently returned by `recall()`.
 *
 * Reads `loadIndex(ctx.hippoRoot).last_retrieval_ids` (per-hippoRoot local
 * state; not tenant-scoped at the index layer) and forwards to `outcome()`,
 * which DOES tenant-filter its read by `ctx.tenantId`. Cross-tenant
 * ids in `last_retrieval_ids` are silently skipped, matching the MCP
 * `hippo_outcome` semantics.
 *
 * **Tenant-safe response shape:** the returned `ids`
 * field contains ONLY the tenant-filtered subset that actually had outcomes
 * applied (i.e. `appliedIds` from the inner `outcome()` call). It lives in this
 * helper so every caller (CLI, HTTP /v1/outcome, MCP) inherits the contract.
 *
 * Do NOT tighten `loadIndex` with `tenantId` inside this helper — doing so
 * would break the (correct) cross-tenant-silent-skip behavior covered by
 * the test in `tests/api-outcome-for-last-recall.test.ts`.
 */
export interface OutcomeForLastRecallResult {
  applied: number;
  ids: string[];
}
export function outcomeForLastRecall(
  ctx: Context,
  good: boolean,
): OutcomeForLastRecallResult {
  const idx = loadIndex(ctx.hippoRoot);
  const ids = idx.last_retrieval_ids;
  if (ids.length === 0) return { applied: 0, ids: [] };
  // Same `loadIndex` snapshot as the ids; buildIndexFromDb already strict-parses it to a
  // positive-integer string or null, so no trace_id=0/NaN reaches outcome().
  const traceId = idx.last_trace_id !== null ? Number(idx.last_trace_id) : null;
  const { applied, appliedIds } = outcome(ctx, ids, good, traceId !== null ? { traceId } : undefined);
  return { applied, ids: appliedIds };
}
