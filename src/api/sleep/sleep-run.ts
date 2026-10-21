// The sleep pipeline behind `sleep`, with its phase dependencies injectable; kept out of the package root.

import { auditMemories, type AuditIssue } from '../../base/memory/memory-audit.js';
import { AUTO_SHARE_MIN_SCORE, autoShare } from '../../domain/sharing/share.js';
import { runConsolidation } from '../../domain/consolidate/sleep.js';
import { deduplicateStore } from '../../domain/consolidate/dedupe.js';
import { evalNow } from '../../base/memory/ablation.js';
import { ambientStateFromTallies, foldAmbientRows, tallyAmbientEntries } from '../../base/memory/ambient.js';
import { extractGraphChunked, type ExtractResult } from '../../domain/graph/extract.js';
import { strengthOptionsOf, type MemoryEntry } from '../../base/memory/memory.js';
import type { Context, SleepContext } from '../types.js';
import { auditRemoveErrors } from '../auth/audit.js';
import type { SleepOpts, SleepResult } from './sleep.js';
import { errorMessage } from '../../base/util/log.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { failedUnitOf } from '../../base/errors/failed-unit.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import type { StoreWith } from '../../store/port.js';
import type { EntryCursor } from '../../store/port/types.js';

/** Test-only seam: `runSleep` overrides force a phase to throw into emitSleepAudit's `partial: true` row, or shrink the
 * pages dedup, the audit and ambient read; production never sets them. */
export interface SleepPhases {
  consolidate: typeof runConsolidation;
  deduplicateStore: typeof deduplicateStore;
  auditMemories: typeof auditMemories;
  autoShare: typeof autoShare;
  computeAmbientState: typeof ambientStateFromTallies;
  loadPendingExtractionTenants: (store: StoreWith<'consolidation'>) => Promise<DirtyTenantSnapshot['dirtyTenants']>;
  extractGraph: (store: StoreWith<'graphRebuild'>, tenantId: string) => ExtractResult | Promise<ExtractResult>;
  pageSize: number;
}

const DEFAULT_SLEEP_PHASES: SleepPhases = {
  consolidate: runConsolidation,
  deduplicateStore,
  auditMemories,
  autoShare,
  computeAmbientState: ambientStateFromTallies,
  loadPendingExtractionTenants: (store) => store.consolidation.dirtyGraphTenants(),
  extractGraph: extractGraphChunked,
  pageSize: 1000,
};

/** Phase counters the consolidate audit row reports, filled in as each phase completes. */
interface SleepCounts {
  consolidation: number;
  dedup: number;
  auditDeleted: number;
  ambient: number;
}

type ConsolidateOutcome = Awaited<ReturnType<SleepPhases['consolidate']>>;
type DedupOutcome = Awaited<ReturnType<SleepPhases['deduplicateStore']>>;

interface DirtyTenantSnapshot {
  dirtyTenants: { tenantId: string; maxPendingId: number }[];
  error: string | null;
}

/** `sleep` with its phase dependencies overridable; tests pass stubs here, so the seam never touches the public
 * `SleepOpts`. */
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
  const snapshot = await snapshotDirtyTenants(ctx, phases, dryRun);

  // Phase 1: Consolidation.
  const { store } = ctx;
  const consolidateResult = await phases.consolidate(store, { dryRun, config: ctx.config, tenantId: ctx.tenantId });
  counts.consolidation = consolidateResult.semanticCreated + consolidateResult.merged;
  const result = sleepResultFrom(consolidateResult, dryRun);

  // Consolidate's own read predates its writes, so it cannot stand in for these. Dedup, the audit and ambient each page
  // through the store after the phase before them wrote, holding one page at a time.
  const pages = (): AsyncIterable<MemoryEntry[]> => entryPages(store, phases.pageSize);

  // Phase 2: Dedup (post-consolidate near-duplicate cleanup).
  const actor = ctx.actor.subject;
  const dedupResult = await phases.deduplicateStore(store, { dryRun, actor, pages: pages() });
  counts.dedup = dedupResult.removed;
  if (dedupResult.removed > 0) result.deduped = dedupSummary(dedupResult);

  // Phase 3: Quality audit (remove junk, report warnings; a dry run skips rows earlier phases would remove).
  const auditOptions = { dryRun, consolidateResult, dedupResult, result, pages };
  counts.auditDeleted = await runQualityAudit(ctx, phases, auditOptions);

  if (dryRun) return result;

  // Phase 4: Auto-share high-transfer-score memories to global.
  if (!opts.noShare) await shareOnSleep(ctx, phases, result);

  // Phase 5: Post-sleep ambient state summary.
  counts.ambient = await summarizeAmbient(ctx, phases, result, pages);

  await drainGraphQueue(ctx, phases, snapshot, result);
  return result;
}

