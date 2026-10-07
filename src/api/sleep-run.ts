// The sleep pipeline behind `sleep`, with its phase dependencies injectable; kept out of the package root.

import { openHippoDb, closeHippoDb } from '../db.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { deleteEntry, memoriesBackingObjects } from '../store/delete-and-batch.js';
import { appendAuditEvent, reportAuditWriteFailure, auditMemories } from '../audit.js';
import { autoShare } from '../shared.js';
import { consolidate } from '../consolidate/sleep.js';
import { failedUnitOf } from '../store/delete-and-batch.js';
import { loadConfig } from '../config.js';
import { deduplicateStore } from '../dedupe.js';
import { computeAmbientState } from '../ambient.js';
import { loadPendingExtractionTenants } from '../graph/read.js';
import { markPendingProcessedUpTo } from '../graph/write.js';
import { extractGraphChunked, type ExtractResult } from '../graph-extract.js';
import type { Context } from './types.js';
import type { SleepOpts, SleepResult } from './sleep.js';

/** Test-only seam: `runSleep` overrides force a phase to throw into emitSleepAudit's `partial: true` row; production never sets them. */
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
  extractGraph: (hippoRoot: string, tenantId: string) => ExtractResult | Promise<ExtractResult>;
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
  extractGraph: extractGraphChunked,
};

/** Phase counters the consolidate audit row reports, filled in as each phase completes. */
interface SleepCounts {
  consolidation: number;
  dedup: number;
  auditDeleted: number;
  ambient: number;
}

type ConsolidateOutcome = Awaited<ReturnType<SleepPhases['consolidate']>>;
type DedupOutcome = ReturnType<SleepPhases['deduplicateStore']>;

interface DirtyTenantSnapshot {
  dirtyTenants: { tenantId: string; maxPendingId: number }[];
  error: string | null;
}

/** `sleep` with its phase dependencies overridable; tests pass stubs here, so the seam never touches the public `SleepOpts`. */
export async function runSleep(
  ctx: Context,
  opts: SleepOpts,
  overrides: Partial<SleepPhases> = {},
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);
  const phases: SleepPhases = { ...DEFAULT_SLEEP_PHASES, ...overrides };

  // Phase counters for the consolidate audit emit (in finally).
  // Accumulated as each phase completes so partial-failure paths still report
  // accurate "what got done before the failure" data.
  const counts: SleepCounts = { consolidation: 0, dedup: 0, auditDeleted: 0, ambient: 0 };
  let phaseError: Error | null = null;

  try {
    return await runSleepPhases(ctx, opts, phases, counts);
  } catch (err) {
    // SAFETY: phaseError is read via phaseError.message / (phaseError !==
    // null) below, both safe even if a non-Error was thrown; this mirrors
    // the existing lenient (err as Error) pattern used throughout this catch chain.
    phaseError = err as Error;
    throw err;
  } finally {
    emitSleepAudit(ctx, opts, dryRun, counts, phaseError);
  }
}

async function runSleepPhases(
  ctx: Context,
  opts: SleepOpts,
  phases: SleepPhases,
  counts: SleepCounts,
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);
  const snapshot = snapshotDirtyTenants(ctx, phases, dryRun);

  // Phase 1: Consolidation.
  const consolidateResult = await phases.consolidate(ctx.hippoRoot, { dryRun });
  counts.consolidation = consolidateResult.semanticCreated + consolidateResult.merged;
  const result = sleepResultFrom(consolidateResult, dryRun);

  // Phase 2: Dedup (post-consolidate near-duplicate cleanup).
  const dedupResult = phases.deduplicateStore(ctx.hippoRoot, { dryRun, actor: ctx.actor.subject });
  counts.dedup = dedupResult.removed;
  if (dedupResult.removed > 0) result.deduped = dedupSummary(dedupResult);

  // Phase 3: Quality audit (remove junk, report warnings; a dry run skips rows earlier phases would remove).
  counts.auditDeleted = runQualityAudit(ctx, phases, dryRun, consolidateResult, dedupResult, result);

  if (dryRun) return result;

  // Phase 4: Auto-share high-transfer-score memories to global.
  if (!opts.noShare) shareOnSleep(ctx, phases, result);

  // Phase 5: Post-sleep ambient state summary.
  counts.ambient = summarizeAmbient(ctx, phases, result);

  await drainGraphQueue(ctx, phases, snapshot, result);
  return result;
}

// Taken before any memory-deleting phase: queue rows cascade-delete with their mirror, so a later read would miss
// tenants dedup touched. Fail-soft: a failed read skips the graph refresh this sleep and never aborts core sleep.
function snapshotDirtyTenants(ctx: Context, phases: SleepPhases, dryRun: boolean): DirtyTenantSnapshot {
  const snapshot: DirtyTenantSnapshot = { dirtyTenants: [], error: null };
  if (!dryRun) {
    try {
      snapshot.dirtyTenants = phases.loadPendingExtractionTenants(ctx.hippoRoot);
    } catch (snapErr) {
      // SAFETY: this is a best-effort log message only; property access on
      // any JS value is safe (undefined if absent), preserving the existing
      // lenient formatting even when something non-Error was thrown.
      snapshot.error = (snapErr as Error).message;
    }
  }
  return snapshot;
}

