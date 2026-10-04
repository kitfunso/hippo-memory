// Outcome feedback on recalled memories.

import { openHippoDb, closeHippoDb } from '../db.js';
import { writeEntry } from '../store/entry-writes.js';
import { readEntry } from '../store/entry-reads.js';
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
 * of input ids that actually had `applyOutcome` run on them (i.e. ids whose
 * `readEntry(..., ctx.tenantId)` resolved). Callers that surface the id list
 * over a multi-tenant boundary (HTTP /v1/outcome last-recall path, Python SDK)
 * MUST return `appliedIds` instead of the raw input list — otherwise the
 * non-applied (cross-tenant) ids leak to the caller. Added in v1.11.4 to
 * close that disclosure path on POST /v1/outcome.
 *
 * `opts.traceId` (LC1, docs/plans/2026-08-02-lc1-recall-trace-persistence.md):
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
  const db = openHippoDb(ctx.hippoRoot);
  try {
    for (const id of ids) {
      const entry = readEntry(ctx.hippoRoot, id, ctx.tenantId);
      if (!entry) continue;
      let updated = applyOutcome(entry, good);
      if (good && updated.tags.includes(CHURN_STALE_TAG)) { // FE2: a good outcome reconfirms the entry
        updated = { ...updated, tags: updated.tags.filter((t) => t !== CHURN_STALE_TAG) };
      }
      writeEntry(ctx.hippoRoot, updated, { actor: ctx.actor.subject });
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor.subject,
        op: 'outcome',
        targetId: id,
        metadata: { good },
      });
      appliedIds.push(id);
    }
    // LC1: link the outcome to its trace, recording only the ids actually
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
// outcomeForLastRecall (last-recall wrapper around outcome — Task 3)
// ---------------------------------------------------------------------------

/**
 * Apply an outcome to the ids most recently returned by `recall()`.
 *
 * Reads `loadIndex(ctx.hippoRoot).last_retrieval_ids` (per-hippoRoot local
 * state; not tenant-scoped at the index layer) and forwards to `outcome()`,
 * which DOES tenant-filter via `readEntry(..., ctx.tenantId)`. Cross-tenant
 * ids in `last_retrieval_ids` are silently skipped, matching the MCP
 * `hippo_outcome` semantics.
 *
 * **Tenant-safe response shape (v1.11.4 security fix):** the returned `ids`
 * field contains ONLY the tenant-filtered subset that actually had outcomes
 * applied (i.e. `appliedIds` from the inner `outcome()` call). Earlier
 * versions returned the raw `last_retrieval_ids` regardless of tenant, which
 * leaked cross-tenant memory IDs to the caller via POST /v1/outcome's
 * no-body last-recall response. The fix is at this helper so all callers
 * (CLI cmdOutcome, HTTP /v1/outcome, MCP `hippo_outcome` if added later)
 * inherit the tenant-safe contract.
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
  // LC1 F1(d) structural fix (docs/plans/2026-08-02-lc1-recall-trace-persistence.md):
  // read the trace id from the SAME `loadIndex` snapshot already in hand
  // (idx.last_trace_id) — a single-snapshot read, not a second DB round
  // trip via a now-deleted readLastTraceId helper. The value is already
  // strict-parsed by buildIndexFromDb's parseLastTraceId (store.ts): every
  // consumer gets a clean positive-integer string or null, never a garbage
  // value that could reach outcome() and INSERT trace_id=0/NaN. null on a
  // fresh store / pre-v40 flow / api.recall-only usage — outcome() skips
  // linkage silently when traceId is undefined.
  const traceId = idx.last_trace_id !== null ? Number(idx.last_trace_id) : null;
  const { applied, appliedIds } = outcome(ctx, ids, good, traceId !== null ? { traceId } : undefined);
  return { applied, ids: appliedIds };
}
