import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openHippoDb,
  closeHippoDb,
  getSchemaVersion,
  getCurrentSchemaVersion,
  withSharedStoreHandles,
} from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { wmPush, wmRead, wmClear } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

// The store's per-scope cap; a literal here so a change to it fails these tests on purpose.
const WM_MAX_ENTRIES = 20;

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeRoot('wm-test');
});

describe('schema migration', () => {
  it('creates the working_memory table at schema version 6', () => {
    const db = openHippoDb(tmpDir);
    try {
      expect(getSchemaVersion(db)).toBe(getCurrentSchemaVersion());
      // Table should exist — inserting should not throw
      db.prepare(`SELECT COUNT(*) AS cnt FROM working_memory`).get();
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('wmPush', () => {
  it('creates entries and returns the row ID', async () => {
    const id = await wmPush(tmpDir, { scope: 'test', content: 'first note' });
    expect(id).toBe(1);

    const id2 = await wmPush(tmpDir, { scope: 'test', content: 'second note' });
    expect(id2).toBe(2);
  });

  it('stores all fields correctly', async () => {
    await wmPush(tmpDir, {
      scope: 'build',
      content: 'npm run build failed',
      importance: 0.9,
      sessionId: 'sess_abc',
      taskId: 'task_123',
      metadata: { retries: 3 },
    });

    const items = await wmRead(tmpDir, { scope: 'build' });
    expect(items).toHaveLength(1);

    const item = items[0]!;
    expect(item.scope).toBe('build');
    expect(item.content).toBe('npm run build failed');
    expect(item.importance).toBe(0.9);
    expect(item.sessionId).toBe('sess_abc');
    expect(item.taskId).toBe('task_123');
    expect(item.metadata).toEqual({ retries: 3 });
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('defaults importance to 0 when not provided', async () => {
    await wmPush(tmpDir, { scope: 'test', content: 'no importance' });
    const items = await wmRead(tmpDir, { scope: 'test' });
    expect(items[0]!.importance).toBe(0);
  });
});

describe('bounded buffer eviction', () => {
  it('evicts entries when exceeding WM_MAX_ENTRIES per scope', async () => {
    // Push WM_MAX_ENTRIES + 5 entries
    await withSharedStoreHandles(async () => {
      for (let i = 0; i < WM_MAX_ENTRIES + 5; i++) {
        await wmPush(tmpDir, {
          scope: 'evict-test',
          content: `entry ${i}`,
          importance: 0.5,
        });
      }
    });

    const items = await wmRead(tmpDir, { scope: 'evict-test', limit: 100 });
    expect(items).toHaveLength(WM_MAX_ENTRIES);
  });

  it('evicts the lowest-importance entries first', async () => {
    // Push entries with varying importance
    // Low importance entries that should be evicted
    await withSharedStoreHandles(async () => {
      for (let i = 0; i < WM_MAX_ENTRIES; i++) {
        await wmPush(tmpDir, {
          scope: 'priority',
          content: `low-${i}`,
          importance: 0.1,
        });
      }
    });

    // Push one high-importance entry — should evict the oldest low-importance one
    await wmPush(tmpDir, {
      scope: 'priority',
      content: 'high-priority',
      importance: 0.9,
    });

    const items = await wmRead(tmpDir, { scope: 'priority', limit: 100 });
    expect(items).toHaveLength(WM_MAX_ENTRIES);

    // The high-priority entry should remain
    const highItem = items.find((item) => item.content === 'high-priority');
    expect(highItem?.importance).toBe(0.9);
  });

  it('evicts the oldest of equal entries, even when all share one created_at', async () => {
    // A frozen clock gives every push the same created_at, the tie a fast loop hits by chance.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    try {
      await withSharedStoreHandles(async () => {
        for (let i = 0; i < WM_MAX_ENTRIES; i++) {
          await wmPush(tmpDir, { scope: 'tie-break', content: `entry-${i}`, importance: 0.5 });
        }
      });
      await wmPush(tmpDir, { scope: 'tie-break', content: 'newest', importance: 0.5 });
    } finally {
      vi.useRealTimers();
    }

    const items = await wmRead(tmpDir, { scope: 'tie-break', limit: 100 });
    expect(items).toHaveLength(WM_MAX_ENTRIES);

    const contents = items.map((item) => item.content);
    expect(contents).not.toContain('entry-0');
    expect(contents).toContain('newest');
  });

  it('does not evict across different scopes', async () => {
    // Fill scope A to the max
    await withSharedStoreHandles(async () => {
      for (let i = 0; i < WM_MAX_ENTRIES; i++) {
        await wmPush(tmpDir, { scope: 'scope-a', content: `a-${i}` });
      }
    });

    // Push to scope B — should not affect scope A
    await wmPush(tmpDir, { scope: 'scope-b', content: 'b-entry' });

    const aItems = await wmRead(tmpDir, { scope: 'scope-a', limit: 100 });
    const bItems = await wmRead(tmpDir, { scope: 'scope-b', limit: 100 });

    expect(aItems).toHaveLength(WM_MAX_ENTRIES);
    expect(bItems).toHaveLength(1);
  });
});

describe('wmRead', () => {
  it('returns entries sorted by importance DESC', async () => {
    await wmPush(tmpDir, { scope: 'read', content: 'low', importance: 0.1 });
    await wmPush(tmpDir, { scope: 'read', content: 'high', importance: 0.9 });
    await wmPush(tmpDir, { scope: 'read', content: 'mid', importance: 0.5 });

    const items = await wmRead(tmpDir, { scope: 'read' });
    expect(items.map((i) => i.content)).toEqual(['high', 'mid', 'low']);
  });

  it('filters by scope', async () => {
    await wmPush(tmpDir, { scope: 'alpha', content: 'a' });
    await wmPush(tmpDir, { scope: 'beta', content: 'b' });
    await wmPush(tmpDir, { scope: 'alpha', content: 'c' });

    const alpha = await wmRead(tmpDir, { scope: 'alpha' });
    expect(alpha).toHaveLength(2);
    expect(alpha.every((i) => i.scope === 'alpha')).toBe(true);
  });

  it('filters by sessionId', async () => {
    await wmPush(tmpDir, { scope: 's', content: 'with-session', sessionId: 'sess_1' });
    await wmPush(tmpDir, { scope: 's', content: 'no-session' });

    const filtered = await wmRead(tmpDir, { sessionId: 'sess_1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.content).toBe('with-session');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await wmPush(tmpDir, { scope: 'limit-test', content: `item-${i}` });
    }

    const items = await wmRead(tmpDir, { scope: 'limit-test', limit: 3 });
    expect(items).toHaveLength(3);
  });

  it('returns empty array when no entries', async () => {
    const items = await wmRead(tmpDir);
    expect(items).toEqual([]);
  });
});

describe('wmClear', () => {
  it('deletes all entries when no filter provided', async () => {
    await wmPush(tmpDir, { scope: 'a', content: 'one' });
    await wmPush(tmpDir, { scope: 'b', content: 'two' });

    const count = await wmClear(tmpDir);
    expect(count).toBe(2);

    const items = await wmRead(tmpDir);
    expect(items).toHaveLength(0);
  });

  it('deletes only entries matching scope', async () => {
    await wmPush(tmpDir, { scope: 'keep', content: 'keep this' });
    await wmPush(tmpDir, { scope: 'remove', content: 'remove this' });

    const count = await wmClear(tmpDir, { scope: 'remove' });
    expect(count).toBe(1);

    const remaining = await wmRead(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.scope).toBe('keep');
  });

  it('deletes only entries matching sessionId', async () => {
    await wmPush(tmpDir, { scope: 's', content: 'a', sessionId: 'sess_x' });
    await wmPush(tmpDir, { scope: 's', content: 'b', sessionId: 'sess_y' });

    const count = await wmClear(tmpDir, { sessionId: 'sess_x' });
    expect(count).toBe(1);

    const remaining = await wmRead(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sessionId).toBe('sess_y');
  });

  it('returns 0 when nothing to clear', async () => {
    const count = await wmClear(tmpDir, { scope: 'nonexistent' });
    expect(count).toBe(0);
  });
});

describe('tenant scoping', () => {
  it("keeps one tenant from reading, clearing or evicting another tenant's rows", async () => {
    await wmPush(tmpDir, { scope: 'shared', content: 'acme note', tenantId: 'acme' });
    await withSharedStoreHandles(async () => {
      for (let i = 0; i < WM_MAX_ENTRIES + 3; i++) {
        await wmPush(tmpDir, { scope: 'shared', content: `globex ${i}`, tenantId: 'globex' });
      }
    });

    expect((await wmRead(tmpDir, { tenantId: 'acme' })).map((i) => i.content)).toEqual(['acme note']);
    expect(await wmRead(tmpDir, { tenantId: 'globex', limit: 100 })).toHaveLength(WM_MAX_ENTRIES);
    expect(await wmClear(tmpDir, { tenantId: 'globex' })).toBe(WM_MAX_ENTRIES);
    expect(await wmRead(tmpDir, { tenantId: 'globex', limit: 100 })).toEqual([]);
    expect(await wmRead(tmpDir, { tenantId: 'acme' })).toHaveLength(1);
  });

  it('still lists a row written before the tenant column was filled in, for the default tenant', async () => {
    const db = openHippoDb(tmpDir);
    try {
      db.prepare(
        `INSERT INTO working_memory(scope, importance, content, metadata_json, created_at, updated_at) VALUES ('old', 1, 'pre-change row', '{}', 't', 't')`,
      ).run();
    } finally {
      closeHippoDb(db);
    }
    expect((await wmRead(tmpDir)).map((i) => i.content)).toEqual(['pre-change row']);
    expect(await wmRead(tmpDir, { tenantId: 'acme' })).toEqual([]);
  });
});
