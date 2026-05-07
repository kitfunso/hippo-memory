/**
 * Trap definitions and task generator for the Sequential Learning Benchmark.
 *
 * 10 trap categories, each appearing 2-3 times across a 50-task sequence.
 * Extracted from hippo's internal agent-eval test suite.
 */

// ---------------------------------------------------------------------------
// Trap categories
// ---------------------------------------------------------------------------

export const TRAP_CATEGORIES = [
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
// Trap placements: position -> trap category
// ---------------------------------------------------------------------------

export const TRAP_PLACEMENTS = [
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

// ---------------------------------------------------------------------------
// Clean task descriptions (for non-trap positions)
// ---------------------------------------------------------------------------

const CLEAN_DESCRIPTIONS = [
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

// ---------------------------------------------------------------------------
// Phase boundaries (PRE-LOCKED for v1.7.5 multi-seed harness)
// ---------------------------------------------------------------------------
//
//   early = positions  1..17 (trap-slots: 2,4,6,8,10,12,14,16)             8 slots
//   mid   = positions 18..34 (trap-slots: 18,20,22,24,26,28,30,32,34)      9 slots
//   late  = positions 35..50 (trap-slots: 36,38,40,42,44,46,48,50)         8 slots
//                                                                       --------
//                                                                  total: 25 slots
//
// "phase shape" = the multiset of phases a category spans across its 2-3 slots.
// Categories with the same shape form a "shape group". Seeded variance =
// shuffle the assignment of categories to slot-tuples WITHIN each shape group.
// Slot positions stay fixed; only WHICH category lands at each slot rotates.

import { mulberry32 } from './aggregate.mjs';

/**
 * Classify a 1-indexed position into early/mid/late per the PRE-LOCKED
 * phase boundaries.
 * @param {number} pos
 * @returns {'early' | 'mid' | 'late'}
 */
export function phaseOf(pos) {
  if (pos <= 17) return 'early';
  if (pos <= 34) return 'mid';
  return 'late';
}

/**
 * In-place Fisher-Yates shuffle keyed off a deterministic RNG.
 * @template T
 * @param {T[]} arr
 * @param {() => number} rng
 * @returns {T[]} the same array, shuffled
 */
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Hash-derive a sub-seed for a shape group. Uses the golden-ratio constant
 * (0x9E3779B9) so adjacent base seeds produce uncorrelated streams across
 * groups.
 * @param {number} baseSeed
 * @param {number} groupSalt e.g. 1, 2, 3, 4 for the four shape groups
 * @returns {number} uint32 sub-seed
 */
function deriveSubSeed(baseSeed, groupSalt) {
  return (Math.imul(0x9E3779B9, (baseSeed + groupSalt) >>> 0)) >>> 0;
}

/**
 * Build the seeded category->positions map. Categories within the same
 * phase-shape group are shuffled to new slot-tuples; slot positions stay
 * fixed.
 *
 * @param {number} seed
 * @returns {Map<number, string>} position -> categoryId
 */
function buildSeededTrapMap(seed) {
  // Group categories by their canonical phase shape (e.g. "early,mid,late").
  const shapeGroups = new Map(); // shape -> [{category, positions}]
  for (const tp of TRAP_PLACEMENTS) {
    const shape = tp.positions.map(phaseOf).sort().join(',');
    if (!shapeGroups.has(shape)) shapeGroups.set(shape, []);
    shapeGroups.get(shape).push(tp);
  }

  // Salt per shape group keeps streams independent across groups. Sort by
  // shape key for determinism (Map insertion order is non-deterministic
  // across spec versions; explicit sort future-proofs the seeded output).
  const sortedShapes = [...shapeGroups.keys()].sort();
  const trapMap = new Map();

  sortedShapes.forEach((shape, idx) => {
    const group = shapeGroups.get(shape);
    // Shuffle the array of category IDs within this group. The list of
    // slot-tuples stays in canonical order; we only rotate which category
    // attaches to which tuple.
    const categoryIds = group.map((tp) => tp.category);
    const slotTuples = group.map((tp) => tp.positions);
    const rng = mulberry32(deriveSubSeed(seed, idx + 1));
    shuffleInPlace(categoryIds, rng);
    for (let i = 0; i < group.length; i++) {
      for (const pos of slotTuples[i]) {
        trapMap.set(pos, categoryIds[i]);
      }
    }
  });

  return trapMap;
}

// ---------------------------------------------------------------------------
// Task generator
// ---------------------------------------------------------------------------

/**
 * Generate the 50-task sequence.
 *
 * - `generateTasks()` (no seed) -- canonical fixed-position output, identical
 *   to pre-v1.7.5 behaviour. Used for any non-seeded callers (legacy tests,
 *   single-run smoke).
 * - `generateTasks(seed)` -- seeded category-to-slot assignment within each
 *   phase-shape group. Slot positions stay fixed (so the early/mid/late
 *   distribution is unchanged), but which category lands at each trap-slot
 *   is shuffled deterministically. Same seed -> same output.
 *
 * Preserves: total trap-encounter count (25), per-category encounter count
 * (matches TRAP_PLACEMENTS), and each category's native phase pattern.
 *
 * @param {number} [seed] optional integer seed
 * @returns {Array<{id: number, description: string, trapCategory: string|null, recallQuery: string}>}
 */
export function generateTasks(seed) {
  let trapMap;
  if (typeof seed === 'number') {
    trapMap = buildSeededTrapMap(seed);
  } else {
    trapMap = new Map();
    for (const tp of TRAP_PLACEMENTS) {
      for (const pos of tp.positions) {
        trapMap.set(pos, tp.category);
      }
    }
  }

  const tasks = [];
  let cleanIdx = 0;

  for (let pos = 1; pos <= 50; pos++) {
    const trapCatId = trapMap.get(pos);

    if (trapCatId) {
      const cat = TRAP_CATEGORIES.find((c) => c.id === trapCatId);
      const queryIdx = Math.min(
        cat.recallQueries.length - 1,
        Math.floor((pos - 1) / 20),
      );
      tasks.push({
        id: pos,
        description: `Task ${pos}: [TRAP:${trapCatId}]`,
        trapCategory: trapCatId,
        recallQuery: cat.recallQueries[queryIdx],
      });
    } else {
      tasks.push({
        id: pos,
        description: CLEAN_DESCRIPTIONS[cleanIdx % CLEAN_DESCRIPTIONS.length],
        trapCategory: null,
        recallQuery: CLEAN_DESCRIPTIONS[cleanIdx % CLEAN_DESCRIPTIONS.length],
      });
      cleanIdx++;
    }
  }

  return tasks;
}

/**
 * Look up a trap category by id.
 * @param {string} id
 */
export function getTrapCategory(id) {
  return TRAP_CATEGORIES.find((c) => c.id === id) ?? null;
}
