// Store-wide status reads: counts, stats, vector index state and the correction and provenance reports.

import type { PhysicsParticle } from '../core/physics.js';
import type { LegacyStats } from '../store/rows.js';
import type { StatusCounts } from '../store/candidates.js';
import { embeddingModelRequiresReindex } from '../store/embeddings/index.js';
import { loadStoredParticles, storedVectorSummary, type StoredVectorSummary } from '../store/vector-index.js';
import { buildCorrectionLatency, type CorrectionLatencyReport } from './correction-latency.js';
import { buildProvenanceCoverage, type ProvenanceCoverage } from './provenance-coverage.js';
import { requireHostAdmin, type Context } from './types.js';

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

/** Ids and dimension of the stored vectors. Every tenant, so the host admin only. */
export function vectorSummary(ctx: Context): StoredVectorSummary {
  requireHostAdmin(ctx, 'Reading every tenant');
  return storedVectorSummary(ctx.hippoRoot);
}

/**
 * Whether the stored vectors were built by a different model than `providerId`. Every tenant, so the host admin only.
 */
export function embeddingReindexNeeded(ctx: Context, providerId: string): boolean {
  requireHostAdmin(ctx, 'Reading every tenant');
  return embeddingModelRequiresReindex(ctx.hippoRoot, providerId);
}

/** Every stored physics particle. Every tenant, so the host admin only. */
export function storedParticles(ctx: Context): PhysicsParticle[] {
  requireHostAdmin(ctx, 'Reading every tenant');
  return loadStoredParticles(ctx.hippoRoot);
}

/** Correction latency over every superseded row in the store. Every tenant, so the host admin only. */
export async function correctionLatencyReport(ctx: Context): Promise<CorrectionLatencyReport> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return buildCorrectionLatency(await ctx.store.reports.correctionEntries());
}

/** Provenance coverage over every kind=raw row in the store. Every tenant, so the host admin only. */
export async function provenanceCoverageReport(ctx: Context): Promise<ProvenanceCoverage> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return buildProvenanceCoverage(await ctx.store.reports.rawEntries());
}
