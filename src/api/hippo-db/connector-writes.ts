// Connector writes: content an agent doesn't control, which the instruction check gates, written
// with its event and any quarantine record on hippo.db's local tier, and a connector's deletes.
import type { ConnectorEvent, ConnectorWrite } from '../../base/ports/store.js';
import type { ContextWith } from '../types.js';
import { autoSleepAfterWrite } from '../sleep/auto-sleep.js';
import {
  prepareRemember,
  rememberResult,
  type PreparedRemember,
  type RememberOptions,
  type RememberResult,
} from '../memories/remember.js';
import { archiveOf, type ArchiveRawResult } from '../memories/promote.js';

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
  ctx: ContextWith<'connectorWrites'>,
  opts: ConnectorRememberOptions,
): Promise<RememberResult> {
  const prepared = prepareRemember(ctx, opts, true);
  const written = await ctx.store.hippoDb.connectorWrites.writeConnectorEntry({
    entry: prepared.entry,
    actor: ctx.actor.subject,
    event: opts.event,
    quarantine: quarantineOf(prepared),
  });
  await autoSleepAfterWrite(ctx);
  return rememberResult(ctx, prepared, written);
}

/** rawArchive for a connector's delete: the store logs `event` in the archive's own transaction,
 * so a redelivery finds it logged. */
export async function rawArchiveForEvent(
  ctx: ContextWith<'connectorWrites'>,
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
