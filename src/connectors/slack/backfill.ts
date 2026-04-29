import type { Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
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
  /**
   * Incremental-resume bound: skip messages with ts <= oldest. Set from
   * `slack_cursors.latest_ts` on the FIRST page of a rerun; unused on
   * subsequent pages within one run (where `cursor` carries us forward).
   * Distinct from `cursor` because Slack treats `cursor` as opaque token
   * and `oldest` as a numeric ts — feeding `latest_ts` as `cursor` breaks
   * against the live API even though it round-trips through test fetchers.
   */
  oldest?: string;
}) => Promise<SlackHistoryPage>;

export interface BackfillOpts {
  teamId: string;
  channel: ChannelMeta;
  fetcher: SlackHistoryFetcher;
  /** Stop after this many messages. Default: unlimited. */
  maxMessages?: number;
}

function readCursor(root: string, tenantId: string, channelId: string): string | null {
  const db = openHippoDb(root);
  try {
    const row = db
      .prepare(`SELECT latest_ts FROM slack_cursors WHERE tenant_id=? AND channel_id=?`)
      .get(tenantId, channelId) as { latest_ts?: string } | undefined;
    return row?.latest_ts ?? null;
  } finally {
    closeHippoDb(db);
  }
}

function writeCursor(
  root: string,
  tenantId: string,
  channelId: string,
  latestTs: string,
): void {
  const db = openHippoDb(root);
  try {
    db.prepare(
      `INSERT INTO slack_cursors (tenant_id, channel_id, latest_ts, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(tenant_id, channel_id) DO UPDATE SET latest_ts = excluded.latest_ts, updated_at = excluded.updated_at`,
    ).run(tenantId, channelId, latestTs, new Date().toISOString());
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Page through `conversations.history` via the injected fetcher and ingest each
 * message. The cursor is persisted to `slack_cursors` after every page so a
 * crash mid-backfill resumes near where it left off.
 *
 * Each ingested message uses a synthesized eventId of the form
 * `backfill:${teamId}:${channelId}:${ts}`. Reruns dedupe via the
 * `slack_event_log` PK so calling `backfillChannel` twice is safe.
 */
export async function backfillChannel(
  ctx: Context,
  opts: BackfillOpts,
): Promise<{ ingested: number; pages: number }> {
  // Resume bound from previous run; passed as `oldest` (numeric ts) on the
  // first page only. `cursor` starts null — Slack mints the next-page token
  // and we feed it back. Mixing the two would feed a numeric ts as an opaque
  // cursor and break against the live API on rerun.
  const resumeFrom: string | null = readCursor(ctx.hippoRoot, ctx.tenantId, opts.channel.id);
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
      const r = ingestMessage(ctx, {
        teamId: opts.teamId,
        channel: opts.channel,
        message: msg,
        eventId: `backfill:${opts.teamId}:${opts.channel.id}:${msg.ts}`,
      });
      if (r.status === 'ingested') ingested++;
      if (!latestTs || msg.ts > latestTs) latestTs = msg.ts;
      if (opts.maxMessages && ingested >= opts.maxMessages) {
        if (latestTs) writeCursor(ctx.hippoRoot, ctx.tenantId, opts.channel.id, latestTs);
        return { ingested, pages };
      }
    }
    if (latestTs) writeCursor(ctx.hippoRoot, ctx.tenantId, opts.channel.id, latestTs);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return { ingested, pages };
}
