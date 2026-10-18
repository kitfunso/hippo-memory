import { MemoryEntry, calculateStrength } from '../core/memory.js';
import { detectSecret } from '../util/secret-detect.js';
import { chunked } from '../util/chunked.js';
import {
  mvCandidate, rankCandidates, rescueSet, validateWeights, type MvCandidate, type MvRankInfo,
} from './memory-value.js';
import type { ConsolidationResult, SleepRun } from './run.js';
import { plural } from '../util/format.js';

const STRENGTH_DECIMALS = 4;

export const DECAY_THRESHOLD = 0.05;

/** What the decay pass hands to the conflict check and the rescue audit at the end of the run. */
export interface DecayOutcome {
  rescuedIds: Set<string>;
  rescuedEntries: Array<Pick<MemoryEntry, 'id' | 'tenant_id'>>;
  /** The rank of each condemned row and of each row whose score is not finite. */
  rankById: Map<string, MvRankInfo>;
}

// Leaving active memory: a raw receipt stays (the append-only trigger aborts DELETE for the whole batch; stored
// strength refreshed) but sits out this cycle;
// others go dormant when config.dormant is on, else are deleted. Only called for rows `retirable` allows.
function retireFaded(run: SleepRun, entry: MemoryEntry, strength: number): void {
  const { result } = run;
  const why = `(strength ${strength.toFixed(STRENGTH_DECIMALS)} < ${DECAY_THRESHOLD})`;
  // A faded secret is deleted, never kept dormant: keeping it would hold a
  // credential on disk that the user reasonably expects forgetting removed.
  if (run.config.dormant.enabled && !detectSecret(entry).flagged) {
    result.dormant++;
    result.details.push(`  💤 dormant ${entry.id} ${why}`);
    run.pendingDormant.push({
      entry: { ...entry, strength },
      strength,
      reason: 'decay',
      dormantAt: run.now.toISOString(),
    });
    return;
  }
  result.removed++;
  result.details.push(`  🗑  removed ${entry.id} ${why}`);
  run.pendingDeletes.push(entry.id);
}

/** Keeps an entry with its live strength cached; only strength is a cached computation, confidence stays as stored. */
function keepSurvivor(run: SleepRun, entry: Pick<MemoryEntry, 'id' | 'strength'>, strength: number): void {
  run.survivors.keep(entry.id, strength);
  if (!run.dryRun && strength !== entry.strength) run.pendingRefreshes.push({ id: entry.id, strength });
  run.result.decayed++;
}

/** Notes the row's DAG parent for the flush's family units, then returns its live strength. */
function liveStrength(run: SleepRun, entry: MemoryEntry): number {
  if (entry.dag_parent_id) run.parentOf.set(entry.id, entry.dag_parent_id);
  return calculateStrength(entry, run.now, run.decayOpts);
}

