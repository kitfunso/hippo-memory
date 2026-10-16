import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { dlqAccess, type DlqColumn, type DlqTable } from '../src/store/connectors/dlq.js';

type Row = Record<string, string | number | null>;
type Insert = Record<string, string | null>;

const COLUMNS: readonly DlqColumn[] = [
  { field: 'id', column: 'id', kind: 'int' },
  { field: 'tenantId', column: 'tenant_id', kind: 'text', insert: true },
  { field: 'rawPayload', column: 'raw_payload', kind: 'text', insert: true },
  { field: 'error', column: 'error', kind: 'text', insert: true },
];

describe('dlq identifier guard', () => {
  let root: string;
  let db: DatabaseSyncLike;
  // SAFETY: deliberately outside the union, to prove the runtime check holds when the types are bypassed.
  const badTable = 'slack_dlq; DROP TABLE memories' as DlqTable;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-dlq-guard-'));
    initStore(root);
    db = openHippoDb(root);
  });
  afterEach(() => {
    closeHippoDb(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts the real tables and columns', () => {
    const dlq = dlqAccess<Row, Insert>('slack_dlq', COLUMNS);
    const id = dlq.insert(db, { tenantId: 't', rawPayload: '{}', error: 'e' });
    expect(dlq.list(db, 't', 5)).toHaveLength(1);
    expect(dlq.get(db, id)).not.toBeNull();
    dlq.markRetried(db, id);
  });

  it('refuses a table outside the union', () => {
    const dlq = dlqAccess<Row, Insert>(badTable, COLUMNS);
    expect(() => dlq.insert(db, { tenantId: 't' })).toThrow(/Invalid DLQ table/);
    expect(() => dlq.list(db, 't', 1)).toThrow(/Invalid DLQ table/);
    expect(() => dlq.get(db, 1)).toThrow(/Invalid DLQ table/);
    expect(() => dlq.markRetried(db, 1)).toThrow(/Invalid DLQ table/);
  });

  it('refuses a column that is not a plain identifier', () => {
    const injected = (column: string): DlqColumn[] => [{ field: 'x', column, kind: 'text', insert: true }];
    expect(() => dlqAccess<Row, Insert>('slack_dlq', injected('tenant_id) VALUES (1); --')).insert(db, { x: 't' }))
      .toThrow(/Invalid DLQ column/);
    expect(() => dlqAccess<Row, Insert>('slack_dlq', injected('(SELECT 1)')).list(db, 't', 1)).toThrow(/Invalid DLQ column/);
    expect(() => dlqAccess<Row, Insert>('slack_dlq', injected('id FROM memories --')).get(db, 1)).toThrow(/Invalid DLQ column/);
  });
});
