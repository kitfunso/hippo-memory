import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore, loadAllEntries } from '../src/store.js';
import { ingestMessage } from '../src/connectors/slack/ingest.js';

const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: { subject: 'connector:slack', role: 'admin' } });

describe('ingestMessage', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-slack-ingest-')); initStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes a kind=raw memory and is idempotent on replay', () => {
    const evt = {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message' as const, channel: 'C1', user: 'U1', text: 'hello', ts: '1700.0001' },
      eventId: 'Ev1',
    };
    const r1 = ingestMessage(ctx(root), evt);
    expect(r1.status).toBe('ingested');
    expect(r1.memoryId).toBeDefined();

    const r2 = ingestMessage(ctx(root), evt);
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBe(r1.memoryId);

    const entries = loadAllEntries(root);
    const slackEntries = entries.filter((e) => e.source === 'slack' || e.tags.includes('source:slack'));
    expect(slackEntries).toHaveLength(1);
    expect(slackEntries[0].kind).toBe('raw');
  });

  it('marks empty-body messages as skipped without writing', () => {
    const evt = {
      teamId: 'T1',
      channel: { id: 'C1' },
      message: { type: 'message' as const, channel: 'C1', ts: '1700.0001' },
      eventId: 'Ev2',
    };
    const r = ingestMessage(ctx(root), evt);
    expect(r.status).toBe('skipped');
    // v1.12.6 (B3): replay of an empty-body event now returns 'skipped' too
    // (the cached memory_id is NULL, so 'duplicate' would be a status-string
    // asymmetry for the same logical outcome). See
    // tests/slack-ingest-empty-body-replay.test.ts for the full B3 contract.
    expect(ingestMessage(ctx(root), evt).status).toBe('skipped');
  });
});
