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

export interface SlackEventEnvelope {
  type: 'event_callback';
  team_id: string;
  event_id: string;
  event_time: number;
  event: SlackMessageEvent | { type: string; [k: string]: unknown };
}

export type SlackInbound = SlackEventEnvelope | SlackUrlVerification;

export function isSlackEventEnvelope(x: unknown): x is SlackEventEnvelope {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.type === 'event_callback' &&
    typeof o.team_id === 'string' &&
    typeof o.event_id === 'string' &&
    typeof o.event_time === 'number' &&
    !!o.event &&
    typeof o.event === 'object' &&
    typeof (o.event as Record<string, unknown>).type === 'string'
  );
}

export function isSlackMessageEvent(x: unknown): x is SlackMessageEvent {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return o.type === 'message' && typeof o.channel === 'string' && typeof o.ts === 'string';
}
