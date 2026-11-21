// Deleting a memory removes the graph rows only it backs, and the cascade takes their edges, on every delete path; rows left all-null before stay hidden from scoped readers.
import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadConfig } from '../../src/host/config-file.js';
import { deleteEntry } from '../_helpers/root-forms.js';
import { savePolicy } from '../../src/entry/testing.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { buildGraphModel } from '../../src/domain/graph/view.js';
import { storeFilesOf } from '../../src/store/sqlite/runtime/handles.js';
import { deleteEntriesInBatches } from '../../src/store/sqlite/entries/delete-and-batch.js';
import { deleteEntryRowInTx } from '../../src/store/sqlite/entries/entry-writes.js';
import { batchWriteAndDeleteInFolder } from '../../src/store/sqlite/fixtures.js';

const { writeEntry, readEntry, sqliteStore, objectsAt } = sessionPerTest();

const T = 'default';

function memory(home: string, text: string, pinned = false): MemoryEntry {
  const m = createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tags: [],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'test',
    tenantId: T,
    scope: null,
    pinned,
  });
  writeEntry(home, m, { actor: 'test' });
  return m;
}

interface Seeded {
  readonly m: MemoryEntry;
  readonly n: MemoryEntry;
  readonly eM: number;
  readonly eN: number;
  readonly eP: number;
  readonly rM: number;
  readonly rP: number;
  readonly rX: number;
  readonly rQ: number;
  readonly rN: number;
}

async function seed(home: string, pinned = false): Promise<Seeded> {
  const m = memory(home, 'graph cleanup memory M', pinned);
  const n = memory(home, 'graph cleanup memory N');
  const policy = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
    policyName: 'CleanupPolicy',
    policyText: 'kept by its object',
  });
  const ref = { type: 'policy', id: policy.id } as const;
  const eM = insertEntityAt(home, T, { entityType: 'system', name: 'eM', memoryId: m.id }).id;
  const eN = insertEntityAt(home, T, { entityType: 'system', name: 'eN', memoryId: n.id }).id;
  const eP = insertEntityAt(home, T, { entityType: 'policy', name: 'eP', memoryId: m.id, sourceObject: ref }).id;
  const rel = (
    to: number,
    relType: 'references' | 'depends-on' | 'owns' | 'blocked-by',
    memoryId: string,
    sourceObject?: typeof ref,
  ) => insertRelationAt(home, T, { fromEntityId: eN, toEntityId: to, relType, memoryId, sourceObject }).id;
  return {
    m,
    n,
    eM,
    eN,
    eP,
    rM: rel(eM, 'references', m.id),
    rP: rel(eP, 'references', m.id, ref),
    rX: rel(eM, 'depends-on', n.id),
    rQ: rel(eP, 'owns', m.id),
    rN: rel(eP, 'blocked-by', n.id),
  };
}

type Row = { id: number; memory_id: string | null; source_object_id: number | null };

function table(home: string, name: 'entities' | 'relations'): Map<number, Row> {
  const db = openHippoDb(home);
  try {
    // SAFETY: the SELECT list matches Row field for field.
    const rows = db.prepare(`SELECT id, memory_id, source_object_id FROM ${name}`).all() as Row[];
    return new Map(rows.map((r) => [r.id, r]));
  } finally {
    closeHippoDb(db);
  }
}

const onDb = <R>(home: string, fn: (db: ReturnType<typeof openHippoDb>) => R): R => {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
};

const PATHS: ReadonlyArray<readonly [string, (home: string, m: MemoryEntry) => void]> = [
  ['forget', (home, m) => void deleteEntry(home, m.id)],
  [
    'batches',
    (home, m) =>
      void onDb(home, (db) =>
        deleteEntriesInBatches(db, storeFilesOf(home), [{ id: m.id, reason: 'test' }], { actor: 'test' }),
      ),
  ],
  ['sleep flush', (home, m) => void batchWriteAndDeleteInFolder(home, [], [m.id])],
  ['set-aside', (home, m) => onDb(home, (db) => deleteEntryRowInTx(db, readEntry(home, m.id)!, 'test'))],
  [
    'admitted automatic delete',
    (home, m) => {
      const out = onDb(home, (db) =>
        deleteEntriesInBatches(db, storeFilesOf(home), [{ id: m.id, reason: 'test' }], {
          actor: 'test',
          automatic: true,
        }),
      );
      expect(out).toEqual([true]);
    },
  ],
];

