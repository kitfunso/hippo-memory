import { MemoryEntry, calculateStrength } from '../memory.js';
import { detectSecret } from '../secret-detect.js';
import { rescueSet, rankNonPinnedByTenant, validateWeights, type MvRankInfo } from '../memory-value.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from '../memory-value-weights.js';
import type { ConsolidationResult, SleepRun } from './run.js';

export const DECAY_THRESHOLD = 0.05;

/** What the decay pass hands to the conflict check and the rescue audit at the end of the run. */
export interface DecayOutcome {
  rescuedIds: Set<string>;
  rescuedEntries: MemoryEntry[];
  rankById: Map<string, MvRankInfo>;
}

// A faded, unpinned, unrescued memory leaves active memory one of three
// ways. A raw receipt is append-only: trg_memories_raw_append_only aborts
// a DELETE, and with it this whole cycle's batch and every later sleep,
// so it stays where it is (stored strength refreshed) but sits out the
// rest of this cycle the way a deleted row would. Anything else goes
// dormant when config.dormant is on, and is deleted otherwise.
// Only called for rows `retirable` allows (never pinned, raw, kept for good or backing a first-class object).
function retireFaded(run: SleepRun, entry: MemoryEntry, strength: number): void {
  const { result } = run;
  const why = `(strength ${strength.toFixed(4)} < ${DECAY_THRESHOLD})`;
  // A faded secret is deleted, never kept dormant: keeping it would hold a
  // credential on disk that the user reasonably expects forgetting removed.
  if (run.config.dormant.enabled && !detectSecret(entry).flagged) {
    result.dormant++;
    result.details.push(`  💤 dormant ${entry.id} ${why}`);
    run.pendingDormant.push({ entry: { ...entry, strength }, strength, reason: 'decay', dormantAt: run.now.toISOString() });
    return;
  }
  result.removed++;
  result.details.push(`  🗑  removed ${entry.id} ${why}`);
  run.pendingDeletes.push(entry.id);
}

/** Keeps an entry with its live strength cached; only strength is a cached computation, confidence stays as stored. */
function keepSurvivor(run: SleepRun, entry: MemoryEntry, strength: number): MemoryEntry {
  const updated = { ...entry, strength };
  run.survivors.push(updated);
  if (!run.dryRun && strength !== entry.strength) {
    run.pendingWrites.push(updated);
  }
  run.result.decayed++;
  return updated;
}

// -------------------------------------------------------------------------
// 1. Decay pass
// -------------------------------------------------------------------------
// Memory-value flag OFF runs the single-phase loop below. Flag ON classifies every entry with ZERO commits,
// runs rescueSet per tenant, then commits; rescued entries stay full survivors for this cycle's later passes.
export function decayPass(run: SleepRun): DecayOutcome {
  if (run.config.memoryValue.enabled) return decayWithMemoryValue(run);
  for (const entry of run.all) {
    const strength = calculateStrength(entry, run.now, run.decayOpts);

    if (run.retirable(entry) && strength < DECAY_THRESHOLD) {
      retireFaded(run, entry, strength);
    } else {
      keepSurvivor(run, entry, strength);
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
      `  ⚠️ memory-value: skipped ${nonFiniteIds.length} entr${nonFiniteIds.length === 1 ? 'y' : 'ies'} ` +
      `with non-finite computed features (never rescued): ${nonFiniteIds.join(', ')}`,
    );
  }
}

function decayWithMemoryValue(run: SleepRun): DecayOutcome {
  const { all, now, result } = run;
  // Carried forward to logRun, where the mv_rescue audit rows are written: writing them here, before
  // batchWriteAndDelete, would assert rescues whose effects might never land if a later phase throws.
  const rescuedEntries: MemoryEntry[] = [];
  let rescuedIds: Set<string> = new Set();
  let rankById: Map<string, MvRankInfo> = new Map();

  // --- Phase 1: classify (zero commits) ---
  const condemned: MemoryEntry[] = [];
  const strengthById = new Map<string, number>();
  for (const entry of all) {
    const strength = calculateStrength(entry, now, run.decayOpts);
    strengthById.set(entry.id, strength);
    if (run.retirable(entry) && strength < DECAY_THRESHOLD) {
      condemned.push(entry);
    }
  }

  // --- Phase 2a: rescue decision (pure compute) ---
  // Runs under --dry-run too (only the pendingDeletes flush and the audit write in
  // logRun stay !dryRun-gated), so the preview matches what a
  // real run would decide.
  const condemnedIds = new Set(condemned.map((e) => e.id));
  // Fail-loud must not depend on condemnation traffic: validate the frozen weights even when nothing is condemned.
  validateWeights();
  if (condemnedIds.size > 0) {
    // Rank per tenant ONCE: rankById feeds both rescueSet (via precomputedRanks) and the detail/audit
    // context below, so the whole-store ranking runs once per sleep and only when something is condemned.
    rankById = rankNonPinnedByTenant(all, now);
    rescuedIds = rescueSet(all, condemnedIds, now, { weights: MEMORY_VALUE_WEIGHTS, digest: SOURCE_ARTIFACT_SHA256, precomputedRanks: rankById });
    reportNonFiniteScores(result, rankById);
  }

  // --- Phase 2b: commit, one pass over `all` in ITS ORIGINAL ORDER ---
  // Rescued entries appended at the tail would be starved by order-sensitive passes like extraction's slice(0,20).
  for (const entry of all) {
    const strength = strengthById.get(entry.id)!;
    if (run.retirable(entry) && strength < DECAY_THRESHOLD) {
      if (rescuedIds.has(entry.id)) {
        // Rescued: standard survivor stored-strength refresh.
        // Confidence is left alone here: it is an epistemic tier, not a
        // cached computation, so resolveConfidence derives it on read.
        rescuedEntries.push(keepSurvivor(run, entry, strength));
        const rank = rankById.get(entry.id);
        const rankNote = rank
          ? ` - rescued (rank ${rank.rank}/${rank.totalNonPinned} in tenant ${rank.tenantId}, top ${rank.keepN})`
          : ' - rescued';
        result.details.push(`  🛟 ${entry.id} (strength ${strength.toFixed(4)} < ${DECAY_THRESHOLD})${rankNote}`);
      } else {
        retireFaded(run, entry, strength);
      }
    } else {
      keepSurvivor(run, entry, strength);
    }
  }
  return { rescuedIds, rescuedEntries, rankById };
}
