// The sleep pipeline behind `sleepWholeStore`, with its phase dependencies injectable; kept out of
// the package root.

import { auditMemories, type AuditIssue } from '../../base/memory/memory-audit.js';
import { AUTO_SHARE_MIN_SCORE, autoShare } from '../../domain/sharing/share.js';
import { runConsolidation } from '../../domain/consolidate/sleep.js';
import { deduplicateStore } from '../../domain/consolidate/dedupe.js';
import { groupDedupPairs } from '../../base/memory/dedup-pairs.js';
import {
  ambientStateFromTallies,
  foldAmbientRows,
  tallyAmbientEntries,
  type AmbientState,
} from '../../base/memory/ambient.js';
import { extractGraphChunked, type ExtractResult } from '../../domain/graph/extract.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { strengthOf, type Context } from '../types.js';
import { auditRemoveErrors } from '../hippo-db/audit-maintenance.js';
import { withDetached } from '../detached.js';
import type { SleepOptions, SleepResult } from './sleep.js';
import type { SleepEvent } from './events.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { failedUnitOf } from '../../base/errors/failed-unit.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import type { EntryCursor } from '../../base/ports/store/types.js';
import { globalTargetOf, type HippoDbContext, type HippoDbStore } from '../hippo-db-context.js';

/** Test-only seam: `runSleep` overrides force a phase to throw into emitSleepAudit's `partial:
 * true` row, or shrink the pages dedup, the audit and ambient read; production never sets them. */
export interface SleepPhases {
  consolidate: typeof runConsolidation;
  deduplicateStore: typeof deduplicateStore;
  auditMemories: typeof auditMemories;
  autoShare: typeof autoShare;
  computeAmbientState: typeof ambientStateFromTallies;
  loadPendingExtractionTenants: (
    store: HippoDbStore,
  ) => Promise<DirtyTenantSnapshot['dirtyTenants']>;
  extractGraph: (store: HippoDbStore, tenantId: string) => ExtractResult | Promise<ExtractResult>;
  pageSize: number;
}

const DEFAULT_SLEEP_PHASES: SleepPhases = {
  consolidate: runConsolidation,
  deduplicateStore,
  auditMemories,
  autoShare,
  computeAmbientState: ambientStateFromTallies,
  loadPendingExtractionTenants: (store) => store.hippoDb.consolidation.dirtyGraphTenants(),
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

/** `sleepWholeStore` with its phase dependencies overridable; tests pass stubs here, so the seam
 * never touches the public `SleepOptions`. */
export async function runSleep(
  ctx: HippoDbContext,
  opts: SleepOptions,
  overrides: Partial<SleepPhases> = {},
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);
  const phases: SleepPhases = { ...DEFAULT_SLEEP_PHASES, ...overrides };

  // Phase counters for the consolidate audit emit (in finally), accumulated per phase so a partial
  // failure still reports what got done.
  const counts: SleepCounts = { consolidation: 0, dedup: 0, auditDeleted: 0, ambient: 0 };
  let phaseError: { thrown: unknown } | null = null;

  try {
    return await runSleepPhases(ctx, opts, phases, counts);
  } catch (err) {
    phaseError = { thrown: err };
    throw err;
  } finally {
    await emitSleepAudit(ctx, { opts, dryRun, counts, phaseError });
  }
}

async function runSleepPhases(
  ctx: HippoDbContext,
  opts: SleepOptions,
  phases: SleepPhases,
  counts: SleepCounts,
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);
  const snapshot = await snapshotDirtyTenants(ctx, phases, dryRun);
  const { result, pages } = await runCorePhases(ctx, phases, dryRun, counts);

  if (dryRun) return result;

  // Phase 4: Auto-share high-transfer-score memories to global.
  if (!opts.noShare) Object.assign(result, await shareOnSleep(ctx, phases));

  // Phase 5: Post-sleep ambient state summary.
  const ambient = await summarizeAmbient(ctx, phases, pages);
  if (ambient) {
    result.ambient = ambient;
    counts.ambient = ambient.totalMemories;
  }

  const drained = await drainGraphQueue(ctx, phases, snapshot);
  if (drained.events.length > 0) result.events = [...(result.events ?? []), ...drained.events];
  if (drained.graph) result.graph = drained.graph;
  return result;
}

