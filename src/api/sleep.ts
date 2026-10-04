// The sleep cycle: decay, consolidation, dedupe, graph extraction and the other maintenance passes.

import { openHippoDb, closeHippoDb } from '../db.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { deleteEntry, memoriesBackingObjects } from '../store/delete-and-batch.js';
import { appendAuditEvent, reportAuditWriteFailure, auditMemories } from '../audit.js';
import { autoShare } from '../shared.js';
import { consolidate } from '../consolidate.js';
import { loadConfig } from '../config.js';
import { deduplicateStore } from '../dedupe.js';
import { computeAmbientState, type AmbientState } from '../ambient.js';
import { loadPendingExtractionTenants } from '../graph/read.js';
import { markPendingProcessedUpTo } from '../graph/write.js';
import { extractGraph } from '../graph-extract.js';
import type { Context } from './types.js';

// ---------------------------------------------------------------------------
// sleep (extracted from cmdSleepCore Phase 2-6 — Task 4 of the api.ts refactor)
// ---------------------------------------------------------------------------

/**
 * Options for `sleep` — run the pure-storage consolidation pipeline
 * (consolidate + dedup + audit + share + ambient) and return structured counts.
 *
 * Extracted from `cmdSleepCore` Phase 2-6 in Episode A. NOT covered by api.sleep:
 * the cli-only auto-learn phase (Phase 1: learnFromRepo + the agent memory import),
 * which is intrinsically host-bound (uses `process.cwd()` / `os.homedir()`).
 * Auto-learn stays in cli.ts cmdSleepCore as a pre-api block.
 *
 * The CLI `cmdSleep` wrapper continues to own the log-file tee + console
 * rendering + `process.exit`; `api.sleep` is pure (no console.log, no IO
 * beyond the store).
 */
export interface SleepOpts {
  dryRun?: boolean;
  noShare?: boolean;
  /**
   * @internal Test-only DI seam — see `tests/api-sleep-phase-faults.test.ts`.
   * Override one or more phase dependencies (typically a throwing stub) to
   * force mid-phase failure paths deterministically. Production callers
   * MUST NOT use this field. The runtime defaults at `DEFAULT_SLEEP_PHASES`
   * preserve all current behaviour when `__phases` is undefined.
   */
  __phases?: Partial<SleepPhases>;
}

export interface SleepResult {
  active: number;
  removed: number;
  /**
   * Faded memories the decay pass moved to the dormant store instead of
   * deleting (config `dormant.enabled`). Absent when 0. Per-invocation
   * activity counter, same class as `removed`.
   */
  dormant?: number;
  /**
   * Dormant memories deleted for good this sleep because they outlived
   * `dormant.retentionDays`. Absent when 0. Same per-invocation class as
   * `removed`.
   */
  dormantExpired?: number;
  mergedEpisodic: number;
  newSemantic: number;
  dryRun: boolean;
  deduped?: {
    removed: number;
    semDups: number;
    epiDups: number;
    crossDups: number;
  };
  audit?: { errorsRemoved: number; warningCount: number };
  shared?: number;
  /**
   * v1.25.0: count of memories the auto-share secret veto withheld this sleep
   * — rows that passed every other admission gate (transfer score,
   * not-already-global) and were blocked solely by `detectSecret`. Absent
   * when 0 or when auto-share did not run.
   */
  secretSkipped?: number;
  /**
   * AT1: count of auto-share candidates the GLOBAL store's rejection
   * tombstone refused this sleep (docs/plans/2026-08-15-at1-rejected-value-tombstone.md
   * plan §3 — copy paths must not let one rejected candidate abort the
   * batch). Absent when 0 or when auto-share did not run.
   */
  rejectedSkipped?: number;
  ambient?: AmbientState | null;
  /**
   * E3 sleep enqueue-hook: graph re-extraction totals across the tenants rebuilt
   * this sleep. Absent when no tenant was dirty, and under dryRun (the graph
   * phase runs only on a real sleep). Cross-tenant aggregate, one reason
   * /v1/sleep stays loopback-only.
   */
  graph?: { tenants: number; entities: number; relations: number };
  details?: string[];
}

/**
 * Run the pure-storage consolidation pipeline.
 *
 * Tenant scope note: sleep operates on the WHOLE hippoRoot (all tenants in
 * it), matching the pre-refactor cmdSleepCore behavior. Correct for a CLI
 * maintenance op invoked by the operator. Episode B (v1.11.4) exposed this
 * over HTTP `/v1/sleep` with loopback-only enforcement (per-request guard
 * in the handler plus serve()'s boot-time host check). The TODOS.md
 * per-tenant scoping follow-up remains open for the day non-loopback
 * serving lands — at that point the route will need an admin-role gate OR
 * api.sleep itself will need to scope dedup / audit / delete by ctx.tenantId.
 *
 * Dedup and audit deletes each log a `forget` row with the ctx actor and a
 * `metadata.reason`. Pinned, raw, kept and object-backing rows are never auto-deleted (AUTOMATIC_DELETE_SQL).
 * dryRun previews consolidate, dedup and audit, then returns before share/ambient.
 */
