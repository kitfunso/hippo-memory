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
// LC2-E3 (opt-in, default off; docs/plans/2026-08-10-lc2-e3-mv-wiring.md):
// flag OFF keeps the single-phase loop below byte-identical to pre-E3
// behavior (pre-registered gate G2). Flag ON restructures into two phases:
// phase 1 classifies every entry (condemned vs survivor) with ZERO
// commits; phase 2 runs rescueSet over the per-tenant candidate groups,
// then commits — rescued entries get the standard survivor bookkeeping
// refresh (stored strength + effective confidence; no half-life edits, no
// rank-derived writes) and are pushed to survivors so they fully
// participate in this cycle's merge/physics/conflict passes; non-rescued
// condemned entries follow the existing pendingDeletes/result.removed/
// details path.
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
  // Carried forward to logRun, where the mv_rescue audit rows are actually
  // written (code-review fix: writing them here, before batchWriteAndDelete,
  // would assert rescues for a cycle whose effects might never land if a
  // later phase throws).
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
  // Fail-loud must not depend on condemnation traffic (round-2 code-review
  // P2-2): validate the frozen weights constant unconditionally, even on a
  // sleep with nothing condemned.
  validateWeights();
  if (condemnedIds.size > 0) {
    // Compute the per-tenant ranking ONCE (round-2 code-review P2-2):
    // rankById feeds both rescueSet's decision (via precomputedRanks,
    // skipping its own internal rankNonPinnedByTenant call) and the
    // detail/audit rank context below, so the whole-store ranking pass
    // runs a single time per sleep instead of twice, and only when there
    // is actually something condemned to rank against.
    rankById = rankNonPinnedByTenant(all, now);
    rescuedIds = rescueSet(all, condemnedIds, now, MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256, rankById);
    reportNonFiniteScores(result, rankById);
  }

  // --- Phase 2b: commit, one pass over `all` in ITS ORIGINAL ORDER ---
  // (review-round F4: rescued entries used to be appended at the tail of
  // survivors, systematically starving them in downstream order-sensitive
  // passes like extraction's slice(0,20) — a single pass over `all`
  // preserves flag-off's ordering semantics exactly.)
  for (const entry of all) {
    const strength = strengthById.get(entry.id)!;
    if (run.retirable(entry) && strength < DECAY_THRESHOLD) {
      if (rescuedIds.has(entry.id)) {
        // Rescued (D1): standard survivor stored-strength refresh (P2-1).
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
