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
// Task generator
// ---------------------------------------------------------------------------

/**
 * Generate the 50-task sequence with traps placed at fixed positions.
 *
 * @returns {Array<{id: number, description: string, trapCategory: string|null, recallQuery: string}>}
 */
export function generateTasks() {
  const trapMap = new Map();
  for (const tp of TRAP_PLACEMENTS) {
    for (const pos of tp.positions) {
      trapMap.set(pos, tp.category);
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
