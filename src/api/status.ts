// Store-wide status reads: counts, stats, vector index state and the correction and provenance
// reports.

import { isJsonObject, isJsonString } from '../base/util/json.js';
import type { LegacyStats } from '../base/ports/store/reports.js';
import type {
  CorrectionLink,
  RawProvenance,
  ReportPage,
  StatusCounts,
} from '../base/ports/store/reports.js';
import { READ_PAGE_ROWS } from '../base/util/pages.js';
import type { Reports } from '../base/ports/store/reports.js';
import { buildCorrectionLatency, type CorrectionLatencyReport } from './correction-latency.js';
import { buildProvenanceCoverage, type ProvenanceCoverage } from './provenance-coverage.js';
import { requireHostAdmin, strengthOf, type Context, type ContextWith } from './types.js';
import { memoryGet } from './memories/memories.js';
import type { ConfidenceLevel, MemoryEntry } from '../base/memory/entry.js';
import {
  calculateRewardFactor,
  calculateStrength,
  resolveConfidence,
} from '../base/memory/strength.js';
import type { StoredVectorSummary } from '../base/ports/store.js';
import { indexStep } from '../domain/search/embed-index-target.js';

export interface StoreStatus {
  stats: LegacyStats;
  counts: StatusCounts;
}

/** Lifetime stats and row counts for the whole store. Every tenant, so the host admin only. */
export async function storeStatus(
  ctx: ContextWith<'reports'>,
  now: Date,
  atRiskBelow: number,
): Promise<StoreStatus> {
  requireHostAdmin(ctx, 'Reading every tenant');
  const { reports } = ctx.store;
  return { stats: await reports.stats(), counts: await reports.statusCounts(now, atRiskBelow) };
}

/** The store's tallies for one tenant, with their mean strength: 0 when the tenant has no rows. */
export type TenantStatus = Readonly<
  Awaited<ReturnType<Reports['memoryStatus']>> & { avgStrength: number }
>;

/** The caller's tenant at a glance, read on one snapshot; its own rows only, so any actor. */
export async function tenantStatus(
  ctx: ContextWith<'reports'>,
  now: Date,
  atRiskBelow: number,
): Promise<TenantStatus> {
  const tallies = await ctx.store.reports.memoryStatus(ctx.tenantId, now, atRiskBelow);
  const avgStrength = tallies.total > 0 ? tallies.strengthSum / tallies.total : 0;
  return { ...tallies, avgStrength };
}

/** One memory with the values it has at a given time beside the ones it stores. */
export interface MemoryDetail {
  readonly entry: MemoryEntry;
  /** Under the context's strength model; `entry.strength` is the stored value. */
  readonly liveStrength: number;
  /** 'stale' once the row has aged out, else its stored confidence. */
  readonly confidence: ConfidenceLevel;
  readonly rewardFactor: number;
}

/** A memory in the caller's tenant read at `now`; null when the tenant holds no such row. */
export async function memoryDetail(
  ctx: Context,
  id: string,
  now: Date,
): Promise<MemoryDetail | null> {
  const entry = await memoryGet(ctx, id);
  if (!entry) return null;
  const model = strengthOf(ctx);
  return {
    entry,
    liveStrength: calculateStrength(entry, now, model),
    confidence: resolveConfidence(entry, now),
    rewardFactor: calculateRewardFactor(entry, model),
  };
}

/** ISO time of the latest sleep, or undefined when it never slept. Every tenant, so the host
 * admin only. */
export async function lastSleepAt(ctx: ContextWith<'reports'>): Promise<string | undefined> {
  requireHostAdmin(ctx, 'Reading every tenant');
  const runs = (await ctx.store.reports.stats()).consolidation_runs;
  const last = Array.isArray(runs) ? runs[runs.length - 1] : undefined;
  const at = isJsonObject(last) ? last['timestamp'] : undefined;
  return isJsonString(at) ? at : undefined;
}

/** Ids and dimension of the stored vectors. Every tenant, so the host admin only. */
export async function vectorSummary(
  ctx: ContextWith<'embeddingIndex'>,
): Promise<StoredVectorSummary> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return indexStep(ctx.store.embeddingIndex, { kind: 'summary' });
}

/**
 * Whether the stored vectors were built by a different model than `providerId`. Every tenant, so
 * the host admin only.
 */
export async function embeddingReindexNeeded(
  ctx: ContextWith<'embeddingIndex'>,
  providerId: string,
): Promise<boolean> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return indexStep(ctx.store.embeddingIndex, { kind: 'reindex', providerId });
}

/** Every correction link, one keyset page per store call. */
async function allCorrectionLinks(reports: Reports): Promise<CorrectionLink[]> {
  const links: CorrectionLink[] = [];
  for (let page: ReportPage = { limit: READ_PAGE_ROWS }; ;) {
    const read = await reports.correctionLinks(page);
    links.push(...read.links);
    if (read.next === null) return links;
    page = { limit: READ_PAGE_ROWS, after: read.next };
  }
}

/** The raw count and every raw row missing provenance, one keyset page per store call. */
async function allRawProvenance(reports: Reports): Promise<RawProvenance> {
  const gaps: RawProvenance['gaps'] = [];
  for (let page: ReportPage = { limit: READ_PAGE_ROWS }; ;) {
    const read = await reports.rawProvenance(page);
    gaps.push(...read.gaps);
    if (read.next === null) return { total: read.total, gaps };
    page = { limit: READ_PAGE_ROWS, after: read.next };
  }
}

/** Correction latency over every superseded row in the store. Every tenant, so the host admin
 * only. */
export async function correctionLatencyReport(
  ctx: ContextWith<'reports'>,
): Promise<CorrectionLatencyReport> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return buildCorrectionLatency(await allCorrectionLinks(ctx.store.reports));
}

/** Provenance coverage over every kind=raw row in the store. Every tenant, so the host admin
 * only. */
export async function provenanceCoverageReport(
  ctx: ContextWith<'reports'>,
): Promise<ProvenanceCoverage> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return buildProvenanceCoverage(await allRawProvenance(ctx.store.reports));
}
