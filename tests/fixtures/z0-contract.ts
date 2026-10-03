// A local copy of the Z0 analyzer's `z0-record/1` contract: the field table and its two cross-checks.
// Written from the analyzer's record contract so these runner tests fail if the runner drifts from it.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Z0Usage { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number }
export interface Z0Lesson { lessonId: string; first: string; final: string; staleFollow: boolean | null }
export interface Z0Chain { stored: boolean | null; shown: boolean | null; followed: boolean | null; captured: boolean | null }
export interface Z0PlanCell {
  seed: number; position: number; arm: string; sequence: string; taskId: string; repo: string;
  kind: string; familyId: string | null; set: string;
}
export interface Z0Record extends Z0PlanCell {
  schema: string; tool: string; order: number; lessonSource: string | null; lessonId: string | null;
  applyIndex: number | null; afterReversal: boolean | null; tasksSinceTeach: number | null; wordOverlap?: number;
  lessons: Z0Lesson[]; usage: { firstSession: Z0Usage; extra: Z0Usage } | null; costUsd: number | null;
  turns: number | null; toolCalls: number | null; fileReads: number | null; shellReads: number | null; repeatedErrors: number | null;
  wallMs: number | null; teachTurns: number | null; correctionTurns: number | null; teachForm: string | null;
  acceptancePassed: boolean | null; timedOut: boolean; leak: boolean; resolved: boolean; invalid: string | null; void: string | null;
  surfaceRestored?: boolean; chain?: Z0Chain;
  limitRetries: number | null; carryUnionMerges: number | null; carryMerges?: number;
  sessionId: string | null; resumeSessionId: string | null; transcriptFound: boolean; hippo: object | null; agentError: string | null;
}

const RN_ARMS = ['A0', 'A1', 'A2', 'A4', 'A5'];
const TWO_SEED_ARMS = new Set(['A0', 'A4']);
const KINDS = new Set(['teach', 'apply', 'no-lesson']);
const CHECKS = new Set(['pass', 'fail', 'na']);
const SOURCES = new Set(['maintainer', 'template']);
const CHAIN_FIELDS: readonly (keyof Z0Chain)[] = ['stored', 'shown', 'followed', 'captured'];
const USAGE_FIELDS: readonly (keyof Z0Usage)[] = ['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'];
const WORK_FIELDS: readonly (keyof Z0Record)[] = ['turns', 'toolCalls', 'fileReads', 'wallMs', 'teachTurns', 'correctionTurns'];

const isBool = (v: any) => v === true || v === false;
const isCount = (v: any) => Number.isInteger(v) && v >= 0;
const isName = (v: any) => v !== null && v !== undefined && v.constructor === String && v.length > 0;
const isPlain = (v: any) => v !== null && v !== undefined && v.constructor === Object;
const isNullish = (v: any) => v === null || v === undefined;

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

export const resolvedOf = (r: Z0Record) => r.acceptancePassed === true && r.timedOut !== true && r.lessons.every((l) => l.final === 'pass');

function checkIdentity(r: Z0Record) {
  check(r.schema === 'z0-record/1', 'schema');
  check(r.set === 'R' || r.set === 'N', 'set must be R or N here');
  check(r.tool === 'claude-code', 'tool');
  check(isName(r.repo) && isName(r.sequence) && isName(r.taskId), 'repo, sequence, taskId');
  check(Number.isInteger(r.seed) && r.seed >= 1 && r.seed <= 3 && !(r.seed === 3 && TWO_SEED_ARMS.has(r.arm)), 'seed');
  check(RN_ARMS.includes(r.arm), `arm ${r.arm}`);
  check(isCount(r.position) && isCount(r.order), 'position and order');
  check(KINDS.has(r.kind), 'kind');
}

function checkKind(r: Z0Record) {
  const lessonTask = r.kind !== 'no-lesson';
  const apply = r.kind === 'apply';
  check(lessonTask || r.set === 'N', 'no-lesson only in set N');
  check(lessonTask ? isName(r.familyId) : r.familyId === null, 'familyId');
  check(lessonTask ? SOURCES.has(r.lessonSource ?? '') : r.lessonSource === null, 'lessonSource');
  check(apply ? isCount(r.applyIndex) && Number(r.applyIndex) >= 1 : r.applyIndex === null, 'applyIndex');
  check(apply ? isBool(r.afterReversal) : r.afterReversal === null, 'afterReversal');
  check(apply ? isCount(r.tasksSinceTeach) : r.tasksSinceTeach === null, 'tasksSinceTeach');
  if (apply && Number(r.tasksSinceTeach) < 2) check(r.afterReversal === true, 'tasksSinceTeach below 2 before a reversal');
  check(r.wordOverlap === undefined || (apply && Number.isFinite(r.wordOverlap)), 'wordOverlap on apply records only');
}

