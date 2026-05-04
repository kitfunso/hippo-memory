import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  writeToDlq,
  listDlq,
  getDlqEntry,
  replayDlqEntry,
  type DlqBucket,
} from '../src/connectors/github/dlq.js';
import type { Context } from '../src/api.js';

describe('github DLQ', () => {
  let root: string;
  let ctx: Context;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-github-dlq-'));
    initStore(root);
    ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writeToDlq round-trips all rich metadata fields', () => {
    const db = openHippoDb(root);
    try {
      const id = writeToDlq(db, {
        tenantId: 'default',
        rawPayload: '{"action":"opened"}',
        error: 'parse fail',
        bucket: 'parse_error',
        eventName: 'issues',
        deliveryId: 'aaaa-bbbb',
        signature: 'sha256=deadbeef',
        installationId: '12345',
        repoFullName: 'octo/repo',
      });
      expect(id).toBe(1);
      const item = getDlqEntry(db, id);
      expect(item).not.toBeNull();
      expect(item!.tenantId).toBe('default');
      expect(item!.rawPayload).toBe('{"action":"opened"}');
      expect(item!.error).toBe('parse fail');
      expect(item!.eventName).toBe('issues');
      expect(item!.deliveryId).toBe('aaaa-bbbb');
      expect(item!.signature).toBe('sha256=deadbeef');
      expect(item!.installationId).toBe('12345');
      expect(item!.repoFullName).toBe('octo/repo');
      expect(item!.retryCount).toBe(0);
      expect(item!.bucket).toBe('parse_error');
      expect(item!.retriedAt).toBeNull();
      expect(item!.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      closeHippoDb(db);
    }
  });

  it('writeToDlq stores tenantId null as the __unroutable__ sentinel', () => {
    const db = openHippoDb(root);
    try {
      const id = writeToDlq(db, {
        tenantId: null,
        rawPayload: '{}',
        error: 'no tenant',
        bucket: 'unroutable',
      });
      const item = getDlqEntry(db, id);
      expect(item!.tenantId).toBe('__unroutable__');
      expect(item!.bucket).toBe('unroutable');
      const listed = listDlq(db, { tenantId: '__unroutable__' });
      expect(listed).toHaveLength(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('writeToDlq round-trips every defined bucket value', () => {
    const db = openHippoDb(root);
    try {
      const buckets: DlqBucket[] = [
        'parse_error',
        'unroutable',
        'signature_failed',
        'unhandled',
      ];
      for (const bucket of buckets) {
        writeToDlq(db, {
          tenantId: 'default',
          rawPayload: `{"b":"${bucket}"}`,
          error: bucket,
          bucket,
        });
      }
      const items = listDlq(db, { tenantId: 'default' });
      expect(items).toHaveLength(4);
      const observed = items.map((i) => i.bucket).sort();
      expect(observed).toEqual([...buckets].sort());
    } finally {
      closeHippoDb(db);
    }
  });

  it('listDlq filters by tenant and orders by received_at ASC', async () => {
    const db = openHippoDb(root);
    try {
      writeToDlq(db, { tenantId: 'default', rawPayload: '{"i":1}', error: 'first' });
      // Force a different received_at by sleeping a millisecond.
      await new Promise((r) => setTimeout(r, 5));
      writeToDlq(db, { tenantId: 'default', rawPayload: '{"i":2}', error: 'second' });
      writeToDlq(db, { tenantId: 'acme', rawPayload: '{"i":3}', error: 'other tenant' });

      const defaults = listDlq(db, { tenantId: 'default' });
      expect(defaults).toHaveLength(2);
      expect(defaults[0].error).toBe('first');
      expect(defaults[1].error).toBe('second');

      const acme = listDlq(db, { tenantId: 'acme' });
      expect(acme).toHaveLength(1);
      expect(acme[0].error).toBe('other tenant');
    } finally {
      closeHippoDb(db);
    }
  });

  it('listDlq honors limit', () => {
    const db = openHippoDb(root);
    try {
      for (let i = 0; i < 5; i += 1) {
        writeToDlq(db, { tenantId: 'default', rawPayload: `{"i":${i}}`, error: `e${i}` });
      }
      const items = listDlq(db, { tenantId: 'default', limit: 2 });
      expect(items).toHaveLength(2);
    } finally {
      closeHippoDb(db);
    }
  });

  it('getDlqEntry returns the row by id and null for unknown ids', () => {
    const db = openHippoDb(root);
    try {
      const id = writeToDlq(db, {
        tenantId: 'default',
        rawPayload: '{}',
        error: 'boom',
      });
      const found = getDlqEntry(db, id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
      expect(getDlqEntry(db, 9999)).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('replayDlqEntry returns not_found for unknown ids', async () => {
    const result = await replayDlqEntry(ctx, 9999);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_found');
    expect(result.memoryId).toBeNull();
    expect(result.retryCount).toBe(0);
  });

  it('replayDlqEntry on parse-error payload bumps retry_count and reports parse_error', async () => {
    const db = openHippoDb(root);
    let id: number;
    try {
      id = writeToDlq(db, {
        tenantId: 'default',
        rawPayload: 'not-json{{{',
        error: 'original parse fail',
        bucket: 'parse_error',
      });
    } finally {
      closeHippoDb(db);
    }

    const result = await replayDlqEntry(ctx, id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('parse_error');
    expect(result.retryCount).toBe(1);

    const db2 = openHippoDb(root);
    try {
      const after = getDlqEntry(db2, id);
      expect(after!.retryCount).toBe(1);
      expect(after!.retriedAt).not.toBeNull();
    } finally {
      closeHippoDb(db2);
    }
  });
});
