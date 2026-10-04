#!/usr/bin/env node
// Request-path latency at 10,000 memories per store: getContext and the MCP tools that read whole stores.
// Fails when any median passes the bound. Run after `npm run build`:
//   node scripts/check-request-path-timing.mjs [--memories 10000] [--bound-ms 2000]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const MEMORIES = flag('--memories', 10000);
const BOUND_MS = flag('--bound-ms', 2000);
const RUNS = 3;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-request-timing-'));
const localRoot = path.join(tmp, 'proj', '.hippo');
const globalRoot = path.join(tmp, 'global');
process.env.HIPPO_HOME = globalRoot;
// Outside git, so hippo_context's auto query is empty and the timing measures the store, not git.
process.chdir(tmp);

// Windows dynamic import() needs a file:// URL, not a raw drive path.
const load = (rel) => import(pathToFileURL(path.join(REPO, 'dist', rel)).href);
const { createMemory } = await load('memory.js');
const { initStore, writeEntryDbOnly, loadAmbientTallies } = await load('store.js');
const { openHippoDb, closeHippoDb } = await load('db.js');
const { getContext, adminActor } = await load('api.js');
const { handleMcpRequest } = await load('mcp/server.js');

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

const cases = [
  ['getContext, no query', () => getContext(ctx, { currentProject: 'proj' })],
  ['getContext, query', () => getContext(ctx, { q: 'kafka redis', currentProject: 'proj' })],
  ['getContext, pinned only', () => getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: 'proj' })],
  ['getContext, local query', withoutGlobal(() => getContext(ctx, { q: 'kafka redis', currentProject: 'proj' }))],
  ['ambient tallies, 2 stores', () => {
    for (const root of [localRoot, globalRoot]) loadAmbientTallies(root, 'default', { project: 'proj', currentProject: 'proj', now: new Date() });
  }],
  ['mcp hippo_context', tool('hippo_context')],
  ['mcp hippo_recall', tool('hippo_recall', { query: 'kafka redis' })],
  ['mcp hippo_status', tool('hippo_status')],
  ['mcp hippo_peers', tool('hippo_peers')],
];

let failed = false;
console.log(`request-path timing, ${MEMORIES} memories in each of the local and global stores, median of ${RUNS}, bound ${BOUND_MS} ms`);
try {
  for (const [label, run] of cases) {
    const ms = [];
    for (let r = 0; r < RUNS; r++) {
      const t = performance.now();
      await run();
      ms.push(performance.now() - t);
    }
    const median = ms.sort((a, b) => a - b)[Math.floor(RUNS / 2)];
    const over = median > BOUND_MS;
    failed ||= over;
    console.log(`${label.padEnd(26)} ${median.toFixed(1).padStart(8)} ms${over ? '  OVER BOUND' : ''}`);
  }
} finally {
  process.chdir(os.tmpdir());
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) {
  console.error('request-path timing: a request path passed its bound; a whole-store load is back on it');
  process.exit(1);
}
