import { describe, it, expect, vi } from 'vitest';
import { slackHistoryFetcher } from '../src/connectors/slack/web-client.js';

type FetchImpl = typeof fetch;

describe('slackHistoryFetcher', () => {
  it('GETs conversations.history with bearer token + cursor', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: FetchImpl = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [{ type: 'message', channel: 'C1', text: 'hi', ts: '1.1' }],
          response_metadata: { next_cursor: 'NEXT' },
        }),
        { status: 200 },
      );
    });
    const fetcher = slackHistoryFetcher('xoxb-fake', fakeFetch);
    const page = await fetcher({ channelId: 'C1', cursor: null });
    expect(page.messages).toHaveLength(1);
    expect(page.next_cursor).toBe('NEXT');
    expect(calls[0].url).toContain('channel=C1');
    // SAFETY: slackHistoryFetcher (src/connectors/slack/web-client.ts) always
    // builds init.headers as a plain object literal, never a Headers instance
    // or an array-of-pairs, so narrowing the HeadersInit union here is sound.
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer xoxb-fake');
  });

  it('throws when ok=false', async () => {
    const fakeFetch: FetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), { status: 200 }),
    );
    const fetcher = slackHistoryFetcher('t', fakeFetch);
    await expect(fetcher({ channelId: 'C1', cursor: null })).rejects.toThrow(/not_in_channel/);
  });
});
