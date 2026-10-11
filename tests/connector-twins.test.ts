import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { adminActor, type Context } from '../src/api/index.js';
import { initStore } from '../src/store/open.js';
import { githubEventRecord } from '../src/store/connectors/github.js';
import { slackEventRecord } from '../src/store/connectors/slack.js';
import { parkInDlq, replayParked } from '../src/connectors/dlq.js';
import { githubDlq } from '../src/connectors/github/dlq.js';
import { slackDlq } from '../src/connectors/slack/dlq.js';
import { rememberWithEventLog } from '../src/connectors/ingest.js';
import { isJsonObject, type JsonValue } from '../src/util/json.js';

describe('GitHub and Slack share one event log and DLQ vocabulary', () => {
  let root: string;
  let ctx: Context;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-connector-twins-'));
    initStore(root);
    ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('connector:test') };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const gh = { connector: 'github', idempotencyKey: 'k1', deliveryId: 'd1', eventName: 'issues' } as const;
  const sl = { connector: 'slack', eventId: 'Ev1' } as const;

  it('an empty body is logged with no memory, and both logs answer the same record shape', async () => {
    expect([githubEventRecord(root, 'k1'), slackEventRecord(root, 'Ev1')]).toEqual([{ seen: false }, { seen: false }]);
    const results = [await rememberWithEventLog(ctx, gh, null), await rememberWithEventLog(ctx, sl, null)];
    expect(results).toEqual([{ status: 'skipped', memoryId: null }, { status: 'skipped', memoryId: null }]);
    const seen = { seen: true, memoryId: null };
    expect([githubEventRecord(root, 'k1'), slackEventRecord(root, 'Ev1')]).toEqual([seen, seen]);
  });

  it('each DLQ reads one row and bumps its retry count the same way', async () => {
    const g = await parkInDlq(githubDlq, root, { tenantId: 'default', rawPayload: '{}', error: 'e' });
    const s = await parkInDlq(slackDlq, root, { tenantId: 'default', rawPayload: '{}', error: 'e' });
    githubDlq.bump(root, g);
    slackDlq.bump(root, s);
    for (const row of [githubDlq.entry(root, g), slackDlq.entry(root, s)]) {
      expect(row?.retryCount).toBe(1);
      expect(row?.retriedAt).not.toBeNull();
    }
  });

  it('the shared replay counts a refused re-ingest once and a missing signature not at all', async () => {
    const id = await parkInDlq(githubDlq, root, { tenantId: 'default', rawPayload: '{"a":1}', error: 'e' });
    const steps = (signed: boolean) => ({
      dlq: githubDlq,
      refuseSignature: () => (signed ? null : { status: 'sig_missing' as const, reason: 'no signature' }),
      isEnvelope: (v: JsonValue): v is JsonValue => isJsonObject(v),
      notEnvelope: 'not an object',
      reingest: async () => ({ ok: false as const, status: 'unroutable' as const, reason: 'no tenant' }),
    });
    expect(await replayParked(steps(false), root, id, false)).toEqual(
      { ok: false, status: 'sig_missing', memoryId: null, retryCount: 0, reason: 'no signature' });
    expect(await replayParked(steps(false), root, id, true)).toEqual(
      { ok: false, status: 'unroutable', memoryId: null, retryCount: 1, reason: 'no tenant' });
    expect(githubDlq.entry(root, id)?.retryCount).toBe(1);
  });
});
