import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import {
  PRODUCTION_STRENGTH,
  type StrengthModel,
  calculateStrength,
} from '../../base/memory/strength.js';
import {
  compareEntryIdentity,
  compareScoresDesc,
  type EntryIdentity,
} from '../../base/rank/compare.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from './memory-value-weights.js';
import { DAY_MS } from '../../base/util/time.js';

const MV_FEATURE_NAMES: ReadonlyArray<keyof MvFeatureVector> = [
  'ageDays',
  'halfLifeDays',
  'strength',
  'retrievalCount',
  'outcomePositive',
  'outcomeNegative',
  'outcomeRatio',
  'contentLength',
];

const RESCUE_BUDGET = 0.3;

const MIN_RESCUE_GROUP = 10;

export interface MvFeatureVector {
  ageDays: number;
  halfLifeDays: number;
  strength: number;
  retrievalCount: number;
  outcomePositive: number;
  outcomeNegative: number;
  outcomeRatio: number;
  contentLength: number;
}

function computeMvFeatures(entry: MemoryEntry, now: Date, rules: StrengthModel): MvFeatureVector {
  const ageDays = (now.getTime() - Date.parse(entry.created)) / DAY_MS;
  const pos = entry.outcomePositive ?? 0;
  const neg = entry.outcomeNegative ?? 0;
  return {
    ageDays,
    halfLifeDays: entry.halfLifeDays,
    strength: calculateStrength(entry, now, rules),
    retrievalCount: entry.retrievalCount,
    outcomePositive: pos,
    outcomeNegative: neg,
    outcomeRatio: (pos - neg) / (pos + neg + 1), // same formula as extract.mjs / calculateRewardFactor's ratio term
    contentLength: entry.content.length,
  };
}

function isNonEmptyDigestString(value: string): boolean {
  return (value?.length ?? 0) > 0;
}

/**
 * Throws on a malformed weight constant (wrong dims, non-finite weight, missing digest): flag-on
 * with a broken constant must throw, never act as flag-off. Parameterized (default: the frozen
 * singleton) so the throw paths are unit-testable. */
export function validateWeights(
  weights: Readonly<Record<string, number>> = MEMORY_VALUE_WEIGHTS,
  digest: string = SOURCE_ARTIFACT_SHA256,
): void {
  for (const key of MV_FEATURE_NAMES) {
    const v = weights[key];
    if (!Number.isFinite(v)) {
      throw new Error(
        `memory-value: weights constant is malformed — "${key}" is not a finite number ` +
          `(src/domain/consolidate/memory-value-weights.ts)`,
      );
    }
  }
  if (!isNonEmptyDigestString(digest)) {
    throw new Error(
      'memory-value: weights constant is malformed — SOURCE_ARTIFACT_SHA256 digest missing ' +
        '(src/domain/consolidate/memory-value-weights.ts)',
    );
  }
}

/**
 * Min-max normalize the 8 features over the given entries (constant -> 0), then score =
 * dot(weights, normalized); callers set the scope. An entry with any non-finite feature (NaN from a
 * malformed `created`) is excluded from normalization and scores -Infinity, so it can never be
 * rescued.
 */
export function scoreEntries(
  entries: MemoryEntry[],
  now: Date,
  weights: Readonly<Record<string, number>> = MEMORY_VALUE_WEIGHTS,
  model: StrengthModel = PRODUCTION_STRENGTH,
): Map<string, number> {
  return scoreFeatures(
    entries.map((e) => [e.id, computeMvFeatures(e, now, model)] as const),
    weights,
  );
}

type MvFeatures = readonly [string, MvFeatureVector];

