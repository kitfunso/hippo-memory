// The in-memory Reports group: the tallies, listings and usage totals the status verbs print.
import {
  calculateStrength,
  confidenceFacets,
  Layer,
  type LossAversion,
  type MemoryEntry,
} from '../../base/memory/memory.js';
import { keysetPage } from '../../base/util/keyset.js';
import { ALL_TENANTS, type TenantId } from '../../base/util/tenant.js';
import { DAY_MS } from '../../base/util/time.js';
import type { Reports } from '../port-groups.js';
import type { CorrectionLink, RawProvenance, StatusCounts, StrengthTallies } from '../port/reports.js';
import type { EntryCursor, EntryPage } from '../port/types.js';
import { openConflictsIn } from './conflicts.js';
import { failureSummary } from './failure-log.js';
import { byBytes, counter, oldestFirst } from './rows.js';
import type { MemoryTables } from './tables.js';
import { tokenUseIn } from './token-ledger.js';

const CONSOLIDATION_RUNS_KEPT = 50;

/** Every tenant's rows in hippo.db's report order, so a float sum adds up in the same order. */
const inStoreOrder = (t: MemoryTables): MemoryEntry[] => [...t.entries.values()].sort(oldestFirst);

function strengthTallies(t: MemoryTables, rules: LossAversion, tenantId: string, now: Date, line: number) {
  const tallies: StrengthTallies = { total: 0, pinned: 0, errors: 0, strengthSum: 0, atRisk: 0 };
  for (const entry of inStoreOrder(t)) {
    if (entry.tenantId !== tenantId) continue;
    const strength = calculateStrength(entry, now, rules);
    tallies.total += 1;
    tallies.strengthSum += strength;
    if (entry.pinned) tallies.pinned += 1;
    if (entry.tags.includes('error')) tallies.errors += 1;
    if (!entry.pinned && strength < line) tallies.atRisk += 1;
  }
  return tallies;
}

function statusCounts(t: MemoryTables, rules: LossAversion, now: Date, line: number): StatusCounts {
  const byLayer = { [Layer.Buffer]: 0, [Layer.Episodic]: 0, [Layer.Semantic]: 0, [Layer.Trace]: 0 };
  const byConfidence = { verified: 0, observed: 0, inferred: 0, stale: 0 };
  const sums = { total: 0, strength: 0, pinned: 0, atRisk: 0, agedOut: 0 };
  for (const entry of inStoreOrder(t)) {
    const strength = calculateStrength(entry, now, rules);
    const facets = confidenceFacets(entry, now);
    sums.total += 1;
    sums.strength += strength;
    byLayer[entry.layer] += 1;
    byConfidence[facets.tier] += 1;
    if (entry.pinned) sums.pinned += 1;
    if (strength < line) sums.atRisk += 1;
    if (facets.agedOut) sums.agedOut += 1;
  }
  const { total, pinned, atRisk, agedOut } = sums;
  const embedded = [...t.vectors.keys()].filter((id) => t.entries.has(id)).length;
  const avgStrength = total > 0 ? sums.strength / total : 0;
  return {
    total,
    byLayer,
    byConfidence,
    pinned,
    atRisk,
    agedOut,
    avgStrength,
    openConflicts: openConflictsIn(t, ALL_TENANTS),
    embedded,
  };
}

/** Rows after `after` in (created, id) order; ALL_TENANTS pages every tenant's rows as one list. */
function entriesPageIn(
  t: MemoryTables,
  tenantId: TenantId,
  page: { readonly limit: number; readonly after?: EntryCursor },
): EntryPage {
  const { after } = page;
  const later = (e: MemoryEntry): boolean =>
    after === undefined ||
    byBytes(e.created, after.created) > 0 ||
    (e.created === after.created && byBytes(e.id, after.id) > 0);
  const rows = inStoreOrder(t).filter((e) => (tenantId === ALL_TENANTS || e.tenantId === tenantId) && later(e));
  const { rows: entries, next } = keysetPage(rows.slice(0, page.limit + 1), page.limit, (e) => ({
    created: e.created,
    id: e.id,
  }));
  return { entries: structuredClone(entries), next };
}

/** Each row of `rows` superseded by another of them, in `rows` order, with its successor's extraction source. */
export function correctionLinksOf(rows: readonly MemoryEntry[]): CorrectionLink[] {
  const byId = new Map(rows.map((e) => [e.id, e]));
  return rows.flatMap((old) => {
    const next = old.supersededBy ? byId.get(old.supersededBy) : undefined;
    if (!next) return [];
    const source = next.extractedFrom ? byId.get(next.extractedFrom) : undefined;
    return [{ oldId: old.id, newId: next.id, correctedAt: next.created, sourceCreated: source?.created ?? null }];
  });
}

/** The raw rows of `rows` and those missing an owner or an artifact ref, in `rows` order. */
export function rawProvenanceOf(rows: readonly MemoryEntry[]): RawProvenance {
  const raw = rows.filter((e) => e.kind === 'raw');
  const gaps = raw.filter((e) => !e.owner || !e.artifactRef);
  return {
    total: raw.length,
    gaps: gaps.map((e) => ({ id: e.id, owner: e.owner ?? null, artifactRef: e.artifactRef ?? null })),
  };
}

/** Created after the later of a day before `now` and the store's last sleep. */
function createdSinceLastSleepIn(t: MemoryTables, tenantId: string, now: Date): number {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const lastRun = t.sleepRuns.reduce((last, run) => (byBytes(run.timestamp, last) > 0 ? run.timestamp : last), '');
  const floor = byBytes(lastRun, dayAgo) > 0 ? lastRun : dayAgo;
  return [...t.entries.values()].filter((e) => e.tenantId === tenantId && byBytes(e.created, floor) > 0).length;
}

export function memoryReports(t: MemoryTables, rules: LossAversion): Reports {
  return {
    tokenUse: async (tenantId, sinceIso) => tokenUseIn(t, tenantId, sinceIso),
    failures: async (tenantId, sinceIso) => failureSummary(t, tenantId, sinceIso),
    memoryStatus: async (tenantId, now, atRiskBelow) => ({
      ...strengthTallies(t, rules, tenantId, now, atRiskBelow),
      openConflicts: openConflictsIn(t, tenantId),
    }),
    entriesPage: async (tenantId, page) => entriesPageIn(t, tenantId, page),
    countEntries: async () => t.entries.size,
    stats: async () => ({
      total_remembered: counter(t, 'total_remembered'),
      total_recalled: counter(t, 'total_recalled'),
      total_forgotten: counter(t, 'total_forgotten'),
      consolidation_runs: t.sleepRuns.slice(-CONSOLIDATION_RUNS_KEPT).map((run) => ({ ...run })),
    }),
    statusCounts: async (now, atRiskBelow) => statusCounts(t, rules, now, atRiskBelow),
    correctionLinks: async () => correctionLinksOf(inStoreOrder(t)),
    rawProvenance: async () => rawProvenanceOf(inStoreOrder(t)),
    createdSinceLastSleep: async (tenantId, now) => createdSinceLastSleepIn(t, tenantId, now),
  };
}
