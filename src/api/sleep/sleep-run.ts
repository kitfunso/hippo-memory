// The sleep pipeline behind `sleep`, with its phase dependencies injectable; kept out of the package root.

import { auditMemories } from '../../core/memory-audit.js';
import { AUTO_SHARE_MIN_SCORE, autoShare } from '../../sharing/share.js';
import { runConsolidation } from '../../consolidate/sleep.js';
import { loadConfig } from '../../core/config.js';
import { deduplicateStore, type LoadedStore } from '../../consolidate/dedupe.js';
import { computeAmbientState } from '../../core/ambient.js';
import { extractGraphChunked, type ExtractResult } from '../../graph/extract.js';
import type { MemoryEntry } from '../../core/memory.js';
import type { Context, ContextWith } from '../types.js';
import { objectsOf } from '../objects/objects.js';
import type { Consolidation, Objects } from '../../store/port.js';
import { removeAuditErrors } from '../auth/audit.js';
import type { SleepOpts, SleepResult } from './sleep.js';
import { errorMessage } from '../../util/log.js';

/** Test-only seam: `runSleep` overrides force a phase to throw into emitSleepAudit's `partial: true` row; production
 * never sets them. */
export interface SleepPhases {
  consolidate: typeof runConsolidation;
  deduplicateStore: typeof deduplicateStore;
  auditMemories: typeof auditMemories;
  autoShare: typeof autoShare;
  loadAllEntries: (store: Consolidation) => MemoryEntry[];
  computeAmbientState: typeof computeAmbientState;
  loadConfig: typeof loadConfig;
  loadPendingExtractionTenants: (store: Consolidation) => DirtyTenantSnapshot['dirtyTenants'];
  extractGraph: (objects: Objects, hippoRoot: string, tenantId: string) => ExtractResult | Promise<ExtractResult>;
}

const DEFAULT_SLEEP_PHASES: SleepPhases = {
  consolidate: runConsolidation,
  deduplicateStore,
  auditMemories,
  autoShare,
  loadAllEntries: (store) => store.allEntries(),
  computeAmbientState,
  loadConfig,
  loadPendingExtractionTenants: (store) => store.dirtyGraphTenants(),
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

/** The groups one sleep runs on: hippo.db's own files, the audit pass and the graph's objects. */
type SleepContext = ContextWith<'auditMaintenance' | 'objects' | 'localFiles'>;

/** `sleep` with its phase dependencies overridable; tests pass
 * stubs here, so the seam never touches the public `SleepOpts`. */
export async function runSleep(
  ctx: SleepContext,
  opts: SleepOpts,
  overrides: Partial<SleepPhases> = {},
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);
  const phases: SleepPhases = { ...DEFAULT_SLEEP_PHASES, ...overrides };

  // Phase counters for the consolidate audit emit (in finally), accumulated per phase so a partial failure still
  // reports what got done.
  const counts: SleepCounts = { consolidation: 0, dedup: 0, auditDeleted: 0, ambient: 0 };
  let phaseError: Error | null = null;

  try {
    return await runSleepPhases(ctx, opts, phases, counts);
  } catch (err) {
    // SAFETY: phaseError is only read via phaseError.message / (phaseError !== null) below, safe even if a non-Error
    // was thrown; this mirrors the lenient (err as Error) pattern used through this catch chain.
    phaseError = err as Error;
    throw err;
  } finally {
    await emitSleepAudit(ctx, opts, dryRun, counts, phaseError);
  }
}

