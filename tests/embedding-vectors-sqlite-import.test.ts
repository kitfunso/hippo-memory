// A store from before schema v52 keeps its embeddings.json vectors: they move into memory_vectors once and the file stays as a backup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { openHippoDb, closeHippoDb, getMeta, setMeta, getSchemaVersion, getCurrentSchemaVersion } from '../src/db.js';
import { loadEmbeddingIndex, saveEmbeddingIndex } from '../src/embeddings.js';
import { decodeVector, deleteOrphanVectors, encodeVector, rankVectorRows, topVectorMatches, type VectorRow } from '../src/vector-store.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vec-import-'));
  initStore(root);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function withDb<T>(fn: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

// Puts the store back to v51: no vectors table, the index still in embeddings.json.
function downgradeToV51(): void {
  withDb((db) => {
    db.exec('DROP TRIGGER IF EXISTS trg_memory_vectors_delete; DROP TABLE IF EXISTS memory_vectors;');
    setMeta(db, 'schema_version', '51');
    db.exec('PRAGMA user_version = 51');
    setMeta(db, 'embedding_model', 'text-embedding-3-small#t2');
  });
}

const backups = (): string[] => fs.readdirSync(root).filter((f) => f.startsWith('embeddings.json.imported-'));
const vectorRows = (): Array<{ memory_id: string; model: string; dim: number }> =>
  // SAFETY: the SELECT names exactly these three columns.
  withDb((db) => db.prepare('SELECT memory_id, model, dim FROM memory_vectors ORDER BY memory_id').all() as Array<{ memory_id: string; model: string; dim: number }>);

describe('embeddings.json import at schema v52', () => {
  it('moves every usable vector into the table, keeps the file as a backup, and a second open changes nothing', () => {
    const a = createMemory('alpha note', { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const b = createMemory('beta note', { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, a);
    writeEntry(root, b);
    downgradeToV51();
    const raw = JSON.stringify({ [a.id]: [0.5, 0.25], [b.id]: [1, 0], bad: 'x', empty: [], nan: [1, 'y'] });
    fs.writeFileSync(path.join(root, 'embeddings.json'), raw, 'utf8');

    expect(loadEmbeddingIndex(root)).toEqual({ [a.id]: [0.5, 0.25], [b.id]: [1, 0] });
    expect(withDb(getSchemaVersion)).toBe(getCurrentSchemaVersion());
    expect(fs.existsSync(path.join(root, 'embeddings.json'))).toBe(false);
    expect(backups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, backups()[0]!), 'utf8')).toBe(raw);
    expect(vectorRows()).toEqual([a.id, b.id].sort().map((id) => ({ memory_id: id, model: 'text-embedding-3-small#t2', dim: 2 })));

    expect(Object.keys(loadEmbeddingIndex(root))).toHaveLength(2);
    expect(backups()).toHaveLength(1);
    expect(withDb((db) => getMeta(db, 'embedding_model'))).toBe('text-embedding-3-small#t2');
  });

  it('a file written later by an older binary imports on the next open', () => {
    const a = createMemory('alpha note', { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, a);
    fs.writeFileSync(path.join(root, 'embeddings.json'), JSON.stringify({ [a.id]: [0, 1] }), 'utf8');

    expect(loadEmbeddingIndex(root)).toEqual({ [a.id]: [0, 1] });
    expect(backups()).toHaveLength(1);
  });
});

describe('memory_vectors upkeep', () => {
  it('deleting a memory drops its vector', () => {
    const a = createMemory('alpha note', { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const b = createMemory('beta note', { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, a);
    writeEntry(root, b);
    saveEmbeddingIndex(root, { [a.id]: [1, 0], [b.id]: [0, 1] });

    expect(deleteEntry(root, a.id)).toBe(true);
    expect(Object.keys(loadEmbeddingIndex(root))).toEqual([b.id]);
  });

  it('pruning removes only vectors whose memory is gone', () => {
    const a = createMemory('alpha note', { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, a);
    saveEmbeddingIndex(root, { [a.id]: [1, 0], mem_gone: [0, 1] });

    expect(withDb(deleteOrphanVectors)).toBe(1);
    expect(Object.keys(loadEmbeddingIndex(root))).toEqual([a.id]);
  });

  it('decodes a BLOB that does not start on a 4-byte boundary', () => {
    const enc = encodeVector([1.5, -2]);
    const shifted = new Uint8Array(enc.length + 1);
    shifted.set(enc, 1);
    expect(Array.from(decodeVector(shifted.subarray(1)))).toEqual([1.5, -2]);
  });

  it('decodes an odd-offset Buffer, whose slice is a view and not a copy', () => {
    const enc = encodeVector([1.5, -2]);
    const shifted = Buffer.alloc(enc.length + 1);
    shifted.set(enc, 1);
    expect(Array.from(decodeVector(shifted.subarray(1)))).toEqual([1.5, -2]);
  });

  it('the nearest-vector scan breaks ties by id and returns nothing for a zero query', () => {
    const rows = ['c', 'a', 'b'].map((t) => createMemory(`${t} note`, { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    for (const r of rows) writeEntry(root, r);
    saveEmbeddingIndex(root, Object.fromEntries(rows.map((r) => [r.id, [1, 0]])));
    const ids = rows.map((r) => r.id).sort();

    expect(withDb((db) => topVectorMatches(db, [2, 0], 2, '', [])).map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(withDb((db) => topVectorMatches(db, [0, 0], 2, '', []))).toEqual([]);
    expect(withDb((db) => topVectorMatches(db, [1, 0, 0], 2, '', []))).toEqual([]);
  });
});

describe('rankVectorRows, the ranking an add-on store shares with hippo.db', () => {
  const row = (id: string, v: readonly number[]): VectorRow => ({ id, vector: Float32Array.from(v) });

  it('breaks a tie at the cut toward the smaller id, in either row order', () => {
    const rows = [row('b', [1, 0]), row('c', [3, 0]), row('a', [2, 0])];
    expect(rankVectorRows([1, 0], rows, 1).map((m) => m.id)).toEqual(['a']);
    expect(rankVectorRows([1, 0], [...rows].reverse(), 2).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('skips a zero-norm row and a row of another dim; a zero query, an empty one or k 0 ranks nothing', () => {
    const rows = [row('zero', [0, 0]), row('wide', [0, 1, 0]), row('ok', [0, 1])];
    expect(rankVectorRows([0, 1], rows, 5).map((m) => m.id)).toEqual(['ok']);
    expect([rankVectorRows([0, 0], rows, 5), rankVectorRows([], rows, 5), rankVectorRows([0, 1], rows, 0)]).toEqual([[], [], []]);
  });

  it('gives the ids and scores topVectorMatches gives on the same stored rows', () => {
    const vectors = [[0.1, 0.7, 0.3], [0.3, 0.1, 0.9], [0.1000001, 0.7, 0.3], [-0.5, 0.2, 0.1]];
    const rows = vectors.map((_, i) => createMemory(`note ${i}`, { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    for (const r of rows) writeEntry(root, r);
    saveEmbeddingIndex(root, Object.fromEntries(rows.map((r, i) => [r.id, vectors[i]!])));
    const q = [0.12345678901, 0.7, 0.29];
    const stored = Object.entries(loadEmbeddingIndex(root)).map(([id, v]) => row(id, v));
    const sql = withDb((db) => topVectorMatches(db, q, 3, '', []));
    expect(sql).toHaveLength(3);
    expect(rankVectorRows(q, stored, 3)).toEqual(sql);
  });
});
