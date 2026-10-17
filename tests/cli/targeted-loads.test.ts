// Perf slice: each changed read keeps its result and pins its load shape through the statements a real store runs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { countMatching, recordStatements, recordStatementsAsync } from '../_helpers/count-statements.js';
import { cliApiContext } from '../../src/cli/api-context.js';
import { listMemories } from '../../src/api/memories/memories.js';
import { loadAllEntries, readEntry } from '../../src/store/entry-reads.js';
import { strengthenRetrieved, writeEntry, writeEntryDbOnly } from '../../src/store/entry-writes.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { closeHippoDb, openHippoDb, withSharedStoreHandles } from '../../src/db/index.js';
import { storedTextKeys } from '../../src/util/same-text.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadContextCandidates, loadEntryTextKeys } from '../_helpers/root-forms.js';

let root: string;

beforeEach(() => {
  root = makeStore('targeted-loads').root;
});

afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

// One transaction and no mirrors: these tests read rows only, and 1003 mirrored writes overran the Windows timeout.
async function seed(count: number, tenantId = 'default'): Promise<string[]> {
  const ids: string[] = [];
  const db = openHippoDb(root);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const e = createMemory(`seeded memory number ${i} about topic${i % 7}`, { tenantId });
      writeEntryDbOnly(db, { ...e, created: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
      ids.push(e.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    closeHippoDb(db);
  }
  return ids;
}

describe('loadEntryTextKeys', () => {
  it('holds the same text keys as the whole-row read, for one tenant or all', async () => {
    await seed(5);
    await seed(3, 'acme');
    const all = storedTextKeys(loadAllEntries(root, 'default'));
    expect(storedTextKeys(loadEntryTextKeys(root))).toEqual(all);
    const acme = storedTextKeys(loadAllEntries(root, 'acme'));
    expect(storedTextKeys(loadEntryTextKeys(root, 'acme'))).toEqual(acme);
    expect(acme.size).toBe(3);
  });

  it('reads four columns, not whole rows', async () => {
    await seed(2);
    const { statements } = recordStatements(() => loadEntryTextKeys(root, 'default'));
    const select = statements.find((sql) => sql.startsWith('SELECT id, tenant_id'))!;
    expect(select).toContain('SELECT id, tenant_id, content, source FROM memories');
    expect(select).not.toContain('tags_json');
  });
});

describe('listMemories paging', () => {
  it('pages the same rows in the same order as one whole read', async () => {
    await seed(7);
    const ctx = cliApiContext(root, 'default');
    const { result, statements } = await recordStatementsAsync(() => listMemories(ctx, {}, { pageSize: 3 }));
    expect(result.map((e) => e.id)).toEqual(loadAllEntries(root, 'default').map((e) => e.id));
    expect(countMatching(statements, /FROM memories .*LIMIT \?/)).toBe(3);
  });

  it('pages past ties on created, and an empty store gives no rows', async () => {
    const ctx = cliApiContext(root, 'default');
    expect(await listMemories(ctx, {}, { pageSize: 2 })).toEqual([]);
    await withSharedStoreHandles(() => {
      for (let i = 0; i < 5; i++) writeEntry(root, { ...createMemory(`tied row ${i}`, { tenantId: 'default' }), created: '2026-02-02T00:00:00.000Z' });
    });
    expect((await listMemories(ctx, {}, { pageSize: 2 })).map((e) => e.id)).toEqual(loadAllEntries(root, 'default').map((e) => e.id));
  });

  it('reads every row across the default page boundary', async () => {
    await seed(1003);
    const ctx = cliApiContext(root, 'default');
    const { result, statements } = await recordStatementsAsync(() => listMemories(ctx));
    expect(result.map((e) => e.id)).toEqual(loadAllEntries(root, 'default').map((e) => e.id));
    expect(countMatching(statements, /FROM memories .*LIMIT \?/)).toBe(2);
  });
});

describe('loadContextCandidates', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  it('skips the decay rank when every match fits under the cap, and still ranks past it', async () => {
    await seed(6);
    const under = recordStatements(() => loadContextCandidates(root, 'default', { cap: 10, now: NOW }));
    expect(under.result).toHaveLength(6);
    expect(countMatching(under.statements, 'julianday')).toBe(0);
    expect(under.result.map((e) => e.id)).toEqual(loadAllEntries(root, 'default').map((e) => e.id));

    const over = recordStatements(() => loadContextCandidates(root, 'default', { cap: 4, now: NOW }));
    expect(over.result).toHaveLength(4);
    expect(countMatching(over.statements, 'julianday')).toBe(1);
  });
});

describe('strengthenRetrieved', () => {
  it('writes every returned row in one statement with the same values as a single-row write', async () => {
    const ids = await seed(4);
    const { result, statements } = recordStatements(() => strengthenRetrieved(root, ids, { recallBoostAblated: false }));
    expect([...result].sort()).toEqual([...ids].sort());
    expect(countMatching(statements, /UPDATE memories SET retrieval_count/)).toBe(1);
    for (const id of ids) {
      const after = readEntry(root, id)!;
      expect(after.retrieval_count).toBe(1);
      expect(after.half_life_days).toBe(createMemory('xyz memory').half_life_days + 2);
      expect(after.last_retrieved).not.toBe(after.created);
    }
  });
});

describe('rejections.apply', () => {
  it('finds holders from text columns and reads whole rows only for the matches', async () => {
    await seed(5);
    const target = createMemory('the deploy window is friday afternoon', { tenantId: 'default' });
    writeEntry(root, target);
    const { rejections } = sqliteSyncStore(root);
    const { result, statements } = recordStatements(() => rejections.apply({
      tenantId: 'default', actor: 'tester', reason: 'wrong', textOf: () => '  The Deploy WINDOW is friday   afternoon ',
      inReach: () => true, successorOf: () => undefined,
    }));
    expect(result.removedIds).toEqual([target.id]);
    expect(readEntry(root, target.id)).toBeNull();
    expect(loadAllEntries(root, 'default')).toHaveLength(5);
    expect(countMatching(statements, 'SELECT id, content, source, scope FROM memories')).toBe(1);
    expect(countMatching(statements, /SELECT .*tags_json.* FROM memories WHERE tenant_id = \? ORDER BY created ASC/)).toBe(0);
  });
});
