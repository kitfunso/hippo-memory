import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { backfillChannel } from '../../src/surface/connectors/slack/backfill.js';
import { slackHistoryFetcher } from '../../src/surface/connectors/slack/web-client.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

const ctx = (root: string): FullContext => apiCtx(root, 'default', { subject: 'connector:slack', role: 'admin' });

describe('backfill survives 429 + Retry-After through the full loop', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('slack-bfrl');
  });

  it('429 then 200 → backfill ingests + cursor advances', async () => {
    let phase = 0;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      phase++;
      if (phase === 1) {
        return new Response('{}', { status: 429, headers: { 'retry-after': '0.01' } });
      }
      return Response.json({
        ok: true,
        messages: [{ type: 'message', user: 'U1', text: 'rate limit survivor', ts: '1700000001.000100' }],
        response_metadata: { next_cursor: null },
      });
    });

    const fetcher = slackHistoryFetcher('xoxb-fake', fakeFetch);
    const r = await backfillChannel(ctx(root), {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      fetcher,
    });

    expect(r.ingested).toBe(1);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    const slackEntries = loadAllEntries(root, 'default').filter((e) => e.tags.includes('source:slack'));
    expect(slackEntries).toHaveLength(1);
    expect(slackEntries[0].kind).toBe('raw');
    expect(slackEntries[0].content).toBe('rate limit survivor');
  });
});
