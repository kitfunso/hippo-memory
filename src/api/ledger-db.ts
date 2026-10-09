// The store the token ledger writes to for a caller's root; context, recall and the session hooks share it.
import { isSqliteBusy, noteStoreBusy, type openHippoDb } from '../db/index.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { lastSentOnSurface, recordLedgerTurn, type LedgerTurn } from '../store/ledger-turn.js';
import { isInitialized, onHandle } from '../store/open.js';
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

// SQLite's result codes for a hippo.db it cannot read: a corrupt image, and a file that is no database.
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** Why a ledger row did not land: the store is `busy`, it has no ledger to write to (`absent`), or the write failed for a reason nobody planned for (`unexpected`). */
type LedgerSkip = 'busy' | 'absent' | 'unexpected';

/** The one rule for a skipped ledger row. `absent` is a store with no token_ledger table or a hippo.db SQLite cannot read; the command that owns the store reports that, and a hook must stay quiet about it. */
function ledgerSkipClass<E>(error: E): LedgerSkip {
  if (isSqliteBusy(error)) return 'busy';
  const code = error instanceof Error && 'errcode' in error ? error.errcode : undefined;
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return 'absent';
  return errorMessage(error).includes('no such table: token_ledger') ? 'absent' : 'unexpected';
}

/** Says why a ledger row did not land, at the level its class earns: busy warns once through noteStoreBusy, absent is debug with no stack, unexpected warns once with the error class and stack. */
export function noteLedgerRowSkipped<E>(error: E): void {
  const skip = ledgerSkipClass(error);
  if (skip === 'busy') {
    noteStoreBusy('token ledger row skipped');
    return;
  }
  const message = `token ledger row skipped: ${errorMessage(error)}`;
  if (skip === 'absent') log.debug(message);
  else log.warnThenDebug('token-ledger-row', message, errorFields(error));
}

/** Runs `call` on ledgerRoot's store root. Best-effort: undefined on any failure, because a ledger failure must not break context or recall. */
function onLedgerRoot<T>(hippoRoot: string, opts: LedgerRootOpts | undefined, call: (root: string) => T): T | undefined {
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

/** Runs `fn` on a handle of ledgerRoot's store, best-effort as the calls above. */
export function withLedgerDb<T>(hippoRoot: string, fn: (db: ReturnType<typeof openHippoDb>) => T, opts?: LedgerRootOpts): T | undefined {
  return onLedgerRoot(hippoRoot, opts, (root) => onHandle(root, fn));
}