interface CorePhasesRun {
  readonly result: SleepResult;
  readonly pages: () => AsyncIterable<MemoryEntry[]>;
}

/** Phases 1 to 3, the ones a dry run also runs. */
async function runCorePhases(
  ctx: HippoDbContext,
  phases: SleepPhases,
  dryRun: boolean,
  counts: SleepCounts,
): Promise<CorePhasesRun> {
  // Phase 1: Consolidation.
  const { store } = ctx;
  const consolidateResult = await phases.consolidate(store, {
    dryRun,
    config: ctx.config,
    tenantId: ctx.tenantId,
    llm: ctx.infra.llm,
    now: ctx.infra.clock(),
    strength: strengthOf(ctx),
  });
  counts.consolidation = consolidateResult.semanticCreated + consolidateResult.merged;
  const result = sleepResultFrom(consolidateResult, dryRun);

  // Consolidate's own read predates its writes, so it cannot stand in for these. Dedup, the audit
  // and ambient each page through the store after the phase before them wrote, holding one page at
  // a time.
  const pages = (): AsyncIterable<MemoryEntry[]> => entryPages(store, phases.pageSize);

  // Phase 2: Dedup (post-consolidate near-duplicate cleanup).
  const actor = ctx.actor.subject;
  const dedupResult = await phases.deduplicateStore(store, { dryRun, actor, pages: pages() });
  counts.dedup = dedupResult.removed;
  if (dedupResult.removed > 0) result.deduped = dedupSummary(dedupResult);

  // Phase 3: Quality audit (remove junk, report warnings; a dry run skips rows earlier phases would
  // remove).
  const auditOptions = { dryRun, consolidateResult, dedupResult, pages };
  const audit = await runQualityAudit(ctx, phases, auditOptions);
  counts.auditDeleted = audit.errorsRemoved;
  if (audit.errorsRemoved > 0 || audit.warningCount > 0) result.audit = audit;
  return { result, pages };
}

