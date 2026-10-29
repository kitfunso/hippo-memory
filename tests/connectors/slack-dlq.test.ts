import { describe, it, expect, beforeEach } from 'vitest';
import { parkInDlq, listDlq } from '../../src/api/dead-letters.js';
import { slackDlq } from '../../src/surface/connectors/slack/dlq.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('slack DLQ', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('slack-dlq');
  });

  it('captures raw payload + error and lists oldest-first', async () => {
    await parkInDlq({ store: sqliteStore(root) }, slackDlq, {
      tenantId: 'default',
      rawPayload: '{"a":1}',
      error: 'parse fail',
    });
    await parkInDlq({ store: sqliteStore(root) }, slackDlq, {
      tenantId: 'default',
      rawPayload: '{"b":2}',
      error: 'unknown event type',
    });
    const items = await listDlq({ tenantId: 'default', store: sqliteStore(root) }, slackDlq);
    expect(items).toHaveLength(2);
    expect(items[0].error).toBe('parse fail');
    expect(items[0].retriedAt).toBeNull();
  });

  it('markSlackDlqRetried sets retried_at', async () => {
    await parkInDlq({ store: sqliteStore(root) }, slackDlq, { tenantId: 'default', rawPayload: '{}', error: 'boom' });
    const [item] = await listDlq({ tenantId: 'default', store: sqliteStore(root) }, slackDlq);
    await sqliteStore(root).connectorEvents.markDeadLetterRetried('slack', 'default', item.id);
    const [after] = await listDlq({ tenantId: 'default', store: sqliteStore(root) }, slackDlq);
    expect(Number.isNaN(Date.parse(String(after.retriedAt)))).toBe(false);
  });

  it('listDlq scopes by tenantId', async () => {
    await parkInDlq({ store: sqliteStore(root) }, slackDlq, { tenantId: 'default', rawPayload: '{}', error: 'a' });
    await parkInDlq({ store: sqliteStore(root) }, slackDlq, { tenantId: 'acme', rawPayload: '{}', error: 'b' });
    expect(await listDlq({ tenantId: 'default', store: sqliteStore(root) }, slackDlq)).toHaveLength(1);
    expect(await listDlq({ tenantId: 'acme', store: sqliteStore(root) }, slackDlq)).toHaveLength(1);
  });
});
