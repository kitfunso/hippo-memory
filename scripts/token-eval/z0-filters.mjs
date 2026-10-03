/** Z0 analyzer, part 2 of 6: G4 counts, abandoned tails, drops, retry and G1 voids, G3 leaks, untaught applies, pairing.
 * Order is the plan's: counts are taken before any removal, so a void or leak cannot hide a crash cluster.
 * Every removal is paired: a cell or (sequence, seed) leaves every arm at once. */

import { TWO_SEED_ARMS, armRunKey, cellKey, isInvalid, isLeak, positionKey, resolvedOf, runKey, untaughtApplies } from './z0-records.mjs';

// Their only carried surface is the instruction files E1 restores before a retry.
const RESTORED_ARMS = new Set(['A0', 'A4']);

const label = (sequence, seed) => `${sequence} seed ${seed}`;

/** Per (sequence, seed, arm), the planned cells after its last record: what a run that stops partway leaves (114). */
export function abandonedTail(records, planCells) {
  const last = new Map();
  for (const r of records) last.set(armRunKey(r), Math.max(last.get(armRunKey(r)) ?? -1, r.position));
  return planCells.filter((c) => c.position > (last.get(armRunKey(c)) ?? -1));
}

/** Step 0: per arm, planned cells, records, crashes other than leaks, missing cells outside a tail, tail cells and originating voids. */
export function countCells(records, planCells, tail = abandonedTail(records, planCells)) {
  const arms = [...new Set(planCells.map((c) => c.arm))].sort();
  const present = new Set(records.map(cellKey));
  const tailCells = new Set(tail.map(cellKey));
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
      missing: planned.filter((c) => !present.has(cellKey(c)) && !tailCells.has(cellKey(c))).length,
      abandoned: planned.filter((c) => tailCells.has(cellKey(c))).length,
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

/** Step 2: a (sequence, seed) with any arm's tail is abandoned (114). */
export function abandonedRuns(records, planCells, tail = abandonedTail(records, planCells)) {
  return new Map(tail.map((c) => [runKey(c.sequence, c.seed), label(c.sequence, c.seed)]));
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

const canonical = (a, b) => a.sequence.localeCompare(b.sequence) || a.seed - b.seed || a.position - b.position || a.arm.localeCompare(b.arm);

/** Filters 0-6 in the plan's order: the step-0 counts, the lists the report prints, and `scored`, the
 * records every statistic reads, in canonical order so argv order cannot move a resample.
 * Abandoned runs are listed, not removed: analyzeZ0 stops on any abandoned run before gates or statistics (114). */
export function filterRecords(records, planCells, { grading = null, dropList = null } = {}) {
  const tail = abandonedTail(records, planCells);
  const { arms, counts } = countCells(records, planCells, tail);
  const plannedRuns = new Set(planCells.map((c) => runKey(c.sequence, c.seed)));
  const abandoned = abandonedRuns(records, planCells, tail);
  const retryFrom = retryVoids(records);
  const voided = new Set(records.filter((r) => r.void !== null).map(positionKey));
  const untaught = new Set(untaughtApplies(records, planCells).map(positionKey));
  const retried = (r) => r.position >= (retryFrom.get(runKey(r.sequence, r.seed)) ?? Infinity);
  const leaked = new Map(records.filter(isLeak).map((r) => [runKey(r.sequence, r.seed), label(r.sequence, r.seed)]));
  const plannedPositions = new Set(planCells.map(positionKey));
  const retryVoided = new Set(planCells.filter(retried).map(positionKey)).size;
  const scored = applyDrops(records, grading, dropList).filter((r) => {
    const run = runKey(r.sequence, r.seed);
    return !leaked.has(run) && !voided.has(positionKey(r)) && !retried(r) && !untaught.has(positionKey(r)) && !isInvalid(r) && !isLeak(r);
  });
  const carryUnion = new Set(records.filter((r) => r.carryUnionMerges > 0).map((r) => runKey(r.sequence, r.seed)));
  return {
    arms,
    // From the plan: a planned set with no records is missing or abandoned data, never "not planned".
    sets: [...new Set(planCells.map((c) => c.set))].sort(),
    counts,
    plannedRuns: plannedRuns.size,
    abandoned: [...abandoned.values()].sort(),
    leaked: [...leaked.values()].sort(),
    retryVoided: { positions: retryVoided, share: plannedPositions.size === 0 ? 0 : retryVoided / plannedPositions.size },
    untaughtApplyDrops: untaught.size,
    carryUnion,
    scored: scored.sort(canonical),
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
  const pairs = [...slots.values()].filter((s) => s.t !== null && s.c !== null);
  for (const { t, c } of pairs) {
    if (t.taskId !== c.taskId) throw new Error(`${positionKey(t)}: ${armT} ran task ${t.taskId} and ${armC} ran ${c.taskId}; a pair must share its task`);
  }
  return pairs;
}
