// The vector graph file a sleep saves beside hippo.db, read on a real store in process: it answers for the rows it
// covers, the rows above them are scored exactly, and a file it cannot trust leaves the read to the scan.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeHippoDb, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { saveVectorGraphFile } from '../../src/db/vector-graph-build.js';
import { VectorGraphs } from '../../src/db/vector-graph-index.js';
import { GraphFileIndex } from '../../src/db/vector-graph-reader.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors, type VectorIndex } from '../../src/db/vector-store.js';
import type { VectorCandidateSpec } from '../../src/store/port/vectors.js';
import { loadVectorCandidateEntries } from '../../src/store/sqlite/search-rows.js';
import { log } from '../../src/base/util/log.js';
import { ALL_TENANTS, type TenantId } from '../../src/base/util/tenant.js';
import { makeRoot } from '../_helpers/make-root.js';
import { clusteredVectors, near, seedVectorRows, type VectorRowSeed } from '../_helpers/vector-rows.js';

// Each case builds a graph of 1,500 nodes, which can pass the unit budget on a busy runner.
vi.setConfig({ testTimeout: 30_000 });

const DIM = 32;
const ROWS = 1_500;
const MODEL = 'test:vectors';
const SEEDS = [1, 2, 3];
// recall@10 against the exact scan: HNSW is approximate, and the file walks on int8 vectors before the exact re-rank.
const RECALL_FLOOR = 0.97;
const OPTS = { maxVectors: 200_000 };

const opened: DatabaseSyncLike[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeHippoDb(db);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

interface Fixture {
  readonly root: string;
  readonly db: DatabaseSyncLike;
  readonly index: VectorIndex;
  /** The rowid each read was answered up to, or undefined for a read left to the scan. */
  readonly covered: (number | undefined)[];
}

function graphFile(root: string): string {
  return join(root, `vector-graph-${DIM}.bin`);
}

/** Tenants t1, t2 and t3 in turn, every fifth row of t1 in scope team-a. */
function mixedRows(n: number, seed: number): VectorRowSeed[] {
  return clusteredVectors(n, DIM, seed).map((vector, i) => ({
    id: `m-${seed}-${i}`,
    tenantId: `t${(i % 3) + 1}`,
    vector,
    ...(i % 15 === 0 && { scope: 'team-a' }),
  }));
}

function spec(tenantId: TenantId, extra: Partial<VectorCandidateSpec> = {}): VectorCandidateSpec {
  return { tenantId, scope: { mode: 'default-deny' }, includeSuperseded: false, limit: 10, ...extra };
}

function onStore(root: string): Fixture {
  const db = openHippoDb(root);
  opened.push(db);
  const file = new GraphFileIndex(root);
  const covered: (number | undefined)[] = [];
  const index: VectorIndex = {
    matches: (...args) => {
      const found = file.matches(...args);
      covered.push(found?.coveredRowid);
      return found;
    },
  };
  return { root, db, index, covered };
}

async function savedStore(rows: readonly VectorRowSeed[]): Promise<Fixture> {
  const root = makeRoot('vector-graph-file');
  seedVectorRows(root, rows, MODEL);
  await saveVectorGraphFile(root, OPTS);
  return onStore(root);
}

/** A write by another connection, as the writer thread, the CLI or a hook makes one. */
function elsewhere<T>(root: string, write: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return write(db);
  } finally {
    closeHippoDb(db);
  }
}

async function nearest(f: Fixture, q: readonly number[], s: VectorCandidateSpec, index = f.index): Promise<string[]> {
  return (await loadVectorCandidateEntries(f.db, q, s, index)).map((e) => e.id);
}

async function scanned(f: Fixture, q: readonly number[], s: VectorCandidateSpec): Promise<string[]> {
  return (await loadVectorCandidateEntries(f.db, q, s)).map((e) => e.id);
}

/** recall@10 against the scan over 20 queries near stored rows. */
async function recall(f: Fixture, rows: readonly VectorRowSeed[], s: VectorCandidateSpec, index = f.index) {
  let hits = 0;
  let wanted = 0;
  for (let n = 0; n < 20; n++) {
    const q = near(rows[(n * 37) % rows.length].vector, 500 + n);
    const truth = new Set(await scanned(f, q, s));
    hits += (await nearest(f, q, s, index)).filter((id) => truth.has(id)).length;
    wanted += truth.size;
  }
  return hits / wanted;
}

