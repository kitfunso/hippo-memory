// The write half every connector's ingest shares, after its own pre-check of the event log.

import { rememberUntrusted, type RememberOptions } from '../../api/index.js';
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
  opts: RememberOptions | null,
): Promise<IngestResult> {
  if (!opts) return markSkipped(ctx, event);
  try {
    // No actor fallback: every caller builds ctx with its connector subject.
    const result = await rememberUntrusted(ctx, { ...opts, event });
    // Another worker logged this key between the pre-check and the write: its memory stands and
    // ours was not stored.
    if (result.duplicate) {
      return { status: 'skipped_duplicate', memoryId: result.duplicate.memoryId };
    }
    return { status: 'ingested', memoryId: result.id };
  } catch (e) {
    // A tombstone refusal is permanent, so a DLQ retry would hit it forever.
    if (e instanceof RejectedValueError) return markSkipped(ctx, event);
    throw e;
  }
}

async function markSkipped(ctx: ConnectorContext, event: ConnectorEvent): Promise<IngestResult> {
  await ctx.store.connectorEvents.markEventSeen(event);
  return { status: 'skipped', memoryId: null };
}