async function runSleepPhases(
  ctx: SleepContext,
  opts: SleepOpts,
  phases: SleepPhases,
  counts: SleepCounts,
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);
  const snapshot = snapshotDirtyTenants(ctx, phases, dryRun);

  // Phase 1: Consolidation.
  const local = ctx.store.localFiles;
  const consolidateResult = await phases.consolidate(local, { dryRun });
  counts.consolidation = consolidateResult.semanticCreated + consolidateResult.merged;
  const result = sleepResultFrom(consolidateResult, dryRun);

  // Consolidate's own read predates its writes, so it cannot stand in for this one. One read after consolidation serves
  // dedup, the audit and ambient: dedup reports every row it deletes, so later phases subtract.
  const loaded: LoadedStore = {
    entries: phases.loadAllEntries(local.consolidation),
    backing: local.consolidation.objectBackedIds(),
  };

  // Phase 2: Dedup (post-consolidate near-duplicate cleanup).
  const dedupResult = phases.deduplicateStore(local.consolidation, { dryRun, actor: ctx.actor.subject, loaded });
  counts.dedup = dedupResult.removed;
  if (dedupResult.removed > 0) result.deduped = dedupSummary(dedupResult);

  // Phase 3: Quality audit (remove junk, report warnings; a dry run skips rows earlier phases would remove).
  const audited = await runQualityAudit(ctx, phases, { dryRun, consolidateResult, dedupResult, result, loaded });
  counts.auditDeleted = audited.removed;

  if (dryRun) return result;

  // Phase 4: Auto-share high-transfer-score memories to global.
  if (!opts.noShare) shareOnSleep(ctx, phases, result);

  // Phase 5: Post-sleep ambient state summary.
  counts.ambient = summarizeAmbient(ctx, phases, result, audited.remaining);

  await drainGraphQueue(ctx, phases, snapshot, result);
  return result;
}

