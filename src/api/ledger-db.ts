// The store the token ledger writes to for a caller's root; context, recall and the session hooks share it.
import { errorMessage, log } from '../util/log.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { lastSentOnSurface, noteLedgerRowSkipped, recordLedgerTurn, type LedgerTurn } from '../store/ledger-turn.js';
import { isInitialized } from '../store/open.js';
import { sqliteSyncStore } from '../store/sqlite/store.js';
import type { LastSent, TokenSurface, TokenUse } from '../store/token-ledger.js';

export interface LedgerRootOpts {
  /** The store serves many people, so the global store of the user running it belongs to none of them. */
  readonly sharedStore?: boolean;
}

/** `hippoRoot` when it holds a store, else the global store (the prompt hook fires where no local one exists), else null. */
export function ledgerRoot(hippoRoot: string, opts?: LedgerRootOpts): string | null {
  if (isInitialized(hippoRoot)) return hippoRoot;
  if (opts?.sharedStore) return null;
  const globalRoot = getGlobalRoot();
  return isInitialized(globalRoot) ? globalRoot : null;
}

/** Runs `call` on ledgerRoot's store root. Best-effort: undefined on any failure, because a ledger failure must not break context or recall. */
export function onLedgerRoot<T>(hippoRoot: string, opts: LedgerRootOpts | undefined, call: (root: string) => T): T | undefined {
  let root: string | null = null;
  try {
    root = ledgerRoot(hippoRoot, opts);
  } catch (error) {
    // An unreadable store root means no ledger write; the ledger must never break context or recall.
    log.debug(`token ledger skipped, store root unreadable: ${errorMessage(error)}`);
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
export function bookTokenUse(hippoRoot: string, use: TokenUse, opts?: LedgerRootOpts): void {
  onLedgerRoot(hippoRoot, opts, (root) => sqliteSyncStore(root).recordTokens(use));
}

/** Books a turn's rows and then its delivery event on one connection of ledgerRoot's store, best-effort. */
export function bookLedgerTurn(hippoRoot: string, turn: LedgerTurn, opts?: LedgerRootOpts): void {
  onLedgerRoot(hippoRoot, opts, (root) => recordLedgerTurn(root, turn));
}

/** What the session last sent on `surface` in ledgerRoot's store; undefined with no ledger or a failed read. */
export function ledgerLastSent(
  hippoRoot: string, tenantId: string, sessionId: string | null | undefined, surface: TokenSurface, opts?: LedgerRootOpts,
): LastSent | null | undefined {
  return onLedgerRoot(hippoRoot, opts, (root) => lastSentOnSurface(root, tenantId, sessionId, surface));
}
