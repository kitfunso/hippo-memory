import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import {
  backfillChannel,
  type SlackHistoryFetcher,
} from '../src/connectors/slack/backfill.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const ctx = (root: string) => ({
  hippoRoot: root,
  tenantId: 'default',
  actor: 'connector:slack',
});

describe('backfillChannel cursor / oldest semantics', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-bfc-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does NOT feed latest_ts as Slack cursor (would be opaque-token mismatch)', async () => {
    // Seed slack_cursors with a prior latest_ts.
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_cursors (tenant_id, channel_id, latest_ts, updated_at) VALUES (?,?,?,?)`,
      ).run('default', 'C1', '1700000000.000100', new Date().toISOString());
    } finally {
      closeHippoDb(db);
    }

    const calls: Array<{ cursor: string | null; oldest: string | undefined }> = [];
    const fetcher: SlackHistoryFetcher = async ({ cursor, oldest }) => {
      calls.push({ cursor, oldest });
      return { messages: [], next_cursor: null };
    };

    await backfillChannel(ctx(root), {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      fetcher,
    });

    expect(calls).toHaveLength(1);
    // First page MUST have cursor=null (Slack mints the next-page token); the
    // resume bound rides on `oldest`, NOT `cursor`.
    expect(calls[0].cursor).toBeNull();
    expect(calls[0].oldest).toBe('1700000000.000100');
  });

  it('subsequent pages within one run pass the next_cursor unchanged, oldest undefined', async () => {
    const calls: Array<{ cursor: string | null; oldest: string | undefined }> = [];
    const fetcher: SlackHistoryFetcher = async ({ cursor, oldest }) => {
      calls.push({ cursor, oldest });
      if (!cursor) {
        return {
          messages: [
            { type: 'message', channel: 'C1', user: 'U1', text: 'pageone msg', ts: '1.1' },
          ],
          next_cursor: 'OPAQUE_PAGE2_TOKEN',
        };
      }
      if (cursor === 'OPAQUE_PAGE2_TOKEN') {
        return {
          messages: [
            { type: 'message', channel: 'C1', user: 'U1', text: 'pagetwo msg', ts: '2.2' },
          ],
          next_cursor: null,
        };
      }
      throw new Error('unexpected cursor');
    };

    await backfillChannel(ctx(root), {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      fetcher,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].cursor).toBeNull();
    expect(calls[0].oldest).toBeUndefined(); // No prior cursor row, so no resume bound.
    expect(calls[1].cursor).toBe('OPAQUE_PAGE2_TOKEN');
    expect(calls[1].oldest).toBeUndefined(); // Page 2+ never sets oldest.
  });
});
