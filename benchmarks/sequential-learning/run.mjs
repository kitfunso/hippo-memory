#!/usr/bin/env node

/**
 * Sequential Learning Benchmark Runner
 *
 * Tests whether a memory system helps an AI agent learn from mistakes
 * over a sequence of 50 tasks containing 10 trap categories.
 *
 * Usage:
 *   node run.mjs                           # Run all adapters
 *   node run.mjs --adapter hippo           # Run only hippo
 *   node run.mjs --adapter static          # Run only static
 *   node run.mjs --adapter none            # Run only no-memory baseline
 *   node run.mjs --adapter all             # Run all (default)
 *   node run.mjs --output results/         # Custom output directory
 *
 * Zero npm dependencies beyond Node.js 22.5+ built-ins.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTasks, getTrapCategory } from './traps.mjs';
import baselineAdapter from './adapters/baseline.mjs';
import staticAdapter from './adapters/static.mjs';
import hippoAdapter from './adapters/hippo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { adapter: 'all', output: join(__dirname, 'results') };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--adapter' && args[i + 1]) {
      opts.adapter = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      opts.output = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Sequential Learning Benchmark

Usage:
  node run.mjs [options]

Options:
  --adapter <name>   Run a specific adapter: none, static, hippo, all (default: all)
  --output <dir>     Output directory for JSON results (default: results/)
  -h, --help         Show this help message
`);
      process.exit(0);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

const ADAPTERS = {
  none: baselineAdapter,
  static: staticAdapter,
  hippo: hippoAdapter,
};

// ---------------------------------------------------------------------------
// Simulation engine
// ---------------------------------------------------------------------------

/**
 * Check whether recall results match a trap category.
 *
 * A match occurs when any top-5 result has overlapping tags or
 * contains significant words from the lesson text.
 *
 * @param {Array<{content: string, score: number, tags?: string[]}>} results
 * @param {{lesson: string, tags: string[]}} category
 * @returns {boolean}
 */
function isRecalled(results, category) {
  return results.some((r) => {
    // Tag overlap
    const rTags = r.tags ?? [];
    const tagMatch = category.tags.some((tag) => rTags.includes(tag));

    // Content text match: check if significant words from the lesson appear
    const contentLower = (r.content ?? '').toLowerCase();
    const textMatch = category.lesson
      .split(' ')
      .slice(0, 5)
      .some((word) => word.length > 4 && contentLower.includes(word.toLowerCase()));

    return tagMatch || textMatch;
  });
}

/**
 * Run the benchmark simulation with a given adapter.
 *
 * @param {import('./adapters/interface.mjs').MemoryAdapter} adapter
 * @param {ReturnType<typeof generateTasks>} tasks
 * @returns {Promise<Array<{taskId: number, trapCategory: string|null, trapHit: boolean, memoryRecalled: boolean}>>}
 */
