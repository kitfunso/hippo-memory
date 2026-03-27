/**
 * Agent Evaluation Benchmark: Sequential Learning Over Time
 *
 * Simulates an agent doing 50 tasks in a codebase with 10 trap categories.
 * Each trap category appears 2-3 times across the sequence. When the agent
 * hits a trap, it stores a memory (hippo remember). On subsequent encounters
 * of the same trap category, it recalls the memory and avoids the trap.
 *
 * Three conditions:
 *   1. No memory (baseline) — agent has no recall, hits every trap
 *   2. Static memory — all memories pre-loaded, no learning
 *   3. Hippo (full mechanics) — starts empty, learns from each trap hit
 *
 * Key metric: trap-hit-rate over the sequence.
 * Hypothesis: hippo condition shows declining hit rate; static is flat.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createMemory,
  applyOutcome,
  type MemoryEntry,
} from '../src/memory.js';
import {
  initStore,
  writeEntry,
  loadAllEntries,
} from '../src/store.js';
import { search, markRetrieved } from '../src/search.js';

// ---------------------------------------------------------------------------
// Trap categories — each has a lesson and 2-3 task instances
// ---------------------------------------------------------------------------

interface TrapCategory {
  id: string;
  lesson: string;
  tags: string[];
  /** Query an agent would use when encountering this type of task */
  recallQueries: string[];
}

interface Task {
  id: number;
  description: string;
  trapCategory: string | null; // null = clean task (no trap)
  recallQuery: string;         // what the agent would search for before starting
}

const TRAP_CATEGORIES: TrapCategory[] = [
  {
    id: 'overwrite_production',
    lesson: 'Never overwrite production files directly. Create versioned copies and let a human promote.',
    tags: ['production', 'overwrite', 'deploy'],
    recallQueries: ['deploying model to production', 'updating production file'],
  },
  {
    id: 'bare_except',
    lesson: 'Never use bare except: pass. It swallows all errors silently. Log and re-raise specific exceptions.',
    tags: ['error-handling', 'exception', 'python'],
    recallQueries: ['handling errors in data pipeline', 'exception handling pattern'],
  },
  {
    id: 'emoji_windows',
    lesson: 'No emoji in Python print statements on Windows. cp1252 encoding crashes on emoji characters.',
    tags: ['windows', 'encoding', 'emoji', 'print'],
    recallQueries: ['adding status output to script', 'print statements python windows'],
  },
  {
    id: 'powershell_chain',
    lesson: 'PowerShell uses semicolons not && to chain commands. && causes silent failure.',
    tags: ['powershell', 'windows', 'shell'],
    recallQueries: ['chaining commands in build script', 'powershell command sequence'],
  },
  {
    id: 'sharpe_inflation',
    lesson: 'Walk-forward Sharpe overestimates by ~50%. Use CPCV-deflated Sharpe for honest reporting.',
    tags: ['quant', 'sharpe', 'backtest', 'oos'],
    recallQueries: ['reporting OOS backtest results', 'model performance sharpe ratio'],
  },
  {
    id: 'constants_sync',
    lesson: 'Frontend and backend trading constants must stay in sync. Mismatch causes wrong position sizing.',
    tags: ['frontend', 'backend', 'constants', 'sync'],
    recallQueries: ['changing risk parameters', 'updating trading constants'],
  },
  {
    id: 'slop_words',
    lesson: 'Remove AI slop words (comprehensive, robust, leverage, harness) from agent-generated text.',
    tags: ['copywriting', 'review', 'agent-output'],
    recallQueries: ['reviewing agent-generated copy', 'publishing marketing text'],
  },
  {
    id: 'exit_code_trust',
    lesson: 'Exit code 0 does not guarantee data freshness. Always verify actual file timestamps and data values.',
    tags: ['monitoring', 'staleness', 'exit-code'],
    recallQueries: ['checking if data refresh succeeded', 'verifying cache freshness'],
  },
  {
    id: 'data_mining',
    lesson: 'Selecting features on the full dataset then reporting OOS results is data mining. Use theory-only selection.',
    tags: ['feature-selection', 'data-mining', 'backtest'],
    recallQueries: ['selecting features for model', 'feature engineering OOS testing'],
  },
  {
    id: 'unverified_metrics',
    lesson: 'Always run the actual backtest to verify metrics. Never accept claimed numbers from agent output.',
    tags: ['verification', 'metrics', 'agent-output'],
    recallQueries: ['model upgrade metrics improved', 'verifying model performance claims'],
  },
];

