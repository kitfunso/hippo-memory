// What a recall records around its own write: the rows and history it leads with, then the session ring, the recalled counter and the token ledger row.
import type { AppendAuditOpts } from '../store/audit.js';
import type { HippoStore } from '../store/index.js';
import type { TokenSurface } from '../store/token-ledger.js';
import { biasHintEnabled, type RecallHistorySnapshot } from './recall-history.js';
import { anchorSkippedRows, callerOf, noteRecall, peekSessionRing, sessionRing, type RecallSurface } from './recall-record.js';
import { recordTokens } from './tokens.js';
import type { Context } from './types.js';

/** How one surface's recall is recorded. The surfaces differ in these three values and in the list they hand over, nowhere else. */
export interface RecallRecording {
  /** Whose session rings the recall reads and feeds. */
  readonly ring: RecallSurface;
  /** The label of its token ledger row. */
  readonly ledger: TokenSurface;
  /** 'every': an empty list still reaches the stats write, which then only rewrites stats.json; 'shown': an empty list skips it. */
  readonly stats: 'every' | 'shown';
}

/** The surfaces `retrieve` records in full. MCP is pending: src/mcp still feeds its own ring and books its own ledger row, and counts no stats. */
export const RECALL_RECORDING = {
  http: { ring: 'http', ledger: 'http_recall', stats: 'every' },
  cli: { ring: 'cli', ledger: 'recall', stats: 'shown' },
} as const satisfies Record<string, RecallRecording>;

/** What a recorded recall takes into ranking. */
export interface RecallLead {
  readonly recallHistory: RecallHistorySnapshot | undefined;
  readonly leadingAudit: readonly AppendAuditOpts[];
}

/** For a surface whose hint `retrieve` judges: the session's history, or the row saying the recall named no session. */
export function recallLead(ctx: Context, how: RecallRecording, query: string, sessionId: string | undefined): RecallLead {
  return {
    // Peeked, never created: a recall that then fails must not LRU-evict a live session.
    recallHistory: sessionId && biasHintEnabled('anchoring') ? peekSessionRing(how.ring, ctx.tenantId, sessionId) : undefined,
    // Written first in the recall's own write, so a recall that fails leaves no row.
    leadingAudit: sessionId ? [] : anchorSkippedRows(callerOf(ctx), query),
  };
}

/** The list a recall showed, as its ranker counted and priced it. */
export interface ShownList {
  readonly query: string;
  /** The recall's session, which keys the ring. */
  readonly sessionId: string | undefined;
  readonly topId: string | null;
  /** The memory this recall's anchoring hint named; the next recall's cooldown reads it. */
  readonly anchoredOn: string | undefined;
  readonly items: number;
  readonly tokens: number;
  /** The session the ledger row names: the recall's own on HTTP, the host agent's on the CLI. */
  readonly ledgerSessionId: string | null;
  /** False when the audit rows could not be written and the caller answers anyway. */
  readonly written: boolean;
}

/** Runs after the recall's own write, in this order: the ring, then the counter, then the ledger. */
export async function recordShownRecall(ctx: Context, store: HippoStore, how: RecallRecording, shown: ShownList): Promise<void> {
  // A surface that only peeked has its ring created here, after the write, so a recall that fails cannot LRU-evict a live session.
  const ring = sessionRing(how.ring, ctx.tenantId, shown.sessionId);
  if (ring) noteRecall(ring, shown.query, shown.topId, shown.anchoredOn);
  // A recall with no audit row counts nothing, as it strengthens and traces nothing.
  if (shown.written && (how.stats === 'every' || shown.items > 0)) await store.bumpRecallStats(shown.items);
  // The ledger books text that was sent, so its row does not wait on the audit write.
  await recordTokens(ctx, how.ledger, { items: shown.items, tokens: shown.tokens, sessionId: shown.ledgerSessionId });
}
