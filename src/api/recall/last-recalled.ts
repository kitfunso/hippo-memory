// The ids each client was last shown, so its next outcome lands on them. Keyed per client, so two
// HTTP clients on one tenant cannot poison each other; the root's CallerState holds the map.

import type { Context } from '../types.js';

const MAX_RECALL_CLIENTS = 4096;

// The caller names the project half of each key, so a set past the cap drops the client that
// recalled longest ago.
export class RecentRecalls extends Map<string, string[]> {
  override set(key: string, ids: string[]): this {
    this.delete(key);
    super.set(key, ids);
    const oldest = this.keys().next().value;
    if (this.size > MAX_RECALL_CLIENTS && oldest !== undefined) this.delete(oldest);
    return this;
  }
}

/** The root's map and the key its surface set for this client. */
type ShownKeeper = Pick<Context, 'callers' | 'clientKey'>;

/** Keeps the ids a recall or context call just showed this client; a context with no client key
 * keeps none. */
export function keepShownIds(ctx: ShownKeeper, ids: readonly string[]): void {
  if (ctx.clientKey) ctx.callers?.lastShown.set(ctx.clientKey, [...ids]);
}

/** The ids this client was last shown, for an outcome that names none. */
export function keptShownIds(ctx: ShownKeeper): readonly string[] {
  return (ctx.clientKey && ctx.callers?.lastShown.get(ctx.clientKey)) || [];
}
