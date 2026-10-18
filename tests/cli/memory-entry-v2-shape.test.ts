// 2.0 entry shape: snake_case tenant_id and a boolean summary_dirty, on a real store.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { cliApiContext } from '../../src/cli/api-context.js';
import { memoryList } from '../../src/api/memories/memories.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { listDormantSnapshots } from '../../src/store/dormant.js';
import { makeStore } from '../_helpers/make-root.js';
import { readEntry, writeEntry } from '../_helpers/root-forms.js';

let root: string;

beforeEach(() => {
  root = makeStore('entry-shape').root;
});

afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

describe('MemoryEntry 2.0 shape', () => {
  it('round-trips tenant_id and a boolean summary_dirty', () => {
    const entry = createMemory('acme deploys on tuesdays', { tenantId: 'acme' });
    writeEntry(root, entry);
    const back = readEntry(root, entry.id, 'acme');
    expect(back?.tenant_id).toBe('acme');
    expect(back?.summary_dirty).toBe(false);
    expect(back).not.toHaveProperty('tenantId');
  });

  it('refuses an entry that carries the 1.x tenantId and no tenant_id', () => {
    const { tenant_id: _dropped, ...rest } = createMemory('legacy caller', { tenantId: 'acme' });
    // @ts-expect-error a 1.x caller still passes tenantId
    expect(() => writeEntry(root, { ...rest, tenantId: 'acme' })).toThrow(
      new TypeError('tenantId was renamed to tenant_id in 2.0'),
    );
  });

  it('revives a 1.x dormant JSON row with the right tenant and a boolean flag', () => {
    const { tenant_id: _dropped, ...rest } = createMemory('dormant from 1.x', { tenantId: 'acme' });
    const snapshot = { ...rest, tenantId: 'acme', summary_dirty: 1 };
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO dormant_memories (tenant_id, id, content, entry_json, reason, strength, dormant_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'acme',
        rest.id,
        rest.content,
        JSON.stringify(snapshot),
        'decay',
        0.1,
        '2026-01-01T00:00:00.000Z',
      );
      const [snap] = listDormantSnapshots(db, 'acme');
      expect(snap?.entry.tenant_id).toBe('acme');
      expect(snap?.entry.summary_dirty).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('emits tenant_id and a boolean summary_dirty in the export JSON', async () => {
    writeEntry(root, createMemory('exported note', { tenantId: 'acme' }));
    const exported = JSON.parse(JSON.stringify(await memoryList(cliApiContext(root, 'acme')), null, 2));
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ tenant_id: 'acme', summary_dirty: false });
    expect(exported[0]).not.toHaveProperty('tenantId');
  });
});
