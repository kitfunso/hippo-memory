// The store the token ledger writes to for a caller; context, recall and the session hooks share it.
import { noteLedgerRowSkipped } from '../store/ledger-turn.js';
import type { LedgerTurn } from '../store/port/ledger.js';
import type { HippoConfig } from '../core/config.js';
import type { FolderFiles, Ledger } from '../store/port.js';
import type { LastSent, TokenSurface, TokenUse } from '../store/port/token-ledger.js';
import type { Context, GlobalInReach } from './types.js';

/** A hippo.db a ledger can sit in, with the config that turns its delivery rows and pilot arm on. */
export interface LedgerHome extends FolderFiles {
  readonly config: HippoConfig;
}

/** Where a call's ledger can sit: its own hippo.db, else the operator's global one; a shared store has no `global`. */
export interface LedgerReach {
  readonly local?: LedgerHome;
  readonly global?: GlobalInReach;
}

/** The ledger is SQLite-only: a local one needs a reach that says the caller has a store and a SQLite store. */
export function ledgerReachOf(
  ctx: Pick<Context, 'hippoRoot' | 'reach' | 'store' | 'config'>,
  shared?: boolean,
): LedgerReach {
  const files = ctx.reach?.hasLocal === true ? ctx.store.localFiles : undefined;
  const local = files === undefined ? undefined : { root: ctx.hippoRoot, files, config: ctx.config };
  return shared === true ? { local } : { local, global: ctx.reach?.global };
}

/** The call's own hippo.db, else the global store's (the prompt hook fires where none is); null with neither. */
export function ledgerFiles(reach: LedgerReach): LedgerHome | null {
  if (reach.local !== undefined) return reach.local;
  const { global } = reach;
  const files = global?.store.localFiles;
  return global === undefined || files === undefined ? null : { root: global.root, files, config: global.config };
}

/** Runs `call` on ledgerFiles' ledger; undefined on any failure, since a ledger failure must not break recall. */
export function onLedger<T>(reach: LedgerReach, call: (ledger: Ledger) => T): T | undefined {
  const home = ledgerFiles(reach);
  if (home === null) return undefined;
  try {
    return call(home.files.ledger);
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
