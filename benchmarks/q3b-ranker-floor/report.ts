// The arithmetic of the floor check: pass counts, p99, the queries where arms disagree, and the locked decision rule.

import { ARMS, type Arm } from './queries.ts';

// The pre-registered margin: an arm wins on pass count only when it leads every other arm by this many queries.
const WIN_MARGIN = 2;

export interface Cell {
  readonly arm: Arm;
  readonly query: string;
  readonly passed: boolean;
  /** Stages the arm cannot run. Non-empty means the query failed by the pre-registered rule and never reached the arm. */
  readonly notRun: readonly string[];
  readonly top: readonly string[];
}

export interface ArmResult {
  readonly arm: Arm;
  readonly passes: number;
  readonly total: number;
  readonly p99Ms: number;
  readonly failedByRule: readonly string[];
}

/** Nearest-rank p99: of 150 samples, the 149th smallest. */
export function p99(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('p99 of no samples');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.99 * sorted.length) - 1]!;
}

export function summarize(cells: readonly Cell[], timings: Readonly<Record<Arm, readonly number[]>>): ArmResult[] {
  return ARMS.map((arm) => {
    const own = cells.filter((c) => c.arm === arm);
    return {
      arm,
      passes: own.filter((c) => c.passed).length,
      total: own.length,
      p99Ms: p99(timings[arm]),
      failedByRule: own.filter((c) => c.notRun.length > 0).map((c) => `${c.query}: ${c.notRun.join(', ')}`),
    };
  });
}

export interface Disagreement { readonly query: string; readonly passed: Readonly<Record<Arm, boolean>> }

export function disagreements(cells: readonly Cell[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const query of new Set(cells.map((c) => c.query))) {
    const passedBy = (arm: Arm): boolean => cells.some((c) => c.query === query && c.arm === arm && c.passed);
    const passed = { A: passedBy('A'), B: passedBy('B'), C: passedBy('C') };
    if (new Set(Object.values(passed)).size > 1) out.push({ query, passed });
  }
  return out;
}

export interface Decision { readonly winner: Arm | null; readonly by: 'pass count' | 'p99' | 'p99 tie' }

/** The locked rule, read as written: a margin of two over every other arm, else the lowest p99 of all the arms. */
export function decide(results: readonly ArmResult[]): Decision {
  const ahead = results.find((r) => results.every((o) => o === r || r.passes - o.passes >= WIN_MARGIN));
  if (ahead) return { winner: ahead.arm, by: 'pass count' };
  const lowest = Math.min(...results.map((r) => r.p99Ms));
  const fastest = results.filter((r) => r.p99Ms === lowest);
  return fastest.length === 1 ? { winner: fastest[0]!.arm, by: 'p99' } : { winner: null, by: 'p99 tie' };
}