/**
 * v1.12.2: Test-only DI seam shape for `sleep`'s phase dependencies.
 *
 * Each field defaults to the real production implementation imported at the
 * top of this file. Test files pass a `Partial<SleepPhases>` override via
 * `SleepOpts.__phases` (note the `__` prefix — internal-only) to inject
 * deterministic throws for mid-phase failure-path coverage (the
 * `partial: true` + `errorMessage` audit-row branch at line ~2098).
 *
 * Production callers MUST NOT use `__phases`. The field exists solely so
 * `tests/api-sleep-phase-faults.test.ts` can force each phase boundary to
 * throw without depending on store-corruption fragility.
 */
export interface SleepPhases {
  consolidate: typeof consolidate;
  deduplicateStore: typeof deduplicateStore;
  auditMemories: typeof auditMemories;
  autoShare: typeof autoShare;
  loadAllEntries: typeof loadAllEntries;
  deleteEntry: typeof deleteEntry;
  computeAmbientState: typeof computeAmbientState;
  loadConfig: typeof loadConfig;
  loadPendingExtractionTenants: typeof loadPendingExtractionTenants;
  extractGraph: typeof extractGraph;
}

const DEFAULT_SLEEP_PHASES: SleepPhases = {
  consolidate,
  deduplicateStore,
  auditMemories,
  autoShare,
  loadAllEntries,
  deleteEntry,
  computeAmbientState,
  loadConfig,
  loadPendingExtractionTenants,
  extractGraph,
};

