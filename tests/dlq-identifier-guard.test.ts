import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { getDlqRow, insertDlqRow, listDlqRows, markDlqRetried, type DlqTable } from '../src/store/connectors/dlq.js';

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
    const id = insertDlqRow(db, 'slack_dlq', [['tenant_id', 't'], ['raw_payload', '{}'], ['error', 'e']]);
    expect(listDlqRows(db, 'slack_dlq', 'id, tenant_id', 't', 5)).toHaveLength(1);
    expect(getDlqRow(db, 'slack_dlq', 'id', id)).not.toBeNull();
    markDlqRetried(db, 'slack_dlq', id);
  });

  it('refuses a table outside the union', () => {
    expect(() => insertDlqRow(db, badTable, [['tenant_id', 't']])).toThrow(/Invalid DLQ table/);
    expect(() => listDlqRows(db, badTable, 'id', 't', 1)).toThrow(/Invalid DLQ table/);
    expect(() => getDlqRow(db, badTable, 'id', 1)).toThrow(/Invalid DLQ table/);
    expect(() => markDlqRetried(db, badTable, 1)).toThrow(/Invalid DLQ table/);
  });

  it('refuses a column that is not a plain identifier', () => {
    expect(() => insertDlqRow(db, 'slack_dlq', [['tenant_id) VALUES (1); --', 't']])).toThrow(/Invalid DLQ column/);
    expect(() => listDlqRows(db, 'slack_dlq', 'id, (SELECT 1)', 't', 1)).toThrow(/Invalid DLQ column/);
    expect(() => getDlqRow(db, 'slack_dlq', 'id FROM memories --', 1)).toThrow(/Invalid DLQ column/);
  });
});