function sleepResultFrom(consolidateResult: ConsolidateOutcome, dryRun: boolean): SleepResult {
  const result: SleepResult = {
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
  return result;
}

function dedupSummary(dedupResult: DedupOutcome): NonNullable<SleepResult['deduped']> {
  const semDups = dedupResult.pairs.filter(
    (p) => p.keptLayer === 'semantic' && p.removedLayer === 'semantic',
  ).length;
  const epiDups = dedupResult.pairs.filter(
    (p) => p.keptLayer === 'episodic' && p.removedLayer === 'episodic',
  ).length;
  const crossDups = dedupResult.pairs.filter(
    (p) => p.keptLayer !== p.removedLayer,
  ).length;
  return {
    removed: dedupResult.removed,
    semDups,
    epiDups,
    crossDups,
  };
}

/** Returns how many audit errors were deleted, or would be under dryRun. */
function runQualityAudit(
  ctx: Context,
  phases: SleepPhases,
  dryRun: boolean,
  consolidateResult: ConsolidateOutcome,
  dedupResult: DedupOutcome,
  result: SleepResult,
): number {
  const planned = new Set(dryRun ? [...(consolidateResult.removedIds ?? []), ...dedupResult.pairs.map((p) => p.removed)] : []);
  const allEntries = phases.loadAllEntries(ctx.hippoRoot).filter((e) => !planned.has(e.id));
  const auditOut = phases.auditMemories(allEntries, memoriesBackingObjects(ctx.hippoRoot));
  if (auditOut.issues.length === 0) return 0;
  const errors = auditOut.issues.filter((i) => i.severity === 'error');
  const warnings = auditOut.issues.filter((i) => i.severity === 'warning');
  let removed = 0;
  for (const issue of errors) {
    const reason = `sleep-audit: ${issue.reason}`;
    if (dryRun || phases.deleteEntry(ctx.hippoRoot, issue.memoryId, { actor: ctx.actor.subject, reason, automatic: true })) removed++;
  }
  if (removed > 0 || warnings.length > 0) {
    result.audit = {
      errorsRemoved: removed,
      warningCount: warnings.length,
    };
  }
  return removed;
}

function shareOnSleep(ctx: Context, phases: SleepPhases, result: SleepResult): void {
  const sleepConfig = phases.loadConfig(ctx.hippoRoot);
  if (!sleepConfig.autoShareOnSleep) return;
  // Both skip counters are surfaced so the secret veto and the rejection tombstone are observable, not silent.
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

/** Returns the ambient total the audit row reports: 0 when ambient is off or no current row is left. */
function summarizeAmbient(ctx: Context, phases: SleepPhases, result: SleepResult): number {
  const postSleepConfig = phases.loadConfig(ctx.hippoRoot);
  if (!postSleepConfig.ambient.enabled) return 0;
  const postSleepEntries = phases.loadAllEntries(ctx.hippoRoot).filter(
    (e) => !e.superseded_by,
  );
  if (postSleepEntries.length === 0) return 0;
  result.ambient = phases.computeAmbientState(postSleepEntries);
  return result.ambient.totalMemories;
}

// Phase 6: rebuild the graph of every tenant marked dirty since the last sleep, so graph recall runs on fresh data.
// Fault-isolated: consolidation has already committed, so no failure here aborts sleep; a failed tenant stays pending.
async function drainGraphQueue(ctx: Context, phases: SleepPhases, snapshot: DirtyTenantSnapshot, result: SleepResult): Promise<void> {
  try {
    if (snapshot.error) {
      // Core sleep already succeeded; surface the skipped graph refresh as a detail.
      result.details = [
        ...(result.details ?? []),
        `graph: dirty-tenant snapshot failed (skipped graph refresh): ${snapshot.error}`,
      ];
    }
    let gTenants = 0;
    let gEntities = 0;
    let gRelations = 0;
    // dirtyTenants was snapshotted before the memory-deleting phases above.
    for (const { tenantId, maxPendingId } of snapshot.dirtyTenants) {
      try {
        const ext = await phases.extractGraph(ctx.hippoRoot, tenantId);
        // Count the rebuild as soon as it succeeds — it happened regardless of
        // the drain-mark below.
        gTenants += 1;
        gEntities += ext.entities;
        gRelations += ext.relations;
        if (ext.skipped) {
          result.details = [
            ...(result.details ?? []),
            `graph: ${ext.skipped} stale op(s) skipped for a tenant; the next sleep redoes them`,
          ];
        }
        // Watermark drain: only items enqueued before this rebuild started are marked; later arrivals stay pending.
        // Marked only after the last chunk, so a run stopped between chunks leaves the tenant for the next one.
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
}

// One 'consolidate' row per sleep, emitted from finally so a partial failure still reports what got done.
// Its own handle; an audit failure is logged and never replaces the original phase error.
function emitSleepAudit(
  ctx: Context,
  opts: SleepOpts,
  dryRun: boolean,
  counts: SleepCounts,
  phaseError: Error | null,
): void {
  try {
    const db = openHippoDb(ctx.hippoRoot);
    try {
      // Tagged '__host__' because sleep is host-wide; the actor still names the operator who ran it.
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
        nextUnitIds?: string[];
      }
      const sleepAuditMetadata: SleepAuditMetadata = {
        consolidationCount: counts.consolidation,
        dedupCount: counts.dedup,
        auditDeletedCount: counts.auditDeleted,
        ambientTotal: counts.ambient,
        dryRun,
        noShare: opts.noShare ?? false,
        partial: phaseError !== null,
        triggeredByTenant: ctx.tenantId, // preserve for audit forensics
      };
      if (phaseError) sleepAuditMetadata.errorMessage = phaseError.message;
      // A flush stopped between chunks names the unit it would have committed next, so a unit that fails every night can be found.
      const nextUnitIds = failedUnitOf(phaseError);
      if (nextUnitIds) sleepAuditMetadata.nextUnitIds = nextUnitIds;
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