// Taken before any memory-deleting phase: queue rows cascade-delete with their mirror, so a later read would miss
// tenants dedup touched. Fail-soft: a failed read skips the graph refresh this sleep and never aborts core sleep.
function snapshotDirtyTenants(ctx: SleepContext, phases: SleepPhases, dryRun: boolean): DirtyTenantSnapshot {
  const snapshot: DirtyTenantSnapshot = { dirtyTenants: [], error: null };
  if (!dryRun) {
    try {
      snapshot.dirtyTenants = phases.loadPendingExtractionTenants(ctx.store.localFiles.consolidation);
    } catch (snapErr) {
      snapshot.error = errorMessage(snapErr);
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

interface QualityAuditOutcome {
  readonly removed: number;
  readonly remaining: MemoryEntry[];
}

interface QualityAuditOptions {
  readonly dryRun: boolean;
  readonly consolidateResult: ConsolidateOutcome;
  readonly dedupResult: DedupOutcome;
  readonly result: SleepResult;
  readonly loaded: LoadedStore;
}

/** `removed` counts audit errors deleted (or that would be under dryRun); `remaining` is what the audit read, less the
 * rows it deleted. */
async function runQualityAudit(
  ctx: ContextWith<'auditMaintenance'>,
  phases: SleepPhases,
  options: QualityAuditOptions,
): Promise<QualityAuditOutcome> {
  const { dryRun, consolidateResult, dedupResult, result, loaded } = options;
  // The load followed consolidation, so only a dry run still holds the rows consolidation would remove; dedup's pairs
  // are gone or would be.
  const planned = new Set([
    ...(dryRun ? (consolidateResult.removedIds ?? []) : []),
    ...dedupResult.pairs.map((p) => p.removed),
  ]);
  const allEntries = loaded.entries.filter((e) => !planned.has(e.id));
  const auditOut = phases.auditMemories(allEntries, loaded.backing);
  if (auditOut.issues.length === 0) return { removed: 0, remaining: allEntries };
  const errors = auditOut.issues.filter((i) => i.severity === 'error');
  const warnings = auditOut.issues.filter((i) => i.severity === 'warning');
  const gone = dryRun ? errors.map((issue) => issue.memoryId) : await removeAuditErrors(ctx, 'sleep-audit', errors);
  const removed = gone.length;
  const deleted = new Set(gone);
  if (removed > 0 || warnings.length > 0) {
    result.audit = {
      errorsRemoved: removed,
      warningCount: warnings.length,
    };
  }
  return { removed, remaining: allEntries.filter((e) => !deleted.has(e.id)) };
}

function shareOnSleep(ctx: Context, phases: SleepPhases, result: SleepResult): void {
  const sleepConfig = ctx.config ?? phases.loadConfig(ctx.hippoRoot);
  if (!sleepConfig.autoShareOnSleep) return;
  // Both skip counters are surfaced so the secret veto and the rejection tombstone are observable, not silent.
  const autoShareStats = { secretSkipped: 0, rejectedSkipped: 0 };
  const shared = phases.autoShare(ctx.hippoRoot, { minScore: AUTO_SHARE_MIN_SCORE, stats: autoShareStats });
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
function summarizeAmbient(
  ctx: Context,
  phases: SleepPhases,
  result: SleepResult,
  loaded: readonly MemoryEntry[],
): number {
  const postSleepConfig = ctx.config ?? phases.loadConfig(ctx.hippoRoot);
  if (!postSleepConfig.ambient.enabled) return 0;
  const postSleepEntries = loaded.filter((e) => !e.superseded_by);
  if (postSleepEntries.length === 0) return 0;
  result.ambient = phases.computeAmbientState(postSleepEntries);
  return result.ambient.totalMemories;
}

// Phase 6: rebuild the graph of every tenant marked dirty since the last sleep, so graph recall runs on fresh data.
// Fault-isolated: consolidation has already committed, so no failure here aborts sleep; a failed tenant stays pending.
async function drainGraphQueue(
  ctx: SleepContext,
  phases: SleepPhases,
  snapshot: DirtyTenantSnapshot,
  result: SleepResult,
): Promise<void> {
  try {
    if (snapshot.error) {
      // Core sleep already succeeded; surface the skipped graph refresh as a detail.
      result.details = [
        ...(result.details ?? []),
        `graph: dirty-tenant snapshot failed (skipped graph refresh): ${snapshot.error}`,
      ];
    }
    const rebuilt: GraphTotals = { tenants: 0, entities: 0, relations: 0 };
    // dirtyTenants was snapshotted before the memory-deleting phases above.
    for (const { tenantId, maxPendingId } of snapshot.dirtyTenants) {
      await rebuildDirtyTenant(ctx, phases, { tenantId, maxPendingId }, rebuilt, result);
    }
    if (rebuilt.tenants > 0) {
      result.graph = rebuilt;
    }
  } catch (graphErr) {
    result.details = [
      ...(result.details ?? []),
      `graph: drain phase failed (skipped): ${errorMessage(graphErr)}`,
    ];
  }
}

type GraphTotals = NonNullable<SleepResult['graph']>;

/** Rebuilds one dirty tenant's graph into `rebuilt` and drains its
 * queue; a failure is a detail line and the tenant stays pending. */
async function rebuildDirtyTenant(
  ctx: SleepContext,
  phases: SleepPhases,
  dirty: DirtyTenantSnapshot['dirtyTenants'][number],
  rebuilt: GraphTotals,
  result: SleepResult,
): Promise<void> {
  try {
    const ext = await phases.extractGraph(objectsOf(ctx), ctx.hippoRoot, dirty.tenantId);
    // Count the rebuild as soon as it succeeds — it happened regardless of
    // the drain-mark below.
    rebuilt.tenants += 1;
    rebuilt.entities += ext.entities;
    rebuilt.relations += ext.relations;
    if (ext.skipped) {
      result.details = [
        ...(result.details ?? []),
        `graph: ${ext.skipped} stale op(s) skipped for a tenant; the next sleep redoes them`,
      ];
    }
    // Watermark drain: only items enqueued before this rebuild started are marked; later arrivals stay pending.
    // Marked only after the last chunk, so a run stopped between chunks leaves the tenant for the next one.
    ctx.store.localFiles.consolidation.markGraphDrained(dirty.tenantId, dirty.maxPendingId);
  } catch (tenantErr) {
    result.details = [
      ...(result.details ?? []),
      `graph: extract failed for a dirty tenant (left pending): ${errorMessage(tenantErr)}`,
    ];
  }
}

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

// One 'consolidate' row per sleep, emitted from finally so a partial failure still reports what got done.
// An audit failure is logged and never replaces the original phase error.
async function emitSleepAudit(
  ctx: ContextWith<'localFiles'>,
  opts: SleepOpts,
  dryRun: boolean,
  counts: SleepCounts,
  phaseError: Error | null,
): Promise<void> {
  try {
    // Tagged '__host__' because sleep is host-wide; the actor still names the operator who ran it.
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
    // A flush stopped between chunks names the unit it would have
    // committed next, so a unit that fails every night can be found.
    const nextUnitIds = ctx.store.localFiles.consolidation.failedUnitOf(phaseError);
    if (nextUnitIds) sleepAuditMetadata.nextUnitIds = nextUnitIds;
    await ctx.store.appendAuditEvents([{
      tenantId: '__host__',
      actor: ctx.actor.subject,
      op: 'consolidate',
      metadata: { ...sleepAuditMetadata },
    }]);
  } catch (auditErr) {
    // Logged, never thrown: a second failure must not mask the original phaseError.
    ctx.store.localFiles.consolidation.reportAuditFailure('consolidate', String(auditErr));
  }
}
