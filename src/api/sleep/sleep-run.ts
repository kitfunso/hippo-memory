import { auditMemories, type AuditIssue } from '../../base/memory/memory-audit.js';
import { AUTO_SHARE_MIN_SCORE, autoShare } from '../../domain/sharing/share.js';
import { runConsolidation } from '../../domain/consolidate/sleep.js';
import { deduplicateStore } from '../../domain/consolidate/dedupe.js';
import { groupDedupPairs } from '../../base/memory/dedup-pairs.js';
import {
  ambientStateFromTallies,
  foldAmbientRows,
  tallyAmbientEntries,
} from '../../base/memory/ambient.js';
import { extractGraphChunked, type ExtractResult } from '../../domain/graph/extract.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { strengthOf, type Context, type ContextWith, type SleepContext } from '../types.js';
import { auditRemoveErrors } from '../auth/audit.js';
import { globalTargetOf } from '../infra.js';
import { withDetached } from '../detached.js';
import type { SleepOptions, SleepResult } from './sleep.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { failedUnitOf } from '../../base/errors/failed-unit.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import type { SleepGroup, StoreWith } from '../../base/ports/store.js';
import type { EntryCursor } from '../../base/ports/store/types.js';
import { isSuperseded } from '../../base/memory/liveness.js';

/** Test-only seam: `runSleep` overrides force a phase to throw into emitSleepAudit's `partial:
 * true` row, or shrink the pages dedup, the audit and ambient read; production never sets them. */
export interface SleepPhases {
  consolidate: typeof runConsolidation;
  deduplicateStore: typeof deduplicateStore;
  auditMemories: typeof auditMemories;
  autoShare: typeof autoShare;
  computeAmbientState: typeof ambientStateFromTallies;
  loadPendingExtractionTenants: (
    store: StoreWith<'consolidation'>,
  ) => Promise<DirtyTenantSnapshot['dirtyTenants']>;
  extractGraph: (
    store: StoreWith<'graphRebuild' | 'graphReads' | 'objects'>,
    tenantId: string,
  ) => ExtractResult | Promise<ExtractResult>;
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
  ctx: SleepContext,
  opts: SleepOptions,
  overrides: Partial<SleepPhases> = {},
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);
  const phases: SleepPhases = { ...DEFAULT_SLEEP_PHASES, ...overrides };

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
  ctx: SleepContext,
  opts: SleepOptions,
  phases: SleepPhases,
  counts: SleepCounts,
): Promise<SleepResult> {
  const dryRun = Boolean(opts.dryRun);
  const snapshot = await snapshotDirtyTenants(ctx, phases, dryRun);
  const { result, pages } = await runCorePhases(ctx, phases, dryRun, counts);

  if (dryRun) return result;

  if (!opts.noShare) await shareOnSleep(ctx, phases, result);

  counts.ambient = await summarizeAmbient(ctx, phases, result, pages);

  await drainGraphQueue(ctx, phases, snapshot, result);
  return result;
}

interface CorePhasesRun {
  readonly result: SleepResult;
  readonly pages: () => AsyncIterable<MemoryEntry[]>;
}

async function runCorePhases(
  ctx: SleepContext,
  phases: SleepPhases,
  dryRun: boolean,
  counts: SleepCounts,
): Promise<CorePhasesRun> {
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

  const pages = (): AsyncIterable<MemoryEntry[]> => entryPages(store, phases.pageSize);

  const actor = ctx.actor.subject;
  const dedupResult = await phases.deduplicateStore(store, { dryRun, actor, pages: pages() });
  counts.dedup = dedupResult.removed;
  if (dedupResult.removed > 0) result.deduped = dedupSummary(dedupResult);

  const auditOptions = { dryRun, consolidateResult, dedupResult, result, pages };
  counts.auditDeleted = await runQualityAudit(ctx, phases, auditOptions);
  return { result, pages };
}

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

async function* entryPages(
  store: StoreWith<'consolidation'>,
  limit: number,
): AsyncGenerator<MemoryEntry[]> {
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
  readonly result: SleepResult;
  readonly pages: () => AsyncIterable<MemoryEntry[]>;
}

async function runQualityAudit(
  ctx: SleepContext,
  phases: SleepPhases,
  options: QualityAuditOptions,
): Promise<number> {
  const { dryRun, consolidateResult, dedupResult, result, pages } = options;
  const wouldGo = dryRun
    ? [...(consolidateResult.removedIds ?? []), ...dedupResult.pairs.map((p) => p.removed)]
    : [];
  const planned = new Set(wouldGo);
  const issues: AuditIssue[] = [];
  for await (const page of pages()) {
    const rows = page.filter((e) => !planned.has(e.id));
    const backing = await ctx.store.auditMaintenance.objectBackedAmong(rows.map((e) => e.id));
    issues.push(...phases.auditMemories(rows, backing).issues);
  }
  if (issues.length === 0) return 0;
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const gone = dryRun
    ? errors.map((issue) => issue.memoryId)
    : await auditRemoveErrors(ctx, 'sleep-audit', errors);
  if (gone.length > 0 || warnings.length > 0) {
    result.audit = {
      errorsRemoved: gone.length,
      warningCount: warnings.length,
    };
  }
  return gone.length;
}