// Taken before any memory-deleting phase: queue rows cascade-delete with their mirror, so a later read would miss
// tenants dedup touched. Fail-soft: a failed read skips the graph refresh this sleep and never aborts core sleep.
async function snapshotDirtyTenants(
  ctx: SleepContext,
  phases: SleepPhases,
  dryRun: boolean,
): Promise<DirtyTenantSnapshot> {
  const snapshot: DirtyTenantSnapshot = { dirtyTenants: [], error: null };
  if (!dryRun) {
    try {
      snapshot.dirtyTenants = await phases.loadPendingExtractionTenants(ctx.store);
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
  // Set only when non-zero, so a store without dormant memories gets a byte-identical result (HTTP /v1/sleep, the CLI
  // render snapshot).
  if (consolidateResult.dormant > 0) {
    result.dormant = consolidateResult.dormant;
  }
  if (consolidateResult.dormantExpired > 0) {
    result.dormantExpired = consolidateResult.dormantExpired;
  }
  return result;
}

function dedupSummary(dedupResult: DedupOutcome): NonNullable<SleepResult['deduped']> {
  const semDups = dedupResult.pairs.filter((p) => p.keptLayer === 'semantic' && p.removedLayer === 'semantic').length;
  const epiDups = dedupResult.pairs.filter((p) => p.keptLayer === 'episodic' && p.removedLayer === 'episodic').length;
  const crossDups = dedupResult.pairs.filter((p) => p.keptLayer !== p.removedLayer).length;
  return {
    removed: dedupResult.removed,
    semDups,
    epiDups,
    crossDups,
  };
}

/** Every row of every tenant in load order, `limit` per read. */
async function* entryPages(store: StoreWith<'consolidation'>, limit: number): AsyncGenerator<MemoryEntry[]> {
  let after: EntryCursor | undefined;
  do {
    const page = await store.consolidation.entriesPage({ limit, after });
    yield page.entries;
    after = page.next ?? undefined;
  } while (after);
}

interface QualityAuditOptions {
  readonly dryRun: boolean;
  readonly consolidateResult: ConsolidateOutcome;
  readonly dedupResult: DedupOutcome;
  readonly result: SleepResult;
  readonly pages: () => AsyncIterable<MemoryEntry[]>;
}

/** Counts audit errors deleted (or that would be under dryRun); each row is judged alone, so pages need no shared state
 * beyond the issues found. */
async function runQualityAudit(ctx: SleepContext, phases: SleepPhases, options: QualityAuditOptions): Promise<number> {
  const { dryRun, consolidateResult, dedupResult, result, pages } = options;
  // The pages follow consolidation and dedup, so only a dry run still holds the rows they would remove.
  const wouldGo = dryRun ? [...(consolidateResult.removedIds ?? []), ...dedupResult.pairs.map((p) => p.removed)] : [];
  const planned = new Set(wouldGo);
  const issues: AuditIssue[] = [];
  for await (const page of pages()) {
    const rows = page.filter((e) => !planned.has(e.id));
    const backing = await ctx.store.consolidation.objectBackedAmong(rows.map((e) => e.id));
    issues.push(...phases.auditMemories(rows, backing).issues);
  }
  if (issues.length === 0) return 0;
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const gone = dryRun ? errors.map((issue) => issue.memoryId) : await auditRemoveErrors(ctx, 'sleep-audit', errors);
  if (gone.length > 0 || warnings.length > 0) {
    result.audit = {
      errorsRemoved: gone.length,
      warningCount: warnings.length,
    };
  }
  return gone.length;
}

async function shareOnSleep(ctx: SleepContext, phases: SleepPhases, result: SleepResult): Promise<void> {
  // No global target means a store with no operator's global store beside it, as context reads it.
  const target = ctx.reach?.globalTarget;
  const { sharing, folderFiles } = ctx.store;
  if (!ctx.config.autoShareOnSleep || target === undefined || sharing === undefined || folderFiles === undefined) {
    return;
  }
  // Both skip counters are surfaced so the secret veto and the rejection tombstone are observable, not silent.
  const autoShareStats = { secretSkipped: 0, rejectedSkipped: 0 };
  const shared = await phases.autoShare({ store: { sharing, folderFiles } }, target, {
    tenantId: ALL_TENANTS,
    minScore: AUTO_SHARE_MIN_SCORE,
    stats: autoShareStats,
  });
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
async function summarizeAmbient(
  ctx: Context,
  phases: SleepPhases,
  result: SleepResult,
  pages: () => AsyncIterable<MemoryEntry[]>,
): Promise<number> {
  if (!ctx.config.ambient.enabled) return 0;
  // One running tally at one `now`, so the float sums match one whole read row for row.
  const now = evalNow();
  const tallies = tallyAmbientEntries([], now);
  const rules = strengthOptionsOf(ctx.config.runtime);
  for await (const page of pages()) {
    foldAmbientRows(
      tallies,
      page.filter((e) => !e.supersededBy),
      now,
      rules,
    );
  }
  if (tallies.total === 0) return 0;
  result.ambient = phases.computeAmbientState(tallies);
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
    result.details = [...(result.details ?? []), `graph: drain phase failed (skipped): ${errorMessage(graphErr)}`];
  }
}

type GraphTotals = NonNullable<SleepResult['graph']>;

/** Rebuilds one dirty tenant's graph into `rebuilt` and drains its queue; a failure is a detail line and the tenant
 * stays pending. */
async function rebuildDirtyTenant(
  ctx: SleepContext,
  phases: SleepPhases,
  dirty: DirtyTenantSnapshot['dirtyTenants'][number],
  rebuilt: GraphTotals,
  result: SleepResult,
): Promise<void> {
  try {
    const ext = await phases.extractGraph(ctx.store, dirty.tenantId);
    // Count the rebuild as soon as it succeeds; it happened regardless of the drain-mark below.
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
    await ctx.store.consolidation.markGraphDrained(dirty.tenantId, dirty.maxPendingId);
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
  ctx: SleepContext,
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
    // A flush stopped between chunks names the unit it would have committed next, so a unit that fails every night can
    // be found.
    const nextUnitIds = failedUnitOf(phaseError);
    if (nextUnitIds) sleepAuditMetadata.nextUnitIds = nextUnitIds;
    await ctx.store.appendAuditEvents([
      {
        tenantId: '__host__',
        actor: ctx.actor.subject,
        op: 'consolidate',
        metadata: { ...sleepAuditMetadata },
      },
    ]);
  } catch (auditErr) {
    // Logged, never thrown: a second failure must not mask the original phaseError.
    reportAuditWriteFailure('consolidate', auditErr);
  }
}
