/** Synthetic Z0 records plus the matching plan, with per-arm knobs, for the analyzer tests.
 * Draws are keyed on (arm, sequence, seed, position), so one arm's knob never moves another arm's draws. */
import { seededRandom } from '../../dist/eval-stats.js';

type Check = 'pass' | 'fail' | 'na';
type Kind = 'teach' | 'apply' | 'no-lesson';

export interface Usage { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number }
export interface Lesson { lessonId: string; first: Check; final: Check; staleFollow: boolean | null }
export interface Chain { stored: boolean | null; shown: boolean | null; followed: boolean | null; captured: boolean | null }

export interface Slot {
  readonly set: 'R' | 'N' | 'X';
  readonly kind: Kind;
  readonly family: number | null;
  readonly position: number;
  readonly lessonId: string | null;
  readonly applyIndex: number | null;
  readonly afterReversal: boolean | null;
  readonly tasksSinceTeach: number | null;
}

export interface Z0Record {
  schema: string; set: string; tool: string; repo: string; sequence: string; seed: number; arm: string;
  position: number; order: number; taskId: string; kind: Kind; familyId: string | null;
  lessonSource: string | null; applyIndex: number | null; afterReversal: boolean | null; tasksSinceTeach: number | null;
  lessons: Lesson[]; acceptancePassed: boolean | null; resolved: boolean;
  usage: { firstSession: Usage; extra: Usage } | null;
  turns: number | null; toolCalls: number | null; fileReads: number | null; wallMs: number | null;
  teachTurns: number | null; correctionTurns: number | null;
  invalid: string | null; timedOut: boolean; void: string | null; leak: boolean;
  limitRetries: number; carryUnionMerges: number; surfaceRestored?: boolean; chain?: Chain; wordOverlap?: number;
}

export interface PlanCell { sequence: string; seed: number; position: number; arm: string }
export interface Generated { records: Z0Record[]; plan: PlanCell[] }

export interface Knobs {
  readonly fail?: number;
  readonly na?: number;
  readonly teachFail?: number;
  readonly resolve?: number;
  readonly cost?: number | ((slot: Slot) => number);
}

export interface GenOpts {
  readonly arms?: readonly string[];
  readonly knobs?: Readonly<Partial<Record<string, Knobs>>>;
  readonly repos?: number;
}

export const ARMS = ['A0', 'A1', 'A2', 'A4', 'A5', 'X1', 'X2', 'X3', 'X4'];
export const PRICES = { 'claude-code': { inputPerMTok: 3, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3, outputPerMTok: 15 } };
const TWO_SEED = new Set(['A0', 'A4', 'X4']);
const DEFAULT_FAIL = new Map([['A0', 0.6], ['A4', 0.05], ['X1', 0.6], ['X4', 0.05]]);
const BASE: Usage = { inputTokens: 2_000, cacheWriteTokens: 8_000, cacheReadTokens: 100_000, outputTokens: 3_000 };

// T teach, A apply, R reversal teach, N no-lesson; family 3 reverses.
const RN_LAYOUT: readonly (readonly [string, number])[] = [
  ['T', 0], ['T', 1], ['N', 0], ['T', 2], ['A', 0], ['T', 3], ['A', 1], ['N', 1], ['A', 2],
  ['A', 3], ['N', 2], ['A', 0], ['A', 3], ['A', 1], ['R', 3], ['A', 2], ['N', 3], ['A', 3],
];

