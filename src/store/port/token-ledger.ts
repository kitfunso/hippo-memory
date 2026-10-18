// Token ledger row and summary shapes of the store port; the ledger group and the reports group use them.

/** Where a block was sent: `hook`/`hook_recall` (per-prompt hook), `compact_resume`, `context`/`recall` (CLI), `mcp_*`,
 * `http_*`, and `pilot` (session pilot arm row, src/api/pilot-arm.ts; not a send, so in no surface list). */
export type TokenSurface =
  | 'hook'
  | 'hook_recall'
  | 'compact_resume'
  | 'context'
  | 'recall'
  | 'mcp_recall'
  | 'mcp_context'
  | 'http_recall'
  | 'http_context'
  | 'http_assemble'
  | 'pilot';

/** What happened to a block: `inject` (sent), `skip` (identical to the last injected block), `reset` (host compacted,
 * next must send), `reread` (tokens later calls read again, booked at session end), `arm` (pilot assignment;
 * `block_hash` is `hippo` or `holdout`, `items` the holdout rate in bp). */
export type TokenEvent = 'inject' | 'skip' | 'reset' | 'reread' | 'arm';

/** One ledger write. */
export interface TokenUse {
  tenantId: string;
  /** Host session id when known (hook payload, `HIPPO_SESSION_ID`); null otherwise. */
  sessionId?: string | null;
  surface: TokenSurface;
  event: TokenEvent;
  /** Memories (and continuity blocks) in the text; for a `reread`, how many times blocks were read again. */
  items: number;
  /** Estimated tokens of the text; for a `skip`, the tokens not sent. */
  tokens: number;
  /** {@link blockHash} of the text, when the caller wants change detection. */
  hash?: string | null;
  /** Override the timestamp (tests). ISO string. */
  now?: string;
}

/** What a session last sent on a surface, for {@link lastSentState}. */
export interface LastSent {
  /** {@link blockHash} of the last injected block. */
  hash: string;
  /** Consecutive `skip` rows since that injection. */
  skipsSince: number;
}

/** Per-surface totals for {@link summarizeTokenUse}. */
export interface TokenSurfaceSummary {
  surface: TokenSurface;
  /** Blocks sent. */
  injected: number;
  /** Tokens sent. */
  tokens: number;
  /** Blocks not sent because they were unchanged. */
  skipped: number;
  /** Tokens those skipped blocks would have cost. */
  tokensAvoided: number;
  /** Tokens of these blocks that later model calls read again, from sessions that have ended; 0 off {@link
   * REREAD_SURFACES}. */
  tokensReread: number;
  /** Distinct session ids seen (rows without one are not counted). */
  sessions: number;
}

/** Ledger totals over a window. */
export interface TokenSummary {
  /** ISO start of the window (inclusive). */
  since: string;
  surfaces: TokenSurfaceSummary[];
  totalTokens: number;
  totalTokensAvoided: number;
  totalTokensReread: number;
  /** Mean tokens sent per session, over rows that carry a session id. */
  meanTokensPerSession: number;
  /** Distinct session ids in the window. */
  sessions: number;
  /** Sessions that sent, skipped or re-read a {@link REREAD_SURFACES} block, the ones whose re-reads can be counted. */
  hookSessions: number;
  /** Sessions whose re-reads were counted at session end; open or crashed sessions are not. */
  rereadSessions: number;
}

/** One model API call in a host transcript, for {@link recordRereads}. */
export interface ApiCall {
  /** Epoch milliseconds of the call's first transcript line. */
  at: number;
  /** Compactions before the call, in file order. */
  compactions: number;
}
