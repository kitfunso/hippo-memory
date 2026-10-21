// 3.0 entry shape: camelCase fields in memory, snake_case keys in every stored and exported format.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { cliApiContext } from '../../src/surface/cli/api-context.js';
import { memoryList } from '../../src/api/memories/memories.js';
import { toWire } from '../../src/base/memory/memory-wire.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { listDormantSnapshots } from '../_helpers/dormant-snapshots.js';
import { makeStore } from '../_helpers/make-root.js';
import { readEntry, writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let root: string;

beforeEach(() => {
  root = makeStore('entry-shape').root;
});

afterEach(() => removeAfterRequest(join(root, '..')));

describe('MemoryEntry 3.0 shape', () => {
  it('round-trips tenantId and a boolean summaryDirty', () => {
    const entry = createMemory('acme deploys on tuesdays', { tenantId: 'acme' });
    writeEntry(root, entry);
    const back = readEntry(root, entry.id, 'acme');
    expect(back?.tenantId).toBe('acme');
    expect(back?.summaryDirty).toBe(false);
    expect(back).not.toHaveProperty('tenant_id');
  });

  it('refuses an entry that carries the 2.x tenant_id and no tenantId', () => {
    const { tenantId: _dropped, ...rest } = createMemory('legacy caller', { tenantId: 'acme' });
    // @ts-expect-error a 2.x caller still passes tenant_id
    expect(() => writeEntry(root, { ...rest, tenant_id: 'acme' })).toThrow(
      new TypeError('tenant_id was renamed to tenantId in 3.0'),
    );
  });

  it('revives a 1.x dormant JSON row with the right tenant and a boolean flag', () => {
    const entry = createMemory('dormant from 1.x', { tenantId: 'acme' });
    const { tenant_id: _dropped, ...wire } = toWire(entry);
    const snapshot = { ...wire, tenantId: 'acme', summary_dirty: 1 };
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO dormant_memories (tenant_id, id, content, entry_json, reason, strength, dormant_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'acme',
        entry.id,
        entry.content,
        JSON.stringify(snapshot),
        'decay',
        0.1,
        '2026-01-01T00:00:00.000Z',
      );
      const [snap] = listDormantSnapshots(db, 'acme');
      expect(snap?.entry.tenantId).toBe('acme');
      expect(snap?.entry.summaryDirty).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('keeps tenant_id and a boolean summary_dirty in the export JSON', async () => {
    writeEntry(root, createMemory('exported note', { tenantId: 'acme' }));
    const entries = await memoryList(cliApiContext(root, 'acme'));
    const exported = JSON.parse(JSON.stringify(entries.map(toWire), null, 2));
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ tenant_id: 'acme', summary_dirty: false });
    expect(exported[0]).not.toHaveProperty('tenantId');
  });
});