function slots(layout: readonly (readonly [string, number])[], set: 'R' | 'X', prefix: string): Slot[] {
  const taught = new Map<number, number>();
  const applies = new Map<number, number>();
  const reversed = new Set<number>();
  return layout.map(([code, f], position) => {
    if (code === 'N') {
      return { set: 'N', kind: 'no-lesson', family: null, position, lessonId: null, applyIndex: null, afterReversal: null, tasksSinceTeach: null };
    }
    if (code === 'R') reversed.add(f);
    const lessonId = `${prefix}-f${f}-L${reversed.has(f) ? 2 : 1}`;
    if (code !== 'A') {
      taught.set(f, position);
      return { set, kind: 'teach', family: f, position, lessonId, applyIndex: null, afterReversal: null, tasksSinceTeach: null };
    }
    applies.set(f, (applies.get(f) ?? 0) + 1);
    const since = position - (taught.get(f) ?? 0) - 1;
    return { set, kind: 'apply', family: f, position, lessonId, applyIndex: applies.get(f) ?? 1, afterReversal: reversed.has(f), tasksSinceTeach: since };
  });
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const scale = (u: Usage, m: number): Usage => ({
  inputTokens: Math.round(u.inputTokens * m), cacheWriteTokens: Math.round(u.cacheWriteTokens * m),
  cacheReadTokens: Math.round(u.cacheReadTokens * m), outputTokens: Math.round(u.outputTokens * m),
});

function record(arm: string, repo: string, sequence: string, seed: number, slot: Slot, knobs: Knobs, order: number): Z0Record {
  const rand = seededRandom(hash(`${arm}|${sequence}|${seed}|${slot.position}`));
  const fail = (slot.kind === 'teach' ? knobs.teachFail : undefined) ?? knobs.fail ?? DEFAULT_FAIL.get(arm) ?? 0.5;
  const na = knobs.na ?? 0;
  const u = rand();
  const first: Check = u < na ? 'na' : u < na + fail ? 'fail' : 'pass';
  const acceptancePassed = rand() < (knobs.resolve ?? 0.8);
  const m = knobs.cost === undefined ? 1 : knobs.cost instanceof Function ? knobs.cost(slot) : knobs.cost;
  const lessonTask = slot.kind !== 'no-lesson';
  const r: Z0Record = {
    schema: 'z0-record/1', set: slot.set, tool: slot.set === 'X' && slot.kind === 'apply' ? 'codex' : 'claude-code',
    repo, sequence, seed, arm, position: slot.position, order, taskId: `${sequence}-t${slot.position}`, kind: slot.kind,
    familyId: lessonTask ? `${sequence}-f${slot.family}` : null, lessonSource: lessonTask ? (slot.family === 3 ? 'template' : 'maintainer') : null,
    applyIndex: slot.applyIndex, afterReversal: slot.afterReversal, tasksSinceTeach: slot.tasksSinceTeach,
    lessons: slot.lessonId === null ? [] : [{ lessonId: slot.lessonId, first, final: 'pass', staleFollow: slot.afterReversal ? rand() < 0.3 : null }],
    acceptancePassed, resolved: acceptancePassed,
    usage: { firstSession: scale(BASE, m), extra: scale(BASE, lessonTask ? m * 0.25 : 0) },
    turns: 10, toolCalls: 20, fileReads: 5, wallMs: 60_000, teachTurns: slot.kind === 'teach' ? 1 : 0,
    correctionTurns: slot.kind === 'apply' && first === 'fail' ? 1 : 0,
    invalid: null, timedOut: false, void: null, leak: false, limitRetries: 0, carryUnionMerges: 0,
  };
  if (slot.kind === 'apply') {
    r.wordOverlap = 0.1 * ((slot.family ?? 0) + 1);
    r.chain = { stored: true, shown: true, followed: first === 'pass', captured: arm === 'A2' || arm === 'X2' ? true : null };
  }
  return r;
}

/** 6 repos x 3 seeds; sets R and N share one sequence per repo and set X has its own, 36 (sequence, seed) runs. */
export function generate(opts: GenOpts = {}): Generated {
  const arms = opts.arms ?? ARMS;
  const records: Z0Record[] = [];
  for (let i = 1; i <= (opts.repos ?? 6); i++) {
    const repo = `repo${i}`;
    const runs = [
      { sequence: `rn-${repo}`, layout: slots(RN_LAYOUT, 'R', `rn-${repo}`), armSet: arms.filter((a) => a.startsWith('A')) },
      { sequence: `x-${repo}`, layout: slots(RN_LAYOUT.filter(([c]) => c !== 'N'), 'X', `x-${repo}`), armSet: arms.filter((a) => a.startsWith('X')) },
    ];
    for (const { sequence, layout, armSet } of runs) {
      for (let seed = 1; seed <= 3; seed++) {
        for (const slot of layout) {
          armSet.forEach((arm, k) => {
            if (seed === 3 && TWO_SEED.has(arm)) return;
            const order = seed * 1_000_000 + slot.position * 1_000 + i * 10 + ((k + slot.position) % armSet.length);
            records.push(record(arm, repo, sequence, seed, slot, opts.knobs?.[arm] ?? {}, order));
          });
        }
      }
    }
  }
  const plan = records.map((r) => ({ sequence: r.sequence, seed: r.seed, position: r.position, arm: r.arm }));
  return { records, plan };
}

export const jsonl = (records: readonly Z0Record[]): string => records.map((r) => JSON.stringify(r)).join('\n');
