// The window fixture: 1,600 seeded memories whose ten targets sit past row 200 of the BM25 order and inside row 1,000.
// Run alone, it builds the fixture and checks that placement; no arm runs and no embedding is needed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminActor, goalPush, outcome } from '../../dist/api/index.js';
import { loadConfig } from '../../dist/core/config.js';
import { createMemory } from '../../dist/core/memory.js';
import { writeEntry } from '../../dist/store/entry-writes.js';
import { loadRecallSearchEntries } from '../../dist/store/search-rows.js';
import { resolveTenantId } from '../../dist/store/tenant.js';
import { WINDOW_QUERY_COUNT, type EvalQuery } from './queries.ts';
import { inSandbox, initSandbox } from './sandbox.ts';

const SEED = 20261004;
const STRONG_ROWS = 600;
const WEAK_ROWS = 990;
export const WINDOW_ROW_COUNT = 1600;
const FIRST_ROW = 201;
const LAST_ROW = 1000;
const GOOD_OUTCOMES = 3;

/** Both terms sit in every row, so the BM25 order comes from term count and row length alone. */
export const WINDOW_QUERY = 'turbine gasket';

// Filler words: none is a query term, and none is a word hippo reads as a signal.
const VOCAB = (
  'harbor ledger meadow lantern quarry orchard saddle anchor copper willow granite ribbon candle pebble thistle barley ' +
  'walnut feather compass shutter trellis kettle basket mortar plank gravel timber canvas marble pillar lattice ferry ' +
  'bridge tunnel cellar attic porch gable chimney shingle rafter girder trowel chisel mallet anvil bellows furnace hearth ' +
  'ladle spindle bobbin thimble needle button collar sleeve pocket satchel parcel crate barrel bucket trough funnel sieve ' +
  'grater whisk skillet platter saucer pitcher tumbler goblet decanter carafe flagon tankard beaker vial flask cruet'
).split(' ');

interface Goal { readonly tag: string; readonly sessionId: string }

// One goal per session, so each goal query boosts its own target and not the other's.
const GOALS: readonly Goal[] = [
  { tag: 'wfxgoal1', sessionId: 'wfx-session-1' },
  { tag: 'wfxgoal2', sessionId: 'wfx-session-2' },
];

interface Target {
  readonly id: string;
  /** A token no other row holds, so a query can name this target without ranking by it. */
  readonly marker: string;
  readonly lift: 'pinned' | 'goal' | 'outcomes' | 'none';
  readonly goal?: Goal;
}

const LIFTS: readonly Pick<Target, 'lift' | 'goal'>[] = [
  { lift: 'pinned' },
  { lift: 'pinned' },
  { lift: 'goal', goal: GOALS[0] },
  { lift: 'goal', goal: GOALS[1] },
  { lift: 'outcomes' },
  { lift: 'none' },
  { lift: 'none' },
  { lift: 'none' },
  { lift: 'none' },
  { lift: 'none' },
];

const TARGETS: readonly Target[] = LIFTS.map((lift, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { id: `mem_wfx_t${n}`, marker: `wfxt${n}`, ...lift };
});

/** The unlifted targets. One in any arm's top 5 means the fixture is broken, and no result is reported. */
export const CONTROL_MARKERS: readonly string[] = TARGETS.filter((t) => t.lift === 'none').map((t) => t.marker);

