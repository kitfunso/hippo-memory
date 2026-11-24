import { MemoryEntry } from '../../base/memory/entry.js';
import { calculateStrength, type DecayBasis } from '../../base/memory/strength.js';
import { detectSecret } from '../../base/util/secret-detect.js';
import { chunked } from '../../base/util/chunked.js';
import {
  mvCandidate,
  rankCandidates,
  rescueSet,
  validateWeights,
  type MvCandidate,
  type MvRankInfo,
} from './memory-value.js';
import type { ConsolidationResult, SleepRun } from './run.js';
import { DAY_MS } from '../../base/util/time.js';
import type { SleepStart } from '../../base/ports/store/consolidation.js';

export const DECAY_THRESHOLD = 0.05;

/** The sleep count (the stored one, else the runs on record) and the average days between the
 * recent runs, 0 with fewer than two, which session-based and adaptive decay read. */
export function sessionDecayContext({
  sleepCount,
  recentRuns,
}: Pick<SleepStart, 'sleepCount' | 'recentRuns'>): Required<
  Pick<DecayBasis, 'sleepCount' | 'avgSessionIntervalDays'>
> {
  const count = sleepCount || recentRuns.length;
  if (recentRuns.length < 2) return { sleepCount: count, avgSessionIntervalDays: 0 };
  const timestamps = recentRuns.map((at) => new Date(at).getTime()).reverse();
  let totalInterval = 0;
  for (let i = 1; i < timestamps.length; i++) totalInterval += timestamps[i] - timestamps[i - 1];
  const avgMs = totalInterval / (timestamps.length - 1);
  return { sleepCount: count, avgSessionIntervalDays: Math.max(0, avgMs / DAY_MS) };
}

/** What the decay pass hands to the conflict check and the rescue audit at the end of the run. */
export interface DecayOutcome {
  rescuedIds: Set<string>;
  rescuedEntries: Array<Pick<MemoryEntry, 'id' | 'tenantId'>>;
  rankById: Map<string, MvRankInfo>;
}

function retireFaded(run: SleepRun, entry: MemoryEntry, strength: number): void {
  const { result } = run;
  if (run.config.dormant.enabled && !detectSecret(entry).flagged) {
    result.dormant++;
    result.events.push({ kind: 'dormant', id: entry.id, strength, threshold: DECAY_THRESHOLD });
    run.pendingDormant.push({
      entry: { ...entry, strength },
      strength,
      reason: 'decay',
      dormantAt: run.now.toISOString(),
    });
    return;
  }
  result.removed++;
  result.events.push({ kind: 'removed', id: entry.id, strength, threshold: DECAY_THRESHOLD });
  run.pendingDeletes.push(entry.id);
}

function keepSurvivor(
  run: SleepRun,
  entry: Pick<MemoryEntry, 'id' | 'strength'>,
  strength: number,
): void {
  run.survivors.keep(entry.id, strength);
  if (!run.dryRun && strength !== entry.strength) {
    run.pendingRefreshes.push({ id: entry.id, strength });
  }
  run.result.decayed++;
}

function liveStrength(run: SleepRun, entry: MemoryEntry): number {
  if (entry.dagParentId) run.parentOf.set(entry.id, entry.dagParentId);
  return calculateStrength(entry, run.now, run.strength, run.decayOpts);
}

export async function decayPass(run: SleepRun): Promise<DecayOutcome> {
  if (run.config.memoryValue.enabled) return decayWithMemoryValue(run);
  for await (const page of run.rows.pages()) {
    for (const entry of page) {
      const strength = liveStrength(run, entry);
      if (run.retirable(entry) && strength < DECAY_THRESHOLD) {
        retireFaded(run, entry, strength);
      } else {
        keepSurvivor(run, entry, strength);
      }
    }
  }
  return { rescuedIds: new Set(), rescuedEntries: [], rankById: new Map() };
}

function reportNonFiniteScores(
  result: ConsolidationResult,
  rankById: Map<string, MvRankInfo>,
): void {
  const nonFiniteIds = [...rankById.entries()]
    .filter(([, info]) => !Number.isFinite(info.score))
    .map(([id]) => id);
  if (nonFiniteIds.length > 0) {
    result.events.push({ kind: 'nonFiniteScores', ids: nonFiniteIds });
  }
}

interface Verdict {
  id: string;
  tenant_id: string;
  strength: number;
  live: number;
  condemned: boolean;
}

async function classifyByStrength(run: SleepRun) {
  const verdicts: Verdict[] = [];
  const candidates: MvCandidate[] = [];
  const mvRules = run.strength;
  for await (const page of run.rows.pages()) {
    for (const entry of page) {
      const live = liveStrength(run, entry);
      const condemned = run.retirable(entry) && live < DECAY_THRESHOLD;
      verdicts.push({
        id: entry.id,
        tenant_id: entry.tenantId,
        strength: entry.strength,
        live,
        condemned,
      });
      if (!entry.pinned) candidates.push(mvCandidate(entry, run.now, mvRules));
    }
  }
  return { verdicts, candidates };
}

function reportRescue(
  result: ConsolidationResult,
  id: string,
  strength: number,
  rank: MvRankInfo | undefined,
): void {
  result.events.push({ kind: 'rescued', id, strength, threshold: DECAY_THRESHOLD, rank });
}

async function decayWithMemoryValue(run: SleepRun): Promise<DecayOutcome> {
  const { verdicts, candidates } = await classifyByStrength(run);
  const condemnedIds = new Set(verdicts.filter((v) => v.condemned).map((v) => v.id));
  validateWeights();
  let rankById: Map<string, MvRankInfo> = new Map();
  let rescuedIds = new Set<string>();
  if (condemnedIds.size > 0) {
    rankById = await rankCandidates(
      candidates,
      (id) => condemnedIds.has(id),
      (ids) => run.rows.pagesOf(ids),
    );
    rescuedIds = rescueSet([], condemnedIds, run.now, { precomputedRanks: rankById });
    reportNonFiniteScores(run.result, rankById);
  }
  return {
    rescuedIds,
    rescuedEntries: await commitVerdicts(run, verdicts, rescuedIds, rankById),
    rankById,
  };
}

async function commitVerdicts(
  run: SleepRun,
  verdicts: readonly Verdict[],
  rescuedIds: ReadonlySet<string>,
  rankById: ReadonlyMap<string, MvRankInfo>,
): Promise<DecayOutcome['rescuedEntries']> {
  const rescuedEntries: DecayOutcome['rescuedEntries'] = [];
  for (const page of chunked(verdicts, run.rows.pageRows)) {
    const faded = page.filter((v) => v.condemned && !rescuedIds.has(v.id)).map((v) => v.id);
    const fadedRows = new Map((await run.rows.read(faded)).map((row) => [row.id, row]));
    for (const v of page) {
      if (!v.condemned) {
        keepSurvivor(run, v, v.live);
      } else if (rescuedIds.has(v.id)) {
        keepSurvivor(run, v, v.live);
        rescuedEntries.push({ id: v.id, tenantId: v.tenant_id });
        reportRescue(run.result, v.id, v.live, rankById.get(v.id));
      } else {
        const row = fadedRows.get(v.id);
        if (row) retireFaded(run, row, v.live);
      }
    }
  }
  return rescuedEntries;
}