function rowidOf(db: DatabaseSyncLike, id: string): number {
  // SAFETY: the read names the one column it is cast to, and the caller names a stored row.
  return (db.prepare('SELECT rowid AS rowid FROM memory_vectors WHERE memory_id = ?').get(id) as { rowid: number })
    .rowid;
}

describe('a saved graph file', () => {
  it(`reaches recall@10 of ${RECALL_FLOOR} against the scan on ${SEEDS.length} seeds, for all rows, a tenant and a scope`, async () => {
    for (const seed of SEEDS) {
      const rows = mixedRows(ROWS, seed);
      const f = await savedStore(rows);
      const team = spec('t1', { scope: { mode: 'exact', value: 'team-a' } });

      for (const [label, s] of [
        ['all rows', spec(ALL_TENANTS)],
        ['one tenant', spec('t1')],
        ['one scope', team],
      ] as const) {
        expect(await recall(f, rows, s), `seed ${seed}, ${label}`).toBeGreaterThanOrEqual(RECALL_FLOOR);
      }
      expect(f.covered.every((rowid) => rowid === ROWS)).toBe(true);
    }
  });

  it('answers as the store worker graph it was saved from does', async () => {
    for (const seed of SEEDS) {
      const rows = mixedRows(ROWS, seed);
      const root = makeRoot('vector-graph-file');
      seedVectorRows(root, rows, MODEL);
      const f = onStore(root);
      const graphs = new VectorGraphs(root);
      await nearest(f, rows[0].vector, spec(ALL_TENANTS), graphs);
      await graphs.idle();

      expect(fs.existsSync(graphFile(root))).toBe(true);
      const fromGraph = await recall(f, rows, spec('t2'), graphs);
      const fromFile = await recall(f, rows, spec('t2'));
      expect(fromFile, `seed ${seed}`).toBeGreaterThanOrEqual(Math.min(fromGraph, RECALL_FLOOR));
      graphs.close();
    }
  });

  it('after added, forgotten, re-embedded and reused rows answers for what it covers and scores the rest', async () => {
    for (const seed of SEEDS) {
      const rows = mixedRows(ROWS, seed);
      const f = await savedStore(rows);
      const q = near(rows[11].vector, seed);
      const added = clusteredVectors(100, DIM, 100 + seed).map((vector, i) => ({
        id: `new-${i}`,
        tenantId: 't1',
        vector,
      }));
      added[0] = { ...added[0], vector: q };
      seedVectorRows(f.root, added, MODEL);
      const gone = rows.filter((_, i) => i % 20 === 7).map((r) => r.id);
      elsewhere(f.root, (db) =>
        db.prepare(`DELETE FROM memories WHERE id IN (${gone.map(() => '?').join()})`).run(...gone),
      );
      // The newest row is forgotten and SQLite hands its rowid to the next row.
      elsewhere(f.root, (db) => db.prepare("DELETE FROM memories WHERE id = 'new-99'").run());
      seedVectorRows(f.root, [{ id: 'reused', tenantId: 't1', vector: q }], MODEL);
      // A re-embed deletes the row and writes a new one above every other, so no node is updated in place.
      const moved = rows.slice(30, 40).map((r, i): [string, readonly number[]] => [r.id, near(q, 1000 + i)]);
      const before = moved.map(([id]) => rowidOf(f.db, id));
      elsewhere(f.root, (db) => upsertVectors(db, moved, MODEL));
      const after = moved.map(([id]) => rowidOf(f.db, id));

      expect(rowidOf(f.db, 'reused')).toBe(ROWS + 100);
      expect(after).toEqual(before.map((_, i) => ROWS + 101 + i));
      for (const s of [spec(ALL_TENANTS), spec('t1')]) {
        const answer = await nearest(f, q, s);
        expect(answer).toEqual(await scanned(f, q, s));
        expect(answer.slice(0, 2)).toEqual(['new-0', 'reused']);
      }
      expect(await nearest(f, q, spec(ALL_TENANTS))).toEqual(expect.arrayContaining([moved[0][0]]));
      expect(await recall(f, rows, spec('t2')), `seed ${seed}`).toBeGreaterThanOrEqual(RECALL_FLOOR);
      expect(f.covered.every((rowid) => rowid === ROWS)).toBe(true);
    }
  });
});

