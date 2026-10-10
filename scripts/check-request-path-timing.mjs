#!/usr/bin/env node
// Request-path work at 10,000 memories per store: getContext, the MCP tools that read whole stores, and the HTTP recall.
// Fails when a request runs more statements, reads more rows or opens more stores than its ceiling; the time is printed and fails nothing. Run after `npm run build`:
//   node scripts/check-request-path-timing.mjs [--memories 10000]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const MEMORIES = flag('--memories', 10000);
const RUNS = 3;
// The work ceilings below were set at this size, about 1.3 times what each request does; twice the work fails every one.
const CEILING_MEMORIES = 10000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-request-timing-'));
const localRoot = path.join(tmp, 'proj', '.hippo');
const globalRoot = path.join(tmp, 'global');
process.env.HIPPO_HOME = globalRoot;
// The http rows time the recall p99-recall.ts sends, with no key, so both servers run in keyless local mode.
process.env.HIPPO_ALLOW_KEYLESS_LOCAL = '1';
// Outside git, so hippo_context's auto query is empty and the timing measures the store, not git.
process.chdir(tmp);

// Windows dynamic import() needs a file:// URL, not a raw drive path.
const load = (rel) => import(pathToFileURL(path.join(REPO, 'dist', rel)).href);
const { createMemory } = await load('core/memory.js');
const { initStore } = await load('store/open.js');
const { writeEntryDbOnly } = await load('store/entry-writes.js');
const { loadAmbientTallies } = await load('store/ambient.js');
const { openHippoDb, closeHippoDb } = await load('db/index.js');
const { createApiKey } = await load('store/auth.js');
const { getContext, adminActor } = await load('api/index.js');
const { handleMcpRequest } = await load('mcp/server.js');
const { sqliteStore } = await load('store/sqlite/store.js');
const { workerSqliteStore } = await load('store/sqlite/worker-store.js');
const { serve } = await load('server.js');

const { DatabaseSync, StatementSync } = createRequire(import.meta.url)('node:sqlite');

// Every connection open sets its lock wait first, so this counts store opens.
const STORE_OPEN = /^PRAGMA busy_timeout = [1-9]/;

function* countEach(rows, work) {
  for (const row of rows) {
    work.rows += 1;
    yield row;
  }
}

/** Statements `run` executes, rows they hand to JavaScript and stores it opens: the same on every runner, where the wall clock is not. */
async function countWork(run) {
  const work = { statements: 0, rows: 0, opens: 0 };
  const exec = DatabaseSync.prototype.exec;
  const originals = ['run', 'get', 'all', 'iterate'].map((name) => [name, StatementSync.prototype[name]]);
  DatabaseSync.prototype.exec = function (sql) {
    work.statements += 1;
    if (STORE_OPEN.test(sql)) work.opens += 1;
    return exec.call(this, sql);
  };
  for (const [name, original] of originals) {
    StatementSync.prototype[name] = function (...params) {
      work.statements += 1;
      const out = original.apply(this, params);
      if (name === 'get' && out !== undefined) work.rows += 1;
      if (name === 'all') work.rows += out.length;
      return name === 'iterate' ? countEach(out, work) : out;
    };
  }
  try {
    await run();
  } finally {
    DatabaseSync.prototype.exec = exec;
    for (const [name, original] of originals) StatementSync.prototype[name] = original;
  }
  return work;
}

const WORDS = 'cache index query build deploy test lint merge rebase docker kafka redis postgres auth token schema migration release hook retry queue worker cron backup restore metric alert trace log shard'.split(' ');
const DAY_MS = 86400000;

// One transaction on one handle: writeEntry's per-row commit and markdown mirror would make seeding the slow part.
function seed(root, sourceOf) {
  initStore(root);
  const db = openHippoDb(root);
  const started = Date.now();
  db.exec('BEGIN');
  try {
    for (let i = 0; i < MEMORIES; i++) {
      const w = (k) => WORDS[(i * 7 + k * 13) % WORDS.length];
      const entry = createMemory(`note ${i}: the ${w(1)} ${w(2)} path needs ${w(3)} before ${w(4)}, step ${i % 97}`, {
        tags: i % 50 === 0 ? ['error'] : [w(5)],
        pinned: i % 500 === 0,
        source: sourceOf(i),
        tenantId: 'default',
        baseHalfLifeDays: 30,
      });
      const created = new Date(started - (i % 365) * DAY_MS - i * 1000).toISOString();
      writeEntryDbOnly(db, { ...entry, created, last_retrieved: created, origin_project: 'proj' });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    closeHippoDb(db);
  }
}

seed(localRoot, () => 'cli');
seed(globalRoot, (i) => `shared:proj${i % 12}:seed`);
// serve() refuses a second server on one root, and the copy is taken while no connection holds the store.
const copyRoot = path.join(tmp, 'copy', '.hippo');
fs.cpSync(localRoot, copyRoot, { recursive: true });

const ctx = { hippoRoot: localRoot, tenantId: 'default', actor: adminActor('ci:timing') };
const mcpCtx = { hippoRoot: localRoot, tenantId: 'default', actor: 'ci:timing' };
const tool = (name, args = {}) => async () => {
  const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, mcpCtx);
  if (res?.error || res?.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(res)}`);
};

// With no global store a context query searches the local store alone, a separate load path.
const withoutGlobal = (run) => async () => {
  process.env.HIPPO_HOME = path.join(tmp, 'no-global');
  try {
    await run();
  } finally {
    process.env.HIPPO_HOME = globalRoot;
  }
};

// Answers from a store worker thread, as serve() does by default; the counts below are this thread's, so its ceilings are zero.
const served = workerSqliteStore(localRoot);

function mintKey(root) {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', label: 'timing' }).keyId;
  } finally {
    closeHippoDb(db);
  }
}
const keyId = mintKey(localRoot);
// Every authenticated request starts with this read.
const keyLookup = async () => {
  if ((await served.findApiKey(keyId)) === null) throw new Error('the served store did not find the key the script minted');
};

// The request benchmarks/a1/p99-recall.ts times, through a real server and socket. serve() answers it from store worker threads, where this thread
// counts nothing, so its work is counted on a second server over a copy of the store, in process.
const server = await serve({ hippoRoot: localRoot, port: 0 });
const inProcess = sqliteStore(copyRoot);
const inProcessServer = await serve({ hippoRoot: copyRoot, port: 0, store: inProcess });
const httpRecall = (url, limit) => async () => {
  const res = await fetch(`${url}/v1/memories?q=${encodeURIComponent('kafka redis')}&limit=${limit}`);
  const body = await res.json();
  if (!res.ok || body.results.length === 0) throw new Error(`GET /v1/memories failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
};

