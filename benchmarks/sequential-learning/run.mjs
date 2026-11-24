import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTasks, getTrapCategory, TRAP_CATEGORIES, N_TASKS } from './traps.mjs';
import { aggregatePhases } from './aggregate.mjs';
import baselineAdapter from './adapters/baseline.mjs';
import staticAdapter from './adapters/static.mjs';
import hippoAdapter from './adapters/hippo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse and validate the --restrict-late-to flag value. Expects a non-negative
 * integer; throws otherwise.
 *
 * @param {string} raw
 * @returns {number}
 */
/**
 * Human-readable type name for an error message, without `typeof`. Matches
 * `typeof` for every value this CLI parser actually sees (string,
 * undefined); diverges only for null/arrays, which never reach this path.
 * @param {unknown} value
 * @returns {string}
 */
function describeType(value) {
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

export function parseRestrictLateTo(raw) {
  if (Object.prototype.toString.call(raw) !== '[object String]') {
    throw new Error(`--restrict-late-to expects a string; got ${describeType(raw)}`);
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
      opts.useGoalStack = true;
    } else if (args[i] === '--eval-strict') {
      opts.evalStrict = true;
    } else if (args[i] === '--seed' && args[i + 1]) {
      opts.seed = parseInt(args[++i], 10);
    } else if (args[i] === '--n-seeds' && args[i + 1]) {
      opts.nSeeds = parseInt(args[++i], 10);
    } else if (args[i] === '--budget' && args[i + 1]) {
      opts.budget = parseInt(args[++i], 10);
    } else if (args[i] === '--restrict-late-to' && args[i + 1]) {
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
  if (Object.prototype.toString.call(opts.seed) === '[object Number]') {
    return [opts.seed];
  }
  return [undefined];
}

const ADAPTERS = {
  none: baselineAdapter,
  static: staticAdapter,
  hippo: hippoAdapter,
};

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
    const rTags = r.tags ?? [];
    const tagMatch = category.tags.some((tag) => rTags.includes(tag));

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
    opts.useGoalStack === true && adapter.pushGoal instanceof Function;
  const evalStrict = opts.evalStrict === true;

  const results = [];
  let pushFailures = 0;
  let completeFailures = 0;

  async function completeGoalReportingFailure(adapter, goalId, matched, taskId, evalStrict) {
    try {
      await adapter.completeGoal(goalId, matched);
      return 0;
    } catch (err) {
      if (evalStrict) {
        throw new Error(`evalStrict: completeGoal failed task ${taskId}: ${err.message}`);
      }
      console.error(`completeGoal failed for task ${taskId}: ${err.message}`);
      return 1;
    }
  }

  for (const task of tasks) {
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
        await adapter.outcome(true);
        results.push({
          taskId: task.id,
          trapCategory: task.trapCategory,
          trapHit: false,
          memoryRecalled: true,
        });
      } else {
        await adapter.outcome(false);
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
      if (useGoalStack && goalId) {
        completeFailures += await completeGoalReportingFailure(adapter, goalId, matched, task.id, evalStrict);
      }
    }
  }

  await adapter.cleanup();

  if (evalStrict && (pushFailures > 0 || completeFailures > 0)) {
    throw new Error(
      `evalStrict: ${pushFailures} push failures, ${completeFailures} complete failures`,
    );
  }

  return { results, hookFailures: { push: pushFailures, complete: completeFailures } };
}

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
 * Post-review P2-2 -- `tests/core/agent-eval.test.ts` defines a local namesake
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
    const third = Math.ceil(n / 3);
    return {
      early: rate(trapTasks.slice(0, third)),
      mid: rate(trapTasks.slice(third, third * 2)),
      late: rate(trapTasks.slice(third * 2)),
    };
  }

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
  const trapCount = TRAP_CATEGORIES.length;
  const taskCount = N_TASKS;

  const tasks = generateTasks();
  const trapEncounters = tasks.filter((t) => t.trapCategory !== null).length;

  console.log('');
  console.log('\u2550\u2550 Sequential Learning Benchmark \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log(`${taskCount} tasks \u00b7 ${trapCount} trap categories \u00b7 ${trapEncounters} trap encounters`);
  console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('Condition      \u2502 Overall \u2502 Early \u2502  Mid  \u2502  Late \u2502 Learns?');
  console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  for (const [, cond] of entries) {
    const label = cond.name.padEnd(14);
    const learnsStr = cond.learns ? '  Yes' : '   No';
    console.log(
      `${label} \u2502  ${fmt(cond.overall)}  \u2502 ${fmt(cond.phases.early)} \u2502 ${fmt(cond.phases.mid)} \u2502 ${fmt(cond.phases.late)} \u2502${learnsStr}`,
    );
  }

  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('');
}

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

    if (cond.hookFailures) {
      entry.hook_failures = cond.hookFailures;
    }

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
    tasks: N_TASKS,
    traps: TRAP_CATEGORIES.length,
    trap_encounters: trapEncounters,
    restrict_late_to: opts.restrictLateTo ?? null,
  };
}

async function main() {
  const opts = parseArgs();

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

    const phaseAggregate =
      seedRuns.length > 1
        ? aggregatePhases(seedRuns.map((r) => r.phases))
        : null;

    conditionResults[key] = {
      name: adapter.name,
      overall,
      phases,
      learns,
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

  printTable(conditionResults);

  if (!existsSync(opts.output)) {
    mkdirSync(opts.output, { recursive: true });
  }

  const output = buildOutput(conditionResults, opts);
  const outputPath = join(opts.output, `benchmark-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Results written to: ${outputPath}`);

  const latestPath = join(opts.output, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(output, null, 2));
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
