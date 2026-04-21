#!/usr/bin/env node

/**
 * Minimal recursive-self-improvement demo using hippo traces.
 *
 * Runs 50 tasks in 8 categories. Each category has a hidden "trap":
 * the task only succeeds on first attempt if the agent invokes the
 * correct hint (e.g. "USE:wrap-in-transaction" for db-write). On first
 * encounter the agent has no hint in memory, fails, extracts the hint
 * from the trap observation, retries, and records a successful trace.
 * On every subsequent encounter it recalls the prior trace, extracts
 * the hint, and succeeds on first attempt.
 *
 * The pass bar: late success rate (tasks 40-50) must exceed early
 * success rate (tasks 1-10) by at least 20 percentage points, or the
 * demo exits non-zero. This is the evidence that sequence-bound
 * traces actually let an agent self-improve.
 *
 * Self-contained: sets HIPPO_HOME to a fresh tmp dir, cleans up on
 * exit. Deterministic under --seed (default 1337). No network.
 *
 * Usage:
 *   node agent.mjs              # default seed 1337, prints summary
 *   node agent.mjs --seed 42    # override seed
 *   node agent.mjs --gap 0.99   # raise pass bar (to prove the check is real)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the hippo CLI entrypoint. We prefer the local checkout's
// bin/hippo.js (so the demo always runs against the current build),
// falling back to a globally installed `hippo` on PATH.
function resolveHippoJs() {
  const local = resolve(__dirname, '..', '..', 'bin', 'hippo.js');
  if (existsSync(local)) return local;
  return null; // indicates "use PATH-resolved hippo"
}

const HIPPO_JS = resolveHippoJs();

// -------------------------------------------------------------------------
// CLI flags
// -------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { seed: 1337, gap: 0.20 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--seed' && argv[i + 1]) {
      out.seed = Number(argv[++i]);
    } else if (argv[i] === '--gap' && argv[i + 1]) {
      out.gap = Number(argv[++i]);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node agent.mjs [--seed <n>] [--gap <0..1>]');
      process.exit(0);
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// Deterministic RNG (mulberry32)
// -------------------------------------------------------------------------

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// -------------------------------------------------------------------------
// hippo CLI wrapper
// -------------------------------------------------------------------------

/**
 * Run a hippo CLI command scoped entirely to `sandbox`.
 *
 * - cwd = sandbox, so hippo's local-store lookup resolves to <sandbox>/.hippo.
 * - HIPPO_HOME = <sandbox>/global, so the "global" store is also inside the
 *   sandbox and the user's real ~/.hippo is never read or written.
 *
 * On non-zero exit we return stdout if any (hippo recall can exit non-zero
 * when there are no results). True failures surface via `strict: true`.
 */
