// The store the token ledger writes to for a caller's root; context, recall and the session hooks share it.
import { closeHippoDb, isSqliteBusy, noteStoreBusy, openHippoDb } from './db.js';
import { errorMessage, log } from './log.js';
import { getGlobalRoot } from './shared.js';
import { isInitialized } from './store/open.js';

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

/** Runs `fn` on ledgerRoot's store. Best-effort: undefined on any failure, because a ledger failure must not break context or recall. */
export function withLedgerDb<T>(hippoRoot: string, fn: (db: ReturnType<typeof openHippoDb>) => T, opts?: LedgerRootOpts): T | undefined {
  let root: string | null = null;
  try {
    root = ledgerRoot(hippoRoot, opts);
  } catch (error) {
    // An unreadable store root means no ledger write; the ledger must never break context or recall.
    log.debug(`token ledger skipped, store root unreadable: ${errorMessage(error)}`);
    return undefined;
  }
  if (root === null) return undefined;
  let db: ReturnType<typeof openHippoDb> | undefined;
  try {
    db = openHippoDb(root);
    return fn(db);
  } catch (error) {
    // Best effort, but a busy store is the one failure an operator can act on, so it warns once.
    if (isSqliteBusy(error)) noteStoreBusy('token ledger row skipped');
    else log.debug(`token ledger row skipped: ${errorMessage(error)}`);
    return undefined;
  } finally {
    if (db) closeHippoDb(db);
  }
}