interface Row {
  readonly id: string;
  readonly content: string;
  readonly tags: string[];
  readonly pinned: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 1,600 rows, the same on every call: strong filler, weak filler, then the targets. */
export function windowRows(): Row[] {
  const rng = mulberry32(SEED);
  const words = (n: number): string[] => Array.from({ length: n }, () => VOCAB[Math.floor(rng() * VOCAB.length)]!);
  const serial = (i: number): string => String(i + 1).padStart(4, '0');
  const rows: Row[] = [];
  for (let i = 0; i < STRONG_ROWS; i++) {
    const [a, b, c, d] = words(4);
    rows.push({ id: `mem_wfx_s${serial(i)}`, content: `wfxs${serial(i)} ${a} ${WINDOW_QUERY} ${b} ${c} ${WINDOW_QUERY} ${d}`, tags: [], pinned: false });
  }
  for (let i = 0; i < WEAK_ROWS; i++) {
    const filler = words(30 + Math.floor(rng() * 15));
    filler.splice(Math.floor(rng() * filler.length), 0, WINDOW_QUERY);
    rows.push({ id: `mem_wfx_w${serial(i)}`, content: `wfxw${serial(i)} ${filler.join(' ')}`, tags: [], pinned: false });
  }
  for (const t of TARGETS) {
    const [a, b] = words(2);
    rows.push({ id: t.id, content: `${t.marker} ${WINDOW_QUERY} ${a} ${b}`, tags: t.goal ? [t.goal.tag] : [], pinned: t.lift === 'pinned' });
  }
  if (rows.length !== WINDOW_ROW_COUNT) throw new Error(`the window fixture is ${rows.length} rows, not ${WINDOW_ROW_COUNT}`);
  return rows;
}

/** One query per lifted target: the same words each time, a different target to find in the top 5. */
export function windowQueries(): EvalQuery[] {
  const queries = TARGETS.filter((t) => t.lift !== 'none').map((t, i): EvalQuery => ({
    id: `window#${i + 1} (${t.lift})`,
    corpus: 'window',
    fixture: 'window',
    text: WINDOW_QUERY,
    topK: 5,
    mustContainAny: [t.marker],
    mustNotContainAny: [],
    stages: t.goal ? { sessionId: t.goal.sessionId } : {},
    budget: 4000,
    goalPushes: [],
  }));
  if (queries.length !== WINDOW_QUERY_COUNT) throw new Error(`the window fixture has ${queries.length} queries, not ${WINDOW_QUERY_COUNT}`);
  return queries;
}

export interface WindowStore { readonly root: string; readonly tenantId: string }

/** Writes the fixture into a fresh sandbox: `hippo init`'s default config, the seeded rows, then the lifts through their own verbs. */
export function buildWindowFixture(home: string): Promise<WindowStore> {
  initSandbox(home);
  const root = join(home, '.hippo');
  return inSandbox(home, home, async () => {
    const tenantId = resolveTenantId({});
    const baseHalfLifeDays = loadConfig(root).defaultHalfLifeDays;
    // One stamp for every row, so age lifts none of them over another.
    const stamp = new Date().toISOString();
    for (const row of windowRows()) {
      const entry = createMemory(row.content, { baseHalfLifeDays, tenantId, tags: row.tags, pinned: row.pinned });
      writeEntry(root, { ...entry, id: row.id, created: stamp, last_retrieved: stamp, valid_from: stamp });
    }
    const ctx = { hippoRoot: root, tenantId, actor: adminActor('window-fixture') };
    for (const goal of GOALS) goalPush(ctx, { sessionId: goal.sessionId, goalName: goal.tag });
    for (const t of TARGETS.filter((x) => x.lift === 'outcomes')) {
      for (let i = 0; i < GOOD_OUTCOMES; i++) await outcome(ctx, [t.id], true);
    }
    return { root, tenantId };
  });
}

export interface Placement { readonly marker: string; readonly lift: Target['lift']; readonly row: number }

/** Each target's row in the SQL BM25 order every arm loads from. Throws when one is outside rows 201 to 1,000. */
export function checkPlacement(store: WindowStore): Placement[] {
  // The 200-row and 1,000-row loads are prefixes of this order: same ORDER BY, a smaller LIMIT.
  const order = loadRecallSearchEntries(store.root, WINDOW_QUERY, WINDOW_ROW_COUNT + 1, store.tenantId, undefined, 'exact', false);
  if (order.length !== WINDOW_ROW_COUNT) throw new Error(`${order.length} rows match the window query, not ${WINDOW_ROW_COUNT}`);
  const placements = TARGETS.map((t): Placement => ({ marker: t.marker, lift: t.lift, row: order.findIndex((e) => e.id === t.id) + 1 }));
  const outside = placements.filter((p) => p.row < FIRST_ROW || p.row > LAST_ROW);
  if (outside.length > 0) {
    throw new Error(`window fixture broken: ${outside.map((p) => `${p.marker} at row ${p.row}`).join(', ')}; every target must sit in rows ${FIRST_ROW} to ${LAST_ROW}`);
  }
  return placements;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-q3b-window-'));
  try {
    const store = await buildWindowFixture(join(dir, 'home'));
    for (const p of checkPlacement(store)) console.log(`${p.marker}  ${p.lift.padEnd(8)}  BM25 row ${p.row}`);
    console.log(`placement ok: ${WINDOW_ROW_COUNT} rows, every target in rows ${FIRST_ROW} to ${LAST_ROW}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
