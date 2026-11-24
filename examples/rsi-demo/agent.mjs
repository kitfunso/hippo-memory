#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveHippoJs() {
  const local = resolve(__dirname, '..', '..', 'bin', 'hippo.js');
  if (existsSync(local)) return local;
  return null;
}

const HIPPO_JS = resolveHippoJs();

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

/**
 * Read a string property off a caught execFileSync error without assuming
 * its shape. Node attaches `.stdout`/`.stderr` as strings when `encoding`
 * is set, but the thrown value's exact shape is otherwise unknown.
 * @param {unknown} err
 * @param {'stdout' | 'stderr'} key
 * @returns {string | null}
 */
function errorStringField(err, key) {
  const value = err && err[key];
  return Object.prototype.toString.call(value) === '[object String]' ? value : null;
}

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
      const stderr = errorStringField(err, 'stderr') ?? '';
      throw new Error(`hippo ${args.join(' ')} failed:\n${stderr}`);
    }
    const stdout = errorStringField(err, 'stdout');
    if (stdout !== null) return stdout;
    throw err;
  }
}

function hippoInit(sandbox) {
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

const HINT_PATTERN = /USE:([a-z0-9-]+)/i;

function extractHint(results) {
  for (const r of results) {
    const content = String(r.content ?? '');
    const m = content.match(HINT_PATTERN);
    if (m) return m[1];
  }
  return null;
}

function executeTask(category, hint, rng) {
  const correctHint = category.hint;

  if (hint === correctHint) {
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

  const sandbox = mkdtempSync(join(tmpdir(), 'hippo-rsi-demo-'));
  const cleanup = () => {
    if (existsSync(sandbox)) {
      try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
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

    const recalled = hippoRecallSuccessfulTraces(sandbox, category.description);
    const hint = extractHint(recalled);

    const outcome = executeTask(category, hint, rng);

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
