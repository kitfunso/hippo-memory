import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store/open.js';
import { parkInDlq, listDlq } from '../src/connectors/dlq.js';
import { slackDlq } from '../src/connectors/slack/dlq.js';
import { markSlackDlqRetried } from '../src/store/connectors/slack.js';

describe('slack DLQ', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-slack-dlq-')); initStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('captures raw payload + error and lists oldest-first', async () => {
    await parkInDlq(slackDlq, root, { tenantId: 'default', rawPayload: '{"a":1}', error: 'parse fail' });
    await parkInDlq(slackDlq, root, { tenantId: 'default', rawPayload: '{"b":2}', error: 'unknown event type' });
    const items = listDlq(slackDlq, root, { tenantId: 'default' });
    expect(items).toHaveLength(2);
    expect(items[0].error).toBe('parse fail');
    expect(items[0].retriedAt).toBeNull();
  });

  it('markSlackDlqRetried sets retried_at', async () => {
    await parkInDlq(slackDlq, root, { tenantId: 'default', rawPayload: '{}', error: 'boom' });
    const [item] = listDlq(slackDlq, root, { tenantId: 'default' });
    markSlackDlqRetried(root, item.id);
    const [after] = listDlq(slackDlq, root, { tenantId: 'default' });
    expect(after.retriedAt).not.toBeNull();
  });

  it('listDlq scopes by tenantId', async () => {
    await parkInDlq(slackDlq, root, { tenantId: 'default', rawPayload: '{}', error: 'a' });
    await parkInDlq(slackDlq, root, { tenantId: 'acme', rawPayload: '{}', error: 'b' });
    expect(listDlq(slackDlq, root, { tenantId: 'default' })).toHaveLength(1);
    expect(listDlq(slackDlq, root, { tenantId: 'acme' })).toHaveLength(1);
  });
});
