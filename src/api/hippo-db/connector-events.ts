// What a connector reads and writes beside its memories: the event log, backfill cursors and the
// replay holds on signed deliveries, each in the caller's tenant where it has one.
import type {
  BackfillStream,
  ConnectorEvent,
  DeliveryClaim,
  EventMarked,
} from '../../base/records/connectors.js';
import { errorFields, log } from '../../base/util/log.js';
import type { HippoDbContext } from '../hippo-db-context.js';
import { rawArchiveForEvent } from './connector-writes.js';

/** A webhook holds a delivery before it has routed it to a tenant. */
export type DeliveryContext = Pick<HippoDbContext, 'store'>;

export interface RowDeletion {
  readonly status: 'archived' | 'not_found' | 'duplicate';
  readonly memoryId: string | null;
}

/** Archives the raw row the caller's tenant holds for `artifactRef`, never another tenant's row
 * that shares the ref, and logs `event` in the archive's own transaction. A logged event answers
 * duplicate; a delete with no row is logged too, so its retry answers duplicate. */
export async function archiveRowForEvent(
  ctx: HippoDbContext,
  event: ConnectorEvent,
  artifactRef: string,
  reason: string,
): Promise<RowDeletion> {
  const events = ctx.store.hippoDb.connectorEvents;
  const target = await events.eventRecord(event, { artifactRef, tenantId: ctx.tenantId });
  if (target.seen) return { status: 'duplicate', memoryId: null };
  if (!target.memoryId) {
    await events.markEventSeen(event);
    return { status: 'not_found', memoryId: null };
  }
  await rawArchiveForEvent(ctx, target.memoryId, reason, event);
  return { status: 'archived', memoryId: target.memoryId };
}

/** One transaction archives every raw row of the artifact in the caller's tenant, under its
 * actor, and logs `event`; a logged event answers duplicate and archives nothing. */
export function archiveArtifactForEvent(
  ctx: HippoDbContext,
  event: ConnectorEvent,
  artifactRef: string,
  reason: string,
): Promise<EventMarked> {
  const deleted = { tenantId: ctx.tenantId, actor: ctx.actor.subject, artifactRef, reason };
  return ctx.store.hippoDb.connectorEvents.markEventSeen(event, deleted);
}

export function backfillCursor(ctx: HippoDbContext, at: BackfillStream): Promise<string | null> {
  return ctx.store.hippoDb.connectorEvents.cursor({ ...at, tenantId: ctx.tenantId });
}

/** With `keepSaved`, a position already saved stays, so a first run's `--since` seeds only what
 * no run saved. */
export function saveBackfillCursor(
  ctx: HippoDbContext,
  at: BackfillStream,
  value: string,
  opts?: { readonly keepSaved?: boolean },
): Promise<void> {
  return ctx.store.hippoDb.connectorEvents.saveCursor(
    { ...at, tenantId: ctx.tenantId },
    value,
    opts,
  );
}

/** Runs `route` once per delivery key: false, without running it, while an earlier hold on the
 * key has not run out. A route that throws stored nothing, so its hold is freed for the retry. */
export async function routeOncePerDelivery(
  ctx: DeliveryContext,
  claim: DeliveryClaim,
  route: () => Promise<void>,
): Promise<boolean> {
  const events = ctx.store.hippoDb.connectorEvents;
  if (!(await events.claimDelivery(claim))) return false;
  try {
    await route();
  } catch (err) {
    await events.releaseDelivery(claim.connector, claim.key).catch((releaseErr) => {
      log.warn(
        `${claim.connector} webhook: could not free the replay hold of a failed delivery`,
        errorFields(releaseErr),
      );
    });
    throw err;
  }
  return true;
}