export async function sleep(
  ctx: Context,
  opts: SleepOpts = {},
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);

  // v1.12.2: resolve phase dependencies, allowing test-only `__phases`
  // override to inject deterministic throws for mid-phase failure coverage.
  const phases: SleepPhases = { ...DEFAULT_SLEEP_PHASES, ...(opts.__phases ?? {}) };

  // v1.11.5: phase counters for the consolidate audit emit (in finally).
  // Accumulated as each phase completes so partial-failure paths still report
  // accurate "what got done before the failure" data.
  let consolidationCount = 0;
  let dedupCount = 0;
  let auditDeletedCount = 0;
  let ambientTotal = 0;
  let phaseError: Error | null = null;
  let graphSnapshotError: string | null = null;

  let result: SleepResult | null = null;
  try {
    // Snapshot dirty tenants BEFORE any memory-deleting phase (consolidate /
    // dedup / audit). The graph_extraction_queue rows are FK'd to mirror
    // memories with ON DELETE CASCADE, so a phase that deletes a queued mirror
    // (e.g. dedup removing a near-duplicate superseding decision) would drop the
    // tenant from a drain-time load and leave its graph stale (codex P1). The
    // MAX(id) watermark captured here stays valid: arrivals during sleep get a
    // higher id and remain pending.
    //
    // Fail-soft (codex P2): a queue-read failure here must NOT abort core sleep
    // (consolidation / dedup / audit run regardless). On failure, skip graph
    // refresh this sleep (recovered next sleep) and surface a detail once
    // `result` exists (Phase 6).
    let dirtyTenants: { tenantId: string; maxPendingId: number }[] = [];
    if (!dryRun) {
      try {
        dirtyTenants = phases.loadPendingExtractionTenants(ctx.hippoRoot);
      } catch (snapErr) {
        // SAFETY: this is a best-effort log message only; property access on
        // any JS value is safe (undefined if absent), preserving the existing
        // lenient formatting even when something non-Error was thrown.
        graphSnapshotError = (snapErr as Error).message;
      }
    }

    // Phase 1: Consolidation.
    const consolidateResult = await phases.consolidate(ctx.hippoRoot, { dryRun });
    consolidationCount = consolidateResult.semanticCreated + consolidateResult.merged;

    result = {
      active: consolidateResult.decayed,
      removed: consolidateResult.removed,
      mergedEpisodic: consolidateResult.merged,
      newSemantic: consolidateResult.semanticCreated,
      dryRun,
      details: consolidateResult.details,
    };
    // Set only when non-zero, so a store without dormant memories gets a
    // byte-identical result (HTTP /v1/sleep, the CLI render snapshot).
    if (consolidateResult.dormant > 0) {
      result.dormant = consolidateResult.dormant;
    }
    if (consolidateResult.dormantExpired > 0) {
      result.dormantExpired = consolidateResult.dormantExpired;
    }

    // Phase 2: Dedup (post-consolidate near-duplicate cleanup).
    const dedupResult = phases.deduplicateStore(ctx.hippoRoot, { dryRun, actor: ctx.actor.subject });
    dedupCount = dedupResult.removed;
    if (dedupResult.removed > 0) {
      const semDups = dedupResult.pairs.filter(
        (p) => p.keptLayer === 'semantic' && p.removedLayer === 'semantic',
      ).length;
      const epiDups = dedupResult.pairs.filter(
        (p) => p.keptLayer === 'episodic' && p.removedLayer === 'episodic',
      ).length;
      const crossDups = dedupResult.pairs.filter(
        (p) => p.keptLayer !== p.removedLayer,
      ).length;
      result.deduped = {
        removed: dedupResult.removed,
        semDups,
        epiDups,
        crossDups,
      };
    }

    // Phase 3: Quality audit (remove junk, report warnings; a dry run skips rows earlier phases would remove).
    const planned = new Set(dryRun ? [...(consolidateResult.removedIds ?? []), ...dedupResult.pairs.map((p) => p.removed)] : []);
    const allEntries = phases.loadAllEntries(ctx.hippoRoot).filter((e) => !planned.has(e.id));
    const auditOut = phases.auditMemories(allEntries, memoriesBackingObjects(ctx.hippoRoot));
    if (auditOut.issues.length > 0) {
      const errors = auditOut.issues.filter((i) => i.severity === 'error');
      const warnings = auditOut.issues.filter((i) => i.severity === 'warning');
      let removed = 0;
      for (const issue of errors) {
        const reason = `sleep-audit: ${issue.reason}`;
        if (dryRun || phases.deleteEntry(ctx.hippoRoot, issue.memoryId, { actor: ctx.actor.subject, reason, automatic: true })) removed++;
      }
      auditDeletedCount = removed;
      if (removed > 0 || warnings.length > 0) {
        result.audit = {
          errorsRemoved: removed,
          warningCount: warnings.length,
        };
      }
    }

    if (dryRun) return result;

    // Phase 4: Auto-share high-transfer-score memories to global.
    if (!opts.noShare) {
      const sleepConfig = phases.loadConfig(ctx.hippoRoot);
      if (sleepConfig.autoShareOnSleep) {
        // v1.25.0: surface the secret-veto skip count (v39 follow-up #2) so
        // the veto is observable instead of silent.
        // AT1: rejectedSkipped is autoShare's sibling counter for candidates
        // the global store's rejection tombstone refused (threaded the same
        // way as secretSkipped just below).
        const autoShareStats = { secretSkipped: 0, rejectedSkipped: 0 };
        const shared = phases.autoShare(ctx.hippoRoot, { minScore: 0.6, stats: autoShareStats });
        if (shared.length > 0) {
          result.shared = shared.length;
        }
        if (autoShareStats.secretSkipped > 0) {
          result.secretSkipped = autoShareStats.secretSkipped;
        }
        if (autoShareStats.rejectedSkipped > 0) {
          result.rejectedSkipped = autoShareStats.rejectedSkipped;
        }
      }
    }

    // Phase 5: Post-sleep ambient state summary.
    const postSleepConfig = phases.loadConfig(ctx.hippoRoot);
    if (postSleepConfig.ambient.enabled) {
      const postSleepEntries = phases.loadAllEntries(ctx.hippoRoot).filter(
        (e) => !e.superseded_by,
      );
      if (postSleepEntries.length > 0) {
        result.ambient = phases.computeAmbientState(postSleepEntries);
        ambientTotal = result.ambient.totalMemories;
      }
    }

    // Phase 6: Graph extraction drain (E3 sleep enqueue-hook). Rebuild the
    // entity/relation graph for every tenant marked dirty (by markGraphDirty)
    // since the last sleep, so `recall --hops` + cross-object `references` edges
    // run on fresh data without a manual `hippo graph extract`. Fully
    // fault-isolated: the consolidation work above has already committed, so a
    // failure here must never abort sleep; a per-tenant extract failure leaves
    // that tenant's queue items pending for the next sleep. (Skipped under
    // dryRun via the early return above.)
    try {
      if (graphSnapshotError) {
        // The dirty-tenant snapshot failed (codex P2 fail-soft). Core sleep
        // already succeeded; surface the skipped graph refresh as a detail.
        result.details = [
          ...(result.details ?? []),
          `graph: dirty-tenant snapshot failed (skipped graph refresh): ${graphSnapshotError}`,
        ];
      }
      let gTenants = 0;
      let gEntities = 0;
      let gRelations = 0;
      // dirtyTenants was snapshotted before the memory-deleting phases above.
      for (const { tenantId, maxPendingId } of dirtyTenants) {
        try {
          const ext = phases.extractGraph(ctx.hippoRoot, tenantId);
          // Count the rebuild as soon as it succeeds — it happened regardless of
          // the drain-mark below.
          gTenants += 1;
          gEntities += ext.entities;
          gRelations += ext.relations;
          // Watermark drain: mark processed only items enqueued before this
          // rebuild started (id <= maxPendingId). Arrivals during the rebuild
          // keep pending status and are caught next sleep; rows whose mirror was
          // cascade-deleted earlier this sleep are already gone (no-op).
          markPendingProcessedUpTo(ctx.hippoRoot, tenantId, maxPendingId);
        } catch (tenantErr) {
          // SAFETY: this is a best-effort log message only; property access
          // on any JS value is safe (undefined if absent), preserving the
          // existing lenient formatting even when something non-Error was thrown.
          result.details = [
            ...(result.details ?? []),
            `graph: extract failed for a dirty tenant (left pending): ${(tenantErr as Error).message}`,
          ];
        }
      }
      if (gTenants > 0) {
        result.graph = { tenants: gTenants, entities: gEntities, relations: gRelations };
      }
    } catch (graphErr) {
      // SAFETY: this is a best-effort log message only; property access on
      // any JS value is safe (undefined if absent), preserving the existing
      // lenient formatting even when something non-Error was thrown.
      result.details = [
        ...(result.details ?? []),
        `graph: drain phase failed (skipped): ${(graphErr as Error).message}`,
      ];
    }

    return result;
  } catch (err) {
    // SAFETY: phaseError is read via phaseError.message / (phaseError !==
    // null) below, both safe even if a non-Error was thrown; this mirrors
    // the existing lenient (err as Error) pattern used throughout this catch chain.
    phaseError = err as Error;
    throw err;
  } finally {
    // v1.11.5: emit one 'consolidate' audit_log row per api.sleep invocation,
    // with phase counters in metadata. Closes the CLI/MCP parity gap that T6
    // fixed for cmdOutcome (Episode A follow-up). In finally so partial-failure
    // paths still emit; `partial: true` + errorMessage flag the failure.
    // Dedicated handle for this emit only (phase helpers above each open their
    // own handle via hippoRoot — SQLite single-writer makes parallel handles
    // safe for the read-heavy phases).
    //
    // TODO(v1.12.0 + A5 v2): the audit row is tagged with ctx.tenantId but
    // api.sleep is host-wide (cross-tenant dedup is intentional). When
    // /v1/sleep moves off loopback-only, either tag with a synthetic "host"
    // tenant or scope api.sleep per-tenant. Independent-review-critic flag,
    // v1.11.5 ship.
    //
    // Error preservation: if openHippoDb or appendAuditEvent throws here, we
    // do NOT let it replace the original phaseError (independent-review HIGH:
    // would mask the underlying consolidation failure). Audit emit failure
    // is logged to stderr but the original throw wins.
    try {
      const db = openHippoDb(ctx.hippoRoot);
      try {
        // D2 v1.12.10: tag with '__host__' synthetic tenant since api.sleep
        // is host-wide (cross-tenant dedup is intentional). Tagging with
        // ctx.tenantId would mislead tenant-scoped audit queries — a
        // consolidate row labeled tenant=acme is wrong when the underlying
        // work touched all tenants' rows. '__host__' is a system-reserved
        // tenant string for host-wide ops; admins query it explicitly via
        // `hippo audit list --tenant __host__`. The actor field still
        // carries ctx.actor.subject so the operator who triggered the
        // consolidation is traceable.
        interface SleepAuditMetadata {
          consolidationCount: number;
          dedupCount: number;
          auditDeletedCount: number;
          ambientTotal: number;
          dryRun: boolean;
          noShare: boolean;
          partial: boolean;
          triggeredByTenant: string;
          errorMessage?: string;
        }
        const sleepAuditMetadata: SleepAuditMetadata = {
          consolidationCount,
          dedupCount,
          auditDeletedCount,
          ambientTotal,
          dryRun,
          noShare: opts.noShare ?? false,
          partial: phaseError !== null,
          triggeredByTenant: ctx.tenantId, // preserve for audit forensics
        };
        if (phaseError) sleepAuditMetadata.errorMessage = phaseError.message;
        appendAuditEvent(db, {
          tenantId: '__host__',
          actor: ctx.actor.subject,
          op: 'consolidate',
          metadata: { ...sleepAuditMetadata },
        });
      } finally {
        closeHippoDb(db);
      }
    } catch (auditErr) {
      // Logged, never thrown: a second failure must not mask the original phaseError.
      reportAuditWriteFailure('consolidate', String(auditErr));
    }
  }
}
