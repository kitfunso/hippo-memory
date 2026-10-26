import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { backfillChannel, type SlackHistoryFetcher } from '../../src/surface/connectors/slack/backfill.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

const ctx = (root: string): FullContext => apiCtx(root, 'default', { subject: 'connector:slack', role: 'admin' });

describe('backfillChannel', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('slack-bf');
  });

  it('paginates, ingests, and persists the cursor', async () => {
    const fetcher: SlackHistoryFetcher = async ({ cursor }) => {
      if (!cursor) {
        return {
          messages: [
            { type: 'message', channel: 'C1', user: 'U1', text: 'msg-a', ts: '1.1' },
            { type: 'message', channel: 'C1', user: 'U1', text: 'msg-b', ts: '2.2' },
          ],
          next_cursor: 'PAGE2',
        };
      }
      if (cursor === 'PAGE2') {
        return {
          messages: [{ type: 'message', channel: 'C1', user: 'U1', text: 'msg-c', ts: '3.3' }],
          next_cursor: null,
        };
      }
      throw new Error('unexpected cursor: ' + cursor);
    };
    const r = await backfillChannel(ctx(root), {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      fetcher,
    });
    expect(r.ingested).toBe(3);

    const db = openHippoDb(root);
    try {
      // SAFETY: backfillChannel() above persisted the cursor for tenant
      // 'default'/channel 'C1' in this same test, so the row is guaranteed
      // present with a latest_ts column.
      const row = db
        .prepare(`SELECT latest_ts FROM slack_cursors WHERE tenant_id=? AND channel_id=?`)
        .get('default', 'C1') as { latest_ts: string };
      expect(row.latest_ts).toBe('3.3');
    } finally {
      closeHippoDb(db);
    }

    expect(loadAllEntries(root, 'default').filter((e) => e.tags.includes('source:slack'))).toHaveLength(3);
  });

  it('resumes from the saved cursor (idempotent on rerun)', async () => {
    let phase = 1;
    const fetcher: SlackHistoryFetcher = async () => {
      if (phase === 1) {
        phase = 2;
        return {
          messages: [{ type: 'message', channel: 'C1', user: 'U1', text: 'msg-a', ts: '1.1' }],
          next_cursor: null,
        };
      }
      // Second pass returns the same message — replay must not duplicate.
      return {
        messages: [{ type: 'message', channel: 'C1', user: 'U1', text: 'msg-a', ts: '1.1' }],
        next_cursor: null,
      };
    };
    await backfillChannel(ctx(root), { teamId: 'T1', channel: { id: 'C1' }, fetcher });
    await backfillChannel(ctx(root), { teamId: 'T1', channel: { id: 'C1' }, fetcher });
    expect(loadAllEntries(root, 'default').filter((e) => e.tags.includes('source:slack'))).toHaveLength(1);
  });
});
