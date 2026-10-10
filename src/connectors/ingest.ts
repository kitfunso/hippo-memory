// The write half every connector's ingest shares, after its own pre-check of the event log.

import { remember, type Context, type RememberOpts } from '../api/index.js';
import { requireGroup, storeFor } from '../store/index.js';
import type { ConnectorEvent } from '../store/port.js';
import { RejectedValueError } from '../store/rejection.js';

export type IngestStatus = 'ingested' | 'duplicate' | 'skipped' | 'skipped_duplicate';

export interface IngestResult {
  status: IngestStatus;
  memoryId: string | null;
}

/** Stores `opts` once per event key; null `opts` (an empty body) and a tombstoned value are logged with no memory, so a redelivery acks instead of retrying. */
export async function rememberWithEventLog(ctx: Context, event: ConnectorEvent, opts: RememberOpts | null): Promise<IngestResult> {
  if (!opts) return markSkipped(ctx, event);
  try {
    // No actor fallback: every caller builds ctx with its connector subject.
    const result = await remember(ctx, { ...opts, untrusted: true, event });
    // Another worker logged this key between the pre-check and the write: its memory stands and ours was not stored.
    if (result.duplicate) return { status: 'skipped_duplicate', memoryId: result.duplicate.memoryId };
    return { status: 'ingested', memoryId: result.id };
  } catch (e) {
    // A tombstone refusal is permanent, so a DLQ retry would hit it forever.
    if (e instanceof RejectedValueError) return markSkipped(ctx, event);
    throw e;
  }
}

async function markSkipped(ctx: Context, event: ConnectorEvent): Promise<IngestResult> {
  await requireGroup(storeFor(ctx), 'connectorEvents').markEventSeen(event);
  return { status: 'skipped', memoryId: null };
}
