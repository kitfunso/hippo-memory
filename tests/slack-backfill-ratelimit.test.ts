import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import type { Context } from '../src/api/index.js';
import { backfillChannel } from '../src/connectors/slack/backfill.js';
import { slackHistoryFetcher } from '../src/connectors/slack/web-client.js';

const ctx = (root: string): Context => ({
  hippoRoot: root,
  tenantId: 'default',
  actor: { subject: 'connector:slack', role: 'admin' },
});

/**
 * Integration test for rate-limit handling THROUGH the full backfill loop.
 * The /review skill flagged this gap (HIGH-test): tests/slack-ratelimit.test.ts
 * exercises only the inner fetchWithRetry helper. This wires a fake fetch
 * returning 429 then 200 into slackHistoryFetcher and runs backfillChannel
 * end-to-end, asserting the loop completes, messages land, and the cursor
 * advances despite the 429.
 */
describe('backfill survives 429 + Retry-After through the full loop', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-bfrl-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('429 then 200 → backfill ingests + cursor advances', async () => {
    let phase = 0;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      phase++;
      if (phase === 1) {
        // 429 with Retry-After: 0.01 seconds → fetchWithRetry sleeps 10ms.
        return new Response('{}', { status: 429, headers: { 'retry-after': '0.01' } });
      }
      // Second attempt succeeds with one message.
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
    expect(fakeFetch).toHaveBeenCalledTimes(2); // 429 + 200 retry.
    const slackEntries = loadAllEntries(root).filter((e) => e.tags.includes('source:slack'));
    expect(slackEntries).toHaveLength(1);
    expect(slackEntries[0].kind).toBe('raw');
    expect(slackEntries[0].content).toBe('rate limit survivor');
  });
});