// Each case: label, request, and its ceilings on statements run, rows read and stores opened.
const cases = [
  ['getContext, no query', () => getContext(ctx, { currentProject: 'proj' }), [330, 5335, 11]],
  ['getContext, query', () => getContext(ctx, { q: 'kafka redis', currentProject: 'proj' }), [375, 665, 16]],
  ['getContext, pinned only', () => getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: 'proj' }), [42, 141, 5]],
  ['getContext, local query', withoutGlobal(() => getContext(ctx, { q: 'kafka redis', currentProject: 'proj' })), [325, 395, 10]],
  ['ambient tallies, 2 stores', () => {
    for (const root of [localRoot, globalRoot]) loadAmbientTallies(root, 'default', { project: ['proj'], currentProject: ['proj'], now: new Date() });
  }, [19, 6, 2]],
  ['mcp hippo_context', tool('hippo_context'), [345, 5370, 2]],
  ['mcp hippo_recall', tool('hippo_recall', { query: 'kafka redis' }), [411, 1495, 1]],
  ['mcp hippo_status', tool('hippo_status'), [13, 7, 1]],
  ['mcp hippo_peers', tool('hippo_peers'), [10, 17, 1]],
  ['served predictions list', () => served.predictions.listPredictions('default', { limit: 20 }), [0, 0, 0]],
  ['served decisions list', () => served.objects.listObjects('default', 'decision', { limit: 20 }), [0, 0, 0]],
  ['served key lookup', keyLookup, [0, 0, 0]],
  ['http recall, limit 10', httpRecall(inProcessServer.url, 10), [62, 287, 1]],
  // Fifty rows back, so one extra statement per returned row passes the ceiling, which ten rows would not.
  ['http recall, limit 50', httpRecall(inProcessServer.url, 50), [166, 335, 1]],
  // As serve() answers by default: a statement or an open on the server thread during a recall fails here.
  ['served http recall, limit 10', httpRecall(server.url, 10), [0, 0, 0]],
  ['served http recall, limit 50', httpRecall(server.url, 50), [0, 0, 0]],
];

let overworked = false;
let uncounted = false;
const summary = ['| request | median ms (not gated) | statements | rows read | store opens |', '| --- | ---: | ---: | ---: | ---: |'];
console.log(`request-path work, ${MEMORIES} memories in each of the local and global stores; the time is the median of ${RUNS} and fails nothing`);
try {
  for (const [label, run, [maxStatements, maxRows, maxOpens]] of cases) {
    const ms = [];
    for (let r = 0; r < RUNS; r++) {
      const t = performance.now();
      await run();
      ms.push(performance.now() - t);
    }
    const median = ms.sort((a, b) => a - b)[Math.floor(RUNS / 2)];
    const work = await countWork(run);
    const overWork = MEMORIES === CEILING_MEMORIES && (work.statements > maxStatements || work.rows > maxRows || work.opens > maxOpens);
    overworked ||= overWork;
    // A request that moves to a worker thread, or an open whose pragma text changes, counts nothing here, and the ceiling would pass it unread.
    uncounted ||= (maxStatements > 0 && work.statements === 0) || (maxOpens > 0 && work.opens === 0);
    console.log(`${label.padEnd(28)} ${median.toFixed(1).padStart(8)} ms  ${String(work.statements).padStart(4)} of ${maxStatements} statements, ${String(work.rows).padStart(6)} of ${maxRows} rows, ${String(work.opens).padStart(2)} of ${maxOpens} opens${overWork ? '  OVER CEILING' : ''}`);
    summary.push(`| ${label} | ${median.toFixed(1)} | ${work.statements} of ${maxStatements} | ${work.rows} of ${maxRows} | ${work.opens} of ${maxOpens} |`);
  }
} finally {
  // The threads hold the store's files until they exit, and Windows cannot remove a folder with an open file.
  await server.stop();
  await inProcessServer.stop();
  await inProcess.close();
  await served.close();
  process.chdir(os.tmpdir());
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Request-path work at ${MEMORIES} memories\n\n${summary.join('\n')}\n\n`);
if (overworked) console.error('request-path work: a request ran more statements, read more rows or opened more stores than its ceiling; find the new query before raising a ceiling');
if (uncounted) console.error('request-path work: a request with ceilings ran no statement or opened no store on this thread; count its work where it now runs');
if (overworked || uncounted) process.exit(1);
