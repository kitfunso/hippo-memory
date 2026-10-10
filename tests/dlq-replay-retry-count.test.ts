import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store/open.js';
import { parkInDlq, listDlq } from '../src/connectors/dlq.js';
import { githubDlq, replayDlqEntry as replayGitHub } from '../src/connectors/github/dlq.js';
import { slackDlq, replayDlqEntry as replaySlack } from '../src/connectors/slack/dlq.js';

describe('failed replay bumps retry_count by exactly one, for both connectors', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-dlq-retry-')); initStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const countOf = (items: { id: number; retryCount: number }[], id: number): number =>
    items.find((i) => i.id === id)?.retryCount ?? -1;
  const githubCount = (id: number): number => countOf(listDlq(githubDlq, root, { tenantId: 'default' }), id);
  const slackCount = (id: number): number => countOf(listDlq(slackDlq, root, { tenantId: 'default' }), id);

  it('unparseable payload', async () => {
    const g = await parkInDlq(githubDlq, root, { tenantId: 'default', rawPayload: 'x{', error: 'e', eventName: null, deliveryId: null, installationId: null, repoFullName: null });
    const s = await parkInDlq(slackDlq, root, { tenantId: 'default', rawPayload: 'x{', error: 'e', teamId: null, slackTimestamp: null });
    const gr = await replayGitHub({ hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } }, g);
    const sr = await replaySlack({ hippoRoot: root }, s, { force: true });
    expect([gr.retryCount, sr.retryCount]).toEqual([1, 1]);
    expect([githubCount(g), slackCount(s)]).toEqual([1, 1]);
  });

  it('signature that does not verify', async () => {
    const g = await parkInDlq(githubDlq, root, { tenantId: 'default', rawPayload: '{}', error: 'e', signature: 'sha256=00', eventName: null, deliveryId: null, installationId: null, repoFullName: null });
    const s = await parkInDlq(slackDlq, root, { tenantId: 'default', rawPayload: '{}', error: 'e', signature: 'v0=00', teamId: 'T1', slackTimestamp: '1700000000' });
    const gr = await replayGitHub({ hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } }, g, { webhookSecret: 'real' });
    const sr = await replaySlack({ hippoRoot: root }, s, { signingSecret: 'real', now: 1700000000 });
    expect([gr.status, sr.status]).toEqual(['sig_fail', 'sig_fail']);
    expect([githubCount(g), slackCount(s)]).toEqual([1, 1]);
  });
});
