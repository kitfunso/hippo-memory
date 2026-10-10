// P7 gate: getContext with a query ranks recall's FTS candidate window from each store, never the whole store.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeEntryDbOnly } from '../src/store/entry-writes.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../src/store/rows.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import type { MemoryEntry } from '../src/core/memory.js';
import type { DeliveryObserver } from '../src/store/delivery-recorder.js';
import { getContext, adminActor, type Context } from '../src/api/index.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';
import { recordStatementsAsync, countMatching } from './_helpers/count-statements.js';

const ROWS = 10_000;
const OWN_ROWS = 10;
const QUERY = 'deploy step';

function fill(root: string, count: number, label: string, origin: (i: number) => string): void {
  const db = openHippoDb(root);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      writeEntryDbOnly(db, { ...createMemory(`${label} note ${i} about the deploy step w${i % 97}`, { tags: [`t${i % 7}`] }), origin_project: origin(i) });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    closeHippoDb(db);
  }
}

/** Counts every row the loader hands to admission, which is every row the search can rank. */
function admitCounter() {
  const seen = new Set<string>();
  let calls = 0;
  const noop = (): void => undefined;
  const obs: DeliveryObserver = {
    facts: noop, sections: noop, qualityDropped: noop, disabled: noop, offer: noop, reject: noop, dropMissing: noop, gated: noop, selected: noop, queried: noop, traced: noop,
    watchAdmit: (admit) => (e: MemoryEntry) => {
      calls++;
      seen.add(e.id);
      return admit(e);
    },
  };
  return { obs, seen, calls: () => calls };
}

let local = '';
let global = '';
let ctx: Context;

beforeAll(() => {
  local = makeRoot('ctx-window-local');
  global = makeRoot('ctx-window-global');
  // Every row matches the query; all but the last OWN_ROWS come from another project.
  fill(local, ROWS, 'local', (i) => (i >= ROWS - OWN_ROWS ? 'proj' : 'other'));
  fill(global, 1_000, 'global', () => '');
  ctx = { hippoRoot: local, tenantId: 'default', actor: adminActor('test') };
}, 600_000);

afterAll(() => {
  rmSync(local, { recursive: true, force: true });
  rmSync(global, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllEnvs());

describe('getContext with a query reads the FTS candidate window', () => {
  it('ranks at most the window from a 10k-row local store', async () => {
    vi.stubEnv('HIPPO_HOME', join(local, 'no-global'));
    const counter = admitCounter();
    const result = await getContext(ctx, { q: QUERY, currentProject: '', deliveryObserver: counter.obs });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(counter.calls()).toBe(DEFAULT_SEARCH_CANDIDATE_LIMIT);
    for (const r of result.entries) expect(counter.seen.has(r.entry.id)).toBe(true);
  });

  it('ranks at most one window per store when the global store exists', async () => {
    vi.stubEnv('HIPPO_HOME', global);
    const counter = admitCounter();
    const result = await getContext(ctx, { q: QUERY, currentProject: '', deliveryObserver: counter.obs });

    // Both stores hold more matches than the window, so each fills it exactly.
    expect(result.entries.length).toBeGreaterThan(0);
    expect(counter.calls()).toBe(2 * DEFAULT_SEARCH_CANDIDATE_LIMIT);
    for (const r of result.entries) expect(counter.seen.has(r.entry.id)).toBe(true);
  });

  it("keeps other projects out of the window, so they cannot crowd out this project's rows", async () => {
    vi.stubEnv('HIPPO_HOME', join(local, 'no-global'));
    const counter = admitCounter();
    const result = await getContext(ctx, { q: QUERY, currentProject: 'proj', budget: 5000, deliveryObserver: counter.obs });

    expect(result.entries).toHaveLength(OWN_ROWS);
    expect(result.entries.every((r) => r.entry.origin_project === 'proj')).toBe(true);
    expect(counter.calls()).toBe(OWN_ROWS);
  });
});

describe('getContext with a query labels each result local or global', () => {
  const INDEX_READ = 'SELECT id, created, last_retrieved, strength, layer, tags_json, pinned FROM memories';

  it('reads no index of the 10k-row local store to do it', async () => {
    vi.stubEnv('HIPPO_HOME', global);
    const { result, statements, rowsRead } = await recordStatementsAsync(() => getContext(ctx, { q: QUERY, currentProject: '' }));

    expect(result.entries.length).toBeGreaterThan(0);
    expect(countMatching(statements, INDEX_READ)).toBe(0);
    expect(rowsRead).toBeLessThan(ROWS / 4);
  });

  it('labels a global hit local when sync left a copy outside the local window, and global when it did not', async () => {
    const small = makeRoot('ctx-window-small-global');
    try {
      // Long rows rank under the 10k short local matches, so the local window leaves the copy out.
      const padded = (label: string): MemoryEntry => createMemory(`${label} about the deploy step ${'filler '.repeat(60)}`);
      const synced = padded('synced quokka note');
      const globalOnly = padded('unsynced wombat note');
      fill(small, 0, 'none', () => '');
      const db = openHippoDb(small);
      try {
        writeEntryDbOnly(db, synced);
        writeEntryDbOnly(db, globalOnly);
      } finally {
        closeHippoDb(db);
      }
      const localDb = openHippoDb(local);
      try {
        writeEntryDbOnly(localDb, synced);
      } finally {
        closeHippoDb(localDb);
      }
      vi.stubEnv('HIPPO_HOME', small);
      const counter = admitCounter();
      const result = await getContext(ctx, { q: QUERY, currentProject: '', budget: 1_000_000, deliveryObserver: counter.obs });

      const labels = new Map(result.entries.map((r) => [r.entry.id, r.isGlobal]));
      expect(labels.get(synced.id)).toBe(false);
      expect(labels.get(globalOnly.id)).toBe(true);
    } finally {
      rmSync(small, { recursive: true, force: true });
    }
  });
});
