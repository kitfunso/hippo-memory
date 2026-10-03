/** Z0 analyzer, part 1 of 6: the `z0-record/1` contract and the runner's plan file.
 * Spec: docs/evals/2026-09-29-z0-built-in-memory-prereg.md, field table in docs/evals/2026-10-03-z0-analyzer.md.
 * A bad record rejects with its file and line; nothing is defaulted. */

export const SCHEMA = 'z0-record/1';
export const RN_ARMS = ['A0', 'A1', 'A2', 'A4', 'A5'];
export const X_ARMS = ['X1', 'X2', 'X3', 'X4'];
export const ALL_ARMS = [...RN_ARMS, ...X_ARMS];
export const TWO_SEED_ARMS = new Set(['A0', 'A4', 'X4']);

const SETS = new Set(['R', 'N', 'X']);
const KINDS = new Set(['teach', 'apply', 'no-lesson']);
const CHECKS = new Set(['pass', 'fail', 'na']);
const SOURCES = new Set(['maintainer', 'template']);
const USAGE_FIELDS = ['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'];
const WORK_FIELDS = ['turns', 'toolCalls', 'fileReads', 'wallMs', 'teachTurns', 'correctionTurns'];
const CHAIN_FIELDS = ['stored', 'shown', 'followed', 'captured'];
const LOCATION = Symbol('z0-location');

/** JSON string check without `typeof` (anti-slop rule). */
export function isString(v) {
  return v !== undefined && v !== null && v.constructor === String;
}

export const isBool = (v) => v === true || v === false;
const isPlainObject = (v) => v !== undefined && v !== null && v.constructor === Object;
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isName = (v) => isString(v) && v.length > 0;
const isNullish = (v) => v === null || v === undefined;

/** E1 writes a leaked session as `invalid: 'leak'`; it belongs to G3, never to G4's invalid count. */
export const isLeak = (r) => r.leak === true || r.invalid === 'leak';
export const isInvalid = (r) => !isNullish(r.invalid) && r.invalid !== 'leak';
export const locationOf = (r) => r[LOCATION];

export const runKey = (sequence, seed) => `${sequence}#${seed}`;
export const positionKey = (r) => `${runKey(r.sequence, r.seed)}@${r.position}`;
export const cellKey = (r) => `${positionKey(r)}/${r.arm}`;