describe('deleting a memory deletes the graph rows only it backs', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('graph-forget-cleanup');
  });

  it.each(PATHS)('T1 %s removes eM, rM, rQ and the cascaded rX; keeps the object rows', async (_name, run) => {
    const s = await seed(home);
    run(home, s.m);
    const ents = table(home, 'entities');
    const rels = table(home, 'relations');
    expect(ents.has(s.eM)).toBe(false);
    expect(rels.has(s.rM)).toBe(false);
    expect(rels.has(s.rX)).toBe(false);
    expect(rels.has(s.rQ)).toBe(false);
    expect(ents.get(s.eP)).toMatchObject({ memory_id: null });
    expect(ents.get(s.eP)!.source_object_id).not.toBeNull();
    expect(rels.get(s.rP)).toMatchObject({ memory_id: null });
    expect(rels.get(s.rP)!.source_object_id).not.toBeNull();
    expect(ents.get(s.eN)).toMatchObject({ memory_id: s.n.id });
    expect(rels.get(s.rN)).toMatchObject({ memory_id: s.n.id });
  });

  it('T2 a refused automatic delete keeps the rows', async () => {
    const s = await seed(home, true);
    const out = onDb(home, (db) =>
      deleteEntriesInBatches(db, storeFilesOf(home), [{ id: s.m.id, reason: 'test' }], {
        actor: 'test',
        automatic: true,
      }),
    );
    expect(out).toEqual([false]);
    const ents = table(home, 'entities');
    const rels = table(home, 'relations');
    expect(ents.get(s.eM)).toMatchObject({ memory_id: s.m.id });
    expect(rels.get(s.rM)).toMatchObject({ memory_id: s.m.id });
    expect(rels.has(s.rX)).toBe(true);
  });

  it('T3 rows left all-null before the fix stay hidden from scoped readers', async () => {
    const t = memory(home, 'graph orphan memory T');
    const kept = insertEntityAt(home, T, { entityType: 'system', name: 'KEPT', memoryId: t.id }).id;
    const orphan = insertEntityAt(home, T, { entityType: 'system', name: 'ORPHAN', memoryId: t.id }).id;
    const edge = insertRelationAt(home, T, {
      fromEntityId: orphan,
      toEntityId: kept,
      relType: 'references',
      memoryId: t.id,
    }).id;
    const policy = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'AnchoredPolicy',
      policyText: 'kept by its object',
    });
    insertEntityAt(home, T, {
      entityType: 'policy',
      name: 'ANCHORED',
      memoryId: null,
      sourceObject: { type: 'policy', id: policy.id },
    });
    onDb(home, (db) => {
      db.prepare('UPDATE entities SET memory_id = NULL WHERE id = ?').run(orphan);
      db.prepare('UPDATE relations SET memory_id = NULL WHERE id = ?').run(edge);
    });
    const names = (m: { nodes: { name: string }[] }): string[] => m.nodes.map((n) => n.name).sort();
    const reads = sqliteStore(home).graphReads;
    for (const reader of [{ role: 'member', owner: 'alice' }, { role: 'admin' }] as const) {
      const view = await buildGraphModel(reads, T, { reader });
      expect(names(view)).toEqual(['ANCHORED', 'KEPT']);
      expect(view.edges).toHaveLength(0);
    }
    const open = await buildGraphModel(reads, T, {});
    expect(names(open)).toEqual(['ANCHORED', 'KEPT', 'ORPHAN']);
    expect(open.edges).toHaveLength(1);
    expect(await buildGraphModel(reads, T, { entity: 'ORPHAN', reader: { role: 'member', owner: 'alice' } })).toEqual({
      nodes: [],
      edges: [],
      truncated: false,
    });
  });
});

const DELETE_SITE = /DELETE\s+FROM\s+memories\b/gi;

function countIn(pattern: RegExp, skip: string) {
  const src = join(__dirname, '..', '..', 'src');
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const rel = relative(src, p).split(sep).join('/');
        const hits = readFileSync(p, 'utf8').match(pattern)?.length ?? 0;
        if (hits > 0 && rel !== skip) out.set(rel, hits);
      }
    }
  };
  walk(src);
  return Object.fromEntries(out);
}

describe('every memory delete site clears graph rows first', () => {
  it('a new DELETE FROM memories must call deleteMemoryOnlyGraphRows first (raw rows excepted)', () => {
    expect(countIn(DELETE_SITE, '')).toEqual({
      'store/sqlite/entries/delete-and-batch.ts': 2,
      'store/sqlite/entries/entry-writes.ts': 1,
      'store/sqlite/entries/raw-archive.ts': 1,
    });
    expect(countIn(/deleteMemoryOnlyGraphRows\(/g, 'store/sqlite/graph/graph-writes.ts')).toEqual({
      'store/sqlite/entries/delete-and-batch.ts': 2,
      'store/sqlite/entries/entry-writes.ts': 1,
    });
  });

  it('each DELETE FROM memories has its helper call after the previous DELETE', () => {
    const src = join(__dirname, '..', '..', 'src', 'store', 'sqlite', 'entries');
    for (const file of ['delete-and-batch.ts', 'entry-writes.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      let from = 0;
      for (const del of text.matchAll(DELETE_SITE)) {
        expect(text.slice(from, del.index)).toContain('deleteMemoryOnlyGraphRows(');
        from = del.index + del[0].length;
      }
    }
  });
});
