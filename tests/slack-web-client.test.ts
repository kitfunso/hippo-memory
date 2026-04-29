import { describe, it, expect, vi } from 'vitest';
import { slackHistoryFetcher } from '../src/connectors/slack/web-client.js';

describe('slackHistoryFetcher', () => {
  it('GETs conversations.history with bearer token + cursor', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          ok: true,
          messages: [{ type: 'message', channel: 'C1', text: 'hi', ts: '1.1' }],
          response_metadata: { next_cursor: 'NEXT' },
        }),
      } as unknown as Response;
    });
    const fetcher = slackHistoryFetcher('xoxb-fake', fakeFetch as unknown as typeof fetch);
    const page = await fetcher({ channelId: 'C1', cursor: null });
    expect(page.messages).toHaveLength(1);
    expect(page.next_cursor).toBe('NEXT');
    expect(calls[0].url).toContain('channel=C1');
    const auth = (calls[0].init?.headers as Record<string, string>).authorization;
    expect(auth).toBe('Bearer xoxb-fake');
  });

  it('throws when ok=false', async () => {
    const fakeFetch = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: false, error: 'not_in_channel' }),
    } as unknown as Response));
    const fetcher = slackHistoryFetcher('t', fakeFetch as unknown as typeof fetch);
    await expect(fetcher({ channelId: 'C1', cursor: null })).rejects.toThrow(/not_in_channel/);
  });
});