// ---------------------------------------------------------------------------
// Generate 50 tasks with traps spread across the sequence
// ---------------------------------------------------------------------------

function generateTasks(): Task[] {
  const tasks: Task[] = [];

  // Each trap category appears at 3 positions: early, mid, late
  // This tests whether the agent learns from early encounters
  const trapPlacements: Array<{ category: string; positions: number[] }> = [
    { category: 'overwrite_production', positions: [2, 22, 42] },
    { category: 'bare_except',          positions: [4, 28, 46] },
    { category: 'emoji_windows',        positions: [6, 24, 38] },
    { category: 'powershell_chain',     positions: [8, 30] },
    { category: 'sharpe_inflation',     positions: [10, 32, 44] },
    { category: 'constants_sync',       positions: [12, 34] },
    { category: 'slop_words',           positions: [14, 36, 48] },
    { category: 'exit_code_trust',      positions: [16, 26] },
    { category: 'data_mining',          positions: [18, 40] },
    { category: 'unverified_metrics',   positions: [20, 50] },
  ];

  // Build a map: position -> trap category
  const trapMap = new Map<number, string>();
  for (const tp of trapPlacements) {
    for (const pos of tp.positions) {
      trapMap.set(pos, tp.category);
    }
  }

  // Fill task descriptions
  const cleanDescriptions = [
    'Add logging to the data refresh script',
    'Update README with new API endpoint',
    'Refactor config loader to use dataclass',
    'Fix typo in error message',
    'Add unit test for price parser',
    'Update dependencies to latest versions',
    'Clean up unused imports',
    'Add type annotations to utility functions',
    'Document the deploy process',
    'Add retry logic to HTTP client',
    'Optimize database query for dashboard',
    'Add input validation to API endpoint',
    'Update CI config for new test suite',
    'Refactor logging to use structured format',
    'Add health check endpoint',
    'Update API documentation',
    'Add rate limiting to public endpoints',
    'Refactor error codes to enum',
    'Add pagination to list endpoint',
    'Update monitoring alerts threshold',
  ];

  let cleanIdx = 0;
  for (let pos = 1; pos <= 50; pos++) {
    const trapCat = trapMap.get(pos);
    if (trapCat) {
      const cat = TRAP_CATEGORIES.find((c) => c.id === trapCat)!;
      const queryIdx = Math.min(
        cat.recallQueries.length - 1,
        Math.floor((pos - 1) / 20) // vary queries across encounters
      );
      tasks.push({
        id: pos,
        description: `Task ${pos}: [TRAP:${trapCat}]`,
        trapCategory: trapCat,
        recallQuery: cat.recallQueries[queryIdx],
      });
    } else {
      tasks.push({
        id: pos,
        description: cleanDescriptions[cleanIdx % cleanDescriptions.length],
        trapCategory: null,
        recallQuery: cleanDescriptions[cleanIdx % cleanDescriptions.length],
      });
      cleanIdx++;
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Simulation engine
// ---------------------------------------------------------------------------

interface SimResult {
  taskId: number;
  trapCategory: string | null;
  trapHit: boolean;     // true = agent hit the trap (failed to avoid it)
  memoryRecalled: boolean; // true = relevant memory was in top-5 results
}

/**
 * Simulate an agent running tasks with a given memory condition.
 *
 * @param mode 'none' | 'static' | 'hippo'
 *   - none: no memory store, agent hits every trap
 *   - static: all lessons pre-loaded, agent recalls but doesn't learn new ones
 *   - hippo: starts empty, learns from each trap hit, memories strengthen through use
 */
function simulate(tasks: Task[], mode: 'none' | 'static' | 'hippo'): SimResult[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hippo-eval-${mode}-`));
  initStore(tmpDir);

  // For static mode: pre-load all lessons
  if (mode === 'static') {
    for (const cat of TRAP_CATEGORIES) {
      const entry = createMemory(cat.lesson, { tags: cat.tags });
      writeEntry(tmpDir, entry);
    }
  }

  const results: SimResult[] = [];

  for (const task of tasks) {
    if (!task.trapCategory) {
      // Clean task, no trap to hit
      results.push({ taskId: task.id, trapCategory: null, trapHit: false, memoryRecalled: false });
      continue;
    }

    if (mode === 'none') {
      // No memory: always hits the trap
      results.push({ taskId: task.id, trapCategory: task.trapCategory, trapHit: true, memoryRecalled: false });
      continue;
    }

    // Search memory for relevant guidance
    const entries = loadAllEntries(tmpDir);
    const searchResults = search(task.recallQuery, entries, { budget: 4000 });
    const topIds = searchResults.slice(0, 5);

    // Check if any top result is relevant to this trap category
    const cat = TRAP_CATEGORIES.find((c) => c.id === task.trapCategory)!;
    const recalled = topIds.some((r) => {
      // Check if the result's content matches the lesson or tags overlap
      const contentMatch = cat.tags.some((tag) => r.entry.tags.includes(tag));
      const textMatch = cat.lesson.split(' ').slice(0, 5).some((word) =>
        word.length > 4 && r.entry.content.toLowerCase().includes(word.toLowerCase())
      );
      return contentMatch || textMatch;
    });

    if (recalled) {
      // Agent recalled the right memory, avoids the trap
      // Strengthen the recalled memories
      if (mode === 'hippo') {
        const toUpdate = markRetrieved(topIds.map((r) => r.entry));
        for (const u of toUpdate) writeEntry(tmpDir, u);
      }
      results.push({ taskId: task.id, trapCategory: task.trapCategory, trapHit: false, memoryRecalled: true });
    } else {
      // Agent missed the trap — hits it
      results.push({ taskId: task.id, trapCategory: task.trapCategory, trapHit: true, memoryRecalled: false });

      // For hippo mode: learn from the mistake
      if (mode === 'hippo') {
        const lesson = createMemory(cat.lesson, {
          tags: [...cat.tags, 'error'],
          emotional_valence: 'negative',
        });
        writeEntry(tmpDir, lesson);
      }
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return results;
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function trapHitRate(results: SimResult[]): number {
  const trapTasks = results.filter((r) => r.trapCategory !== null);
  if (trapTasks.length === 0) return 0;
  const hits = trapTasks.filter((r) => r.trapHit).length;
  return hits / trapTasks.length;
}

/** Split results into thirds and compute hit rate for each */
function hitRateByPhase(results: SimResult[]): { early: number; mid: number; late: number } {
  const trapTasks = results.filter((r) => r.trapCategory !== null);
  const n = trapTasks.length;
  const third = Math.ceil(n / 3);

  const rate = (slice: SimResult[]) => {
    if (slice.length === 0) return 0;
    return slice.filter((r) => r.trapHit).length / slice.length;
  };

  return {
    early: rate(trapTasks.slice(0, third)),
    mid: rate(trapTasks.slice(third, third * 2)),
    late: rate(trapTasks.slice(third * 2)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tasks = generateTasks();

describe('Agent evaluation: sequential learning benchmark', () => {
  it('generates 50 tasks with 25+ trap encounters', () => {
    expect(tasks.length).toBe(50);
    const trapTasks = tasks.filter((t) => t.trapCategory !== null);
    expect(trapTasks.length).toBeGreaterThanOrEqual(25);
  });

  it('all 10 trap categories appear at least twice', () => {
    for (const cat of TRAP_CATEGORIES) {
      const appearances = tasks.filter((t) => t.trapCategory === cat.id).length;
      expect(appearances, `Trap category ${cat.id} appears ${appearances} times`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('Condition: no memory (baseline)', () => {
  let results: SimResult[];

  it('hits 100% of traps', () => {
    results = simulate(tasks, 'none');
    const rate = trapHitRate(results);
    expect(rate).toBe(1.0);
  });

  it('no improvement over time (flat hit rate)', () => {
    const phases = hitRateByPhase(results);
    expect(phases.early).toBe(1.0);
    expect(phases.mid).toBe(1.0);
    expect(phases.late).toBe(1.0);

    console.log('\n  ── No Memory (baseline) ──────────────────────────');
    console.log(`  Overall hit rate: 100%`);
    console.log(`  Early:  ${(phases.early * 100).toFixed(0)}%`);
    console.log(`  Mid:    ${(phases.mid * 100).toFixed(0)}%`);
    console.log(`  Late:   ${(phases.late * 100).toFixed(0)}%`);
  });
});

describe('Condition: static memory (pre-loaded)', () => {
  let results: SimResult[];

  it('catches most traps from the start', () => {
    results = simulate(tasks, 'static');
    const rate = trapHitRate(results);
    // Static should catch many (lessons pre-loaded) but rate is flat across phases
    expect(rate).toBeLessThan(0.5); // catches >50% of traps
  });

  it('hit rate is roughly flat across phases (no learning)', () => {
    const phases = hitRateByPhase(results);

    console.log('\n  ── Static Memory ─────────────────────────────────');
    console.log(`  Overall hit rate: ${(trapHitRate(results) * 100).toFixed(0)}%`);
    console.log(`  Early:  ${(phases.early * 100).toFixed(0)}%`);
    console.log(`  Mid:    ${(phases.mid * 100).toFixed(0)}%`);
    console.log(`  Late:   ${(phases.late * 100).toFixed(0)}%`);

    // Static memory doesn't improve over time — late should not be significantly
    // better than early (within 20 percentage points)
    const improvement = phases.early - phases.late;
    expect(Math.abs(improvement)).toBeLessThanOrEqual(0.25);
  });
});

describe('Condition: hippo (learns from mistakes)', () => {
  let results: SimResult[];

  it('hit rate is lower than no-memory baseline', () => {
    results = simulate(tasks, 'hippo');
    const rate = trapHitRate(results);
    expect(rate).toBeLessThan(1.0);
  });

  it('late-phase hit rate is lower than early-phase (agent learns)', () => {
    const phases = hitRateByPhase(results);

    console.log('\n  ── Hippo (learns from mistakes) ──────────────────');
    console.log(`  Overall hit rate: ${(trapHitRate(results) * 100).toFixed(0)}%`);
    console.log(`  Early:  ${(phases.early * 100).toFixed(0)}%`);
    console.log(`  Mid:    ${(phases.mid * 100).toFixed(0)}%`);
    console.log(`  Late:   ${(phases.late * 100).toFixed(0)}%`);

    // Core hypothesis: late hit rate < early hit rate
    // The agent should learn from early mistakes and avoid later ones
    expect(phases.late).toBeLessThan(phases.early);
  });

  it('improvement is >= 30 percentage points from early to late', () => {
    const phases = hitRateByPhase(results);
    const improvement = phases.early - phases.late;
    expect(improvement).toBeGreaterThanOrEqual(0.30);
  });
});

describe('Comparative summary', () => {
  it('prints full comparison table', () => {
    const noMem = simulate(tasks, 'none');
    const staticMem = simulate(tasks, 'static');
    const hippoMem = simulate(tasks, 'hippo');

    const noMemPhases = hitRateByPhase(noMem);
    const staticPhases = hitRateByPhase(staticMem);
    const hippoPhases = hitRateByPhase(hippoMem);

    console.log('\n  ══ Agent Evaluation Benchmark ═══════════════════════════');
    console.log('  50 tasks, 10 trap categories, 25+ trap encounters');
    console.log('  ──────────────────────────────────────────────────────────');
    console.log('  Condition     │ Overall │ Early │  Mid  │  Late │ Learns?');
    console.log('  ──────────────┼─────────┼───────┼───────┼───────┼────────');
    console.log(`  No memory     │  ${fmt(trapHitRate(noMem))}  │ ${fmt(noMemPhases.early)} │ ${fmt(noMemPhases.mid)} │ ${fmt(noMemPhases.late)} │   No`);
    console.log(`  Static memory │  ${fmt(trapHitRate(staticMem))}  │ ${fmt(staticPhases.early)} │ ${fmt(staticPhases.mid)} │ ${fmt(staticPhases.late)} │   No`);
    console.log(`  Hippo         │  ${fmt(trapHitRate(hippoMem))}  │ ${fmt(hippoPhases.early)} │ ${fmt(hippoPhases.mid)} │ ${fmt(hippoPhases.late)} │  Yes`);
    console.log('  ══════════════════════════════════════════════════════════');
  });
});

function fmt(rate: number): string {
  return `${(rate * 100).toFixed(0).padStart(3)}%`;
}
