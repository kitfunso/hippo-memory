// The token and delivery ledger as a port group. A hook books its turn here, so every call but replaceRereads is best
// effort: a row that does not land is noted at the level its cause earns and never rejects.
import type { PilotArm } from '../../base/session/pilot-arm.js';
import type { DeliveryEventInput } from '../../base/session/delivery.js';
import type { LastSent } from '../../base/session/skip-unchanged.js';
import type { ApiCall } from '../../base/session/transcript-calls.js';

export interface Ledger {
  /** The turn's token rows, then its delivery event, on one connection. */
  recordTurn(turn: LedgerTurn): Promise<void>;
  /** What the session last sent on `surface`; null with none, or when the read failed. */
  lastSent(tenantId: string, sessionId: string | null | undefined, surface: TokenSurface): Promise<LastSent | null>;
  /** With `write`, books the session's arm unless one is stored; else the stored arm. The hash arm when neither. */
  pilotArm(tenantId: string, sessionId: string, rateBp: number, opts: PilotArmOptions): Promise<PilotArm>;
  /** One delivery event; its id, or null when the write failed. */
  writeDeliveryEvent(input: DeliveryEventInput): Promise<number | null>;
  /** Replaces the session's re-read rows from its transcript's calls; the tokens booked.
   * Rejects when the write fails. */
  replaceRereads(tenantId: string, sessionId: string, calls: readonly ApiCall[]): Promise<number>;
}

export interface PilotArmOptions {
  readonly write: boolean;
  /** Only the caller tenant's arm row counts. */
  readonly ownTenantOnly?: boolean;
}

/** The token rows of one turn and the delivery event that follows them. */
export interface LedgerTurn {
  readonly uses: readonly TokenUse[];
  /** Each row its own attempt, so one that fails leaves the rest; without it the first failure ends the rows. */
  readonly perRow?: boolean;
  /** Written after the rows, whatever became of them. */
  readonly delivery?: DeliveryEventInput;
}

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
  /** `blockHash` of the text, when the caller wants change detection. */
  hash?: string | null;
  /** Override the timestamp (tests). ISO string. */
  now?: string;
}

/** Per-surface totals for `summarizeTokenUse`. */
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
  /** Tokens of these blocks that later model calls read again, from ended sessions; 0 off `REREAD_SURFACES`. */
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
  /** Sessions that sent, skipped or re-read a `REREAD_SURFACES` block, the ones whose re-reads can be counted. */
  hookSessions: number;
  /** Sessions whose re-reads were counted at session end; open or crashed sessions are not. */
  rereadSessions: number;
}
