// The vector graph a store worker holds, on a real store in process: it only proposes rows, so SQL's admission and the
// stored vectors decide every answer, and a read it cannot answer scans.
import { afterEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { VectorGraphs } from '../../src/db/vector-graph-index.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors, type VectorIndex } from '../../src/db/vector-store.js';
import type { VectorCandidateSpec } from '../../src/store/port/vector-reads.js';
import { loadVectorCandidateEntriesAt } from '../../src/store/search-rows.js';
import { makeRoot } from '../_helpers/make-root.js';
import { clusteredVectors, near, seedVectorRows, type VectorRowSeed } from '../_helpers/vector-rows.js';

const DIM = 32;
const THRESHOLD = 300;
const MODEL = 'test:vectors';

interface Fixture {
  readonly root: string;
  /** The connection reads run on, as a store worker's reader holds one. */
  readonly db: DatabaseSyncLike;
  readonly graphs: VectorGraphs;
  /** The graphs, counting the reads they answered rather than left to the scan. */
  readonly index: VectorIndex;
  readonly answered: boolean[];
}

const opened: DatabaseSyncLike[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeHippoDb(db);
});

function fixture(rows: readonly VectorRowSeed[]): Fixture {
  const root = makeRoot('vector-graph');
  seedVectorRows(root, rows, MODEL);
  const db = openHippoDb(root);
  opened.push(db);
  const graphs = new VectorGraphs(root, { threshold: THRESHOLD });
  const answered: boolean[] = [];
  const index: VectorIndex = {
    matches: (...args) => {
      const found = graphs.matches(...args);
      answered.push(found !== undefined);
      return found;
    },
  };
  return { root, db, graphs, index, answered };
}

/** A write by another connection, as the writer thread, the CLI or a hook makes one. */
function elsewhere(root: string, write: (db: DatabaseSyncLike) => void): void {
  const db = openHippoDb(root);
  try {
    write(db);
  } finally {
    closeHippoDb(db);
  }
}

function tenantRows(tenantId: string, n: number, seed: number, scope?: string): VectorRowSeed[] {
  return clusteredVectors(n, DIM, seed).map((vector, i) => ({
    id: `${tenantId}-${i}`,
    tenantId,
    vector,
    ...(scope && { scope }),
  }));
}

function spec(tenantId: string, extra: Partial<VectorCandidateSpec> = {}): VectorCandidateSpec {
  return { tenantId, scope: { mode: 'default-deny' }, includeSuperseded: false, limit: 10, ...extra };
}

async function nearest(f: Fixture, query: readonly number[], s: VectorCandidateSpec): Promise<string[]> {
  return (await loadVectorCandidateEntriesAt(f.db, query, s, f.index)).map((e) => e.id);
}

async function scanned(f: Fixture, query: readonly number[], s: VectorCandidateSpec): Promise<string[]> {
  return (await loadVectorCandidateEntriesAt(f.db, query, s)).map((e) => e.id);
}

/** The first read starts the build; the graph answers once it has settled. */
async function built(f: Fixture, query: readonly number[], s: VectorCandidateSpec): Promise<void> {
  await nearest(f, query, s);
  await f.graphs.idle();
}

describe('a store over the threshold', () => {
  it('answers by scan while its graph builds, and from the graph once it is ready', async () => {
    const rows = tenantRows('t1', 400, 1);
    const f = fixture(rows);
    const q = near(rows[7].vector, 1);
    const scan = await scanned(f, q, spec('t1'));

    // Both start before any turn of the build has run.
    const during = await Promise.all([nearest(f, q, spec('t1')), nearest(f, q, spec('t1'))]);
    await f.graphs.idle();
    const after = await nearest(f, q, spec('t1'));

    expect(during).toEqual([scan, scan]);
    expect(after).toEqual(scan);
    expect(f.answered).toEqual([false, false, true]);
  });

  it('scans a store under the threshold and builds no graph', async () => {
    const rows = tenantRows('t1', THRESHOLD - 1, 2);
    const f = fixture(rows);
    const q = near(rows[3].vector, 2);

    await built(f, q, spec('t1'));
    const answer = await nearest(f, q, spec('t1'));

    expect(answer).toEqual(await scanned(f, q, spec('t1')));
    expect(f.answered).toEqual([false, false]);
  });

  it('reaches recall@10 of at least 0.95 against the scan for each tenant of three', async () => {
    const tenants = ['t1', 't2', 't3'];
    const byTenant = tenants.map((t, i) => tenantRows(t, 200, 10 + i));
    const rows = byTenant[0].flatMap((row, i) => [row, byTenant[1][i], byTenant[2][i]]);
    const f = fixture(rows);
    await built(f, near(rows[0].vector, 0), spec('t1'));

    for (const [i, tenant] of tenants.entries()) {
      let hits = 0;
      for (let n = 0; n < 20; n++) {
        const q = near(byTenant[i][(n * 37) % 200].vector, 100 + n);
        const truth = new Set(await scanned(f, q, spec(tenant)));
        hits += (await nearest(f, q, spec(tenant))).filter((id) => truth.has(id)).length;
      }
      expect(hits / 200, tenant).toBeGreaterThanOrEqual(0.95);
    }
    expect(f.answered.slice(1).every(Boolean)).toBe(true);
  });
});