function checkLessons(r: Z0Record, crashed: boolean) {
  check(Array.isArray(r.lessons), 'lessons array');
  if (r.kind === 'no-lesson') check(r.lessons.length === 0, 'no-lesson carries no lessons');
  else check(r.lessons.length > 0 || crashed, `${r.kind} needs a lesson`);
  for (const l of r.lessons) {
    check(isName(l.lessonId) && CHECKS.has(l.first) && CHECKS.has(l.final), 'lesson verdicts');
    check(r.afterReversal === true ? isBool(l.staleFollow) : l.staleFollow === null, 'staleFollow');
  }
}

function checkUsage(u: Z0Usage, name: string) {
  check(isPlain(u), `${name} object`);
  for (const f of USAGE_FIELDS) check(Number.isFinite(u[f]) && u[f] >= 0, `${name}.${f}`);
}

function checkOutcome(r: Z0Record, crashed: boolean) {
  const nullable = (f: keyof Z0Record) => crashed && isNullish(r[f]);
  if (!nullable('usage')) {
    const usage = r.usage;
    check(usage !== null && isPlain(usage), 'usage object');
    checkUsage(usage.firstSession, 'usage.firstSession');
    checkUsage(usage.extra, 'usage.extra');
  }
  for (const f of WORK_FIELDS) check(nullable(f) || isCount(r[f]), `${f} must be a non-negative integer`);
  check(nullable('acceptancePassed') || isBool(r.acceptancePassed), 'acceptancePassed');
  check(isBool(r.timedOut) && isBool(r.leak) && isBool(r.resolved), 'timedOut, leak, resolved');
  check(r.resolved === resolvedOf(r), 'resolved must follow the literal formula');
  check(r.invalid === null || isName(r.invalid), 'invalid');
  check(r.void === null || isName(r.void), 'void must be null or a reason');
  for (const f of ['limitRetries', 'carryUnionMerges'] as const) check(nullable(f) || isCount(r[f]), f);
  check(r.surfaceRestored === undefined || isBool(r.surfaceRestored), 'surfaceRestored must be boolean when present');
  if (r.chain === undefined) return;
  check(isPlain(r.chain), 'chain must be an object when present');
  for (const f of CHAIN_FIELDS) check(r.chain[f] === null || isBool(r.chain[f]), `chain.${f} must be boolean or null`);
  check(r.chain.captured === null || r.arm === 'A2' || r.arm === 'X2', 'chain.captured is set only for A2 and X2');
}

/** Throws with the field name on the first breach of the per-record contract. */
export function validateRecord(r: Z0Record) {
  check(isPlain(r), 'a record must be an object');
  checkIdentity(r);
  checkKind(r);
  const crashed = !isNullish(r.invalid);
  checkLessons(r, crashed);
  checkOutcome(r, crashed);
}

const armRunKey = (r: Z0PlanCell) => `${r.sequence}#${r.seed}/${r.arm}`;

/** Per (sequence, seed, arm), the planned cells after its last record: what a run that stops partway leaves (114). */
export function abandonedTail(records: Z0PlanCell[], planCells: Z0PlanCell[]) {
  const last = new Map<string, number>();
  for (const r of records) last.set(armRunKey(r), Math.max(last.get(armRunKey(r)) ?? -1, r.position));
  return planCells.filter((c) => c.position > (last.get(armRunKey(c)) ?? -1));
}

const cellKey = (r: Z0PlanCell, position = r.position) => `${r.sequence}#${r.seed}@${position}/${r.arm}`;

/** The two cross-checks over a runs file and its plan; returns the apply records left unchecked (taskIds). */
export function validateCorpus(records: Z0Record[], plan: Z0PlanCell[]) {
  for (const r of records) validateRecord(r);
  const planned = new Set(plan.map((c) => cellKey(c)));
  const byCell = new Map(records.map((r) => [cellKey(r), r]));
  check(byCell.size === records.length, 'one record per cell');
  for (const r of records) check(planned.has(cellKey(r)), `cell ${cellKey(r)} is not planned`);
  const unchecked: string[] = [];
  for (const a of records.filter((r) => r.kind === 'apply')) {
    const before = plan.filter((c) => c.sequence === a.sequence && c.seed === a.seed && c.arm === a.arm && c.position < a.position);
    const teach: Z0Record[] = [];
    let missing = false;
    for (const c of before) {
      const rec = byCell.get(cellKey(c));
      if (rec === undefined) missing = missing || (c.kind === 'teach' && c.familyId === a.familyId);
      else if (rec.kind === 'teach' && rec.familyId === a.familyId) {
        if (!isNullish(rec.invalid)) missing = true;
        else teach.push(rec);
      }
    }
    if (missing) {
      unchecked.push(a.taskId);
      continue;
    }
    check(teach.length > 0, `apply ${a.taskId} has no teach record before it`);
    const latest = Math.max(...teach.map((t) => t.position));
    check(a.tasksSinceTeach === a.position - latest - 1, `apply ${a.taskId}: tasksSinceTeach ${a.tasksSinceTeach}, expected ${a.position - latest - 1}`);
    const taught = new Set(teach.flatMap((t) => t.lessons.map((l) => l.lessonId)));
    for (const l of a.lessons) check(taught.has(l.lessonId), `apply ${a.taskId}: lesson ${l.lessonId} is in no teach record`);
  }
  return unchecked;
}
