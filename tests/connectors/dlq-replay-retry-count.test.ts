import { describe, it, expect, beforeEach } from 'vitest';
import { parkInDlq } from '../../src/surface/connectors/dlq.js';
import { githubDlq, replayDlqEntry as replayGitHub } from '../../src/surface/connectors/github/dlq.js';
import { slackDlq, replayDlqEntry as replaySlack } from '../../src/surface/connectors/slack/dlq.js';
import { sqliteStore, sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadConfig } from '../../src/base/config/config.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

describe('failed replay bumps retry_count by exactly one, for both connectors', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('dlq-retry');
  });

  const countOf = (items: { id: number; retryCount: number }[], id: number): number =>
    items.find((i) => i.id === id)?.retryCount ?? -1;
  const githubCount = (id: number): number =>
    countOf(sqliteSyncStore(root).connectorEvents.deadLetters('github', 'default', 100), id);
  const slackCount = (id: number): number =>
    countOf(sqliteSyncStore(root).connectorEvents.deadLetters('slack', 'default', 100), id);

  it('unparseable payload', async () => {
    const g = await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: 'x{',
      error: 'e',
      eventName: null,
      deliveryId: null,
      installationId: null,
      repoFullName: null,
    });
    const s = await parkInDlq(slackDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: 'x{',
      error: 'e',
      teamId: null,
      slackTimestamp: null,
    });
    const gr = await replayGitHub(apiCtx(root, 'default', { subject: 'cli', role: 'admin' }), g);
    const sr = await replaySlack(
      { tenantId: 'default', hippoRoot: root, store: sqliteStore(root), config: loadConfig(root) },
      s,
      {
        force: true,
      },
    );
    expect([gr.retryCount, sr.retryCount]).toEqual([1, 1]);
    expect([githubCount(g), slackCount(s)]).toEqual([1, 1]);
  });

  it('signature that does not verify', async () => {
    const g = await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{}',
      error: 'e',
      signature: 'sha256=00',
      eventName: null,
      deliveryId: null,
      installationId: null,
      repoFullName: null,
    });
    const s = await parkInDlq(slackDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{}',
      error: 'e',
      signature: 'v0=00',
      teamId: 'T1',
      slackTimestamp: '1700000000',
    });
    const gr = await replayGitHub(apiCtx(root, 'default', { subject: 'cli', role: 'admin' }), g, {
      webhookSecret: 'real',
    });
    const sr = await replaySlack(
      { tenantId: 'default', hippoRoot: root, store: sqliteStore(root), config: loadConfig(root) },
      s,
      {
        signingSecret: 'real',
        now: 1700000000,
      },
    );
    expect([gr.status, sr.status]).toEqual(['sig_fail', 'sig_fail']);
    expect([githubCount(g), slackCount(s)]).toEqual([1, 1]);
  });
});
