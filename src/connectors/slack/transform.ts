import type { RememberOpts } from '../../api.js';
import { scopeFromChannel, type ChannelMeta } from './scope.js';
import type { SlackMessageEvent } from './types.js';

export interface TransformInput {
  teamId: string;
  channel: ChannelMeta;
  message: SlackMessageEvent;
}

/**
 * Convert a SlackMessageEvent into RememberOpts for api.remember(). Returns
 * null when the message has no usable body (e.g. system events, bot reactions
 * without text). Caller treats null as "skip but mark idempotency seen".
 *
 * Contract:
 * - kind is the literal 'raw' (E1.x connector boundary, see src/importers.ts).
 * - artifact_ref format MUST be exactly `slack://${teamId}/${channelId}/${ts}`;
 *   the deletion path (Task 9) looks up by this string.
 * - owner is non-null whenever a row is written. Required by the v0.40.0
 *   provenance gate (`hippo provenance --strict`).
 *   - `user:<slack_user_id>` when the event carries a `user`.
 *   - `bot:<bot_id>` for the `bot_message` subtype (or any userless+text event
 *     that supplies bot_id).
 *   - `bot:unknown` only as a last-resort sentinel so the gate never sees null.
 *     Codex round 1 P1: skipping userless messages instead of stamping a bot
 *     owner would silently drop existing bot ingestion via the
 *     "skipped but seen" path at ingest.ts:54-65.
 */
export function messageToRememberOpts(input: TransformInput): RememberOpts | null {
  const text = input.message.text?.trim();
  if (!text) return null;
  const artifactRef = `slack://${input.teamId}/${input.channel.id}/${input.message.ts}`;
  const owner = input.message.user
    ? `user:${input.message.user}`
    : input.message.bot_id
      ? `bot:${input.message.bot_id}`
      : 'bot:unknown';
  const tags = [
    'source:slack',
    `channel:${input.channel.id}`,
    ...(input.message.user ? [`user:${input.message.user}`] : []),
    ...(input.message.bot_id ? [`bot:${input.message.bot_id}`] : []),
    ...(input.message.thread_ts ? [`thread:${input.message.thread_ts}`] : []),
  ];
  return {
    content: text,
    kind: 'raw',
    scope: scopeFromChannel(input.channel),
    artifactRef,
    owner,
    tags,
  };
}
