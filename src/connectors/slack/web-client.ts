import { fetchWithRetry } from './ratelimit.js';
import type { SlackHistoryFetcher } from './backfill.js';
import type { SlackMessageEvent } from './types.js';

/**
 * Build a SlackHistoryFetcher that pages `conversations.history` over real
 * HTTP. Wraps `fetchWithRetry` so 429 handling is automatic. The returned
 * fetcher is the one Task 13's `backfillChannel` consumes.
 *
 * Slack omits `channel` from messages in the history response, so we stamp
 * the request channel id onto each parsed message — downstream ingest needs
 * it on every event.
 */
export function slackHistoryFetcher(
  token: string,
  fetchImpl?: typeof fetch,
): SlackHistoryFetcher {
  return async ({ channelId, cursor, oldest }) => {
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channelId);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    if (oldest) url.searchParams.set('oldest', oldest);
    const r = await fetchWithRetry({
      url: url.toString(),
      init: { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      fetchImpl,
    });
    const body = (await r.json()) as {
      ok: boolean;
      error?: string;
      messages?: unknown[];
      response_metadata?: { next_cursor?: string };
    };
    if (!body.ok) throw new Error(`slack: ${body.error ?? 'unknown error'}`);
    const messages: SlackMessageEvent[] = (body.messages ?? [])
      .filter((m): m is SlackMessageEvent => {
        if (!m || typeof m !== 'object') return false;
        const o = m as Record<string, unknown>;
        return o.type === 'message' && typeof o.ts === 'string';
      })
      // Slack returns messages without `channel`; stamp it from the request.
      .map((m) => ({ ...m, channel: channelId }));
    return {
      messages,
      next_cursor: body.response_metadata?.next_cursor ?? null,
    };
  };
}
