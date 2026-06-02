/**
 * D1 v1.12.10 — Redact-on-egress for SleepResult cross-tenant counters.
 *
 * `api.sleep` returns host-wide counters (deduped.crossDups, audit counters,
 * ambient totals) — they describe the host's full memory state, not any one
 * tenant. Today the route is loopback-only + admin-gated since v1.12.0
 * sub-1, so all callers see the full picture honestly.
 *
 * Once `HIPPO_BIND_ALL` ships (per D3 lock-step sequencing), non-loopback
 * admin Bearer callers would see another tenant's accounting data in the
 * SleepResult. That's a metadata-leak path.
 *
 * Redact-on-egress (chosen via D1 picks): when the caller is non-loopback
 * AND non-self admin, zero out cross-tenant counters before serialization.
 * Loopback admins still get the full picture (host ops legitimately need
 * dedup quality + total counts).
 *
 * Today this is layered-defence dead code (loopback-only gate is upstream).
 * Lands now so the gate is in place when D3 ships non-loopback serving;
 * "behind a flag first" historically means "flag flips before gates close."
 */

import type { SleepResult } from './api.js';

export interface RedactSleepCtx {
  /** True when the request came from 127.0.0.1 / ::1. Pass-through everything. */
  isLoopback: boolean;
  /**
   * The caller's tenant. Today's only non-loopback admin is the deployment
   * operator whose own tenant matches the row owner of the audit_prune /
   * audit_create rows. When `callerTenant === '__host__'` (synthetic
   * representing a future "host operator" actor), pass-through.
   */
  callerTenant: string;
}

/**
 * Returns a SleepResult that's safe to serialize to a non-loopback non-self
 * caller. Loopback OR `__host__` caller = pass-through unchanged.
 *
 * Redaction surface (the cross-tenant counters specifically):
 *   - deduped.crossDups
 *   - deduped.semDups, .epiDups (aggregate dedup activity across tenants)
 *   - audit.errorsRemoved, .warningCount (aggregate audit-pipeline activity)
 *   - ambient.totalMemories, .avgStrength (aggregate corpus shape)
 *   - graph.tenants, .entities, .relations (cross-tenant graph rebuild totals)
 *
 * NOT redacted (per-invocation activity counters, not cross-tenant accounting):
 *   - active, removed, mergedEpisodic, newSemantic (this invocation's totals)
 *   - dryRun (echo of input)
 *   - shared (counted within api.sleep's per-call work)
 *   - details (text descriptions, no aggregate numerics)
 */
export function redactSleepResultForCaller(
  result: SleepResult,
  ctx: RedactSleepCtx,
): SleepResult {
  if (ctx.isLoopback || ctx.callerTenant === '__host__') {
    return result;
  }
  const redacted: SleepResult = { ...result };
  if (result.deduped !== undefined) {
    redacted.deduped = {
      ...result.deduped,
      crossDups: 0,
      semDups: 0,
      epiDups: 0,
      // .removed is per-invocation work; preserved.
    };
  }
  if (result.audit !== undefined) {
    redacted.audit = {
      ...result.audit,
      errorsRemoved: 0,
      warningCount: 0,
    };
  }
  if (result.ambient !== undefined && result.ambient !== null) {
    redacted.ambient = {
      ...result.ambient,
      totalMemories: 0,
      avgStrength: 0,
    };
  }
  if (result.graph !== undefined) {
    // E3 sleep enqueue-hook: per-tenant graph rebuild totals are cross-tenant
    // accounting, the same class as deduped/audit/ambient above.
    redacted.graph = { tenants: 0, entities: 0, relations: 0 };
  }
  return redacted;
}
