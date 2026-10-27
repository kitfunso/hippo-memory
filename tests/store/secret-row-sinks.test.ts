// The row primitives store the redacted form of content and source, so no caller of them can land a raw secret in memories or its full-text rows.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  replaceFtsRows,
  syncFtsRow,
  updateMemoryRows,
  upsertEntryRow,
  upsertMemoryRow,
} from '../../src/store/sqlite/entry-row.js';
import { duplicateHash } from '../../src/base/util/same-text.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';

const GHP = runtimeJoin('ghp_', 'x1Y2z3W4v5'.repeat(3), 'Q6r7S8');
const RAW = `the ci token is ${GHP}`;
const STORED = 'the ci token is [REDACTED]';

let db: DatabaseSyncLike;

beforeEach(() => {
  db = openHippoDb(makeRoot('secret-row-sinks'));
});

afterEach(() => {
  closeHippoDb(db);
});

function row(id: string): { content: string; source: string; duplicate_hash: number } {
  return db.prepare('SELECT content, source, duplicate_hash FROM memories WHERE id = ?').get(id) as {
    content: string;
    source: string;
    duplicate_hash: number;
  };
}

function ftsContent(id: string): string[] {
  return (db.prepare('SELECT content FROM memories_fts WHERE id = ?').all(id) as { content: string }[]).map(
    (r) => r.content,
  );
}

describe('memory row sinks', () => {
  it('upsertEntryRow stores content, source, hash and full-text row in stored form', () => {
    const entry = { ...createMemory(RAW), id: 'mem_s1', source: `import:${GHP}` };
    upsertEntryRow(db, entry);
    expect(row('mem_s1')).toEqual({ content: STORED, source: 'import:[REDACTED]', duplicate_hash: duplicateHash(STORED) });
    expect(ftsContent('mem_s1')).toEqual([STORED]);
  });

  it('upsertMemoryRow still says whether the row is new', () => {
    const entry = { ...createMemory(RAW), id: 'mem_s2' };
    expect(upsertMemoryRow(db, entry)).toBe(true);
    expect(upsertMemoryRow(db, entry)).toBe(false);
    expect(row('mem_s2').content).toBe(STORED);
  });

  it('updateMemoryRows redacts and returns the ids whose stored text differs from the input', () => {
    const secret = { ...createMemory('clean first'), id: 'mem_s3' };
    const clean = { ...createMemory('stays clean'), id: 'mem_s4' };
    upsertMemoryRow(db, secret);
    upsertMemoryRow(db, clean);
    expect(updateMemoryRows(db, [{ ...secret, content: RAW }, clean])).toEqual(['mem_s3']);
    expect(row('mem_s3').content).toBe(STORED);
  });

  it('syncFtsRow and replaceFtsRows index the stored form', () => {
    syncFtsRow(db, { id: 'mem_f1', content: RAW, tags: [] }, true);
    replaceFtsRows(db, [{ ...createMemory(RAW), id: 'mem_f2' }], []);
    expect(ftsContent('mem_f1')).toEqual([STORED]);
    expect(ftsContent('mem_f2')).toEqual([STORED]);
  });
});
