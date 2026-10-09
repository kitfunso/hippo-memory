import { describe, it, expect, vi } from 'vitest';
import { slackHistoryFetcher } from '../src/connectors/slack/web-client.js';
import { paddedJsonResponse } from './_helpers/padded-response.js';

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

describe('slackHistoryFetcher: a reply that is not the documented shape', () => {
  const SECRET = 'xoxb-secret-token';
  const SLACK_CAP_BYTES = 64 * 1024 * 1024;

  /** The rejection of one page fetch whose reply is `reply`; a page that came back fails the test. */
  async function failure(reply: Response): Promise<Error> {
    const fetcher = slackHistoryFetcher(SECRET, async () => reply);
    const outcome = await fetcher({ channelId: 'C0CHANNEL', cursor: 'CURSOR1' }).then((page) => page, (err: Error) => err);
    if (!(outcome instanceof Error)) throw new Error(`expected a rejection, got a page of ${outcome.messages.length} messages`);
    return outcome;
  }

  function expectNamesTheReply(err: Error, reason: RegExp): void {
    expect(err.message).toMatch(/^slack: HTTP 200 on \/api\/conversations\.history: /);
    expect(err.message).toMatch(reason);
    // The query string holds the channel and the cursor; the header holds the token.
    expect(err.message).not.toMatch(/C0CHANNEL|CURSOR1|xoxb/);
  }

  it('throws on an HTML error page served with status 200', async () => {
    const err = await failure(new Response('<html><body>Service Unavailable</body></html>', { status: 200 }));
    expectNamesTheReply(err, /reply is not JSON/);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('throws on a null body, an array body and a reply with no body at all', async () => {
    expectNamesTheReply(await failure(new Response('null', { status: 200 })), /not a JSON object/);
    expectNamesTheReply(await failure(new Response('[]', { status: 200 })), /not a JSON object/);
    expectNamesTheReply(await failure(new Response(null, { status: 200 })), /reply has no body/);
  });

  it('throws when `messages` is not an array', async () => {
    const body = JSON.stringify({ ok: true, messages: { 0: { type: 'message', ts: '1.1' } } });
    expectNamesTheReply(await failure(new Response(body, { status: 200 })), /`messages` is not an array/);
  });

  it('throws on a body over the byte cap', async () => {
    const err = await failure(paddedJsonResponse('{"ok":true,"messages":[]', '}', SLACK_CAP_BYTES));
    expectNamesTheReply(err, new RegExp(`reply over ${SLACK_CAP_BYTES} bytes`));
  }, 60_000);

  it('still reads a well-formed page: other entries dropped, the channel stamped, a missing cursor null', async () => {
    const body = { ok: true, messages: [{ type: 'message', text: 'hi', ts: '1.1' }, null, 'x', { type: 'reaction', ts: '1.2' }, { type: 'message' }] };
    const fetcher = slackHistoryFetcher(SECRET, async () => new Response(JSON.stringify(body), { status: 200 }));
    const page = await fetcher({ channelId: 'C0CHANNEL', cursor: null });
    expect(page.messages).toEqual([{ type: 'message', text: 'hi', ts: '1.1', channel: 'C0CHANNEL' }]);
    expect(page.next_cursor).toBeNull();
  });
});
