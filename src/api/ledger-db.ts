// The store the token ledger writes to for a caller's root; context, recall and the session hooks share it.
import { errorMessage, log, errorFields } from '../util/log.js';
import {
  lastSentOnSurface, noteLedgerRowSkipped, recordLedgerTurn, recordTokensAt, type LedgerTurn,
} from '../store/ledger-turn.js';
import { hasGroup, type HippoStore, type StoreReach } from '../store/port.js';
import type { LastSent, TokenSurface, TokenUse } from '../store/token-ledger.js';

/** The slice of a call's store reach that picks the ledger; a shared store has no `global`. */
export type LedgerReach = Pick<StoreReach, 'hasLocal' | 'global'>;

/** The ledger is SQLite-only: a local store needs a reach that says so and a SQLite store; no reach books nowhere. */
export function ledgerReachOf(
  ctx: { readonly reach?: StoreReach; readonly store?: HippoStore },
  shared?: boolean,
): LedgerReach {
  const hasLocal = ctx.reach?.hasLocal === true && (ctx.store === undefined || hasGroup(ctx.store, 'localFiles'));
  return shared === true ? { hasLocal } : { hasLocal, global: ctx.reach?.global };
}

/** `hippoRoot` when the call has a store of its own, else the global store (the prompt hook fires where none is). */
export function ledgerRoot(hippoRoot: string, reach: LedgerReach): string | null {
  return reach.hasLocal ? hippoRoot : (reach.global?.root ?? null);
}

/** Runs `call` on ledgerRoot's store root; undefined on any failure, since a ledger failure must not break recall. */
export function onLedgerRoot<T>(
  hippoRoot: string,
  reach: LedgerReach,
  call: (root: string) => T,
): T | undefined {
  let root: string | null = null;
  try {
    root = ledgerRoot(hippoRoot, reach);
  } catch (error) {
    // An unreadable store root means no ledger write; the ledger must never break context or recall.
    log.debug(`token ledger skipped, store root unreadable: ${errorMessage(error)}`, errorFields(error));
    return undefined;
  }
  if (root === null) return undefined;
  try {
    return call(root);
  } catch (error) {
    noteLedgerRowSkipped(error);
    return undefined;
  }
}

/** Books one row in ledgerRoot's store, best-effort. */
export function bookTokenUse(hippoRoot: string, use: TokenUse, reach: LedgerReach): void {
  onLedgerRoot(hippoRoot, reach, (root) => recordTokensAt(root, use));
}

/** Books a turn's rows and then its delivery event on one connection of ledgerRoot's store, best-effort. */
export function bookLedgerTurn(hippoRoot: string, turn: LedgerTurn, reach: LedgerReach): void {
  onLedgerRoot(hippoRoot, reach, (root) => recordLedgerTurn(root, turn));
}

/** What the session last sent on `surface` in ledgerRoot's store; undefined with no ledger or a failed read. */
export function ledgerLastSent(
  hippoRoot: string,
  tenantId: string,
  sessionId: string | null | undefined,
  surface: TokenSurface,
  reach: LedgerReach,
): LastSent | null | undefined {
  return onLedgerRoot(hippoRoot, reach, (root) => lastSentOnSurface(root, tenantId, sessionId, surface));
}