function scoreFeatures(
  features: readonly MvFeatures[],
  weights: Readonly<Record<string, number>>,
): Map<string, number> {
  const raw = new Map(features);
  const nonFiniteIds = new Set<string>();
  for (const [id, nf] of features) {
    if (MV_FEATURE_NAMES.some((f) => !Number.isFinite(nf[f]))) nonFiniteIds.add(id);
  }
  const normContext = features.filter(([id]) => !nonFiniteIds.has(id));

  const minMax = new Map<keyof MvFeatureVector, { min: number; max: number }>();
  for (const f of MV_FEATURE_NAMES) {
    let min = Infinity;
    let max = -Infinity;
    for (const [id] of normContext) {
      const v = raw.get(id)![f];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    minMax.set(f, { min, max });
  }
  const norm = (f: keyof MvFeatureVector, v: number): number => {
    const { min, max } = minMax.get(f)!;
    return max === min ? 0 : (v - min) / (max - min);
  };

  const scores = new Map<string, number>();
  for (const [id] of features) {
    if (nonFiniteIds.has(id)) {
      scores.set(id, -Infinity);
      continue;
    }
    const nf = raw.get(id)!;
    let sum = 0;
    for (const f of MV_FEATURE_NAMES) sum += weights[f] * norm(f, nf[f]);
    scores.set(id, sum);
  }
  return scores;
}

/**
 * Per-entry rank context within its tenant's non-pinned candidate set: the basis both rescueSet and
 * the consolidate audit-row metadata read.
 */
export interface MvRankInfo {
  tenantId: string;
  score: number;
  rank: number;
  totalNonPinned: number;
  keepN: number;
}

export interface RankNonPinnedByTenantOptions {
  readonly entries: MemoryEntry[];
  readonly now: Date;
  readonly weights?: Readonly<Record<string, number>>;
  readonly digest?: string;
  readonly model?: StrengthModel;
}

/**
 * Group non-pinned entries by tenantId, score and rank each group independently, and return rank
 * context for every non-pinned entry; rescueSet and the consolidate audit rows share it so they
 * never compute the ranking differently. */
export function rankNonPinnedByTenant({
  entries,
  now,
  weights = MEMORY_VALUE_WEIGHTS,
  digest = SOURCE_ARTIFACT_SHA256,
  model = PRODUCTION_STRENGTH,
}: RankNonPinnedByTenantOptions): Map<string, MvRankInfo> {
  validateWeights(weights, digest);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const candidates = entries.filter((e) => !e.pinned).map((e) => mvCandidate(e, now, model));
  const result = new Map<string, MvRankInfo>();
  for (const group of tieGroups(candidates, () => true, weights)) {
    const held = group.tied.map((id) => identityOf(byId.get(id)!)).sort(compareEntryIdentity);
    placeTie(
      result,
      group,
      held.map((row, at) => [at, row.id] as const),
    );
  }
  return result;
}

/** A non-pinned row's id, tenant and features: all the ranking keeps of a row. */
export interface MvCandidate {
  readonly id: string;
  readonly tenantId: string;
  readonly features: MvFeatureVector;
}

/** The candidate `entry` ranks as; pinned entries never compete for rescue (never condemned). */
export function mvCandidate(entry: MemoryEntry, now: Date, rules: StrengthModel): MvCandidate {
  return {
    id: entry.id,
    tenantId: entry.tenantId ?? DEFAULT_TENANT_ID,
    features: computeMvFeatures(entry, now, rules),
  };
}

type TiePages = Iterable<readonly EntryIdentity[]> | AsyncIterable<readonly EntryIdentity[]>;

/** rankNonPinnedByTenant over compact candidates, for the `wanted` ids and every non-finite one;
 * `read` returns the rows of a score tie, which the shared tie-break orders by content. */
export async function rankCandidates(
  candidates: readonly MvCandidate[],
  wanted: (id: string) => boolean,
  read: (ids: readonly string[]) => TiePages,
  weights: Readonly<Record<string, number>> = MEMORY_VALUE_WEIGHTS,
): Promise<Map<string, MvRankInfo>> {
  const result = new Map<string, MvRankInfo>();
  for (const group of tieGroups(candidates, wanted, weights)) {
    placeTie(result, group, await tiePlaces(group.tied, group.want, read));
  }
  return result;
}

interface TieGroup {
  readonly tenantId: string;
  readonly score: number;
  readonly start: number;
  readonly tied: readonly string[];
  readonly total: number;
  readonly keepN: number;
  readonly want: (id: string) => boolean;
}

function tieGroups(
  candidates: readonly MvCandidate[],
  wanted: (id: string) => boolean,
  weights: Readonly<Record<string, number>>,
): TieGroup[] {
  const byTenant = new Map<string, MvFeatures[]>();
  for (const c of candidates) {
    const list = byTenant.get(c.tenantId);
    if (list) list.push([c.id, c.features]);
    else byTenant.set(c.tenantId, [[c.id, c.features]]);
  }
  const groups: TieGroup[] = [];
  for (const [tenantId, group] of byTenant) {
    const scores = scoreFeatures(group, weights);
    const ids = group
      .map(([id]) => id)
      .sort((a, b) => compareScoresDesc(scores.get(a)!, scores.get(b)!));
    const keepN =
      ids.length < MIN_RESCUE_GROUP
        ? 0
        : Math.min(ids.length, Math.ceil(RESCUE_BUDGET * ids.length));
    for (let start = 0, end = 0; start < ids.length; start = end) {
      const score = scores.get(ids[start])!;
      while (end < ids.length && scores.get(ids[end]) === score) end++;
      const want = (id: string): boolean => wanted(id) || score === -Infinity;
      const tied = ids.slice(start, end);
      if (tied.some(want)) {
        groups.push({ tenantId, score, start, tied, total: ids.length, keepN, want });
      }
    }
  }
  return groups;
}

function placeTie(
  result: Map<string, MvRankInfo>,
  { tenantId, score, start, total, keepN }: TieGroup,
  places: ReadonlyArray<readonly [number, string]>,
): void {
  for (const [at, id] of places) {
    result.set(id, { tenantId, score, rank: start + at + 1, totalNonPinned: total, keepN });
  }
}

async function tiePlaces(
  tied: readonly string[],
  wanted: (id: string) => boolean,
  read: (ids: readonly string[]) => TiePages,
): Promise<Array<readonly [number, string]>> {
  const mine = tied.filter(wanted);
  if (mine.length === 0) return [];
  if (tied.length === 1) return [[0, tied[0]]];
  const held: EntryIdentity[] = [];
  for await (const page of read(mine)) for (const row of page) held.push(identityOf(row));
  held.sort(compareEntryIdentity);
  const own = new Set(mine);
  const below = Array.from({ length: held.length + 1 }, () => 0);
  for await (const page of read(tied.filter((id) => !own.has(id)))) {
    for (const row of page) below[heldBelow(held, row)]++;
  }
  let others = 0;
  return held.map((row, i) => {
    others += below[i];
    return [i + others, row.id] as const;
  });
}

function identityOf({ content, leadIn, id, layer, tags, source }: EntryIdentity): EntryIdentity {
  return { content, leadIn, id, layer, tags, source };
}

function heldBelow(held: readonly EntryIdentity[], row: EntryIdentity): number {
  let [lo, hi] = [0, held.length];
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareEntryIdentity(held[mid], row) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface RescueSetOptions {
  readonly weights?: Readonly<Record<string, number>>;
  readonly digest?: string;
  readonly precomputedRanks?: Map<string, MvRankInfo>;
  readonly strength?: StrengthModel;
}

/**
 * Rescue decision: the subset of condemnedIds ranking in the top 30% of their tenant's non-pinned
 * set by learned score. Pass `precomputedRanks` to skip the internal ranking so the whole-store
 * pass runs once per sleep; `weights`/`digest` overrides exist for tests only.
 */
export function rescueSet(
  entries: MemoryEntry[],
  condemnedIds: Set<string>,
  now: Date,
  options: RescueSetOptions = {},
): Set<string> {
  const {
    weights = MEMORY_VALUE_WEIGHTS,
    digest = SOURCE_ARTIFACT_SHA256,
    precomputedRanks,
    strength,
  } = options;
  validateWeights(weights, digest);
  const ranked =
    precomputedRanks ?? rankNonPinnedByTenant({ entries, now, weights, digest, model: strength });
  const rescued = new Set<string>();
  for (const id of condemnedIds) {
    const info = ranked.get(id);
    if (info && info.rank <= info.keepN && Number.isFinite(info.score)) rescued.add(id);
  }
  return rescued;
}
