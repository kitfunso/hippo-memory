// The ranker floor check. `--plan` lists what each arm would be asked and runs nothing; without it, the whole run.
// A retrieval-floor check that picks a ranking core. It is not a measure of how well hippo serves an agent.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { embedAll, loadEmbeddingIndex } from '../../dist/store/embeddings/index.js';
import { isEmbeddingAvailable } from '../../dist/store/embeddings/local.js';
import { rankWith, SHOWN_ROWS } from './arms.ts';
import { buildMicroStore } from './micro-store.ts';
import {
  ALL_STAGES, ARM_LABEL, ARMS, MICRO_DIR, REPO_ROOT, STAGE_LABEL, judge, loadMicroFixtures, stagesNotRun,
  type Arm, type EvalQuery, type LoadedFixture, type Stage,
} from './queries.ts';
import { decide, disagreements, summarize, type ArmResult, type Cell } from './report.ts';
import { hippoOk, inSandbox, resolveItemCwd, restore, takeSnapshot, type Site } from './sandbox.ts';
import { buildWindowFixture, checkPlacement, CONTROL_MARKERS, WINDOW_ROW_COUNT, windowQueries } from './window-fixture.ts';

const TOTAL_QUERIES = 38;
const WARM_UPS = 3;
const TIMED_RUNS = 30;
const BACKEND_INSTALL = 'npm install --no-save @huggingface/transformers@4.2.0';
const NOTE = 'Retrieval-floor check for choosing one ranking core. Not a success measure for hippo.';

interface Args { readonly plan: boolean; readonly keep: boolean; readonly out: string; readonly python: string }

function parseArgs(argv: readonly string[]): Args {
  const args = { plan: false, keep: false, out: join(REPO_ROOT, 'benchmarks', 'q3b-ranker-floor', 'results', 'result.json'), python: 'python' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--plan') args.plan = true;
    else if (flag === '--keep') args.keep = true;
    else if ((flag === '--out' || flag === '--python') && argv[i + 1] !== undefined) {
      const value = argv[++i]!;
      if (flag === '--out') args.out = resolve(value);
      else args.python = value;
    } else throw new Error(`unknown or incomplete argument ${flag}; use --plan, --keep, --out <file>, --python <exe>`);
  }
  return args;
}

const labels = (stages: readonly Stage[]): string[] => stages.map((s) => STAGE_LABEL[s]);

function printPlan(queries: readonly EvalQuery[]): void {
  const reached = { A: 0, B: 0, C: 0 };
  for (const q of queries) {
    const asked = labels(ALL_STAGES.filter((s) => q.stages[s] !== undefined));
    console.log(`${q.id}  stages: ${asked.join(', ') || 'none'}`);
    for (const arm of ARMS) {
      const missing = labels(stagesNotRun(arm, q.stages));
      if (missing.length === 0) reached[arm]++;
      else console.log(`  ${arm} fails by rule: cannot run ${missing.join(', ')}`);
    }
  }
  for (const arm of ARMS) {
    console.log(`${arm} (${ARM_LABEL[arm]}): ${reached[arm]} of ${queries.length} queries reach the arm, ${queries.length - reached[arm]} fail by rule`);
  }
  console.log('plan only: no store was built and no arm was called');
}

