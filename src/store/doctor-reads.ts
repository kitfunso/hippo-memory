// The two counts `hippo doctor` reads from tables whose own store modules belong to other changes.
import type { DatabaseSyncLike } from '../db.js';

export interface CompactionCounts {
  total: number;
  summarised: number;
  started: number;
}

/** Compaction records in all, those with a summary whose memories never got saved, and those still without a summary; each cutoff is an ISO time. */
export function compactionCountsAt(db: DatabaseSyncLike, stuckBefore: string, transcriptFloor: string): CompactionCounts {
  // SAFETY: COUNT aggregate row.
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN status = 'summarised' AND summarised_at < ? THEN 1 END) AS summarised,
              COUNT(CASE WHEN status = 'started' AND started_at < ? AND started_at > ? AND transcript_path IS NOT NULL THEN 1 END) AS started
       FROM compactions`,
  ).get(stuckBefore, stuckBefore, transcriptFloor) as { total: number; summarised: number; started: number } | undefined;
  return { total: Number(row?.total ?? 0), summarised: Number(row?.summarised ?? 0), started: Number(row?.started ?? 0) };
}

export interface TokenTally {
  injected: number;
  tokensSent: number;
  tokensReread: number;
}

/** Memory blocks injected since `sinceIso`, the tokens they sent and the tokens later model calls re-read. */
export function tokenTallySince(db: DatabaseSyncLike, sinceIso: string): TokenTally {
  // SAFETY: COUNT/SUM aggregate row.
  const row = db.prepare(
    `SELECT COUNT(CASE WHEN event = 'inject' THEN 1 END) AS n,
              COALESCE(SUM(CASE WHEN event = 'inject' THEN tokens END), 0) AS t,
              COALESCE(SUM(CASE WHEN event = 'reread' THEN tokens END), 0) AS r
       FROM token_ledger WHERE ts >= ?`,
  ).get(sinceIso) as { n: number; t: number; r: number } | undefined;
  return { injected: Number(row?.n ?? 0), tokensSent: Number(row?.t ?? 0), tokensReread: Number(row?.r ?? 0) };
}
