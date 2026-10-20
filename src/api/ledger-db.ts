// The store the token ledger writes to for a caller; context, recall and the session hooks share it.
import type { HippoConfig } from '../base/config/config.js';
import type { FolderFiles, HippoStore, Ledger, LedgerTurn } from '../store/port.js';
import type { TokenSurface, TokenUse } from '../store/port/token-ledger.js';
import type { LastSent } from '../base/session/skip-unchanged.js';
import type { Context, GlobalInReach } from './types.js';

/** A store a ledger can sit in, with the config that turns its delivery rows and pilot arm on. */
export interface LedgerHome {
  readonly ledger: Ledger;
  /** Where the store sits, which its delivery rows name by hash. */
  readonly folderFiles: FolderFiles;
  readonly config: HippoConfig;
}

/** Where a call's ledger can sit: its own store, else the operator's global one; a shared store has no `global`. */
export interface LedgerReach {
  readonly local?: LedgerHome;
  readonly global?: GlobalInReach;
}

function homeOf(store: HippoStore, config: HippoConfig): LedgerHome | undefined {
  const { ledger, folderFiles } = store;
  return ledger === undefined || folderFiles === undefined ? undefined : { ledger, folderFiles, config };
}

/** Only a store that keeps a ledger has one, and a local one needs a reach that says the caller has a store. */
export function ledgerReachOf(ctx: Pick<Context, 'reach' | 'store' | 'config'>, shared?: boolean): LedgerReach {
  const local = ctx.reach?.hasLocal === true ? homeOf(ctx.store, ctx.config) : undefined;
  return shared === true ? { local } : { local, global: ctx.reach?.global };
}

/** The call's own store, else the global store (the prompt hook fires where none is); null with neither. */
export function ledgerHome(reach: LedgerReach): LedgerHome | null {
  if (reach.local !== undefined) return reach.local;
  const { global } = reach;
  return (global && homeOf(global.store, global.config)) ?? null;
}

/** Books one row in ledgerHome's store, best-effort. */
export async function bookTokenUse(use: TokenUse, reach: LedgerReach): Promise<void> {
  await ledgerHome(reach)?.ledger.recordTurn({ uses: [use] });
}

/** Books a turn's rows and then its delivery event on one connection of ledgerHome's store, best-effort. */
export async function bookLedgerTurn(turn: LedgerTurn, reach: LedgerReach): Promise<void> {
  await ledgerHome(reach)?.ledger.recordTurn(turn);
}

/** bookLedgerTurn where each row is its own attempt: a row that fails is noted and the rest still land. */
export async function bookLedgerTurnPerRow(turn: Omit<LedgerTurn, 'perRow'>, reach: LedgerReach): Promise<void> {
  await ledgerHome(reach)?.ledger.recordTurn({ ...turn, perRow: true });
}

/** What the session last sent on `surface` in ledgerHome's store; null with no ledger, no row or a failed read. */
export async function ledgerLastSent(
  tenantId: string,
  sessionId: string | null | undefined,
  surface: TokenSurface,
  reach: LedgerReach,
): Promise<LastSent | null> {
  return (await ledgerHome(reach)?.ledger.lastSent(tenantId, sessionId, surface)) ?? null;
}