async function simulate(adapter, tasks) {
  await adapter.init();

  const results = [];

  for (const task of tasks) {
    // Clean task: no trap
    if (!task.trapCategory) {
      results.push({
        taskId: task.id,
        trapCategory: null,
        trapHit: false,
        memoryRecalled: false,
      });
      continue;
    }

    const category = getTrapCategory(task.trapCategory);

    // Try to recall relevant memory
    const recalled = await adapter.recall(task.recallQuery);
    const top5 = recalled.slice(0, 5);
    const matched = isRecalled(top5, category);

    if (matched) {
      // Agent recalled the right lesson, avoids the trap
      await adapter.outcome(true);
      results.push({
        taskId: task.id,
        trapCategory: task.trapCategory,
        trapHit: false,
        memoryRecalled: true,
      });
    } else {
      // Agent missed the trap, hits it, then learns
      await adapter.outcome(false);
      await adapter.store(category.lesson, [...category.tags, 'error']);
      results.push({
        taskId: task.id,
        trapCategory: task.trapCategory,
        trapHit: true,
        memoryRecalled: false,
      });
    }
  }

  await adapter.cleanup();
  return results;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Compute trap-hit-rate for a set of results.
 * @param {Array<{trapCategory: string|null, trapHit: boolean}>} results
 * @returns {number}
 */
function trapHitRate(results) {
  const trapTasks = results.filter((r) => r.trapCategory !== null);
  if (trapTasks.length === 0) return 0;
  return trapTasks.filter((r) => r.trapHit).length / trapTasks.length;
}

/**
 * Split trap results into thirds and compute hit rate for each phase.
 * @param {Array<{trapCategory: string|null, trapHit: boolean}>} results
 * @returns {{early: number, mid: number, late: number}}
 */
function hitRateByPhase(results) {
  const trapTasks = results.filter((r) => r.trapCategory !== null);
  const n = trapTasks.length;
  const third = Math.ceil(n / 3);

  const rate = (slice) => {
    if (slice.length === 0) return 0;
    return slice.filter((r) => r.trapHit).length / slice.length;
  };

  return {
    early: rate(trapTasks.slice(0, third)),
    mid: rate(trapTasks.slice(third, third * 2)),
    late: rate(trapTasks.slice(third * 2)),
  };
}

/**
 * Determine if a condition shows learning (declining hit rate over phases).
 * @param {{early: number, mid: number, late: number}} phases
 * @returns {boolean}
 */
function showsLearning(phases) {
  return phases.late < phases.early && (phases.early - phases.late) >= 0.20;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format a rate as a percentage string, right-aligned in 4 chars.
 * @param {number} rate
 * @returns {string}
 */
function fmt(rate) {
  return `${(rate * 100).toFixed(0).padStart(3)}%`;
}

/**
 * Print the comparison table to stdout.
 * @param {Record<string, {overall: number, phases: {early: number, mid: number, late: number}, learns: boolean}>} conditions
 */
function printTable(conditions) {
  const entries = Object.entries(conditions);
  const trapCount = 10;
  const taskCount = 50;

  // Count total trap encounters from the task sequence
  const tasks = generateTasks();
  const trapEncounters = tasks.filter((t) => t.trapCategory !== null).length;

  console.log('');
  console.log('\u2550\u2550 Sequential Learning Benchmark \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log(`${taskCount} tasks \u00b7 ${trapCount} trap categories \u00b7 ${trapEncounters} trap encounters`);
  console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('Condition      \u2502 Overall \u2502 Early \u2502  Mid  \u2502  Late \u2502 Learns?');
  console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  for (const [key, cond] of entries) {
    const label = cond.name.padEnd(14);
    const learnsStr = cond.learns ? '  Yes' : '   No';
    console.log(
      `${label} \u2502  ${fmt(cond.overall)}  \u2502 ${fmt(cond.phases.early)} \u2502 ${fmt(cond.phases.mid)} \u2502 ${fmt(cond.phases.late)} \u2502${learnsStr}`,
    );
  }

  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('');
}

/**
 * Build the JSON output object.
 */
function buildOutput(conditionResults) {
  const tasks = generateTasks();
  const trapEncounters = tasks.filter((t) => t.trapCategory !== null).length;

  const conditions = {};
  for (const [key, cond] of Object.entries(conditionResults)) {
    const entry = {
      overall_trap_hit_rate: parseFloat(cond.overall.toFixed(2)),
      phases: {
        early: parseFloat(cond.phases.early.toFixed(2)),
        mid: parseFloat(cond.phases.mid.toFixed(2)),
        late: parseFloat(cond.phases.late.toFixed(2)),
      },
      learns: cond.learns,
    };

    if (cond.learns) {
      entry.improvement_pct = Math.round((cond.phases.early - cond.phases.late) * 100);
    }

    conditions[key] = entry;
  }

  return {
    benchmark: 'hippo-sequential-learning',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    conditions,
    tasks: 50,
    traps: 10,
    trap_encounters: trapEncounters,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  // Determine which adapters to run
  const adapterKeys =
    opts.adapter === 'all'
      ? Object.keys(ADAPTERS)
      : [opts.adapter];

  for (const key of adapterKeys) {
    if (!(key in ADAPTERS)) {
      console.error(`Unknown adapter: ${key}`);
      console.error(`Available adapters: ${Object.keys(ADAPTERS).join(', ')}`);
      process.exit(1);
    }
  }

  const tasks = generateTasks();
  const conditionResults = {};

  for (const key of adapterKeys) {
    const adapter = ADAPTERS[key];
    process.stdout.write(`Running: ${adapter.name}...`);

    const startMs = performance.now();

    let results;
    try {
      results = await simulate(adapter, tasks);
    } catch (err) {
      console.log(` FAILED`);
      console.error(`  Error: ${err.message}`);
      if (key === 'hippo' && err.message.includes('hippo')) {
        console.error('  Hint: ensure hippo CLI is on PATH (npm link or global install)');
      }
      continue;
    }

    const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);
    const overall = trapHitRate(results);
    const phases = hitRateByPhase(results);
    const learns = showsLearning(phases);

    conditionResults[key] = {
      name: adapter.name,
      overall,
      phases,
      learns,
      results,
    };

    console.log(` done (${elapsed}s) - hit rate: ${fmt(overall)}`);
  }

  if (Object.keys(conditionResults).length === 0) {
    console.error('\nNo adapters ran successfully.');
    process.exit(1);
  }

  // Print comparison table
  printTable(conditionResults);

  // Write JSON output
  if (!existsSync(opts.output)) {
    mkdirSync(opts.output, { recursive: true });
  }

  const output = buildOutput(conditionResults);
  const outputPath = join(opts.output, `benchmark-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Results written to: ${outputPath}`);

  // Also write a latest.json symlink-equivalent
  const latestPath = join(opts.output, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
