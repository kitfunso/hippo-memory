export interface ChannelMeta {
  id: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}

/**
 * Map a Slack channel into a hippo scope string.
 *
 * Default to private when privacy is undetermined. The cost of leaking a
 * public channel into private scope (recall returns nothing) is far smaller
 * than the cost of leaking a private channel into public scope (data exposed
 * to a tenant that should not see it).
 */
export function scopeFromChannel(ch: ChannelMeta): string {
  const isPublic = ch.is_private === false && !ch.is_im && !ch.is_mpim;
  return isPublic ? `slack:public:${ch.id}` : `slack:private:${ch.id}`;
}
