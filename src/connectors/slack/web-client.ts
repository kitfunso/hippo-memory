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
/** JSON value shape for the parts of the Slack history response not yet
 *  narrowed to a known message shape. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

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
    // SAFETY: body is the Slack `conversations.history` response; per the
    // documented shape it's `{ ok, error?, messages?, response_metadata? }`.
    const body = (await r.json()) as {
      ok: boolean;
      error?: string;
      messages?: unknown[];
      response_metadata?: { next_cursor?: string };
    };
    if (!body.ok) throw new Error(`slack: ${body.error ?? 'unknown error'}`);
    const messages: SlackMessageEvent[] = (body.messages ?? [])
      .filter((m): m is SlackMessageEvent => {
        if (m === null || Array.isArray(m) || typeof m !== 'object') {
          return false;
        }
        // SAFETY: the check above just confirmed m is a non-null, non-array
        // plain object, so it's safe to treat as a JSON-shaped record; the
        // `m is SlackMessageEvent` predicate is what validates the fields.
        const o = m as { [key: string]: JsonValue };
        return o.type === 'message' && isJsonString(o.ts);
      })
      // Slack returns messages without `channel`; stamp it from the request.
      .map((m) => ({ ...m, channel: channelId }));
    return {
      messages,
      next_cursor: body.response_metadata?.next_cursor ?? null,
    };
  };
}
