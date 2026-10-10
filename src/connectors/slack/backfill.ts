import type { Context } from '../../api/index.js';
import { saveSlackCursor, slackCursor } from '../../store/connectors/slack.js';
import { ingestMessage } from './ingest.js';
import type { SlackMessageEvent } from './types.js';
import type { ChannelMeta } from './scope.js';

export interface SlackHistoryPage {
  messages: SlackMessageEvent[];
  next_cursor: string | null;
}

export type SlackHistoryFetcher = (args: {
  channelId: string;
  /** Slack's opaque pagination token. Null on first page of a backfill run. */
  cursor: string | null;
  /** Incremental-resume bound: skip messages with ts <= oldest, set from `slack_cursors.latest_ts` on the first page only.
   *  Kept apart from `cursor` because Slack treats `cursor` as an opaque token, so feeding latest_ts as cursor fails on the live API. */
  oldest?: string;
}) => Promise<SlackHistoryPage>;

export interface BackfillOpts {
  teamId: string;
  channel: ChannelMeta;
  fetcher: SlackHistoryFetcher;
  /** Stop after this many messages. Default: unlimited. */
  maxMessages?: number;
}

/** Page through `conversations.history` and ingest each message, persisting the cursor to `slack_cursors` after every page.
 *  The synthesized eventId `backfill:${teamId}:${channelId}:${ts}` makes reruns dedupe via the `slack_event_log` PK. */
export async function backfillChannel(
  ctx: Context,
  opts: BackfillOpts,
): Promise<{ ingested: number; pages: number }> {
  // `oldest` (numeric ts) is the resume bound for the first page only; `cursor` starts null and Slack mints the next-page token.
  // Mixing the two would feed a numeric ts as an opaque cursor and break on rerun.
  const resumeFrom: string | null = slackCursor(ctx.hippoRoot, ctx.tenantId, opts.channel.id);
  let cursor: string | null = null;
  let ingested = 0;
  let pages = 0;
  let latestTs: string | null = resumeFrom;
  while (true) {
    const page = await opts.fetcher({
      channelId: opts.channel.id,
      cursor,
      oldest: pages === 0 && resumeFrom ? resumeFrom : undefined,
    });
    pages++;
    for (const msg of page.messages) {
      const r = await ingestMessage(ctx, {
        teamId: opts.teamId,
        channel: opts.channel,
        message: msg,
        eventId: `backfill:${opts.teamId}:${opts.channel.id}:${msg.ts}`,
      });
      if (r.status === 'ingested') ingested++;
      if (!latestTs || msg.ts > latestTs) latestTs = msg.ts;
      if (opts.maxMessages && ingested >= opts.maxMessages) {
        if (latestTs) saveSlackCursor(ctx.hippoRoot, ctx.tenantId, opts.channel.id, latestTs);
        return { ingested, pages };
      }
    }
    if (latestTs) saveSlackCursor(ctx.hippoRoot, ctx.tenantId, opts.channel.id, latestTs);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return { ingested, pages };
}
