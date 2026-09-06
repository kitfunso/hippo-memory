/**
 * Slack Events API envelope shapes used by the ingestion connector.
 * Spec: https://api.slack.com/events-api
 */

export interface SlackUrlVerification {
  type: 'url_verification';
  challenge: string;
  token?: string;
}

export interface SlackMessageEvent {
  type: 'message';
  subtype?: 'message_deleted' | 'message_changed' | 'channel_join' | string;
  channel: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  /**
   * Slack `bot_message` subtype carries `bot_id` instead of `user`. The
   * v0.40.0 provenance gate requires a non-null `owner`, so transform.ts
   * derives `owner: bot:<bot_id>` when `user` is absent.
   */
  bot_id?: string;
  /** Present on subtype='message_deleted'. */
  deleted_ts?: string;
}

/** JSON value shape for the parts of an inbound Slack payload not yet
 *  narrowed to a known envelope/event shape. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface SlackEventEnvelope {
  type: 'event_callback';
  team_id: string;
  event_id: string;
  event_time: number;
  event: SlackMessageEvent | { type: string; [k: string]: JsonValue };
}

export type SlackInbound = SlackEventEnvelope | SlackUrlVerification;

function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === '[object String]';
}

function isJsonNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === '[object Number]';
}

function isJsonRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

export function isSlackEventEnvelope(x: unknown): x is SlackEventEnvelope {
  if (x === null || Array.isArray(x) || Object.prototype.toString.call(x) !== '[object Object]') {
    return false;
  }
  // SAFETY: the check above just confirmed x is a non-null, non-array
  // plain object, so it's safe to treat as a JSON-shaped record.
  const o = x as { [key: string]: JsonValue };
  if (o.type !== 'event_callback') return false;
  if (!isJsonString(o.team_id) || !isJsonString(o.event_id) || !isJsonNumber(o.event_time)) {
    return false;
  }
  const event = o.event;
  return isJsonRecord(event) && isJsonString(event.type);
}

export function isSlackMessageEvent(x: unknown): x is SlackMessageEvent {
  if (x === null || Array.isArray(x) || Object.prototype.toString.call(x) !== '[object Object]') {
    return false;
  }
  // SAFETY: the check above just confirmed x is a non-null, non-array
  // plain object, so it's safe to treat as a JSON-shaped record.
  const o = x as { [key: string]: JsonValue };
  return o.type === 'message' && isJsonString(o.channel) && isJsonString(o.ts);
}
