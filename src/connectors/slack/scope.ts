export interface ChannelMeta {
  id: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}

/** Map a Slack channel into a hippo scope string, defaulting to private when privacy is undetermined:
 *  a public channel leaking into private scope returns nothing, but the reverse exposes data. */
export function scopeFromChannel(ch: ChannelMeta): string {
  const isPublic = ch.is_private === false && !ch.is_im && !ch.is_mpim;
  return isPublic ? `slack:public:${ch.id}` : `slack:private:${ch.id}`;
}