function hippo(sandbox, args, { strict = false } = {}) {
  const baseArgs = HIPPO_JS ? [HIPPO_JS, ...args] : args;
  const cmd = HIPPO_JS ? process.execPath : 'hippo';
  try {
    return execFileSync(cmd, baseArgs, {
      cwd: sandbox,
      env: { ...process.env, HIPPO_HOME: join(sandbox, 'global') },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch (err) {
    if (strict) {
      const stderr = err && typeof err.stderr === 'string' ? err.stderr : '';
      throw new Error(`hippo ${args.join(' ')} failed:\n${stderr}`);
    }
    if (err && typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

function hippoInit(sandbox) {
  // Init a local store inside the sandbox. `cwd` in hippo(...) makes this
  // resolve to <sandbox>/.hippo, so trace record + recall both operate
  // on an isolated store.
  hippo(sandbox, ['init', '--no-schedule', '--no-hooks'], { strict: true });
}

function hippoRecallSuccessfulTraces(sandbox, query) {
  const raw = hippo(sandbox, [
    'recall', query,
    '--outcome', 'success',
    '--layer', 'trace',
    '--json',
    '--budget', '800',
  ]);
  if (!raw) return [];
  const start = raw.indexOf('{');
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(raw.slice(start));
    return parsed.results ?? [];
  } catch {
    return [];
  }
}

function hippoRecordTrace(sandbox, { task, steps, outcome }) {
  hippo(sandbox, [
    'trace', 'record',
    '--task', task,
    '--steps', JSON.stringify(steps),
    '--outcome', outcome,
  ], { strict: true });
}

// -------------------------------------------------------------------------
// Hint extraction — reads "USE:<token>" from recalled trace content.
// -------------------------------------------------------------------------

const HINT_PATTERN = /USE:([a-z0-9-]+)/i;

function extractHint(results) {
  for (const r of results) {
    const content = String(r.content ?? '');
    const m = content.match(HINT_PATTERN);
    if (m) return m[1];
  }
  return null;
}

// -------------------------------------------------------------------------
// Task execution (mocked)
// -------------------------------------------------------------------------

/**
 * Execute a single task.
 *
 * Returns { firstAttemptSucceeded, stepsRecorded, outcomeRecorded }.
 *
 * Mechanics:
 *   - If `hint` matches `category.hint`, the task succeeds on first attempt.
 *   - Otherwise it fails on first attempt. The agent then reads the
 *     observation (which contains the hint), retries with it, and succeeds.
 *   - Every task ultimately records a success trace with the hint embedded,
 *     so future recalls can find it. First-attempt failures also record a
 *     failure trace so the store reflects the learning journey.
 *
 * The early-vs-late learning curve therefore tracks
 * "did the agent come prepared?" — not "did it eventually succeed?".
 */
function executeTask(category, hint, rng) {
  const correctHint = category.hint;

  if (hint === correctHint) {
    // Prepared. Deterministic success on first attempt.
    return {
      firstAttemptSucceeded: true,
      trace: {
        task: `${category.description} (${category.id})`,
        steps: [
          { action: `recalled prior strategy USE:${correctHint}`, observation: 'applied directly' },
          { action: `execute ${category.id} with USE:${correctHint}`, observation: 'ok, completed on first try' },
        ],
        outcome: 'success',
      },
      failureTrace: null,
    };
  }

  // No hint, or wrong hint. First attempt fails; observation reveals the trap.
  // rng consumed so the run is deterministic even though the outcome is fixed;
  // this also leaves headroom for future variants (e.g. occasional lucky hits).
  void rng();

  return {
    firstAttemptSucceeded: false,
    trace: {
      task: `${category.description} (${category.id})`,
      steps: [
        { action: `attempt ${category.id} without hint`, observation: `failed: ${category.trap_note}` },
        { action: `retry ${category.id} USE:${correctHint}`, observation: 'ok, completed after learning the trap' },
      ],
      outcome: 'success',
    },
    failureTrace: {
      task: `${category.description} (${category.id})`,
      steps: [
        { action: `attempt ${category.id} without hint`, observation: `failed: ${category.trap_note}` },
      ],
      outcome: 'failure',
    },
  };
}

// -------------------------------------------------------------------------
// Main loop
// -------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const tasksPath = join(__dirname, 'tasks.json');
  const cfg = JSON.parse(readFileSync(tasksPath, 'utf8'));
  const rng = mulberry32(args.seed);

  const categoriesById = new Map(cfg.categories.map((c) => [c.id, c]));
  const sequence = cfg.sequence;
  if (sequence.length !== 50) {
    console.error(`FAIL: expected 50 tasks in sequence, got ${sequence.length}`);
    process.exit(1);
  }

  // Fresh isolated sandbox. Both the local .hippo/ (via cwd) and the global
  // store (via HIPPO_HOME) live under this tmp dir, so the demo never reads
  // or writes the user's real hippo data.
  const sandbox = mkdtempSync(join(tmpdir(), 'hippo-rsi-demo-'));
  const cleanup = () => {
    if (existsSync(sandbox)) {
      try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { cleanup(); process.exit(130); });
  }

  console.error(`RSI demo - seed=${args.seed}, gap-threshold=${args.gap}, sandbox=${sandbox}`);
  hippoInit(sandbox);

  const results = [];
  for (let i = 0; i < sequence.length; i++) {
    const catId = sequence[i];
    const category = categoriesById.get(catId);
    if (!category) {
      console.error(`FAIL: unknown category "${catId}" at position ${i + 1}`);
      process.exit(1);
    }

    // Step 1: recall past successful traces for this category.
    const recalled = hippoRecallSuccessfulTraces(sandbox, category.description);
    const hint = extractHint(recalled);

    // Step 2: execute the task.
    const outcome = executeTask(category, hint, rng);

    // Step 3: record trace(s) so the next encounter can learn.
    if (outcome.failureTrace) {
      hippoRecordTrace(sandbox, outcome.failureTrace);
    }
    hippoRecordTrace(sandbox, outcome.trace);

    results.push({
      position: i + 1,
      categoryId: catId,
      hadHint: hint !== null,
      firstAttemptSucceeded: outcome.firstAttemptSucceeded,
    });
  }

  // -------------------------------------------------------------------------
  // Learning curve
  // -------------------------------------------------------------------------

  const rate = (slice) => slice.filter((r) => r.firstAttemptSucceeded).length / slice.length;
  const early = results.slice(0, 10);
  const late = results.slice(40, 50);
  const earlyRate = rate(early);
  const lateRate = rate(late);
  const gap = lateRate - earlyRate;

  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  console.error('');
  console.error(`Tasks 1-10  first-attempt success rate: ${pct(earlyRate)}`);
  console.error(`Tasks 41-50 first-attempt success rate: ${pct(lateRate)}`);
  console.error(`Learning gap:                           ${gap.toFixed(2)}`);

  if (gap < args.gap) {
    console.error(`FAIL: learning gap ${gap.toFixed(2)} < required ${args.gap}`);
    process.exit(1);
  }
  console.error(`PASS: learning gap ${gap.toFixed(2)} >= ${args.gap}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('RSI demo crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
