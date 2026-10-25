// Store-wide status reads: counts, stats, vector index state and the correction and provenance reports.

import { isJsonObject, isJsonString } from '../base/util/json.js';
import type { LegacyStats } from '../base/ports/store/reports.js';
import type { CorrectionLink, RawProvenance, ReportPage, StatusCounts } from '../base/ports/store/reports.js';
import { READ_PAGE_ROWS } from '../base/util/pages.js';
import type { Reports } from '../base/ports/store/reports.js';
import { buildCorrectionLatency, type CorrectionLatencyReport } from './correction-latency.js';
import { buildProvenanceCoverage, type ProvenanceCoverage } from './provenance-coverage.js';
import { requireHostAdmin, type Context, type ContextWith } from './types.js';
import type { ParticleStats, StoredVectorSummary } from '../base/ports/store.js';
import { indexStep } from '../domain/search/embed-memories.js';

export interface StoreStatus {
  stats: LegacyStats;
  counts: StatusCounts;
}

/** Lifetime stats and row counts for the whole store. Every tenant, so the host admin only. */
export async function storeStatus(ctx: Context, now: Date, atRiskBelow: number): Promise<StoreStatus> {
  requireHostAdmin(ctx, 'Reading every tenant');
  const { reports } = ctx.store;
  return { stats: await reports.stats(), counts: await reports.statusCounts(now, atRiskBelow) };
}

/** ISO time of the latest sleep, or undefined when it never slept. Every tenant, so the host admin only. */
export async function lastSleepAt(ctx: Context): Promise<string | undefined> {
  requireHostAdmin(ctx, 'Reading every tenant');
  const runs = (await ctx.store.reports.stats()).consolidation_runs;
  const last = Array.isArray(runs) ? runs[runs.length - 1] : undefined;
  const at = isJsonObject(last) ? last['timestamp'] : undefined;
  return isJsonString(at) ? at : undefined;
}

/** Ids and dimension of the stored vectors. Every tenant, so the host admin only. */
export async function vectorSummary(ctx: ContextWith<'embeddingIndex'>): Promise<StoredVectorSummary> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return indexStep(ctx.store.embeddingIndex, { kind: 'summary' });
}

/**
 * Whether the stored vectors were built by a different model than `providerId`. Every tenant, so the host admin only.
 */
export async function embeddingReindexNeeded(ctx: ContextWith<'embeddingIndex'>, providerId: string): Promise<boolean> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return indexStep(ctx.store.embeddingIndex, { kind: 'reindex', providerId });
}

/** The stored particles' count and mean speed, and the particles while at most `fullUpTo`. Every tenant, so the host
 * admin only. */
export async function storedParticleStats(
  ctx: ContextWith<'embeddingIndex'>,
  fullUpTo: number,
): Promise<ParticleStats> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return indexStep(ctx.store.embeddingIndex, { kind: 'particles', fullUpTo });
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

/** Correction latency over every superseded row in the store. Every tenant, so the host admin only. */
export async function correctionLatencyReport(ctx: Context): Promise<CorrectionLatencyReport> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return buildCorrectionLatency(await allCorrectionLinks(ctx.store.reports));
}

/** Provenance coverage over every kind=raw row in the store. Every tenant, so the host admin only. */
export async function provenanceCoverageReport(ctx: Context): Promise<ProvenanceCoverage> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return buildProvenanceCoverage(await allRawProvenance(ctx.store.reports));
}
