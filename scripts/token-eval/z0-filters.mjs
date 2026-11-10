/** Z0 analyzer, part 2 of 6: G4 counts, abandoned tails, drops, retry, off-pin and G1 voids, G3 leaks, untaught applies, pairing.
 * Order is the plan's: counts are taken before any removal, so a void or leak cannot hide a crash cluster.
 * Every removal is paired: a cell or (sequence, seed) leaves every arm at once. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DESIGNS, RESTORED_ARMS, TWO_SEED_ARMS, designName } from './arms.mjs';
import { OFFPIN_SCHEMA, armRunKey, cellKey, isInvalid, isLeak, isString, locationOf, positionKey, resolvedOf, runKey, untaughtApplies, validateCorpus } from './z0-records.mjs';

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
  /** @type {Record<string, {planned: number, records: number, invalid: number, missing: number, abandoned: number, voids: number, voidReasons: Record<string, number>}>} */
  const counts = {};
  for (const arm of arms) {
    const mine = records.filter((r) => r.arm === arm);
    /** @type {Record<string, number>} */
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

const isCount = (v) => Number.isInteger(v) && v >= 0;
const isName = (v) => isString(v) && v.length > 0;

/** An off-pin file's voids, each tagged with its file and index. `runHashes` are the sha256 of every runs file the read loads and are required:
 * a `runs` entry outside them stops the read, so a leaked run's void never voids its rerun, and voids with no `runs` entry are refused.
 * @param {string} file @param {{cwd?: string, runHashes: string[]}} options */
export function readVoids(file, { cwd = process.cwd(), runHashes } = {}) {
  if (!Array.isArray(runHashes)) throw new Error(`${file}: runHashes is required, the sha256 of each runs file the read loads`);
  const text = fs.readFileSync(path.resolve(cwd, file), 'utf8');
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not JSON (${e.message})`);
  }
  if (body === null || body === undefined || body.schema !== OFFPIN_SCHEMA) throw new Error(`${file}: schema must be "${OFFPIN_SCHEMA}"`);
  if (!Array.isArray(body.runs) || !body.runs.every((r) => r !== null && isName(r.dir) && isName(r.file) && isName(r.sha256))) throw new Error(`${file}: runs must be a list of { dir, file, sha256 }`);
  if (!Array.isArray(body.voids)) throw new Error(`${file}: voids must be a list of { sequence, seed, arm, position, sessionId, reason }`);
  if (body.voids.length > 0 && body.runs.length === 0) throw new Error(`${file}: it lists voids but its runs is empty; name the runs file the voids were written for`);
  const stray = body.runs.findIndex((r) => !runHashes.includes(r.sha256));
  if (stray >= 0) throw new Error(`${file}: runs[${stray}] (${body.runs[stray].file}, sha256 ${body.runs[stray].sha256}) is not a runs file this read loads; pass the runs file the off-pin file was written for`);
  return body.voids.map((v, index) => {
    const bad = [['sequence', isName(v?.sequence)], ['seed', Number.isInteger(v?.seed) && v.seed >= 1], ['arm', isName(v?.arm)], ['position', isCount(v?.position)],
      ['sessionId', v?.sessionId === null || isName(v?.sessionId)], ['reason', isName(v?.reason)]].find(([, ok]) => !ok);
    if (bad !== undefined) throw new Error(`${file} void ${index}: ${bad[0]} is missing or not valid`);
    return { ...v, file, index };
  });
}

/** Per (sequence, seed), the first position an off-pin void reaches: its own, and the rest of the run in every arm. */
function voidStarts(voids) {
  const from = new Map();
  for (const v of voids) from.set(runKey(v.sequence, v.seed), Math.min(from.get(runKey(v.sequence, v.seed)) ?? Infinity, v.position));
  return from;
}

/** The (sequence, seed, position)s of `planCells` the voids reach, and their share of all planned positions. */
export function offPinReach(voids, planCells) {
  const from = voidStarts(voids);
  const reached = new Set(planCells.filter((c) => c.position >= (from.get(runKey(c.sequence, c.seed)) ?? Infinity)).map(positionKey));
  const planned = new Set(planCells.map(positionKey));
  return { positions: reached.size, share: planned.size === 0 ? 0 : reached.size / planned.size };
}

const canonical = (a, b) => a.sequence.localeCompare(b.sequence) || a.seed - b.seed || a.position - b.position || a.arm.localeCompare(b.arm);

/** Filters 0-6 in the plan's order: the step-0 counts, the lists the report prints, and `scored`, the
 * records every statistic reads, in canonical order so argv order cannot move a resample.
 * Abandoned runs are listed, not removed: analyzeZ0 stops on any abandoned run before gates or statistics (114).
 * @param {any[]} records
 * @param {any[]} planCells
 * @param {{grading?: object | null, dropList?: object | null, voids?: any[]}} [options] `voids` are checked off-pin voids (readVoids) */
export function filterRecords(records, planCells, { grading = null, dropList = null, voids = [] } = {}) {
  const tail = abandonedTail(records, planCells);
  const { arms, counts } = countCells(records, planCells, tail);
  const plannedRuns = new Set(planCells.map((c) => runKey(c.sequence, c.seed)));
  const abandoned = abandonedRuns(records, planCells, tail);
  const retryFrom = retryVoids(records);
  const offPinFrom = voidStarts(voids);
  const offPinned = (r) => r.position >= (offPinFrom.get(runKey(r.sequence, r.seed)) ?? Infinity);
  // A failed hippo start or prompt hook (hook-check.mjs reads it from the transcripts) left its arm without hippo's text there.
  const hookVoided = new Set((dropList?.hookVoids ?? []).map(positionKey));
  const voided = new Set([...records.filter((r) => r.void !== null).map(positionKey), ...hookVoided]);
  const untaught = new Set(untaughtApplies(records, planCells).map(positionKey));
  const retried = (r) => r.position >= (retryFrom.get(runKey(r.sequence, r.seed)) ?? Infinity);
  const leaked = new Map(records.filter(isLeak).map((r) => [runKey(r.sequence, r.seed), label(r.sequence, r.seed)]));
  const plannedPositions = new Set(planCells.map(positionKey));
  const retryVoided = new Set(planCells.filter(retried).map(positionKey)).size;
  const scored = applyDrops(records, grading, dropList).filter((r) => {
    const run = runKey(r.sequence, r.seed);
    return !leaked.has(run) && !voided.has(positionKey(r)) && !retried(r) && !offPinned(r) && !untaught.has(positionKey(r)) && !isInvalid(r) && !isLeak(r);
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
    hookVoided: { positions: hookVoided.size, share: plannedPositions.size === 0 ? 0 : hookVoided.size / plannedPositions.size },
    offPinVoided: offPinReach(voids, planCells),
    carryUnion,
    scored: scored.sort(canonical),
  };
}

export const withoutRuns = (records, runs) => records.filter((r) => !runs.has(runKey(r.sequence, r.seed)));

/** The inputs `filterRecords` reads; a new filter input is one edit here. */
export const FILTER_KEYS = ['grading', 'dropList', 'voids', 'design'];

/** The filter inputs of `x`, with the design's dropped families added to the drop list's `droppedFamilies` (applyDrops reads them from there). */
export function filterOpts(x) {
  const out = Object.fromEntries(FILTER_KEYS.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]));
  const extra = (x.design ?? DESIGNS.r3).dropFamilies;
  if (extra.length > 0) out.dropList = { droppedLessons: [], ...x.dropList, droppedFamilies: [...new Set([...(x.dropList?.droppedFamilies ?? []), ...extra])] };
  return out;
}

function checkVoids(voids, planCells) {
  const planned = new Set(planCells.map(cellKey));
  for (const v of voids) if (!planned.has(cellKey(v))) throw new Error(`${v.file} void ${v.index}: cell ${cellKey(v)} is not in any plan file`);
}

function checkDesignArms(design, records, planCells) {
  const name = designName(design);
  for (const [what, items] of [['record', records], ['plan cell', planCells]]) {
    const stray = items.find((x) => !design.arms.includes(x.arm));
    if (stray !== undefined) throw new Error(`${locationOf(stray) ?? cellKey(stray)}: ${what} arm ${stray.arm} is not in design ${name}; pass the design that holds it`);
  }
}

/** The one path from parsed inputs to filtered records. It checks the voids against the whole plan, drops seeds above the design's `maxSeed`,
 * validates the corpus and the design's arms, and calls `filterRecords` with the design's families dropped. With `dropAbandoned` it leaves
 * abandoned runs out of the filter; the returned `records` and `planCells` stay whole, so counts taken before filtering do not move.
 * @param {any[]} records @param {any[]} planCells @param {any} opts the FILTER_KEYS inputs @param {{dropAbandoned: boolean}} mode */
export function filteredInput(records, planCells, opts, { dropAbandoned }) {
  const design = opts.design ?? DESIGNS.r3;
  checkVoids(opts.voids ?? [], planCells);
  const under = (x) => design.maxSeed === null || x.seed <= design.maxSeed;
  const [kept, cells, voids] = [records.filter(under), planCells.filter(under), (opts.voids ?? []).filter(under)];
  const { unchecked } = validateCorpus(kept, cells);
  checkDesignArms(design, kept, cells);
  const abandoned = abandonedRuns(kept, cells);
  const [inRecords, inCells] = dropAbandoned ? [withoutRuns(kept, abandoned), withoutRuns(cells, abandoned)] : [kept, cells];
  const filtered = { ...filterRecords(inRecords, inCells, filterOpts({ ...opts, voids })), offPinVoided: offPinReach(voids, cells) };
  return { filtered, abandoned, unchecked, records: kept, planCells: cells };
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
