// The quarantine fixture: records in three tenants, one with no memory row and one moved out of its quarantine
// scope, plus 105 records of one timestamp, written straight to hippo.db.
import { vi } from 'vitest';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { closeHippoDb } from '../../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { recordQuarantine } from '../../src/store/sqlite/quarantine.js';
import { TENANT_A, TENANT_B } from './store-conformance.js';
import { writeEntry } from './root-forms.js';
import { openStore } from '../../src/store/sqlite/handles.js';

export const HELD = {
  a1: 'mem_qa1',
  a2: 'mem_qa2',
  a3: 'mem_qa3',
  gone: 'mem_qgone',
  moved: 'mem_qmoved',
  b1: 'mem_qb1',
  solo: 'mem_qsolo',
} as const;
export const BULK_TENANT = 'bulk';
export const BULK_RECORDS = 105;
export const bulkId = (i: number): string => `mem_qbulk_${String(i).padStart(3, '0')}`;
export const heldAt = (second: number): string => `2020-02-01T00:00:${String(second).padStart(2, '0')}.000Z`;
export const heldContent = (id: string): string => `held note ${id} asks the reader to run a script`;

interface Seeded {
  readonly tenantId: string;
  readonly memoryId: string;
  readonly originalScope: string | null;
  readonly second: number;
  /** The scope of the memory row written in the record's tenant; unset writes no memory row. */
  readonly memoryScope?: string;
}

const held = (original: string | null): string => `quarantine:private:${original ?? 'unscoped'}`;

const SEEDED: readonly Seeded[] = [
  { tenantId: TENANT_A, memoryId: HELD.a1, originalScope: 'team:alpha', second: 1, memoryScope: held('team:alpha') },
  { tenantId: TENANT_A, memoryId: HELD.a2, originalScope: null, second: 2, memoryScope: held(null) },
  { tenantId: TENANT_A, memoryId: HELD.a3, originalScope: 'team:alpha', second: 2, memoryScope: held('team:alpha') },
  { tenantId: TENANT_A, memoryId: HELD.gone, originalScope: 'team:alpha', second: 3 },
  { tenantId: TENANT_A, memoryId: HELD.moved, originalScope: 'team:alpha', second: 4, memoryScope: 'team:elsewhere' },
  { tenantId: TENANT_B, memoryId: HELD.b1, originalScope: 'team:beta', second: 2, memoryScope: held('team:beta') },
  { tenantId: TENANT_B, memoryId: HELD.a1, originalScope: 'team:alpha', second: 3 },
  { tenantId: 'solo', memoryId: HELD.solo, originalScope: null, second: 5, memoryScope: held(null) },
];

/** Adds the records above, 105 records of one timestamp under `bulk`, and an admin key for tenant B whose bearer token it returns. */
export function seedQuarantineRecords(dir: string): string {
  const db = openStore(dir);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (const r of [
      ...SEEDED,
      ...Array.from({ length: BULK_RECORDS }, (_, i): Seeded => ({
        tenantId: BULK_TENANT,
        memoryId: bulkId(i),
        originalScope: null,
        second: 6,
      })),
    ]) {
      vi.setSystemTime(new Date(heldAt(r.second)));
      if (r.memoryScope !== undefined) {
        const entry = createMemory(heldContent(r.memoryId), {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          tenantId: r.tenantId,
          scope: r.memoryScope,
        });
        writeEntry(dir, { ...entry, id: r.memoryId });
      }
      recordQuarantine(db, {
        tenantId: r.tenantId,
        memoryId: r.memoryId,
        originalScope: r.originalScope,
        reason: 'test',
        actor: 'seed',
      });
    }
    return createApiKey(db, {
      tenantId: TENANT_B,
      label: 'globex-admin',
      role: 'admin',
      expiresAt: '2999-01-01T00:00:00.000Z',
    }).plaintext;
  } finally {
    vi.useRealTimers();
    closeHippoDb(db);
  }
}