describe('a read the saved file cannot answer goes to the scan', () => {
  it('when a fifth of its rows are forgotten, the model changed, the length differs or there is no file', async () => {
    const rows = mixedRows(ROWS, 4);
    const f = await savedStore(rows);
    const q = near(rows[3].vector, 4);
    const otherLength = near(clusteredVectors(1, DIM + 1, 5)[0], 5);

    const ids = rows.filter((_, i) => i % 5 === 0).map((r) => r.id);
    elsewhere(f.root, (db) =>
      db.prepare(`DELETE FROM memories WHERE id IN (${ids.map(() => '?').join()})`).run(...ids),
    );
    const stale = await nearest(f, q, spec(ALL_TENANTS));
    await nearest(f, otherLength, spec(ALL_TENANTS));
    elsewhere(f.root, (db) => setMeta(db, EMBEDDING_MODEL_META_KEY, 'test:other-model'));
    await nearest(f, q, spec(ALL_TENANTS));
    fs.rmSync(graphFile(f.root));
    await nearest(f, q, spec(ALL_TENANTS));

    expect(stale).toEqual(await scanned(f, q, spec(ALL_TENANTS)));
    expect(f.covered).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('when the file is short or not a graph file, with one warn line for each file', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const rows = mixedRows(ROWS, 6);
    const f = await savedStore(rows);
    const q = near(rows[8].vector, 6);
    const whole = fs.readFileSync(graphFile(f.root));

    fs.writeFileSync(graphFile(f.root), whole.subarray(0, whole.length - 100));
    const short = [await nearest(f, q, spec(ALL_TENANTS)), await nearest(f, q, spec(ALL_TENANTS))];
    fs.writeFileSync(graphFile(f.root), Buffer.concat([Buffer.from('JUNK'), whole.subarray(4)]));
    const junk = await nearest(f, q, spec(ALL_TENANTS));

    expect([...short, junk]).toEqual([0, 1, 2].map(() => short[0]));
    expect(short[0]).toEqual(await scanned(f, q, spec(ALL_TENANTS)));
    expect(f.covered).toEqual([undefined, undefined, undefined]);
    expect(warned(warn)).toEqual([
      expect.stringContaining('short file'),
      expect.stringContaining('not a version 1 vector graph file'),
    ]);
  });
});

/** The header fields a corruption test needs to find one record. */
interface RecordLayout {
  readonly nodes: number;
  readonly entry: number;
  readonly recordsAt: number;
  readonly recordBytes: number;
}

function layoutOf(bytes: Buffer): RecordLayout {
  const recordsAt = Math.ceil((64 + bytes.readUInt32LE(28)) / 8) * 8;
  return {
    nodes: bytes.readUInt32LE(16),
    entry: bytes.readUInt32LE(20),
    recordsAt,
    recordBytes: bytes.readUInt32LE(44),
  };
}

/** Every positional read of a file opened from now on, as [position, length]. */
function recordReads(): [number, number][] {
  const reads: [number, number][] = [];
  const read = fs.readSync.bind(fs);
  // SAFETY: the reader calls only the positional overload, and the wrapper passes every argument of it through.
  vi.spyOn(fs, 'readSync').mockImplementation(((
    fd: number,
    buf: NodeJS.ArrayBufferView,
    off: number,
    len: number,
    pos: number,
  ) => {
    reads.push([pos, len]);
    return read(fd, buf, off, len, pos);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  return reads;
}

describe('a value out of bounds deep in the file', () => {
  it.each([
    ['a layer-0 link of the last record', 'out of range'],
    ["the entry's upper-links offset", 'out of bounds'],
  ])('in %s ends the read with one warn line and no read past the file', async (where, says) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const rows = mixedRows(ROWS, 7);
    const f = await savedStore(rows);
    const bytes = fs.readFileSync(graphFile(f.root));
    const { nodes, entry, recordsAt, recordBytes } = layoutOf(bytes);
    const last = rows[rows.length - 1];
    expect(bytes[recordsAt + entry * recordBytes + 12], 'the entry sits above layer 0').toBeGreaterThan(0);
    if (where.startsWith('a layer-0')) bytes.writeUInt32LE(nodes + 7, recordsAt + (nodes - 1) * recordBytes + 20);
    else bytes.writeUInt32LE(0xfffffff0, recordsAt + entry * recordBytes + 16);
    fs.writeFileSync(graphFile(f.root), bytes);
    const reads = recordReads();

    const answers = [
      await nearest(f, last.vector, spec(ALL_TENANTS)),
      await nearest(f, last.vector, spec(ALL_TENANTS)),
    ];

    expect(answers).toEqual([0, 1].map(() => answers[0]));
    expect(answers[0]).toEqual(await scanned(f, last.vector, spec(ALL_TENANTS)));
    expect(answers[0][0]).toBe(last.id);
    expect(f.covered).toEqual([undefined, undefined]);
    expect(warned(warn)).toEqual([expect.stringContaining(says)]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(([pos, len]) => pos + len <= bytes.length)).toBe(true);
  });
});

describe('a reader that lives across queries', () => {
  it('reads the file once for two queries and again after the file is replaced', async () => {
    const rows = mixedRows(ROWS, 8);
    const f = await savedStore(rows);
    const q = near(rows[5].vector, 8);
    const reads = recordReads();

    await nearest(f, q, spec(ALL_TENANTS));
    const first = reads.length;
    await nearest(f, q, spec(ALL_TENANTS));
    expect(first, 'the first query reads the file').toBeGreaterThan(0);
    expect(reads.length, 'the second query reads nothing').toBe(first);

    const tmp = `${graphFile(f.root)}.next`;
    fs.writeFileSync(tmp, fs.readFileSync(graphFile(f.root)));
    fs.renameSync(tmp, graphFile(f.root));
    await nearest(f, q, spec(ALL_TENANTS));
    expect(reads.length, 'a replaced file is read again').toBeGreaterThan(first);
    expect(f.covered.every((c) => c !== undefined)).toBe(true);
  });
});

const warned = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('vector graph'));

describe('saving the file', () => {
  it('skips with one info line and keeps the old file when another process holds it open', async () => {
    const rows = mixedRows(ROWS, 8);
    const f = await savedStore(rows);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const old = fs.readFileSync(graphFile(f.root));
    seedVectorRows(f.root, mixedRows(200, 80), MODEL);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    });
    syncBuiltinESMExports();

    await saveVectorGraphFile(f.root, OPTS);

    expect(fs.readFileSync(graphFile(f.root)).equals(old)).toBe(true);
    expect(fs.readdirSync(f.root).filter((name) => name.startsWith('vector-graph'))).toEqual([
      `vector-graph-${DIM}.bin`,
    ]);
    expect(warned(info)).toEqual([expect.stringContaining('is open in another process (EBUSY)')]);
  });

  it('holds no lock: a writer with no busy wait commits between the pages of a build', async () => {
    const root = makeRoot('vector-graph-file');
    seedVectorRows(root, mixedRows(ROWS, 9), MODEL);
    const saving = saveVectorGraphFile(root, OPTS);
    let settled = false;
    void saving.then(() => {
      settled = true;
    });
    let writes = 0;
    while (!settled) {
      elsewhere(root, (db) => {
        db.exec('PRAGMA busy_timeout = 0');
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
          'graph-test',
          String(writes),
        );
        db.exec('COMMIT');
      });
      writes++;
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(writes).toBeGreaterThan(2);
    expect(fs.existsSync(graphFile(root))).toBe(true);
  });

  it('gives up with one info line, writing nothing, once the deadline has passed', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const root = makeRoot('vector-graph-file');
    seedVectorRows(root, mixedRows(ROWS, 10), MODEL);

    await saveVectorGraphFile(root, { ...OPTS, deadline: Date.now() - 1 });

    expect(fs.existsSync(graphFile(root))).toBe(false);
    expect(warned(info)).toEqual([expect.stringContaining("the sleep's deadline came first")]);
  });

  it.skipIf(process.platform === 'win32')('gives the file the mode bits of hippo.db', async () => {
    const f = await savedStore(mixedRows(ROWS, 11));

    expect(fs.statSync(graphFile(f.root)).mode & 0o777).toBe(fs.statSync(join(f.root, 'hippo.db')).mode & 0o777);
  });
});
