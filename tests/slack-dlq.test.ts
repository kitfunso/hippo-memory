import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { writeToDlq, listDlq, markDlqRetried } from '../src/connectors/slack/dlq.js';

describe('slack DLQ', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-slack-dlq-')); initStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('captures raw payload + error and lists oldest-first', () => {
    const db = openHippoDb(root);
    try {
      writeToDlq(db, { tenantId: 'default', rawPayload: '{"a":1}', error: 'parse fail' });
      writeToDlq(db, { tenantId: 'default', rawPayload: '{"b":2}', error: 'unknown event type' });
      const items = listDlq(db, { tenantId: 'default' });
      expect(items).toHaveLength(2);
      expect(items[0].error).toBe('parse fail');
      expect(items[0].retriedAt).toBeNull();
    } finally { closeHippoDb(db); }
  });

  it('markDlqRetried sets retried_at', () => {
    const db = openHippoDb(root);
    try {
      writeToDlq(db, { tenantId: 'default', rawPayload: '{}', error: 'boom' });
      const [item] = listDlq(db, { tenantId: 'default' });
      markDlqRetried(db, item.id);
      const [after] = listDlq(db, { tenantId: 'default' });
      expect(after.retriedAt).not.toBeNull();
    } finally { closeHippoDb(db); }
  });

  it('listDlq scopes by tenantId', () => {
    const db = openHippoDb(root);
    try {
      writeToDlq(db, { tenantId: 'default', rawPayload: '{}', error: 'a' });
      writeToDlq(db, { tenantId: 'acme', rawPayload: '{}', error: 'b' });
      expect(listDlq(db, { tenantId: 'default' })).toHaveLength(1);
      expect(listDlq(db, { tenantId: 'acme' })).toHaveLength(1);
    } finally { closeHippoDb(db); }
  });
});
