import { fetchWithRetry, isRetryableStatus } from '../../util/http-retry.js';
import type { SlackHistoryFetcher } from './backfill.js';
import type { SlackMessageEvent } from './types.js';
import { readCappedJson } from '../../util/capped-json.js';
import { errorMessage } from '../../util/log.js';
import { type JsonValue, isJsonObject, isJsonString } from '../../util/json.js';

/**
 * Build a SlackHistoryFetcher that pages `conversations.history` over real
 * HTTP. Wraps `fetchWithRetry` so 429 and 5xx handling is automatic. The returned
 * fetcher is the one `backfillChannel` consumes.
 *
 * Slack omits `channel` from messages in the history response, so we stamp
 * the request channel id onto each parsed message — downstream ingest needs
 * it on every event.
 */
const SLACK_TIMEOUT_MS = 30_000;
// A page is at most 200 messages, each up to 40,000 characters at 4 bytes, carried once as text and once as rich-text blocks.
const SLACK_MAX_REPLY_BYTES = 64 * 1024 * 1024;

function isSlackMessage(m: JsonValue): m is { [key: string]: JsonValue } & SlackMessageEvent {
  return isJsonObject(m) && m.type === 'message' && isJsonString(m.ts);
}

/** The reply as a JSON object. The error names the status and the path only, since the query string carries channel ids and cursors. */
async function readHistoryReply(r: Response, url: URL): Promise<{ [key: string]: JsonValue }> {
  const where = `slack: HTTP ${r.status} on ${url.pathname}`;
  let body: JsonValue;
  try {
    body = await readCappedJson(r, SLACK_MAX_REPLY_BYTES);
  } catch (err) {
    throw new Error(`${where}: ${errorMessage(err)}`, { cause: err });
  }
  if (!isJsonObject(body)) throw new Error(`${where}: the reply is not a JSON object`);
  if (body.messages !== undefined && !Array.isArray(body.messages)) throw new Error(`${where}: \`messages\` is not an array`);
  return body;
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
    const r = await fetchWithRetry(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, {
      timeoutMs: SLACK_TIMEOUT_MS,
      fetchFn: fetchImpl,
    });
    if (isRetryableStatus(r.status)) throw new Error(`slack: still rate-limited or unavailable (HTTP ${r.status})`);
    const body = await readHistoryReply(r, url);
    if (body.ok !== true) throw new Error(`slack: ${isJsonString(body.error) ? body.error : 'unknown error'}`);
    const messages: SlackMessageEvent[] = (Array.isArray(body.messages) ? body.messages : [])
      .filter(isSlackMessage)
      // Slack returns messages without `channel`; stamp it from the request.
      .map((m) => ({ ...m, channel: channelId }));
    const nextCursor = isJsonObject(body.response_metadata) ? body.response_metadata.next_cursor : undefined;
    return {
      messages,
      next_cursor: isJsonString(nextCursor) ? nextCursor : null,
    };
  };
}
