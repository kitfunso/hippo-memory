import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initStore } from '../src/store.js';
import {
  wmPush,
  wmRead,
  wmClear,
  wmFlush,
  WM_MAX_ENTRIES,
  WorkingMemoryItem,
} from '../src/working-memory.js';
import { openHippoDb, closeHippoDb, getSchemaVersion } from '../src/db.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-wm-test-'));
  initStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('schema migration', () => {
  it('creates the working_memory table at schema version 6', () => {
    const db = openHippoDb(tmpDir);
    try {
      expect(getSchemaVersion(db)).toBe(7);
      // Table should exist — inserting should not throw
      db.prepare(`SELECT COUNT(*) AS cnt FROM working_memory`).get();
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('wmPush', () => {
  it('creates entries and returns the row ID', () => {
    const id = wmPush(tmpDir, { scope: 'test', content: 'first note' });
    expect(id).toBeGreaterThan(0);

    const id2 = wmPush(tmpDir, { scope: 'test', content: 'second note' });
    expect(id2).toBeGreaterThan(id);
  });

  it('stores all fields correctly', () => {
    wmPush(tmpDir, {
      scope: 'build',
      content: 'npm run build failed',
      importance: 0.9,
      sessionId: 'sess_abc',
      taskId: 'task_123',
      metadata: { retries: 3 },
    });

    const items = wmRead(tmpDir, { scope: 'build' });
    expect(items).toHaveLength(1);

    const item = items[0]!;
    expect(item.scope).toBe('build');
    expect(item.content).toBe('npm run build failed');
    expect(item.importance).toBe(0.9);
    expect(item.sessionId).toBe('sess_abc');
    expect(item.taskId).toBe('task_123');
    expect(item.metadata).toEqual({ retries: 3 });
    expect(item.createdAt).toBeTruthy();
    expect(item.updatedAt).toBeTruthy();
  });

  it('defaults importance to 0 when not provided', () => {
    wmPush(tmpDir, { scope: 'test', content: 'no importance' });
    const items = wmRead(tmpDir, { scope: 'test' });
    expect(items[0]!.importance).toBe(0);
  });
});

describe('bounded buffer eviction', () => {
  it('evicts entries when exceeding WM_MAX_ENTRIES per scope', () => {
    // Push WM_MAX_ENTRIES + 5 entries
    for (let i = 0; i < WM_MAX_ENTRIES + 5; i++) {
      wmPush(tmpDir, {
        scope: 'evict-test',
        content: `entry ${i}`,
        importance: 0.5,
      });
    }

    const items = wmRead(tmpDir, { scope: 'evict-test', limit: 100 });
    expect(items).toHaveLength(WM_MAX_ENTRIES);
  });

  it('evicts the lowest-importance entries first', () => {
    // Push entries with varying importance
    // Low importance entries that should be evicted
    for (let i = 0; i < WM_MAX_ENTRIES; i++) {
      wmPush(tmpDir, {
        scope: 'priority',
        content: `low-${i}`,
        importance: 0.1,
      });
    }

    // Push one high-importance entry — should evict the oldest low-importance one
    wmPush(tmpDir, {
      scope: 'priority',
      content: 'high-priority',
      importance: 0.9,
    });

    const items = wmRead(tmpDir, { scope: 'priority', limit: 100 });
    expect(items).toHaveLength(WM_MAX_ENTRIES);

    // The high-priority entry should remain
    const highItem = items.find((item) => item.content === 'high-priority');
    expect(highItem).toBeDefined();
    expect(highItem!.importance).toBe(0.9);
  });

  it('breaks eviction ties by oldest created_at', () => {
    // All same importance — oldest should be evicted
    for (let i = 0; i < WM_MAX_ENTRIES; i++) {
      wmPush(tmpDir, {
        scope: 'tie-break',
        content: `entry-${i}`,
        importance: 0.5,
      });
    }

    // Push one more with same importance — should evict entry-0 (oldest)
    wmPush(tmpDir, {
      scope: 'tie-break',
      content: 'newest',
      importance: 0.5,
    });

    const items = wmRead(tmpDir, { scope: 'tie-break', limit: 100 });
    expect(items).toHaveLength(WM_MAX_ENTRIES);

    const contents = items.map((item) => item.content);
    expect(contents).not.toContain('entry-0');
    expect(contents).toContain('newest');
  });

  it('does not evict across different scopes', () => {
    // Fill scope A to the max
    for (let i = 0; i < WM_MAX_ENTRIES; i++) {
      wmPush(tmpDir, { scope: 'scope-a', content: `a-${i}` });
    }

    // Push to scope B — should not affect scope A
    wmPush(tmpDir, { scope: 'scope-b', content: 'b-entry' });

    const aItems = wmRead(tmpDir, { scope: 'scope-a', limit: 100 });
    const bItems = wmRead(tmpDir, { scope: 'scope-b', limit: 100 });

    expect(aItems).toHaveLength(WM_MAX_ENTRIES);
    expect(bItems).toHaveLength(1);
  });
});

describe('wmRead', () => {
  it('returns entries sorted by importance DESC', () => {
    wmPush(tmpDir, { scope: 'read', content: 'low', importance: 0.1 });
    wmPush(tmpDir, { scope: 'read', content: 'high', importance: 0.9 });
    wmPush(tmpDir, { scope: 'read', content: 'mid', importance: 0.5 });

    const items = wmRead(tmpDir, { scope: 'read' });
    expect(items.map((i) => i.content)).toEqual(['high', 'mid', 'low']);
  });

  it('filters by scope', () => {
    wmPush(tmpDir, { scope: 'alpha', content: 'a' });
    wmPush(tmpDir, { scope: 'beta', content: 'b' });
    wmPush(tmpDir, { scope: 'alpha', content: 'c' });

    const alpha = wmRead(tmpDir, { scope: 'alpha' });
    expect(alpha).toHaveLength(2);
    expect(alpha.every((i) => i.scope === 'alpha')).toBe(true);
  });

  it('filters by sessionId', () => {
    wmPush(tmpDir, { scope: 's', content: 'with-session', sessionId: 'sess_1' });
    wmPush(tmpDir, { scope: 's', content: 'no-session' });

    const filtered = wmRead(tmpDir, { sessionId: 'sess_1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.content).toBe('with-session');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      wmPush(tmpDir, { scope: 'limit-test', content: `item-${i}` });
    }

    const items = wmRead(tmpDir, { scope: 'limit-test', limit: 3 });
    expect(items).toHaveLength(3);
  });

  it('returns empty array when no entries', () => {
    const items = wmRead(tmpDir);
    expect(items).toEqual([]);
  });
});

describe('wmClear', () => {
  it('deletes all entries when no filter provided', () => {
    wmPush(tmpDir, { scope: 'a', content: 'one' });
    wmPush(tmpDir, { scope: 'b', content: 'two' });

    const count = wmClear(tmpDir);
    expect(count).toBe(2);

    const items = wmRead(tmpDir);
    expect(items).toHaveLength(0);
  });

  it('deletes only entries matching scope', () => {
    wmPush(tmpDir, { scope: 'keep', content: 'keep this' });
    wmPush(tmpDir, { scope: 'remove', content: 'remove this' });

    const count = wmClear(tmpDir, { scope: 'remove' });
    expect(count).toBe(1);

    const remaining = wmRead(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.scope).toBe('keep');
  });

  it('deletes only entries matching sessionId', () => {
    wmPush(tmpDir, { scope: 's', content: 'a', sessionId: 'sess_x' });
    wmPush(tmpDir, { scope: 's', content: 'b', sessionId: 'sess_y' });

    const count = wmClear(tmpDir, { sessionId: 'sess_x' });
    expect(count).toBe(1);

    const remaining = wmRead(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sessionId).toBe('sess_y');
  });

  it('returns 0 when nothing to clear', () => {
    const count = wmClear(tmpDir, { scope: 'nonexistent' });
    expect(count).toBe(0);
  });
});

describe('wmFlush', () => {
  it('deletes entries just like wmClear', () => {
    wmPush(tmpDir, { scope: 'flush', content: 'temp note', sessionId: 'sess_done' });
    wmPush(tmpDir, { scope: 'flush', content: 'another', sessionId: 'sess_done' });
    wmPush(tmpDir, { scope: 'other', content: 'keep' });

    const count = wmFlush(tmpDir, { sessionId: 'sess_done' });
    expect(count).toBe(2);

    const remaining = wmRead(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.scope).toBe('other');
  });

  it('flushes everything when no filter provided', () => {
    wmPush(tmpDir, { scope: 'a', content: 'one' });
    wmPush(tmpDir, { scope: 'b', content: 'two' });

    const count = wmFlush(tmpDir);
    expect(count).toBe(2);

    expect(wmRead(tmpDir)).toHaveLength(0);
  });
});
