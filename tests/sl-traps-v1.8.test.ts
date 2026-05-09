// tests/sl-traps-v1.8.test.ts
//
// v1.8.0 — Schema invariants + uniform-distribution invariants for the
// adversarial-categories release. Tightened per outside voice B2/B3/E3.

import { describe, it, expect } from 'vitest';
import {
  TRAP_CATEGORIES,
  TRAP_PLACEMENTS,
  generateTasks,
  N_TASKS,
} from '../benchmarks/sequential-learning/traps.mjs';

const NEW_IDS = ['timezone_naive', 'idempotency_retry', 'float_accumulation'];

describe('v1.8 adversarial traps schema', () => {
  it('N_TASKS = 62', () => {
    expect(N_TASKS).toBe(62);
  });

  it('has 13 trap categories (10 v1.7.x + 3 adversarial)', () => {
    expect(TRAP_CATEGORIES.length).toBe(13);
  });

  it('includes the 3 new adversarial categories with required fields', () => {
    for (const id of NEW_IDS) {
      const cat = TRAP_CATEGORIES.find((c) => c.id === id);
      expect(cat).toBeDefined();
      expect(cat!.lesson.length).toBeGreaterThan(20);
      expect(cat!.tags.length).toBeGreaterThanOrEqual(3);
      expect(cat!.recallQueries.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('total trap encounters = 31', () => {
    const total = TRAP_PLACEMENTS.reduce(
      (sum, p) => sum + p.positions.length,
      0,
    );
    expect(total).toBe(31);
  });

  it('all positions unique across categories', () => {
    const allPositions = TRAP_PLACEMENTS.flatMap((p) => p.positions);
    expect(new Set(allPositions).size).toBe(allPositions.length);
  });

  it('all positions in [1, N_TASKS]', () => {
    for (const tp of TRAP_PLACEMENTS) {
      for (const pos of tp.positions) {
        expect(pos).toBeGreaterThanOrEqual(1);
        expect(pos).toBeLessThanOrEqual(N_TASKS);
      }
    }
  });
});

describe('v1.8 adversarial position assignment (uniform across early/mid/late)', () => {
  // Per outside voice B2: uniform distribution = ~2 per region of the 62-task sequence.
  // Late-clustering would optimise for magnitude visibility, which RETRACTION.md forbids.

  it('new categories have EXACTLY 6 trap positions', () => {
    const newPositions = TRAP_PLACEMENTS
      .filter((p) => NEW_IDS.includes(p.category))
      .flatMap((p) => p.positions);
    expect(newPositions.length).toBe(6);
  });

  it('new positions are exactly {11, 21, 33, 41, 51, 59} (uniform)', () => {
    const newPositions = TRAP_PLACEMENTS
      .filter((p) => NEW_IDS.includes(p.category))
      .flatMap((p) => p.positions)
      .sort((a, b) => a - b);
    expect(newPositions).toEqual([11, 21, 33, 41, 51, 59]);
  });

  it('exactly 2 new positions in each of early (1-22), mid (22-42), late (42-62) regions', () => {
    const newPositions = TRAP_PLACEMENTS
      .filter((p) => NEW_IDS.includes(p.category))
      .flatMap((p) => p.positions);

    const earlyCount = newPositions.filter((pos) => pos >= 1 && pos <= 22).length;
    const midCount = newPositions.filter((pos) => pos >= 23 && pos <= 42).length;
    const lateCount = newPositions.filter((pos) => pos >= 43 && pos <= 62).length;

    expect(earlyCount).toBe(2);
    expect(midCount).toBe(2);
    expect(lateCount).toBe(2);
  });

  it('all new placements carry adversarial: true flag', () => {
    for (const tp of TRAP_PLACEMENTS) {
      if (NEW_IDS.includes(tp.category)) {
        expect((tp as { adversarial?: boolean }).adversarial).toBe(true);
      }
    }
  });
});

describe('v1.8 generateTasks correctness', () => {
  it('generateTasks() (no seed) produces N_TASKS tasks with 31 trap encounters', () => {
    const tasks = generateTasks();
    expect(tasks.length).toBe(N_TASKS);
    const trapTasks = tasks.filter((t) => t.trapCategory);
    expect(trapTasks.length).toBe(31);
  });

  it('generateTasks(seed=0) produces N_TASKS tasks with 31 trap encounters', () => {
    const tasks = generateTasks(0);
    expect(tasks.length).toBe(N_TASKS);
    const trapTasks = tasks.filter((t) => t.trapCategory);
    expect(trapTasks.length).toBe(31);
  });

  it('generateTasks is deterministic for fixed seed', () => {
    const a = generateTasks(42).map((t) => t.trapCategory ?? null);
    const b = generateTasks(42).map((t) => t.trapCategory ?? null);
    expect(a).toEqual(b);
  });

  it('generateTasks(seed=0) and (seed=1) produce different category-to-slot mappings', () => {
    const a = generateTasks(0).map((t) => t.trapCategory ?? null);
    const b = generateTasks(1).map((t) => t.trapCategory ?? null);
    expect(a).not.toEqual(b);
  });

  it('adversarial categories are at FIXED positions across all seeds (no shape-group shuffle)', () => {
    // timezone_naive at [11, 41]; idempotency_retry at [21, 51]; float_accumulation at [33, 59]
    for (const seed of [0, 1, 5, 19, 42, 99]) {
      const tasks = generateTasks(seed);
      expect(tasks[10].trapCategory).toBe('timezone_naive'); // pos 11 = index 10
      expect(tasks[40].trapCategory).toBe('timezone_naive'); // pos 41
      expect(tasks[20].trapCategory).toBe('idempotency_retry'); // pos 21
      expect(tasks[50].trapCategory).toBe('idempotency_retry'); // pos 51
      expect(tasks[32].trapCategory).toBe('float_accumulation'); // pos 33
      expect(tasks[58].trapCategory).toBe('float_accumulation'); // pos 59
    }
  });
});

describe('v1.8 existing-10 categories PRNG-stability vs v1.7.x positions (per outside voice E3)', () => {
  // The existing-10 categories' positions are unchanged from v1.7.x.
  // This test asserts the canonical (non-seeded) placement matches v1.7.x.
  it('existing-10 categories occupy exactly positions {2, 4, ..., 50} (all even, 25 positions)', () => {
    const existingIds = TRAP_CATEGORIES.filter((c) => !NEW_IDS.includes(c.id)).map((c) => c.id);
    const existingPlacements = TRAP_PLACEMENTS.filter((p) => existingIds.includes(p.category));
    const existingPositions = existingPlacements.flatMap((p) => p.positions).sort((a, b) => a - b);

    expect(existingPositions.length).toBe(25);
    expect(existingPositions[0]).toBe(2);
    expect(existingPositions[24]).toBe(50);
    expect(existingPositions.every((p) => p >= 2 && p <= 50 && p % 2 === 0)).toBe(true);
  });

  it('v1.7.x existing-10 placements are unchanged (per-category positions match v1.7.x record)', () => {
    const expected: Record<string, number[]> = {
      overwrite_production: [2, 22, 42],
      bare_except: [4, 28, 46],
      emoji_windows: [6, 24, 38],
      powershell_chain: [8, 30],
      sharpe_inflation: [10, 32, 44],
      constants_sync: [12, 34],
      slop_words: [14, 36, 48],
      exit_code_trust: [16, 26],
      data_mining: [18, 40],
      unverified_metrics: [20, 50],
    };
    for (const [catId, expectedPositions] of Object.entries(expected)) {
      const tp = TRAP_PLACEMENTS.find((p) => p.category === catId);
      expect(tp).toBeDefined();
      expect(tp!.positions).toEqual(expectedPositions);
    }
  });
});
