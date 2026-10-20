import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { ingestMessage } from '../../src/surface/connectors/slack/ingest.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

const ctx = (root: string): FullContext => apiCtx(root, 'default', { subject: 'connector:slack', role: 'admin' });

describe('ingestMessage', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('slack-ingest');
  });

  it('writes a kind=raw memory and is idempotent on replay', async () => {
    const evt = {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message' as const, channel: 'C1', user: 'U1', text: 'hello', ts: '1700.0001' },
      eventId: 'Ev1',
    };
    const r1 = await ingestMessage(ctx(root), evt);
    expect(r1.status).toBe('ingested');
    expect(r1.memoryId).toBeDefined();

    const r2 = await ingestMessage(ctx(root), evt);
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBe(r1.memoryId);

    const entries = loadAllEntries(root, 'default');
    const slackEntries = entries.filter((e) => e.source === 'slack' || e.tags.includes('source:slack'));
    expect(slackEntries).toHaveLength(1);
    expect(slackEntries[0].kind).toBe('raw');
  });

  it('marks empty-body messages as skipped without writing', async () => {
    const evt = {
      teamId: 'T1',
      channel: { id: 'C1' },
      message: { type: 'message' as const, channel: 'C1', ts: '1700.0001' },
      eventId: 'Ev2',
    };
    const r = await ingestMessage(ctx(root), evt);
    expect(r.status).toBe('skipped');
    // v1.12.6 (B3): replay of an empty-body event now returns 'skipped' too
    // (the cached memory_id is NULL, so 'duplicate' would be a status-string
    // asymmetry for the same logical outcome). See
    // tests/connectors/slack-ingest-empty-body-replay.test.ts for the full B3 contract.
    expect((await ingestMessage(ctx(root), evt)).status).toBe('skipped');
  });
});
