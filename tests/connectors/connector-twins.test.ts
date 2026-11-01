import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { adminActor } from '../../src/api/index.js';
import { parkInDlq, replayParked } from '../../src/api/dead-letters.js';
import { githubDlq } from '../../src/surface/connectors/github/dlq.js';
import { slackDlq } from '../../src/surface/connectors/slack/dlq.js';
import { rememberOncePerEvent } from '../../src/api/hippo-db/connector-writes.js';
import { isJsonObject, type JsonValue } from '../../src/base/util/json.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { githubEventRecord, loadAllEntries, slackEventRecord } from '../_helpers/root-forms.js';

describe('GitHub and Slack share one event log and DLQ vocabulary', () => {
  let root: string;
  let ctx: FullContext;
  beforeEach(() => {
    root = makeRoot('connector-twins');
    ctx = apiCtx(root, 'default', adminActor('connector:test'));
  });

  const gh = {
    connector: 'github',
    idempotencyKey: 'k1',
    deliveryId: 'd1',
    eventName: 'issues',
  } as const;
  const sl = { connector: 'slack', eventId: 'Ev1' } as const;

  it('an empty body is logged with no memory, and both logs answer the same record shape', async () => {
    expect([githubEventRecord(root, 'k1'), slackEventRecord(root, 'Ev1')]).toEqual([{ seen: false }, { seen: false }]);
    const results = [await rememberOncePerEvent(ctx, gh, () => null), await rememberOncePerEvent(ctx, sl, () => null)];
    expect(results).toEqual([
      { status: 'skipped', memoryId: null },
      { status: 'skipped', memoryId: null },
    ]);
    const seen = { seen: true, memoryId: null };
    expect([githubEventRecord(root, 'k1'), slackEventRecord(root, 'Ev1')]).toEqual([seen, seen]);
    const build = () => {
      throw new Error('a logged event runs no transform');
    };
    expect(await rememberOncePerEvent(ctx, gh, build)).toEqual({ status: 'logged', memoryId: null });
  });

  it('ingest stores a short low-salience text: the connector path runs no salience gate', async () => {
    const result = await rememberOncePerEvent(ctx, gh, () => ({ content: 'yes', tags: [] }));
    expect(result.status).toBe('ingested');
    expect(loadAllEntries(root, 'default').map((e) => e.content)).toEqual(['yes']);
  });

  it('each DLQ reads one row and bumps its retry count the same way', async () => {
    const g = await parkInDlq({ store: sqliteStore(root) }, githubDlq, {
      tenantId: 'default',
      rawPayload: '{}',
      error: 'e',
    });
    const s = await parkInDlq({ store: sqliteStore(root) }, slackDlq, {
      tenantId: 'default',
      rawPayload: '{}',
      error: 'e',
    });
    const events = sqliteStore(root).hippoDb.connectorEvents;
    await events.markDeadLetterRetried('github', 'default', g);
    await events.markDeadLetterRetried('slack', 'default', s);
    for (const row of [
      (await events.deadLetters('github', 'default', { id: g }))[0],
      (await events.deadLetters('slack', 'default', { id: s }))[0],
    ]) {
      expect(row?.retryCount).toBe(1);
      expect(row?.retriedAt).not.toBeNull();
    }
  });

  it('the shared replay counts a refused re-ingest once and a missing signature not at all', async () => {
    const id = await parkInDlq({ store: sqliteStore(root) }, githubDlq, {
      tenantId: 'default',
      rawPayload: '{"a":1}',
      error: 'e',
    });
    const steps = (signed: boolean) => ({
      dlq: githubDlq,
      refuseSignature: () => (signed ? null : { status: 'sig_missing' as const, reason: 'no signature' }),
      isEnvelope: (v: JsonValue): v is JsonValue => isJsonObject(v),
      notEnvelope: 'not an object',
      reingest: async () => ({
        ok: false as const,
        status: 'unroutable' as const,
        reason: 'no tenant',
      }),
    });
    expect(
      await replayParked({ tenantId: 'default', store: sqliteStore(root) }, steps(false), { id, force: false }),
    ).toEqual({
      ok: false,
      status: 'sig_missing',
      memoryId: null,
      retryCount: 0,
      reason: 'no signature',
    });
    expect(
      await replayParked({ tenantId: 'default', store: sqliteStore(root) }, steps(false), { id, force: true }),
    ).toEqual({
      ok: false,
      status: 'unroutable',
      memoryId: null,
      retryCount: 1,
      reason: 'no tenant',
    });
    expect(
      (await sqliteStore(root).hippoDb.connectorEvents.deadLetters('github', 'default', { id }))[0]?.retryCount,
    ).toBe(1);
  });
});