/** Reading 7: acceptance passed, every remaining lesson's final check is `pass`, and no timeout. */
export function resolvedOf(r) {
  return r.acceptancePassed === true && r.timedOut !== true && r.lessons.every((l) => l.final === 'pass');
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

function checkUsage(u, name) {
  check(isPlainObject(u), `${name} must be an object with four usage buckets`);
  for (const f of USAGE_FIELDS) check(Number.isFinite(u[f]) && u[f] >= 0, `${name}.${f} must be a non-negative number`);
}

function checkLessons(r, crashed) {
  check(Array.isArray(r.lessons), 'lessons must be an array');
  if (r.kind === 'no-lesson') check(r.lessons.length === 0, 'a no-lesson record carries no lessons');
  else check(r.lessons.length > 0 || crashed, `a ${r.kind} record needs at least one lesson`);
  for (const l of r.lessons) {
    check(isPlainObject(l) && isName(l.lessonId), 'lessons[].lessonId must be a non-empty string');
    check(CHECKS.has(l.first) && CHECKS.has(l.final), `lesson ${l.lessonId}: first and final must be pass, fail or na`);
    const staleOk = r.afterReversal === true ? isBool(l.staleFollow) : l.staleFollow === null;
    check(staleOk, `lesson ${l.lessonId}: staleFollow is boolean after a reversal and null otherwise`);
  }
}

function checkKind(r, warnings) {
  const lessonTask = r.kind !== 'no-lesson';
  check(r.kind !== 'no-lesson' || r.set === 'N', 'kind no-lesson appears only in set N');
  check(lessonTask ? isName(r.familyId) : r.familyId === null, 'familyId is a string for teach and apply, null for no-lesson');
  check(lessonTask ? SOURCES.has(r.lessonSource) : r.lessonSource === null, 'lessonSource is maintainer or template for teach and apply, null for no-lesson');
  const apply = r.kind === 'apply';
  check(apply ? Number.isInteger(r.applyIndex) && r.applyIndex >= 1 : r.applyIndex === null, 'applyIndex is an integer >= 1 on apply records, null otherwise');
  check(apply ? isBool(r.afterReversal) : r.afterReversal === null, 'afterReversal is boolean on apply records, null otherwise');
  check(apply ? isCount(r.tasksSinceTeach) : r.tasksSinceTeach === null, 'tasksSinceTeach is a non-negative integer on apply records, null otherwise');
  if (apply && r.tasksSinceTeach < 2) {
    check(r.afterReversal, `tasksSinceTeach ${r.tasksSinceTeach} is below the 2 tasks prereg 118 requires`);
    warnings.push(`tasksSinceTeach ${r.tasksSinceTeach} after a reversal`);
  }
  check(r.wordOverlap === undefined || (apply && Number.isFinite(r.wordOverlap)), 'wordOverlap is a number on apply records only');
}

function checkIdentity(r) {
  check(r.schema === SCHEMA, `schema must be "${SCHEMA}"`);
  check(SETS.has(r.set), 'set must be R, N or X');
  check(r.tool === 'claude-code' || r.tool === 'codex', 'tool must be claude-code or codex');
  check(isName(r.repo) && isName(r.sequence) && isName(r.taskId), 'repo, sequence and taskId must be non-empty strings');
  check(Number.isInteger(r.seed) && r.seed >= 1 && r.seed <= 3, 'seed must be an integer from 1 to 3');
  check((r.set === 'X' ? X_ARMS : RN_ARMS).includes(r.arm), `arm ${r.arm} is not an arm of set ${r.set}`);
  check(!(r.seed === 3 && TWO_SEED_ARMS.has(r.arm)), `seed 3 is not run for ${r.arm} (prereg 124)`);
  check(isCount(r.position) && isCount(r.order), 'position and order must be non-negative integers');
  check(KINDS.has(r.kind), 'kind must be teach, apply or no-lesson');
  if (r.set === 'X') {
    const tool = r.kind === 'teach' ? 'claude-code' : 'codex';
    check(r.tool === tool, `set X ${r.kind} records run in ${tool}`);
  }
}

function checkOutcome(r, crashed) {
  const nullable = (f) => crashed && isNullish(r[f]);
  if (!nullable('usage')) {
    check(isPlainObject(r.usage), 'usage must be an object');
    checkUsage(r.usage.firstSession, 'usage.firstSession');
    checkUsage(r.usage.extra, 'usage.extra');
  }
  for (const f of WORK_FIELDS) check(nullable(f) || isCount(r[f]), `${f} must be a non-negative integer`);
  check(nullable('acceptancePassed') || isBool(r.acceptancePassed), 'acceptancePassed must be boolean');
  check(isBool(r.timedOut) && isBool(r.leak), 'timedOut and leak must be boolean');
  check(isBool(r.resolved), 'resolved must be boolean');
  check(r.resolved === resolvedOf(r), 'resolved must equal acceptancePassed with every final check pass and no timeout (reading 7)');
  check(r.invalid === null || isName(r.invalid), 'invalid must be null or a reason');
  check(r.void === null || isName(r.void), 'void must be null or a reason');
  // A setup failure ran no session, so E1 writes no retry or carry counts for it.
  for (const f of ['limitRetries', 'carryUnionMerges']) check(nullable(f) || isCount(r[f]), `${f} must be a non-negative integer`);
  check(r.surfaceRestored === undefined || isBool(r.surfaceRestored), 'surfaceRestored must be boolean when present');
  if (r.chain === undefined) return;
  check(isPlainObject(r.chain), 'chain must be an object when present');
  for (const f of CHAIN_FIELDS) check(r.chain[f] === null || isBool(r.chain[f]), `chain.${f} must be boolean or null`);
  check(r.chain.captured === null || r.arm === 'A2' || r.arm === 'X2', 'chain.captured is set only for A2 and X2');
}

/** Per-record contract; returns warnings. A crash may null its usage, work counts and acceptance (E1 `writeRecord`). */
export function validateRecord(r) {
  check(isPlainObject(r), 'a record must be a JSON object');
  const warnings = [];
  checkIdentity(r);
  checkKind(r, warnings);
  const crashed = isInvalid(r);
  checkLessons(r, crashed);
  checkOutcome(r, crashed);
  return warnings;
}

/** Parse JSONL records; throws on the first bad line, naming the file and line. */
export function parseZ0Records(text, file = 'runs') {
  const records = [];
  const warnings = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${file} line ${i + 1}`;
    try {
      const r = JSON.parse(line);
      for (const w of validateRecord(r)) warnings.push(`${where}: ${w}`);
      r[LOCATION] = where;
      records.push(r);
    } catch (e) {
      throw new Error(`${where}: ${e.message}`);
    }
  });
  return { records, warnings };
}

/** Parse the runner's plan.json: the expected cells, G4's denominator. */
export function parsePlan(text, file = 'plan') {
  let cells;
  try {
    cells = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not JSON (${e.message})`);
  }
  if (!Array.isArray(cells)) throw new Error(`${file}: the plan must be a JSON array of cells`);
  return cells.map((c, i) => {
    const where = `${file} entry ${i + 1}`;
    const ok = isPlainObject(c) && isName(c.sequence) && Number.isInteger(c.seed) && c.seed >= 1 && c.seed <= 3
      && isCount(c.position) && ALL_ARMS.includes(c.arm) && !(c.seed === 3 && TWO_SEED_ARMS.has(c.arm));
    if (!ok) throw new Error(`${where}: a cell needs sequence, seed 1-3 (1-2 for A0, A4, X4), position and a known arm`);
    const cell = { sequence: c.sequence, seed: c.seed, position: c.position, arm: c.arm };
    cell[LOCATION] = where;
    return cell;
  });
}