// Taken before any memory-deleting phase: queue rows cascade-delete with their mirror, so a later
// read would miss tenants dedup touched. Fail-soft: a failed read skips the graph refresh this
// sleep and never aborts core sleep.
async function snapshotDirtyTenants(
  ctx: HippoDbContext,
  phases: SleepPhases,
  dryRun: boolean,
): Promise<DirtyTenantSnapshot> {
  const snapshot: DirtyTenantSnapshot = { dirtyTenants: [], error: null };
  if (!dryRun) {
    try {
      snapshot.dirtyTenants = await phases.loadPendingExtractionTenants(ctx.store);
    } catch (snapErr) {
      snapshot.error = errorMessage(snapErr);
      log.warn(
        `sleep: dirty-tenant snapshot failed, so no graph refresh this sleep: ${snapshot.error}`,
        errorFields(snapErr),
      );
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
    events: consolidateResult.events,
  };
  // Set only when non-zero, so a store without dormant memories gets a byte-identical result (HTTP
  // /v1/sleep, the CLI render snapshot).
  if (consolidateResult.dormant > 0) {
    result.dormant = consolidateResult.dormant;
  }
  if (consolidateResult.dormantExpired > 0) {
    result.dormantExpired = consolidateResult.dormantExpired;
  }
  return result;
}

function dedupSummary(dedupResult: DedupOutcome): NonNullable<SleepResult['deduped']> {
  const groups = groupDedupPairs(dedupResult.pairs);
  return {
    removed: dedupResult.removed,
    semDups: groups.semantic.length,
    epiDups: groups.episodic.length,
    crossDups: groups.cross.length,
  };
}

/** Every row of every tenant in load order, `limit` per read. */
async function* entryPages(store: HippoDbStore, limit: number): AsyncGenerator<MemoryEntry[]> {
  let after: EntryCursor | undefined;
  do {
    const page = await store.entriesWhere({ tenantId: ALL_TENANTS }, { limit, after });
    yield page.entries;
    after = page.next ?? undefined;
  } while (after);
}

interface QualityAuditOptions {
  readonly dryRun: boolean;
  readonly consolidateResult: ConsolidateOutcome;
  readonly dedupResult: DedupOutcome;
  readonly pages: () => AsyncIterable<MemoryEntry[]>;
}

type AuditSummary = NonNullable<SleepResult['audit']>;

/** The audit errors deleted (or that would be under dryRun) and the warnings; each row is judged
 * alone, so pages need no shared state beyond the issues found. */
async function runQualityAudit(
  ctx: HippoDbContext,
  phases: SleepPhases,
  options: QualityAuditOptions,
): Promise<AuditSummary> {
  const { dryRun, consolidateResult, dedupResult, pages } = options;
  // The pages follow consolidation and dedup, so only a dry run still holds the rows they would
  // remove.
  const wouldGo = dryRun
    ? [...(consolidateResult.removedIds ?? []), ...dedupResult.pairs.map((p) => p.removed)]
    : [];
  const planned = new Set(wouldGo);
  const issues: AuditIssue[] = [];
  for await (const page of pages()) {
    const rows = page.filter((e) => !planned.has(e.id));
    const backing = await ctx.store.hippoDb.auditMaintenance.objectBackedAmong(
      rows.map((e) => e.id),
    );
    issues.push(...phases.auditMemories(rows, backing).issues);
  }
  if (issues.length === 0) return { errorsRemoved: 0, warningCount: 0 };
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const gone = dryRun
    ? errors.map((issue) => issue.memoryId)
    : await auditRemoveErrors(ctx, 'sleep-audit', errors);
  return { errorsRemoved: gone.length, warningCount: warnings.length };
}

/** The auto-share counts, each set only when non-zero so an idle share leaves the result as it
 * was. */
async function shareOnSleep(
  ctx: HippoDbContext,
  phases: SleepPhases,
): Promise<Pick<SleepResult, 'shared' | 'secretSkipped' | 'rejectedSkipped'>> {
  // No global target means a store with no operator's global store beside it, as context reads it.
  const target = globalTargetOf(ctx);
  if (!ctx.config.autoShareOnSleep || target === undefined) return {};
  const { store } = ctx;
  const { sharing, folderFiles } = store.hippoDb;
  // Both skip counters are surfaced so the secret veto and the rejection tombstone are observable,
  // not silent.
  const autoShareStats = { secretSkipped: 0, rejectedSkipped: 0 };
  const shared = await withDetached(ctx, (detached) =>
    phases.autoShare(
      {
        store: {
          hippoDb: { sharing, folderFiles },
          entriesWhere: (filter, page) => store.entriesWhere(filter, page),
        },
      },
      target,
      {
        tenantId: ALL_TENANTS,
        minScore: AUTO_SHARE_MIN_SCORE,
        stats: autoShareStats,
        embed: ctx.infra,
        detached,
      },
    ),
  );
  const { secretSkipped, rejectedSkipped } = autoShareStats;
  return {
    ...(shared.length > 0 && { shared: shared.length }),
    ...(secretSkipped > 0 && { secretSkipped }),
    ...(rejectedSkipped > 0 && { rejectedSkipped }),
  };
}

/** The ambient state after sleep: null when ambient is off or no current row is left. */
async function summarizeAmbient(
  ctx: Context,
  phases: SleepPhases,
  pages: () => AsyncIterable<MemoryEntry[]>,
): Promise<AmbientState | null> {
  if (!ctx.config.ambient.enabled) return null;
  // One running tally at one `now`, so the float sums match one whole read row for row.
  const now = ctx.infra.clock();
  const rules = strengthOf(ctx);
  const tallies = tallyAmbientEntries([], now, rules);
  for await (const page of pages()) {
    foldAmbientRows(
      tallies,
      page.filter((e) => !e.supersededBy),
      now,
      rules,
    );
  }
  return tallies.total === 0 ? null : phases.computeAmbientState(tallies);
}

// Phase 6: rebuild the graph of every tenant marked dirty since the last sleep, so graph recall
// runs on fresh data. Fault-isolated: consolidation has already committed, so no failure here
// aborts sleep; a failed tenant stays pending.
async function drainGraphQueue(
  ctx: HippoDbContext,
  phases: SleepPhases,
  snapshot: DirtyTenantSnapshot,
): Promise<GraphDrain> {
  const events: SleepEvent[] = [];
  try {
    if (snapshot.error) {
      // Core sleep already succeeded; surface the skipped graph refresh as an event.
      events.push({ kind: 'graphSnapshotFailed', message: snapshot.error });
    }
    const rebuilt: GraphTotals = { tenants: 0, entities: 0, relations: 0 };
    // dirtyTenants was snapshotted before the memory-deleting phases above.
    for (const dirty of snapshot.dirtyTenants) {
      const tenant = await rebuildDirtyTenant(ctx, phases, dirty);
      events.push(...tenant.events);
      if (tenant.extracted === undefined) continue;
      rebuilt.tenants += 1;
      rebuilt.entities += tenant.extracted.entities;
      rebuilt.relations += tenant.extracted.relations;
    }
    return rebuilt.tenants > 0 ? { events, graph: rebuilt } : { events };
  } catch (graphErr) {
    log.warn(`sleep: graph drain phase failed: ${errorMessage(graphErr)}`, errorFields(graphErr));
    events.push({ kind: 'graphDrainFailed', message: errorMessage(graphErr) });
    return { events };
  }
}

type GraphTotals = NonNullable<SleepResult['graph']>;

/** The graph phase's events in order, and its totals when a tenant was rebuilt and none threw. */
interface GraphDrain {
  readonly events: readonly SleepEvent[];
  readonly graph?: GraphTotals;
}

/** One tenant's rebuild: its events in order, and its counts when the extract ran. */
interface TenantRebuild {
  readonly events: readonly SleepEvent[];
  readonly extracted?: Pick<GraphTotals, 'entities' | 'relations'>;
}

/** Rebuilds one dirty tenant's graph and drains its queue; on a failure the tenant stays
 * pending. */
async function rebuildDirtyTenant(
  ctx: HippoDbContext,
  phases: SleepPhases,
  dirty: DirtyTenantSnapshot['dirtyTenants'][number],
): Promise<TenantRebuild> {
  const events: SleepEvent[] = [];
  let extracted: TenantRebuild['extracted'];
  try {
    const ext = await phases.extractGraph(ctx.store, dirty.tenantId);
    // Count the rebuild as soon as it succeeds; it happened regardless of the drain-mark below.
    extracted = { entities: ext.entities, relations: ext.relations };
    if (ext.skipped) events.push({ kind: 'graphStaleOpsSkipped', count: ext.skipped });
    // Watermark drain: only items enqueued before this rebuild started are marked; later arrivals
    // stay pending. Marked only after the last chunk, so a run stopped between chunks leaves the
    // tenant for the next one.
    await ctx.store.hippoDb.consolidation.markGraphDrained(dirty.tenantId, dirty.maxPendingId);
  } catch (tenantErr) {
    log.warn(
      `sleep: graph extract failed for tenant ${dirty.tenantId}, left pending: ${errorMessage(tenantErr)}`,
      errorFields(tenantErr),
    );
    events.push({ kind: 'graphExtractFailed', message: errorMessage(tenantErr) });
  }
  return extracted === undefined ? { events } : { events, extracted };
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

interface EmitSleepAuditOptions {
  readonly opts: SleepOptions;
  readonly dryRun: boolean;
  readonly counts: SleepCounts;
  readonly phaseError: { thrown: unknown } | null;
}

// One 'consolidate' row per sleep, emitted from finally so a partial failure still reports what got
// done. An audit failure is logged and never replaces the original phase error.
async function emitSleepAudit(
  ctx: HippoDbContext,
  { opts, dryRun, counts, phaseError }: EmitSleepAuditOptions,
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
    if (phaseError) sleepAuditMetadata.errorMessage = errorMessage(phaseError.thrown);
    // A flush stopped between chunks names the unit it would have committed next, so a unit that
    // fails every night can be found.
    const nextUnitIds = failedUnitOf(
      phaseError?.thrown instanceof Error ? phaseError.thrown : null,
    );
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
