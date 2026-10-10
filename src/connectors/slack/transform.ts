import type { RememberOpts } from '../../api/index.js';
import { scopeFromChannel, type ChannelMeta } from './scope.js';
import type { SlackMessageEvent } from './types.js';

export interface TransformInput {
  teamId: string;
  channel: ChannelMeta;
  message: SlackMessageEvent;
}

/** Convert a SlackMessageEvent into RememberOpts; returns null when the message has no usable body so the caller marks it seen and skips it.
 *  artifact_ref MUST be `slack://${teamId}/${channelId}/${ts}` (deletion looks it up); owner is never null: `user:<id>`, `bot:<bot_id>`, else `bot:unknown`. */
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
