/** Z0 analyzer, part 2 of 6: G4 counts, drops, abandoned runs, retry and G1 voids, G3 leaks, pairing.
 * Order is the plan's: counts are taken before any removal, so a void or leak cannot hide a crash cluster.
 * Every removal is paired: a cell or (sequence, seed) leaves every arm at once. */

import { TWO_SEED_ARMS, cellKey, isInvalid, isLeak, positionKey, resolvedOf, runKey } from './z0-records.mjs';

export const RETRY_VOID = 'retry-unrestored';
// Their only carried surface is the instruction files E1 restores before a retry.
const RESTORED_ARMS = new Set(['A0', 'A4']);

const label = (sequence, seed) => `${sequence} seed ${seed}`;

/** Step 0: per arm, planned cells, records, crashes other than leaks, missing cells and originating voids. */
export function countCells(records, planCells) {
  const arms = [...new Set(planCells.map((c) => c.arm))].sort();
  const present = new Set(records.map(cellKey));
  const counts = {};
  for (const arm of arms) {
    const mine = records.filter((r) => r.arm === arm);
    const voidReasons = {};
    for (const r of mine) if (r.void !== null) voidReasons[r.void] = (voidReasons[r.void] ?? 0) + 1;
    const planned = planCells.filter((c) => c.arm === arm);
    counts[arm] = {
      planned: planned.length,
      records: mine.length,
      invalid: mine.filter(isInvalid).length,
      missing: planned.filter((c) => !present.has(cellKey(c))).length,
      voids: mine.filter((r) => r.void !== null).length,
      voidReasons,
    };
  }
  return { arms, counts };
}

/** Step 1: drop flipped and listed lessons and listed families from every arm, then recompute `resolved`. */
export function applyDrops(records, grading, dropList) {
  const lessons = new Set([...(grading?.flippedLessons ?? []), ...(dropList?.droppedLessons ?? [])]);
  const families = new Set(dropList?.droppedFamilies ?? []);
  return records
    .filter((r) => r.familyId === null || !families.has(r.familyId))
    .map((r) => {
      const kept = { ...r, lessons: r.lessons.filter((l) => !lessons.has(l.lessonId)) };
      kept.resolved = resolvedOf(kept);
      return kept;
    });
}

/** Step 2: a (sequence, seed) is abandoned when any planned arm's last planned position has no record. */
export function abandonedRuns(records, planCells) {
  const present = new Set(records.map(cellKey));
  const last = new Map();
  for (const c of planCells) {
    const k = `${runKey(c.sequence, c.seed)}/${c.arm}`;
    if ((last.get(k)?.position ?? -1) < c.position) last.set(k, c);
  }
  const out = new Map();
  for (const c of last.values()) if (!present.has(cellKey(c))) out.set(runKey(c.sequence, c.seed), label(c.sequence, c.seed));
  return out;
}

/** Step 3: an unrestored retry voids its position and the rest of its (sequence, seed), since the cut-off attempt's memory carries. */
export function retryVoids(records) {
  const from = new Map();
  for (const r of records) {
    if (!(r.limitRetries > 0) || RESTORED_ARMS.has(r.arm) || r.surfaceRestored === true) continue;
    const k = runKey(r.sequence, r.seed);
    from.set(k, Math.min(from.get(k) ?? Infinity, r.position));
  }
  return from;
}

/** Filters 0-6 in the plan's order: the step-0 counts, the lists the report prints, and `scored`, the
 * records every statistic reads. */
export function filterRecords(records, planCells, { grading = null, dropList = null } = {}) {
  const { arms, counts } = countCells(records, planCells);
  const plannedRuns = new Set(planCells.map((c) => runKey(c.sequence, c.seed)));
  const abandoned = abandonedRuns(records, planCells);
  const live = records.filter((r) => !abandoned.has(runKey(r.sequence, r.seed)));
  const retryFrom = retryVoids(live);
  const voided = new Set(live.filter((r) => r.void !== null).map(positionKey));
  const retried = (r) => r.position >= (retryFrom.get(runKey(r.sequence, r.seed)) ?? Infinity);
  const leaked = new Map(records.filter(isLeak).map((r) => [runKey(r.sequence, r.seed), label(r.sequence, r.seed)]));
  const liveCells = planCells.filter((c) => !abandoned.has(runKey(c.sequence, c.seed)));
  const livePositions = new Set(liveCells.map(positionKey));
  const retryVoided = new Set(liveCells.filter(retried).map(positionKey)).size;
  const scored = applyDrops(live, grading, dropList).filter((r) => {
    const run = runKey(r.sequence, r.seed);
    return !leaked.has(run) && !voided.has(positionKey(r)) && !retried(r) && !isInvalid(r) && !isLeak(r);
  });
  const carryUnion = new Set(records.filter((r) => r.carryUnionMerges > 0).map((r) => runKey(r.sequence, r.seed)));
  return {
    arms,
    counts,
    plannedRuns: plannedRuns.size,
    abandoned: [...abandoned.values()].sort(),
    leaked: [...leaked.values()].sort(),
    retryVoided: { positions: retryVoided, share: livePositions.size === 0 ? 0 : retryVoided / livePositions.size },
    carryUnion,
    scored,
  };
}

/** Step 7: (sequence, seed, position) pairs where both arms have a scoreable record; seeds 1-2 when a two-seed arm is in (124). */
export function pairTasks(records, armT, armC) {
  const twoSeed = TWO_SEED_ARMS.has(armT) || TWO_SEED_ARMS.has(armC);
  const slots = new Map();
  for (const r of records) {
    if ((r.arm !== armT && r.arm !== armC) || (twoSeed && r.seed > 2) || isInvalid(r) || isLeak(r)) continue;
    const k = positionKey(r);
    const slot = slots.get(k) ?? { t: null, c: null };
    slot[r.arm === armT ? 't' : 'c'] = r;
    slots.set(k, slot);
  }
  return [...slots.values()].filter((s) => s.t !== null && s.c !== null);
}
