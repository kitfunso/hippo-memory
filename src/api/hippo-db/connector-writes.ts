// Connector writes: content an agent doesn't control, which the instruction check gates, written
// with its event and any quarantine record on hippo.db's local tier, and a connector's deletes.
import type { ConnectorEvent, ConnectorWrite } from '../../base/records/connectors.js';
import { autoSleepAfterWrite } from '../sleep/auto-sleep.js';
import {
  countRemembered,
  prepareRemember,
  rememberResult,
  type PreparedRemember,
  type RememberOptions,
  type RememberResult,
} from '../memories/remember.js';
import { archiveOf, type ArchiveRawResult } from '../memories/promote.js';
import type { HippoDbContext } from '../hippo-db-context.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';

/** A connector's write of content an agent doesn't control. */
export interface ConnectorRememberOptions extends RememberOptions {
  /** The connector event this write answers. The store logs it in the memory's own transaction;
   * an event logged before stores nothing and answers `duplicate`. */
  event?: ConnectorEvent;
}

/** A flagged row's review record, which the store writes in the row's own transaction. */
function quarantineOf({
  requestedScope,
  detection,
}: PreparedRemember): ConnectorWrite['quarantine'] {
  return detection.flagged
    ? { originalScope: requestedScope, reason: detection.reason ?? 'unknown' }
    : undefined;
}

/** Store one row of connector content, which the instruction check gates. connectorWrites
 * commits the row with its event and any quarantine record, so an event logged before stores
 * nothing and answers `duplicate`. */
export async function rememberUntrusted(
  ctx: HippoDbContext,
  opts: ConnectorRememberOptions,
): Promise<RememberResult> {
  const prepared = prepareRemember(ctx, opts, true);
  const written = await ctx.store.hippoDb.connectorWrites.writeConnectorEntry({
    entry: prepared.entry,
    actor: ctx.actor.subject,
    event: opts.event,
    quarantine: quarantineOf(prepared),
  });
  // A duplicate event stored nothing, so it counts nothing.
  if (written.outcome === 'written') await countRemembered(ctx, 1);
  await autoSleepAfterWrite(ctx);
  return rememberResult(ctx, prepared, written);
}

/** What one connector event became; `logged` means the pre-check found it logged before, so
 * neither the transform nor the write ran. */
export type EventIngest =
  | { readonly status: 'logged'; readonly memoryId: string | null }
  | { readonly status: 'ingested'; readonly memoryId: string }
  | { readonly status: 'skipped' | 'skipped_duplicate'; readonly memoryId: string | null };

/** Stores what `build` returns once per event key. The pre-check only spares the transform: the
 * write logs the key again in its own transaction, which holds when two workers race. An empty
 * body (null) and a tombstoned value are logged with no memory, so a redelivery acks. */
export async function rememberOncePerEvent(
  ctx: HippoDbContext,
  event: ConnectorEvent,
  build: () => RememberOptions | null,
): Promise<EventIngest> {
  const events = ctx.store.hippoDb.connectorEvents;
  const logged = await events.eventRecord(event);
  if (logged.seen) return { status: 'logged', memoryId: logged.memoryId };
  const opts = build();
  try {
    if (opts) {
      const result = await rememberUntrusted(ctx, { ...opts, event });
      // Another worker logged this key between the pre-check and the write; its memory stands.
      if (!result.duplicate) return { status: 'ingested', memoryId: result.id };
      return { status: 'skipped_duplicate', memoryId: result.duplicate.memoryId };
    }
  } catch (e) {
    // A tombstone refusal is permanent, so a DLQ retry would hit it forever.
    if (!(e instanceof RejectedValueError)) throw e;
  }
  await events.markEventSeen(event);
  return { status: 'skipped', memoryId: null };
}

/** rawArchive for a connector's delete: the store logs `event` in the archive's own transaction,
 * so a redelivery finds it logged. */
export async function rawArchiveForEvent(
  ctx: HippoDbContext,
  id: string,
  reason: string,
  event: ConnectorEvent,
): Promise<ArchiveRawResult> {
  const archivedAt = await ctx.store.hippoDb.connectorWrites.archiveConnectorEntry({
    ...archiveOf(ctx, id, reason),
    event,
  });
  return { ok: true, archivedAt };
}
