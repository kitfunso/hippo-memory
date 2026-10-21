import { describe, it, expect, beforeEach } from 'vitest';
import { parkInDlq, listDlq } from '../../src/surface/connectors/dlq.js';
import { slackDlq } from '../../src/surface/connectors/slack/dlq.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

describe('slack DLQ', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('slack-dlq');
  });

  it('captures raw payload + error and lists oldest-first', async () => {
    await parkInDlq(slackDlq, sqliteStore(root), { tenantId: 'default', rawPayload: '{"a":1}', error: 'parse fail' });
    await parkInDlq(slackDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{"b":2}',
      error: 'unknown event type',
    });
    const items = await listDlq(slackDlq, sqliteStore(root), { tenantId: 'default' });
    expect(items).toHaveLength(2);
    expect(items[0].error).toBe('parse fail');
    expect(items[0].retriedAt).toBeNull();
  });

  it('markSlackDlqRetried sets retried_at', async () => {
    await parkInDlq(slackDlq, sqliteStore(root), { tenantId: 'default', rawPayload: '{}', error: 'boom' });
    const [item] = await listDlq(slackDlq, sqliteStore(root), { tenantId: 'default' });
    await sqliteStore(root).connectorEvents.markDeadLetterRetried('slack', item.id);
    const [after] = await listDlq(slackDlq, sqliteStore(root), { tenantId: 'default' });
    expect(Number.isNaN(Date.parse(String(after.retriedAt)))).toBe(false);
  });

  it('listDlq scopes by tenantId', async () => {
    await parkInDlq(slackDlq, sqliteStore(root), { tenantId: 'default', rawPayload: '{}', error: 'a' });
    await parkInDlq(slackDlq, sqliteStore(root), { tenantId: 'acme', rawPayload: '{}', error: 'b' });
    expect(await listDlq(slackDlq, sqliteStore(root), { tenantId: 'default' })).toHaveLength(1);
    expect(await listDlq(slackDlq, sqliteStore(root), { tenantId: 'acme' })).toHaveLength(1);
  });
});
