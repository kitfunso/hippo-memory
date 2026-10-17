// The store the token ledger writes to for a caller; context, recall and the session hooks share it.
import { noteLedgerRowSkipped, type LedgerTurn } from '../store/ledger-turn.js';
import type { Ledger, LocalFiles, StoreReach } from '../store/port.js';
import type { LastSent, TokenSurface, TokenUse } from '../store/token-ledger.js';
import type { Context } from './types.js';

/** Where a call's ledger can sit: its own hippo.db, else the operator's global one; a shared store has no `global`. */
export interface LedgerReach {
  readonly local?: LocalFiles;
  readonly global?: StoreReach['global'];
}

/** The ledger is SQLite-only: a local one needs a reach that says the caller has a store and a SQLite store. */
export function ledgerReachOf(ctx: Pick<Context, 'reach' | 'store'>, shared?: boolean): LedgerReach {
  const local = ctx.reach?.hasLocal === true ? ctx.store.localFiles : undefined;
  return shared === true ? { local } : { local, global: ctx.reach?.global };
}

/** The call's own hippo.db, else the global store's (the prompt hook fires where none is); null with neither. */
export function ledgerFiles(reach: LedgerReach): LocalFiles | null {
  return reach.local ?? reach.global?.store.localFiles ?? null;
}

/** Runs `call` on ledgerFiles' ledger; undefined on any failure, since a ledger failure must not break recall. */
export function onLedger<T>(reach: LedgerReach, call: (ledger: Ledger) => T): T | undefined {
  const files = ledgerFiles(reach);
  if (files === null) return undefined;
  try {
    return call(files.ledger);
  } catch (error) {
    noteLedgerRowSkipped(error);
    return undefined;
  }
}

/** Books one row in ledgerFiles' store, best-effort. */
export function bookTokenUse(use: TokenUse, reach: LedgerReach): void {
  onLedger(reach, (ledger) => ledger.recordTokens(use));
}

/** Books a turn's rows and then its delivery event on one connection of ledgerFiles' store, best-effort. */
export function bookLedgerTurn(turn: LedgerTurn, reach: LedgerReach): void {
  onLedger(reach, (ledger) => ledger.recordTurn(turn));
}

/** What the session last sent on `surface` in ledgerFiles' store; undefined with no ledger or a failed read. */
export function ledgerLastSent(
  tenantId: string,
  sessionId: string | null | undefined,
  surface: TokenSurface,
  reach: LedgerReach,
): LastSent | null | undefined {
  return onLedger(reach, (ledger) => ledger.lastSent(tenantId, sessionId, surface));
}