// 1. Decay pass. Memory-value flag OFF runs the single-phase loop below; ON classifies every entry with zero commits,
// runs rescueSet per tenant, then commits.
// Rescued entries stay full survivors for this cycle's later passes.
export function decayPass(run: SleepRun): DecayOutcome {
  if (run.config.memoryValue.enabled) return decayWithMemoryValue(run);
  for (const page of run.rows.pages()) {
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

// A non-finite feature (e.g. a malformed `created`) scores -Infinity and can never be
// rescued, so name those entries in one warning rather than leave it a silent NaN detail.
function reportNonFiniteScores(result: ConsolidationResult, rankById: Map<string, MvRankInfo>): void {
  const nonFiniteIds = [...rankById.entries()]
    .filter(([, info]) => !Number.isFinite(info.score))
    .map(([id]) => id);
  if (nonFiniteIds.length > 0) {
    result.details.push(
      `  ⚠️ memory-value: skipped ${plural(nonFiniteIds.length, 'entry', 'entries')} ` +
      `with non-finite computed features (never rescued): ${nonFiniteIds.join(', ')}`,
    );
  }
}

/** One loaded row's decay verdict: all the commit phase keeps of a row it does not retire. */
interface Verdict {
  id: string;
  tenant_id: string;
  strength: number;
  live: number;
  condemned: boolean;
}

// --- Phase 1: classify (zero commits) ---
function classifyByStrength(run: SleepRun) {
  const verdicts: Verdict[] = [];
  const candidates: MvCandidate[] = [];
  for (const page of run.rows.pages()) {
    for (const entry of page) {
      const live = liveStrength(run, entry);
      const condemned = run.retirable(entry) && live < DECAY_THRESHOLD;
      verdicts.push({ id: entry.id, tenant_id: entry.tenant_id, strength: entry.strength, live, condemned });
      if (!entry.pinned) candidates.push(mvCandidate(entry, run.now));
    }
  }
  return { verdicts, candidates };
}

function reportRescue(result: ConsolidationResult, id: string, strength: number, rank: MvRankInfo | undefined): void {
  const rankNote = rank
    ? ` - rescued (rank ${rank.rank}/${rank.totalNonPinned} in tenant ${rank.tenantId}, top ${rank.keepN})`
    : ' - rescued';
  result.details.push(
    `  🛟 ${id} (strength ${strength.toFixed(STRENGTH_DECIMALS)} < ${DECAY_THRESHOLD})${rankNote}`,
  );
}

function decayWithMemoryValue(run: SleepRun): DecayOutcome {
  const { verdicts, candidates } = classifyByStrength(run);
  const condemnedIds = new Set(verdicts.filter((v) => v.condemned).map((v) => v.id));
  // Phase 2a: rescue decision (pure compute); runs under --dry-run too (only the pendingDeletes flush and the logRun
  // audit write are !dryRun-gated).

  // Fail-loud must not depend on condemnation traffic: validate the frozen weights even when nothing is condemned.
  validateWeights();
  let rankById: Map<string, MvRankInfo> = new Map();
  let rescuedIds = new Set<string>();
  if (condemnedIds.size > 0) {
    // Ranks only the rows a rescue or the warning reads, so ranking a tenant holds no row's text but a tie's.
    rankById = rankCandidates(candidates, (id) => condemnedIds.has(id), (ids) => run.rows.pagesOf(ids));
    // The precomputed ranks are all rescueSet reads, so it is handed no rows.
    rescuedIds = rescueSet([], condemnedIds, run.now, { precomputedRanks: rankById });
    reportNonFiniteScores(run.result, rankById);
  }
  return { rescuedIds, rescuedEntries: commitVerdicts(run, verdicts, rescuedIds, rankById), rankById };
}

// --- Phase 2b: commit in run order ---
// Rescued entries appended at the tail would be starved by order-sensitive passes like extraction's slice(0,20).
function commitVerdicts(
  run: SleepRun,
  verdicts: readonly Verdict[],
  rescuedIds: ReadonlySet<string>,
  rankById: ReadonlyMap<string, MvRankInfo>,
): DecayOutcome['rescuedEntries'] {
  // Carried forward to logRun, where the mv_rescue audit rows are written: writing them here, before
  // batchWriteAndDelete, would assert rescues whose effects might never land if a later phase throws.
  const rescuedEntries: DecayOutcome['rescuedEntries'] = [];
  for (const page of chunked(verdicts, run.rows.pageRows)) {
    const faded = page.filter((v) => v.condemned && !rescuedIds.has(v.id)).map((v) => v.id);
    const fadedRows = new Map(run.rows.read(faded).map((row) => [row.id, row]));
    for (const v of page) {
      if (!v.condemned) {
        keepSurvivor(run, v, v.live);
      } else if (rescuedIds.has(v.id)) {
        // Confidence is left alone: it is an epistemic tier resolveConfidence derives, not a cached computation.
        keepSurvivor(run, v, v.live);
        rescuedEntries.push({ id: v.id, tenant_id: v.tenant_id });
        reportRescue(run.result, v.id, v.live, rankById.get(v.id));
      } else {
        const row = fadedRows.get(v.id);
        if (row) retireFaded(run, row, v.live);
      }
    }
  }
  return rescuedEntries;
}
