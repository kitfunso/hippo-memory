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
import { aggregatePhases } from './aggregate.mjs';
import baselineAdapter from './adapters/baseline.mjs';
import staticAdapter from './adapters/static.mjs';
import hippoAdapter from './adapters/hippo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate the --restrict-late-to flag value. Expects a non-negative
 * integer; throws otherwise.
 *
 * @param {string} raw
 * @returns {number}
 */
export function parseRestrictLateTo(raw) {
  if (typeof raw !== 'string') {
    throw new Error(`--restrict-late-to expects a string; got ${typeof raw}`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--restrict-late-to expects a non-negative integer; got "${raw}"`);
  }
  return parseInt(raw, 10);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    adapter: 'all',
    output: join(__dirname, 'results'),
    useGoalStack: false,
    evalStrict: false,
    seed: undefined,
    nSeeds: 1,
    budget: 2000,
    restrictLateTo: null, // v1.7.7 -- null preserves chronological-third behavior.
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--adapter' && args[i + 1]) {
      opts.adapter = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      opts.output = args[++i];
    } else if (args[i] === '--use-goal-stack') {
      // v1.7.5 -- exercise the B3 dlPFC goal-stack via pushGoal/completeGoal.
      opts.useGoalStack = true;
    } else if (args[i] === '--eval-strict') {
      // v1.7.5 -- hook errors hard-fail instead of being logged + swallowed.
      opts.evalStrict = true;
    } else if (args[i] === '--seed' && args[i + 1]) {
      // v1.7.5 -- explicit single-run seed. Implies nSeeds=1 unless overridden.
      opts.seed = parseInt(args[++i], 10);
    } else if (args[i] === '--n-seeds' && args[i + 1]) {
      // v1.7.5 -- multi-seed run. Hash-derived seed list overrides --seed.
      opts.nSeeds = parseInt(args[++i], 10);
    } else if (args[i] === '--budget' && args[i + 1]) {
      // v1.7.6 -- recall budget for the discriminating-workload sweep.
      opts.budget = parseInt(args[++i], 10);
    } else if (args[i] === '--restrict-late-to' && args[i + 1]) {
      // v1.7.7 -- narrow the late-phase metric to last N trap encounters.
      opts.restrictLateTo = parseRestrictLateTo(args[++i]);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Sequential Learning Benchmark

Usage:
  node run.mjs [options]

Options:
  --adapter <name>    Run a specific adapter: none, static, hippo, all (default: all)
  --output <dir>      Output directory for JSON results (default: results/)
  --use-goal-stack    Exercise the v1.7.5 B3 goal-stack via pushGoal/completeGoal
                      hooks. Only adapters that supply both are affected.
  --eval-strict       Hard-fail on any goal-stack hook error (default: log+continue).
                      Pair with --use-goal-stack for the eval pipeline.
  --seed <int>        Single-run seed for deterministic category-to-slot
                      assignment (v1.7.5). Ignored when --n-seeds > 1.
  --n-seeds <int>     Multi-seed run. Hash-derives N seeds and reports
                      mean / std / 95% CI per phase across seeds (v1.7.5).
                      Default: 1.
  --budget <int>      Recall token budget passed to adapter.recall(query, budget).
                      Adapters that honor token budgets (hippo) use it; baseline
                      and static ignore it. Default: 2000. (v1.7.6)
  --restrict-late-to <int>  v1.7.7 -- narrow the late-phase metric to the last
                      <int> trap encounters (early/mid re-split to keep the
                      three slices disjoint). Default: chronological third
                      (~last 7 of 25). Use --restrict-late-to 4 to reproduce
                      the v1.7.7 hypothesis workload.
  -h, --help          Show this help message
`);
      process.exit(0);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Seed list derivation (v1.7.5)
// ---------------------------------------------------------------------------

/**
 * Build the seed list for a run. Hash-derived to avoid correlated mulberry32
 * streams between adjacent base indices. Constant matches `aggregate.mjs`.
 *
 * @param {{seed: number|undefined, nSeeds: number}} opts
 * @returns {Array<number|undefined>} undefined entry = canonical (no-seed) run
 */
function deriveSeedList(opts) {
  if (opts.nSeeds > 1) {
    return Array.from({ length: opts.nSeeds }, (_, i) =>
      (Math.imul(0x9E3779B9, (1000 + i) >>> 0)) >>> 0,
    );
  }
  if (typeof opts.seed === 'number') {
    return [opts.seed];
  }
  return [undefined];
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
 * v1.7.5 changes:
 *  - Returns `{results, hookFailures}` instead of `results` directly.
 *  - When `opts.useGoalStack` is true AND the adapter implements pushGoal,
 *    pushes a goal at task start and completes it at task end (in a `finally`
 *    block so it always fires, even after a recall/outcome exception).
 *  - Stores memories with `[task.trapCategory, ...category.tags, 'error']`.
 *    The category id (e.g. `'bare_except'`) MUST be the first tag so that
 *    the goal-stack boost (which keys on `goalsByTag.has(tag)`) can match
 *    the goal name pushed for the next encounter. Without this, the boost
 *    would silently match zero memories and we'd RETRACT a working mechanism
 *    for the wrong reason.
 *  - Eval-strict mode (`opts.evalStrict`) re-throws hook errors immediately
 *    and re-throws at the end of the run if any hook errors were counted.
 *
 * @param {import('./adapters/interface.mjs').MemoryAdapter} adapter
 * @param {ReturnType<typeof generateTasks>} tasks
 * @param {{useGoalStack?: boolean, evalStrict?: boolean}} [opts]
 * @returns {Promise<{
 *   results: Array<{taskId: number, trapCategory: string|null, trapHit: boolean, memoryRecalled: boolean}>,
 *   hookFailures: {push: number, complete: number},
 * }>}
 */
async function simulate(adapter, tasks, opts = {}) {
  await adapter.init();
  const useGoalStack =
    opts.useGoalStack === true && typeof adapter.pushGoal === 'function';
  const evalStrict = opts.evalStrict === true;

  const results = [];
  let pushFailures = 0;
  let completeFailures = 0;

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

    // v1.7.5 -- push the goal so the dlPFC boost can match `task.trapCategory`
    // against any prior memory tagged with that id.
    let goalId = null;
    if (useGoalStack) {
      try {
        goalId = await adapter.pushGoal(task.trapCategory);
      } catch (err) {
        pushFailures++;
        if (evalStrict) {
          throw new Error(
            `evalStrict: pushGoal failed task ${task.id}: ${err.message}`,
          );
        }
        console.error(`pushGoal failed for task ${task.id}: ${err.message}`);
      }
    }

    let matched = false;
    try {
      const budget = opts.budget ?? 2000;
      const recalled = await adapter.recall(task.recallQuery, budget);
      const top5 = recalled.slice(0, 5);
      matched = isRecalled(top5, category);

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
        // v1.7.5 P0 tag-fix -- include the category id as the FIRST tag so
        // the goal-stack boost (which iterates tags and checks
        // goalsByTag.has(tag)) can match. Pre-v1.7.5 stored only
        // category.tags which lacked the id.
        await adapter.store(category.lesson, [
          task.trapCategory,
          ...category.tags,
          'error',
        ]);
        results.push({
          taskId: task.id,
          trapCategory: task.trapCategory,
          trapHit: true,
          memoryRecalled: false,
        });
      }
    } finally {
      // v1.7.5 P1 -- complete the goal even if recall/outcome/store threw.
      if (useGoalStack && goalId) {
        try {
          await adapter.completeGoal(goalId, matched);
        } catch (err) {
          completeFailures++;
          if (evalStrict) {
            throw new Error(
              `evalStrict: completeGoal failed task ${task.id}: ${err.message}`,
            );
          }
          console.error(`completeGoal failed for task ${task.id}: ${err.message}`);
        }
      }
    }
  }

  await adapter.cleanup();

  // v1.7.5 P1 -- in eval-strict mode, re-throw if any hook quietly failed
  // before a strict gate would have caught it (defensive belt + braces).
  if (evalStrict && (pushFailures > 0 || completeFailures > 0)) {
    throw new Error(
      `evalStrict: ${pushFailures} push failures, ${completeFailures} complete failures`,
    );
  }

  return { results, hookFailures: { push: pushFailures, complete: completeFailures } };
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
 * Split trap results into phases and compute hit rate for each.
 *
 * v1.7.7: when `restrictLateTo` is null (default), late = last third of traps
 * (chronological third). When `restrictLateTo = N` (positive integer), late =
 * last N traps; early/mid re-split to "first ceil((total-N)/2)" / "remainder"
 * so the three slices stay disjoint and exhaustive.
 *
 * Post-review P2-2 -- `tests/agent-eval.test.ts` defines a local namesake
 * `hitRateByPhase`. If you import this module function from elsewhere, alias
 * to avoid shadowing the local in that test file.
 *
 * @param {Array<{trapCategory: string|null, trapHit: boolean}>} results
 * @param {number|null} [restrictLateTo=null] - Optional override for late slice size.
 * @returns {{early: number, mid: number, late: number}}
 */
export function hitRateByPhase(results, restrictLateTo = null) {
  const trapTasks = results.filter((r) => r.trapCategory !== null);
  const n = trapTasks.length;

  const rate = (slice) => {
    if (slice.length === 0) return 0;
    return slice.filter((r) => r.trapHit).length / slice.length;
  };

  if (restrictLateTo === null) {
    // Default: chronological third (v1.7.0..v1.7.6 behavior).
    const third = Math.ceil(n / 3);
    return {
      early: rate(trapTasks.slice(0, third)),
      mid: rate(trapTasks.slice(third, third * 2)),
      late: rate(trapTasks.slice(third * 2)),
    };
  }

  // v1.7.7: late = last N. early = first ceil((n-N)/2). mid = remainder.
  const N = Math.max(0, Math.min(restrictLateTo, n));
  const earlyEnd = Math.ceil((n - N) / 2);
  const midEnd = n - N;
  return {
    early: rate(trapTasks.slice(0, earlyEnd)),
    mid: rate(trapTasks.slice(earlyEnd, midEnd)),
    late: rate(trapTasks.slice(midEnd)),
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
 *
 * v1.7.5 -- when condition.seedRuns is present (length > 1) the output gains
 * a `seeds` array (per-seed details) and a `phaseAggregate` block (mean / std
 * / ci95 per phase across seeds). For single-seed/canonical runs the legacy
 * shape is preserved.
 */
function buildOutput(conditionResults, opts = {}) {
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

    // v1.7.5 -- record hook failure counts per condition (zero when goal-stack
    // hooks weren't exercised).
    if (cond.hookFailures) {
      entry.hook_failures = cond.hookFailures;
    }

    // v1.7.5 -- multi-seed extras. Skipped for canonical (single, undefined-seed)
    // runs to keep the legacy single-seed JSON shape unchanged.
    if (cond.seedRuns && cond.seedRuns.length > 0) {
      entry.seeds = cond.seedRuns.map((s) => ({
        seed: s.seed,
        overall: parseFloat(s.overall.toFixed(4)),
        phases: {
          early: parseFloat(s.phases.early.toFixed(4)),
          mid: parseFloat(s.phases.mid.toFixed(4)),
          late: parseFloat(s.phases.late.toFixed(4)),
        },
        hook_failures: s.hookFailures,
      }));
    }
    if (cond.phaseAggregate) {
      entry.phase_aggregate = cond.phaseAggregate;
    }

    conditions[key] = entry;
  }

  return {
    benchmark: 'hippo-sequential-learning',
    version: '1.7.7',  // v1.7.7 -- bump for audit
    timestamp: new Date().toISOString(),
    conditions,
    tasks: 50,
    traps: 10,
    trap_encounters: trapEncounters,
    // v1.7.7 -- audit field. null preserves chronological-third behavior.
    restrict_late_to: opts.restrictLateTo ?? null,
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

  // v1.7.5 -- derive the seed list. nSeeds=1 with no --seed -> [undefined]
  // (canonical fixed-position run, identical to pre-v1.7.5 behaviour).
  const seedList = deriveSeedList(opts);
  const conditionResults = {};

  for (const key of adapterKeys) {
    const adapter = ADAPTERS[key];
    const seedSuffix = seedList.length > 1 ? ` (${seedList.length} seeds)` : '';
    process.stdout.write(`Running: ${adapter.name}${seedSuffix}...`);

    const startMs = performance.now();
    const seedRuns = [];
    let runFailed = false;

    for (const seed of seedList) {
      const tasks = generateTasks(seed);
      let results;
      let hookFailures = { push: 0, complete: 0 };
      try {
        const out = await simulate(adapter, tasks, {
          useGoalStack: opts.useGoalStack,
          evalStrict: opts.evalStrict,
          budget: opts.budget,
        });
        results = out.results;
        hookFailures = out.hookFailures;
      } catch (err) {
        console.log(` FAILED`);
        console.error(`  Error (seed=${seed}): ${err.message}`);
        if (key === 'hippo' && err.message.includes('hippo')) {
          console.error('  Hint: ensure hippo CLI is on PATH (npm link or global install)');
        }
        // v1.7.5 -- in eval-strict mode propagate the failure so CI can detect it.
        if (opts.evalStrict) throw err;
        runFailed = true;
        break;
      }

      seedRuns.push({
        seed: seed ?? null,
        results,
        overall: trapHitRate(results),
        phases: hitRateByPhase(results, opts.restrictLateTo),
        hookFailures,
      });
    }

    if (runFailed) continue;

    const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);

    // For single-run (canonical or --seed) reporting matches legacy shape.
    // For multi-seed runs the headline numbers are means across seeds.
    const overall =
      seedRuns.reduce((a, r) => a + r.overall, 0) / seedRuns.length;
    const phases = {
      early: seedRuns.reduce((a, r) => a + r.phases.early, 0) / seedRuns.length,
      mid: seedRuns.reduce((a, r) => a + r.phases.mid, 0) / seedRuns.length,
      late: seedRuns.reduce((a, r) => a + r.phases.late, 0) / seedRuns.length,
    };
    const learns = showsLearning(phases);
    const hookFailures = seedRuns.reduce(
      (acc, r) => ({
        push: acc.push + r.hookFailures.push,
        complete: acc.complete + r.hookFailures.complete,
      }),
      { push: 0, complete: 0 },
    );

    // v1.7.5 -- compute phase aggregate when multi-seed; aggregatePhases
    // gracefully handles n=1 (mean=value, std=0, ci95=0 below n<5 floor).
    const phaseAggregate =
      seedRuns.length > 1
        ? aggregatePhases(seedRuns.map((r) => r.phases))
        : null;

    conditionResults[key] = {
      name: adapter.name,
      overall,
      phases,
      learns,
      // legacy single-run results array kept for compatibility (uses last
      // seed's results when multi-seed; downstream code should use seedRuns)
      results: seedRuns[seedRuns.length - 1].results,
      hookFailures,
      seedRuns: seedList.length > 1 ? seedRuns : null,
      phaseAggregate,
    };

    const hookSuffix =
      opts.useGoalStack && (hookFailures.push || hookFailures.complete)
        ? ` (hook failures: push=${hookFailures.push} complete=${hookFailures.complete})`
        : '';
    console.log(` done (${elapsed}s) - hit rate: ${fmt(overall)}${hookSuffix}`);
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

  const output = buildOutput(conditionResults, opts);
  const outputPath = join(opts.output, `benchmark-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Results written to: ${outputPath}`);

  // Also write a latest.json symlink-equivalent
  const latestPath = join(opts.output, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(output, null, 2));
}

// v1.7.7 P0-1 -- run.mjs is now import-safe. main() only runs when invoked as a
// script (matches `calibrate.mjs::invokedAsScript` pattern). Tests can import
// `hitRateByPhase` and `parseRestrictLateTo` without spawning hippo subprocesses.
const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
