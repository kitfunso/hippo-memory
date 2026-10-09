import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store/open.js';
import { parkInDlq, listDlq } from '../src/connectors/dlq.js';
import { githubDlq, replayDlqEntry, type DlqBucket } from '../src/connectors/github/dlq.js';
import { dlqEntry } from '../src/store/connectors/github.js';
import type { Context } from '../src/api/index.js';

describe('github DLQ', () => {
  let root: string;
  let ctx: Context;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-github-dlq-'));
    initStore(root);
    ctx = { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('parkInDlq round-trips all rich metadata fields', async () => {
    const id = await parkInDlq(githubDlq, root, {
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
    const item = dlqEntry(root, id);
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
  });

  it('parkInDlq stores tenantId null as the __unroutable__ sentinel', async () => {
    const id = await parkInDlq(githubDlq, root, {
      tenantId: null,
      rawPayload: '{}',
      error: 'no tenant',
      bucket: 'unroutable',
    });
    const item = dlqEntry(root, id);
    expect(item!.tenantId).toBe('__unroutable__');
    expect(item!.bucket).toBe('unroutable');
    const listed = listDlq(githubDlq, root, { tenantId: '__unroutable__' });
    expect(listed).toHaveLength(1);
  });

  it('parkInDlq round-trips every defined bucket value', async () => {
    const buckets: DlqBucket[] = [
      'parse_error',
      'unroutable',
      'signature_failed',
      'unhandled',
    ];
    for (const bucket of buckets) {
      await parkInDlq(githubDlq, root, {
        tenantId: 'default',
        rawPayload: `{"b":"${bucket}"}`,
        error: bucket,
        bucket,
      });
    }
    const items = listDlq(githubDlq, root, { tenantId: 'default' });
    expect(items).toHaveLength(4);
    const observed = items.map((i) => i.bucket).sort();
    expect(observed).toEqual([...buckets].sort());
  });

  it('listDlq filters by tenant and orders by received_at ASC', async () => {
    await parkInDlq(githubDlq, root, { tenantId: 'default', rawPayload: '{"i":1}', error: 'first' });
    // Force a different received_at by sleeping a millisecond.
    await new Promise((r) => setTimeout(r, 5));
    await parkInDlq(githubDlq, root, { tenantId: 'default', rawPayload: '{"i":2}', error: 'second' });
    await parkInDlq(githubDlq, root, { tenantId: 'acme', rawPayload: '{"i":3}', error: 'other tenant' });

    const defaults = listDlq(githubDlq, root, { tenantId: 'default' });
    expect(defaults).toHaveLength(2);
    expect(defaults[0].error).toBe('first');
    expect(defaults[1].error).toBe('second');

    const acme = listDlq(githubDlq, root, { tenantId: 'acme' });
    expect(acme).toHaveLength(1);
    expect(acme[0].error).toBe('other tenant');
  });

  it('listDlq honors limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await parkInDlq(githubDlq, root, { tenantId: 'default', rawPayload: `{"i":${i}}`, error: `e${i}` });
    }
    const items = listDlq(githubDlq, root, { tenantId: 'default', limit: 2 });
    expect(items).toHaveLength(2);
  });

  it('dlqEntry returns the row by id and null for unknown ids', async () => {
    const id = await parkInDlq(githubDlq, root, {
      tenantId: 'default',
      rawPayload: '{}',
      error: 'boom',
    });
    const found = dlqEntry(root, id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
    expect(dlqEntry(root, 9999)).toBeNull();
  });

  it('replayDlqEntry returns not_found for unknown ids', async () => {
    const result = await replayDlqEntry(ctx, 9999);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_found');
    expect(result.memoryId).toBeNull();
    expect(result.retryCount).toBe(0);
  });

  it('replayDlqEntry on parse-error payload bumps retry_count and reports parse_error', async () => {
    const id = await parkInDlq(githubDlq, root, {
      tenantId: 'default',
      rawPayload: 'not-json{{{',
      error: 'original parse fail',
      bucket: 'parse_error',
    });

    const result = await replayDlqEntry(ctx, id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('parse_error');
    expect(result.retryCount).toBe(1);

    const after = dlqEntry(root, id);
    expect(after!.retryCount).toBe(1);
    expect(after!.retriedAt).not.toBeNull();
  });
});
