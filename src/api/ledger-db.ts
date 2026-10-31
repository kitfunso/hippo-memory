// The ledgers a caller writes to: the token ledger's store and the delivery ledger's recorder, which
// context, recall and the session hooks share.
import type { LedgerTurn } from '../base/records/ledger.js';
import type { TokenSurface, TokenUse } from '../base/records/ledger.js';
import type { LastSent } from '../base/session/skip-unchanged.js';
import type { HippoConfig } from '../base/config/config.js';
import type { CoreEnrichment } from './enrichment.js';
import type { Context, GlobalInReach, LedgerHome } from './types.js';
import {
  createDeliveryRecorder,
  type DeliveryFault,
  type DeliveryRecorder,
} from './delivery/delivery-recorder.js';
import type { DeliveryEventInput, DeliveryEventType } from '../base/session/delivery.js';
import type { HookRuntime } from '../base/session/capture-contract.js';
import { errorMessage, log, errorFields } from '../base/util/log.js';

/** Where a call's ledger can sit: its own store, else the operator's global one; a shared store
 * has no `global`. */
export interface LedgerReach {
  readonly local?: LedgerHome;
  readonly global?: GlobalInReach;
}

/** A store's ledger read through its enrichment, with the config that governs it; unset when the
 * store keeps none. */
export function ledgerHomeOf(
  enrich: Pick<CoreEnrichment, 'ledger' | 'folderFiles'> | undefined,
  config: HippoConfig,
): LedgerHome | undefined {
  const ledger = enrich?.ledger;
  const folderFiles = enrich?.folderFiles;
  return ledger && folderFiles ? { ledger, folderFiles, config } : undefined;
}

/** Only a store that keeps a ledger has one, and a local one needs a reach that says the caller
 * has a store. */
export function ledgerReachOf(ctx: Pick<Context, 'reach'>, shared?: boolean): LedgerReach {
  const local = ctx.reach?.hasLocal === true ? ctx.reach.ledger : undefined;
  return shared === true ? { local } : { local, global: ctx.reach?.global };
}

/** The call's own store, else the global store (the prompt hook fires where none is); null with
 * neither. */
export function ledgerHome(reach: LedgerReach): LedgerHome | null {
  if (reach.local !== undefined) return reach.local;
  const { global } = reach;
  return (global && ledgerHomeOf(global.enrich, global.config)) ?? null;
}

/** Books one row in ledgerHome's store, best-effort. */
export async function bookTokenUse(use: TokenUse, reach: LedgerReach): Promise<void> {
  await ledgerHome(reach)?.ledger.recordTurn({ uses: [use] });
}

/** Books a turn's rows and then its delivery event on one connection of ledgerHome's store,
 * best-effort. */
export async function bookLedgerTurn(turn: LedgerTurn, reach: LedgerReach): Promise<void> {
  await ledgerHome(reach)?.ledger.recordTurn(turn);
}

/** bookLedgerTurn where each row is its own attempt: a row that fails is noted and the rest
 * still land. */
export async function bookLedgerTurnPerRow(
  turn: Omit<LedgerTurn, 'perRow'>,
  reach: LedgerReach,
): Promise<void> {
  await ledgerHome(reach)?.ledger.recordTurn({ ...turn, perRow: true });
}

/** What the session last sent on `surface` in ledgerHome's store; null with no ledger, no row or
 * a failed read. */
export async function ledgerLastSent(
  tenantId: string,
  sessionId: string | null | undefined,
  surface: TokenSurface,
  reach: LedgerReach,
): Promise<LastSent | null> {
  return (await ledgerHome(reach)?.ledger.lastSent(tenantId, sessionId, surface)) ?? null;
}

/** What a hook's delivery row says about the call it records. */
export interface DeliveryStart {
  stdinText: string | undefined;
  runtime: HookRuntime;
  eventType?: DeliveryEventType;
  /** The host's own session id from its environment, used when the payload names none. */
  envSessionId: string | undefined;
  /** Passed through to the recorder; only tests set it. */
  fault?: DeliveryFault;
}

/** A delivery recorder for a hook on `ctx`'s store when the ledger store enables one, else null;
 * never throws. */
export async function startDeliveryRecorder(
  ctx: Context,
  start: DeliveryStart,
): Promise<DeliveryRecorder | null> {
  try {
    // The same store the token ledger writes to, so its config governs both.
    const reach = ledgerReachOf(ctx);
    const home = ledgerHome(reach);
    if (home === null || !home.config.deliveryLedger.enabled) return null;
    return createDeliveryRecorder({
      ledger: home.ledger,
      storeHash: (await home.folderFiles.home()).hash,
      // ledgerHome falls back to the global store only when the primary is not initialized.
      writeStore: home !== reach.local || ctx.reach?.isGlobal === true ? 'global' : 'local',
      tenantId: ctx.tenantId,
      stdinText: start.stdinText,
      envSessionId: start.envSessionId,
      runtime: start.runtime === 'copilot' ? 'copilot' : undefined,
      eventType: start.eventType,
      fault: start.fault,
      now: ctx.infra.clock(),
    });
  } catch (error) {
    log.warn(`delivery ledger skipped: ${errorMessage(error)}`, errorFields(error));
    return null;
  }
}

/** A recorder for `hippo capture-error`, only when the failure log and the ledger are one store,
 * so `failure_id` never points into another. */
export async function startToolFailureRecorder(
  ctx: Context,
  start: Omit<DeliveryStart, 'eventType'>,
): Promise<DeliveryRecorder | null> {
  const reach = ledgerReachOf(ctx);
  // ledgerHome is the call's own store only when it is the local one.
  if (reach.local === undefined) return null;
  return startDeliveryRecorder(ctx, { ...start, eventType: 'tool-failure' });
}

/** The recorder's event for a turn to write after its rows; undefined with no recorder, a second
 * take or a failure. */
export function takeDelivery(rec: DeliveryRecorder | null): DeliveryEventInput | undefined {
  if (rec === null) return undefined;
  try {
    return rec.takeEvent() ?? undefined;
  } catch (error) {
    log.error(`delivery ledger write failed: ${errorMessage(error)}`, errorFields(error));
    return undefined;
  }
}

/** Writes the recorder's event; a second flush is a no-op. A recorder started before the request
 * that flushes it passes that request's `ctx`, so the write takes the request's handle and lock
 * wait. */
export async function flushDeliveryRecorder(
  rec: DeliveryRecorder | null,
  ctx?: Pick<Context, 'reach' | 'store' | 'config'>,
): Promise<void> {
  const event = takeDelivery(rec);
  if (rec === null || event === undefined) return;
  const ledger =
    (ctx === undefined ? undefined : ledgerHome(ledgerReachOf(ctx))?.ledger) ?? rec.ledger;
  await ledger.recordTurn({ uses: [], delivery: event });
}
