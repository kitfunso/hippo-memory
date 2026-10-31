// What a connector reads and writes beside its memories: the event log, backfill cursors and the
// replay holds on signed deliveries, each in the caller's tenant where it has one.
import type {
  BackfillStream,
  ConnectorEvent,
  ConnectorEventRecord,
  DeliveryClaim,
  EventMarked,
} from '../../base/records/connectors.js';
import type { HippoDbContext } from '../hippo-db-context.js';

/** A webhook holds a delivery before it has routed it to a tenant. */
export type DeliveryContext = Pick<HippoDbContext, 'store'>;

/** The fast path only: the write logs the key again in its own transaction, which is what holds
 * when two workers race. */
export function connectorEventRecord(
  ctx: HippoDbContext,
  event: ConnectorEvent,
): Promise<ConnectorEventRecord> {
  return ctx.store.hippoDb.connectorEvents.eventRecord(event);
}

/** Logged with no memory, so a redelivery acks instead of running again. */
export function markConnectorEventSeen(
  ctx: HippoDbContext,
  event: ConnectorEvent,
): Promise<EventMarked> {
  return ctx.store.hippoDb.connectorEvents.markEventSeen(event);
}

/** A delete event's log row, and while it is unlogged the raw row the caller's tenant holds for
 * `artifactRef`; never another tenant's row that shares the ref. */
export function deletionTarget(
  ctx: HippoDbContext,
  event: ConnectorEvent,
  artifactRef: string,
): Promise<ConnectorEventRecord> {
  return ctx.store.hippoDb.connectorEvents.eventRecord(event, {
    artifactRef,
    tenantId: ctx.tenantId,
  });
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

/** False when a hold on the key has not run out: the delivery is a replay. */
export function holdDelivery(ctx: DeliveryContext, claim: DeliveryClaim): Promise<boolean> {
  return ctx.store.hippoDb.connectorEvents.claimDelivery(claim);
}

/** For a delivery that failed and stored nothing, so the sender's retry gets through. */
export function releaseDelivery(
  ctx: DeliveryContext,
  connector: DeliveryClaim['connector'],
  key: string,
): Promise<void> {
  return ctx.store.hippoDb.connectorEvents.releaseDelivery(connector, key);
}
