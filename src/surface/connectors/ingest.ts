import { rememberUntrusted, type ConnectorRememberOptions } from '../../api/index.js';
import type { ContextWith } from '../../api/types.js';
import type { ConnectorEvent, OptionalGroup, StoreWith } from '../../base/ports/store.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { InfraPorts } from '../../base/ports/infra.js';

/** The groups every connector reaches: its event log, and the writes that commit with an event. */
export const CONNECTOR_GROUPS = [
  'connectorWrites',
  'connectorEvents',
] as const satisfies readonly OptionalGroup[];
export type ConnectorGroup = (typeof CONNECTOR_GROUPS)[number];
export type ConnectorStore = StoreWith<ConnectorGroup>;
export type ConnectorContext = ContextWith<ConnectorGroup>;

/** What the server hands a connector's webhook: the store, its config and the outside services. */
export interface WebhookPorts {
  store: ConnectorStore;
  config: HippoConfig;
  infra: InfraPorts;
}

export type IngestStatus = 'ingested' | 'duplicate' | 'skipped' | 'skipped_duplicate';

export interface IngestResult {
  status: IngestStatus;
  memoryId: string | null;
}

/** Stores `opts` once per event key; null `opts` (an empty body) and a tombstoned value are
 * logged with no memory, so a redelivery acks instead of retrying. */
export async function rememberWithEventLog(
  ctx: ConnectorContext,
  event: ConnectorEvent,
  opts: ConnectorRememberOptions | null,
): Promise<IngestResult> {
  if (!opts) return markSkipped(ctx, event);
  try {
    const result = await rememberUntrusted(ctx, { ...opts, event });
    if (result.duplicate) {
      return { status: 'skipped_duplicate', memoryId: result.duplicate.memoryId };
    }
    return { status: 'ingested', memoryId: result.id };
  } catch (e) {
    if (e instanceof RejectedValueError) return markSkipped(ctx, event);
    throw e;
  }
}

async function markSkipped(ctx: ConnectorContext, event: ConnectorEvent): Promise<IngestResult> {
  await ctx.store.connectorEvents.markEventSeen(event);
  return { status: 'skipped', memoryId: null };
}
