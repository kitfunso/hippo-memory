import type { PilotArm } from '../../session/pilot-arm.js';
import type { DeliveryEventInput } from '../../session/delivery.js';
import type { LastSent } from '../../session/skip-unchanged.js';
import type { ApiCall } from '../../session/transcript-calls.js';
import type { MethodEffects } from './effects.js';

export interface Ledger {
  recordTurn(turn: LedgerTurn): Promise<void>;
  lastSent(
    tenantId: string,
    sessionId: string | null | undefined,
    surface: TokenSurface,
  ): Promise<LastSent | null>;
  pilotArm(
    tenantId: string,
    sessionId: string,
    rateBp: number,
    opts: PilotArmOptions,
  ): Promise<PilotArm>;
  replaceRereads(tenantId: string, sessionId: string, calls: readonly ApiCall[]): Promise<number>;
}

/** What each Ledger method does to the store; every adapter honours it. */
export const LEDGER_EFFECTS = {
  recordTurn: 'write',
  lastSent: 'read',
  pilotArm: 'write',
  replaceRereads: 'write',
} as const satisfies MethodEffects<Ledger>;

export interface PilotArmOptions {
  readonly write: boolean;
  readonly ownTenantOnly?: boolean;
}

/** The token rows of one turn and the delivery event that follows them. */
export interface LedgerTurn {
  readonly uses: readonly TokenUse[];
  readonly perRow?: boolean;
  readonly delivery?: DeliveryEventInput;
}

/** Where a block was sent: `hook`/`hook_recall` (per-prompt hook), `compact_resume`, `session_start`,
 * `context`/`recall` (CLI), `mcp_*`, `http_*`, and `pilot` (session pilot arm row,
 * src/api/pilot-arm.ts; not a send, so in no surface list). */
export type TokenSurface =
  | 'hook'
  | 'hook_recall'
  | 'compact_resume'
  | 'session_start'
  | 'context'
  | 'recall'
  | 'mcp_recall'
  | 'mcp_context'
  | 'http_recall'
  | 'http_context'
  | 'http_assemble'
  | 'pilot';

/** What happened to a block: `inject` (sent), `skip` (identical to the last injected block),
 * `reset` (host compacted, next must send), `reread` (tokens later calls read again, booked at
 * session end), `arm` (pilot assignment; `block_hash` is `hippo` or `holdout`, `items` the
 * holdout rate in bp). */
export type TokenEvent = 'inject' | 'skip' | 'reset' | 'reread' | 'arm';

/** One ledger write. */
export interface TokenUse {
  tenantId: string;
  /** Host session id when known (hook payload, `HIPPO_SESSION_ID`); null otherwise. */
  sessionId?: string | null;
  surface: TokenSurface;
  event: TokenEvent;
  /** Memories (and continuity blocks) in the text; for a `reread`, how many times blocks were
   * read again. */
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
  injected: number;
  tokens: number;
  skipped: number;
  tokensAvoided: number;
  tokensReread: number;
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
  /** Sessions that sent, skipped or re-read a `REREAD_SURFACES` block, the ones whose re-reads
   * can be counted. */
  hookSessions: number;
  /** Sessions whose re-reads were counted at session end; open or crashed sessions are not. */
  rereadSessions: number;
}