async function shareOnSleep(
  ctx: ContextWith<SleepGroup, 'sharing' | 'folderFiles'>,
  phases: SleepPhases,
  result: SleepResult,
): Promise<void> {
  const target = globalTargetOf(ctx);
  const { store } = ctx;
  const { sharing, folderFiles } = store;
  if (
    !ctx.config.autoShareOnSleep ||
    target === undefined ||
    sharing === undefined ||
    folderFiles === undefined
  ) {
    return;
  }
  const autoShareStats = { secretSkipped: 0, rejectedSkipped: 0 };
  const shared = await withDetached(ctx, (detached) =>
    phases.autoShare(
      {
        store: {
          sharing,
          folderFiles,
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

async function summarizeAmbient(
  ctx: Context,
  phases: SleepPhases,
  result: SleepResult,
  pages: () => AsyncIterable<MemoryEntry[]>,
): Promise<number> {
  if (!ctx.config.ambient.enabled) return 0;
  const now = ctx.infra.clock();
  const rules = strengthOf(ctx);
  const tallies = tallyAmbientEntries([], now, rules);
  for await (const page of pages()) {
    foldAmbientRows(
      tallies,
      page.filter((e) => !isSuperseded(e)),
      now,
      rules,
    );
  }
  if (tallies.total === 0) return 0;
  result.ambient = phases.computeAmbientState(tallies);
  return result.ambient.totalMemories;
}

async function drainGraphQueue(
  ctx: SleepContext,
  phases: SleepPhases,
  snapshot: DirtyTenantSnapshot,
  result: SleepResult,
): Promise<void> {
  try {
    if (snapshot.error) {
      result.events = [
        ...(result.events ?? []),
        { kind: 'graphSnapshotFailed', message: snapshot.error },
      ];
    }
    const rebuilt: GraphTotals = { tenants: 0, entities: 0, relations: 0 };
    for (const { tenantId, maxPendingId } of snapshot.dirtyTenants) {
      await rebuildDirtyTenant(ctx, { phases, dirty: { tenantId, maxPendingId }, rebuilt, result });
    }
    if (rebuilt.tenants > 0) {
      result.graph = rebuilt;
    }
  } catch (graphErr) {
    log.warn(`sleep: graph drain phase failed: ${errorMessage(graphErr)}`, errorFields(graphErr));
    result.events = [
      ...(result.events ?? []),
      { kind: 'graphDrainFailed', message: errorMessage(graphErr) },
    ];
  }
}

type GraphTotals = NonNullable<SleepResult['graph']>;

interface RebuildDirtyTenantOptions {
  readonly phases: SleepPhases;
  readonly dirty: DirtyTenantSnapshot['dirtyTenants'][number];
  readonly rebuilt: GraphTotals;
  readonly result: SleepResult;
}

async function rebuildDirtyTenant(
  ctx: SleepContext,
  { phases, dirty, rebuilt, result }: RebuildDirtyTenantOptions,
): Promise<void> {
  try {
    const ext = await phases.extractGraph(ctx.store, dirty.tenantId);
    rebuilt.tenants += 1;
    rebuilt.entities += ext.entities;
    rebuilt.relations += ext.relations;
    if (ext.skipped) {
      result.events = [
        ...(result.events ?? []),
        { kind: 'graphStaleOpsSkipped', count: ext.skipped },
      ];
    }
    await ctx.store.consolidation.markGraphDrained(dirty.tenantId, dirty.maxPendingId);
  } catch (tenantErr) {
    log.warn(
      `sleep: graph extract failed for tenant ${dirty.tenantId}, left pending: ${errorMessage(tenantErr)}`,
      errorFields(tenantErr),
    );
    result.events = [
      ...(result.events ?? []),
      { kind: 'graphExtractFailed', message: errorMessage(tenantErr) },
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

interface EmitSleepAuditOptions {
  readonly opts: SleepOptions;
  readonly dryRun: boolean;
  readonly counts: SleepCounts;
  readonly phaseError: { thrown: unknown } | null;
}

async function emitSleepAudit(
  ctx: SleepContext,
  { opts, dryRun, counts, phaseError }: EmitSleepAuditOptions,
): Promise<void> {
  try {
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
    reportAuditWriteFailure('consolidate', auditErr);
  }
}