function rejectDuplicates(items, what) {
  const seen = new Map();
  for (const it of items) {
    const k = cellKey(it);
    if (seen.has(k)) throw new Error(`duplicate ${what} ${k}: ${seen.get(k)} and ${locationOf(it)}`);
    seen.set(k, locationOf(it));
  }
}

/** Teach records of the apply record's family before it, or null when a planned teach cell may be missing. */
function priorTeach(a, byCell, taskAt, plannedPositions) {
  const teach = [];
  for (const q of plannedPositions) {
    if (q >= a.position) continue;
    const rec = byCell.get(cellKey({ ...a, position: q }));
    if (rec === undefined) {
      // Another arm's record names the task at a missing cell; with none, it may be this family's teach.
      const task = taskAt.get(positionKey({ ...a, position: q }));
      if (task === undefined || (task.kind === 'teach' && task.familyId === a.familyId)) return null;
    } else if (rec.kind === 'teach' && rec.familyId === a.familyId) teach.push(rec);
  }
  return teach;
}

function checkApply(a, teach) {
  const where = locationOf(a);
  check(teach.length > 0, `${where}: apply record has no teach record of family ${a.familyId} before it`);
  const latest = Math.max(...teach.map((t) => t.position));
  const between = a.position - latest - 1;
  check(a.tasksSinceTeach === between, `${where}: tasksSinceTeach ${a.tasksSinceTeach} but ${between} positions lie after the teach at ${latest}`);
  if (teach.some((t) => isInvalid(t) && t.lessons.length === 0)) return false;
  const taught = new Set(teach.flatMap((t) => t.lessons.map((l) => l.lessonId)));
  for (const l of a.lessons) check(taught.has(l.lessonId), `${where}: lesson ${l.lessonId} is in no teach record of family ${a.familyId}`);
  return true;
}

/** Cross-record checks against the merged plan. Returns `unchecked`: apply records whose family teach
 * cell is missing, or crashed with no lessons, so their lessonIds could not be checked. */
export function validateCorpus(records, planCells) {
  rejectDuplicates(planCells, 'planned cell');
  rejectDuplicates(records, 'record for cell');
  const planned = new Set(planCells.map(cellKey));
  const repoOf = new Map();
  const taskAt = new Map();
  for (const r of records) {
    check(planned.has(cellKey(r)), `${locationOf(r)}: cell ${cellKey(r)} is not in any plan file`);
    const repo = repoOf.get(r.sequence) ?? r.repo;
    check(repo === r.repo, `${locationOf(r)}: sequence ${r.sequence} maps to repos ${repo} and ${r.repo}`);
    repoOf.set(r.sequence, repo);
    if (!taskAt.has(positionKey(r))) taskAt.set(positionKey(r), r);
  }
  const positions = new Map();
  for (const c of planCells) {
    const k = `${runKey(c.sequence, c.seed)}/${c.arm}`;
    positions.set(k, [...(positions.get(k) ?? []), c.position]);
  }
  const byCell = new Map(records.map((r) => [cellKey(r), r]));
  const unchecked = [];
  for (const a of records) {
    if (a.kind !== 'apply') continue;
    const teach = priorTeach(a, byCell, taskAt, positions.get(`${runKey(a.sequence, a.seed)}/${a.arm}`));
    if (teach === null || !checkApply(a, teach)) unchecked.push(locationOf(a));
  }
  return { unchecked };
}