describe('a row the scan would not admit', () => {
  const twin = clusteredVectors(1, DIM, 99)[0];
  // Each holds the query's own vector, so the graph proposes it first; 'other-scope' is refused by the exact read only.
  const banned: VectorRowSeed[] = [
    { id: 'other-tenant', tenantId: 'b', vector: twin },
    { id: 'quarantined', tenantId: 'a', scope: 'quarantine:private:unscoped', vector: twin },
    { id: 'private', tenantId: 'a', scope: 'cli:private:someone', vector: twin },
    { id: 'forgotten', tenantId: 'a', scope: 'team-a', vector: twin },
    { id: 'other-scope', tenantId: 'a', scope: 'team-b', vector: twin },
  ];

  it('never comes back from the graph, which still finds the admitted rows the scan finds', async () => {
    const admitted = [
      ...tenantRows('a', 300, 3),
      ...tenantRows('team', 60, 4, 'team-a').map((r) => ({ ...r, tenantId: 'a' })),
    ];
    const f = fixture([...admitted, ...tenantRows('b', 100, 5), ...banned]);
    await built(f, twin, spec('a'));
    elsewhere(f.root, (db) => db.prepare("DELETE FROM memories WHERE id = 'forgotten'").run());

    const anyScope = await nearest(f, twin, spec('a'));
    const exactScope = await nearest(f, twin, spec('a', { scope: { mode: 'exact', value: 'team-a' } }));

    for (const [answer, refused] of [
      [anyScope, banned.slice(0, 4)],
      [exactScope, banned],
    ] as const) {
      expect(answer).toHaveLength(10);
      for (const row of refused) expect(answer).not.toContain(row.id);
    }
    expect(anyScope[0]).toBe('other-scope');
    expect(anyScope).toEqual(await scanned(f, twin, spec('a')));
    expect(exactScope).toEqual(await scanned(f, twin, spec('a', { scope: { mode: 'exact', value: 'team-a' } })));
    expect(f.answered.slice(1)).toEqual([true, true]);
  });
});

describe('a write by another connection', () => {
  function newMemory(root: string, id: string, vector: readonly number[]): void {
    seedVectorRows(root, [{ id, tenantId: 't1', vector }], MODEL);
  }

  it('shows in the next read, and a forgotten or replaced row leaves it', async () => {
    const rows = tenantRows('t1', 400, 6);
    const f = fixture(rows);
    const q = near(rows[11].vector, 6);
    await built(f, q, spec('t1'));

    newMemory(f.root, 'fresh', q);
    const added = await nearest(f, q, spec('t1'));
    elsewhere(f.root, (db) => upsertVectors(db, [['fresh', q.map((x) => -x)]], MODEL));
    const replaced = await nearest(f, q, spec('t1'));
    const replacedScan = await scanned(f, q, spec('t1'));
    newMemory(f.root, 'newest', q);
    const newest = await nearest(f, q, spec('t1'));
    elsewhere(f.root, (db) => db.prepare("DELETE FROM memories WHERE id = 'newest'").run());
    newMemory(f.root, 'reused', q);
    const reused = await nearest(f, q, spec('t1'));

    expect(added[0]).toBe('fresh');
    expect(replaced).not.toContain('fresh');
    expect(replaced).toEqual(replacedScan);
    expect(newest[0]).toBe('newest');
    // The forgotten row held the top rowid, which SQLite gave the next row again.
    expect(reused[0]).toBe('reused');
    expect(reused).not.toContain('newest');
    expect(f.answered.slice(1)).toEqual([true, true, true, true]);
  });

  it('that changes the index identity drops the graph, so the read scans and the next one rebuilds', async () => {
    const rows = tenantRows('t1', 400, 7);
    const f = fixture(rows);
    const q = near(rows[5].vector, 7);
    await built(f, q, spec('t1'));

    elsewhere(f.root, (db) => setMeta(db, EMBEDDING_MODEL_META_KEY, 'test:other-model'));
    const dropped = await nearest(f, q, spec('t1'));
    await built(f, q, spec('t1'));
    const rebuilt = await nearest(f, q, spec('t1'));

    expect([dropped, rebuilt]).toEqual([await scanned(f, q, spec('t1')), await scanned(f, q, spec('t1'))]);
    expect(f.answered.slice(1)).toEqual([false, false, true]);
  });

  it('that replaces over a tenth of the vectors rebuilds the graph without their old nodes', async () => {
    const rows = tenantRows('t1', 400, 8);
    const f = fixture(rows);
    const q = near(rows[2].vector, 8);
    await built(f, q, spec('t1'));
    const moved = clusteredVectors(60, DIM, 80);

    elsewhere(f.root, (db) =>
      upsertVectors(
        db,
        moved.map((v, i): [string, readonly number[]] => [rows[i].id, v]),
        MODEL,
      ),
    );
    const answers: string[][] = [];
    // Behind by more rows than one read inserts, then stale past a tenth, then rebuilt.
    for (let step = 0; step < 4; step++) {
      answers.push(await nearest(f, q, spec('t1')));
      await f.graphs.idle();
    }

    const scan = await scanned(f, q, spec('t1'));
    expect(answers).toEqual([scan, scan, scan, scan]);
    expect(f.answered.slice(1)).toEqual([false, false, false, true]);
  });
});

describe('a read the graph cannot fill', () => {
  it('falls back to the scan when fewer than k admitted rows are near', async () => {
    const rows = [...tenantRows('t1', 400, 9), ...tenantRows('few', 3, 90)];
    const f = fixture(rows);
    const q = near(rows[400].vector, 9);
    await built(f, q, spec('t1'));

    const answer = await nearest(f, q, spec('few'));

    expect([...answer].sort()).toEqual(['few-0', 'few-1', 'few-2']);
    expect(answer).toEqual(await scanned(f, q, spec('few')));
    expect(f.answered.slice(1)).toEqual([false]);
  });
});