/** A BM25-only run is not a result, so the run stops here unless run.py's own probe passes. */
function preflight(python: string): void {
  if (!isEmbeddingAvailable()) throw new Error(`the Transformers.js backend is not installed in this checkout: ${BACKEND_INSTALL}`);
  const r = spawnSync(python, ['-c', 'import run; run.preflight_embeddings()'], { cwd: MICRO_DIR, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`run.py's embedding preflight failed: ${(r.stderr || r.stdout).trim()}`);
}

function siteIn(work: string, name: string): Site {
  const dir = join(work, name.replace(/[^A-Za-z0-9_-]/g, '_'));
  return { home: join(dir, 'home'), snapshot: join(dir, 'snapshot') };
}

/** One query, once per arm, each in a fresh copy of the store and from the query's own cwd. */
async function scoreQuery(site: Site, q: EvalQuery): Promise<Cell[]> {
  const cells: Cell[] = [];
  for (const arm of ARMS) {
    const notRun = labels(stagesNotRun(arm, q.stages));
    if (notRun.length > 0) {
      cells.push({ arm, query: q.id, passed: false, notRun, top: [] });
      continue;
    }
    restore(site);
    const cwd = resolveItemCwd(site.home, q.cwdSubdir, q.fixture);
    for (const push of q.goalPushes) hippoOk(['goal', 'push', push.name, '--session-id', push.sessionId], site.home, cwd);
    const { texts } = await inSandbox(site.home, cwd, () => rankWith(arm, q));
    cells.push({ arm, query: q.id, passed: judge(q, texts).passed, notRun, top: texts.slice(0, q.topK) });
  }
  return cells;
}

async function scoreMicro(work: string, fixtures: readonly LoadedFixture[]): Promise<Cell[]> {
  const cells: Cell[] = [];
  for (const { fixture, queries } of fixtures) {
    const site = siteIn(work, fixture.name);
    buildMicroStore(fixture, site.home);
    takeSnapshot(site);
    for (const q of queries) cells.push(...await scoreQuery(site, q));
    console.log(`scored ${fixture.name}`);
  }
  return cells;
}

/** Builds the window store, checks placement, and embeds every row with the call `hippo embed` makes. */
async function buildWindowSite(work: string): Promise<Site> {
  const site = siteIn(work, 'window');
  const store = await buildWindowFixture(site.home);
  checkPlacement(store);
  const vectors = await inSandbox(site.home, site.home, async () => {
    await embedAll(store.root);
    return Object.keys(loadEmbeddingIndex(store.root)).length;
  });
  if (vectors !== WINDOW_ROW_COUNT) throw new Error(`${vectors} of ${WINDOW_ROW_COUNT} window rows have a vector; a partly embedded fixture is not a result`);
  takeSnapshot(site);
  return site;
}

/** An unlifted target in a top 5 means placement or a lift leaked: the fixture is broken, so no result is reported. */
function assertControlsOut(cells: readonly Cell[]): void {
  const leaks = cells.flatMap((c) => CONTROL_MARKERS.filter((m) => c.top.some((t) => t.includes(m))).map((m) => `${m} in arm ${c.arm}'s top 5 for ${c.query}`));
  if (leaks.length > 0) throw new Error(`window fixture broken, fix it before any run: ${leaks.join('; ')}`);
}

/** 3 warm-ups then 30 timed calls per query and arm, on a fresh copy each; 150 samples per arm. */
async function timeWindow(site: Site, queries: readonly EvalQuery[]): Promise<Record<Arm, number[]>> {
  const timings = { A: new Array<number>(), B: new Array<number>(), C: new Array<number>() };
  for (const [i, q] of queries.entries()) {
    // Rotated so no arm always takes the first, coldest slot of a query.
    for (const arm of ARMS.map((_, k) => ARMS[(i + k) % ARMS.length]!)) {
      restore(site);
      await inSandbox(site.home, site.home, async () => {
        for (let n = 0; n < WARM_UPS; n++) await rankWith(arm, q);
        for (let n = 0; n < TIMED_RUNS; n++) timings[arm].push((await rankWith(arm, q)).retrieveMs);
      });
    }
  }
  const expected = queries.length * TIMED_RUNS;
  for (const arm of ARMS) if (timings[arm].length !== expected) throw new Error(`arm ${arm} has ${timings[arm].length} timed runs, not ${expected}`);
  return timings;
}

function commitHash(): string {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git rev-parse failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function report(out: string, cells: readonly Cell[], results: readonly ArmResult[]): void {
  const differing = disagreements(cells);
  const decision = decide(results);
  for (const r of results) {
    console.log(`${r.arm} (${ARM_LABEL[r.arm]}): ${r.passes} of ${r.total} pass, p99 ${r.p99Ms.toFixed(1)} ms, ${r.failedByRule.length} failed by rule`);
    for (const line of r.failedByRule) console.log(`  failed by rule: ${line}`);
  }
  for (const d of differing) console.log(`arms disagree on ${d.query}: ${ARMS.map((a) => `${a} ${d.passed[a] ? 'pass' : 'fail'}`).join(', ')}`);
  console.log(decision.winner ? `locked rule: arm ${decision.winner} by ${decision.by}` : `locked rule: no arm, ${decision.by}`);
  console.log(NOTE);
  mkdirSync(dirname(out), { recursive: true });
  const body = { note: NOTE, commit: commitHash(), shownRows: SHOWN_ROWS, arms: results, disagreements: differing, decision, cells };
  writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

async function run(args: Args, fixtures: readonly LoadedFixture[], windowed: readonly EvalQuery[]): Promise<void> {
  preflight(args.python);
  const work = mkdtempSync(join(tmpdir(), 'hippo-q3b-'));
  try {
    const cells = await scoreMicro(work, fixtures);
    const site = await buildWindowSite(work);
    const windowCells: Cell[] = [];
    for (const q of windowed) windowCells.push(...await scoreQuery(site, q));
    assertControlsOut(windowCells);
    cells.push(...windowCells);
    report(args.out, cells, summarize(cells, await timeWindow(site, windowed)));
  } finally {
    if (args.keep) console.log(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const args = parseArgs(process.argv.slice(2));
const fixtures = loadMicroFixtures();
const windowed = windowQueries();
const queries = [...fixtures.flatMap((f) => f.queries), ...windowed];
if (queries.length !== TOTAL_QUERIES) throw new Error(`${queries.length} queries, not the ${TOTAL_QUERIES} the pre-registration fixes`);
if (args.plan) printPlan(queries);
else await run(args, fixtures, windowed);
