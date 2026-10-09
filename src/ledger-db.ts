// The store the token ledger writes to for a caller's root; context, recall and the session hooks share it.
import { closeHippoDb, isSqliteBusy, noteStoreBusy, openHippoDb } from './db.js';
import { errorFields, errorMessage, log } from './log.js';
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

/** A ledger row that did not land. A busy store warns once through noteStoreBusy; any other failure warns once and then logs at debug, since the caller's output is unaffected. */
export function noteLedgerRowSkipped<E>(error: E): void {
  if (isSqliteBusy(error)) {
    noteStoreBusy('token ledger row skipped');
    return;
  }
  log.warnThenDebug('token-ledger-row', `token ledger row skipped: ${errorMessage(error)}`, errorFields(error));
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
    noteLedgerRowSkipped(error);
    return undefined;
  } finally {
    if (db) closeHippoDb(db);
  }
}
