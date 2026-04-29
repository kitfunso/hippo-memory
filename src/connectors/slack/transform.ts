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
 */
export function messageToRememberOpts(input: TransformInput): RememberOpts | null {
  const text = input.message.text?.trim();
  if (!text) return null;
  const artifactRef = `slack://${input.teamId}/${input.channel.id}/${input.message.ts}`;
  const tags = [
    'source:slack',
    `channel:${input.channel.id}`,
    ...(input.message.user ? [`user:${input.message.user}`] : []),
    ...(input.message.thread_ts ? [`thread:${input.message.thread_ts}`] : []),
  ];
  return {
    content: text,
    kind: 'raw',
    scope: scopeFromChannel(input.channel),
    artifactRef,
    tags,
  };
}
