// The dead-letter queue every webhook connector parks into: one redaction, one unroutable sentinel, one set of
// defaults, one replay result.

import { DEFAULT_LIST_LIMIT } from '../../base/util/limits.js';
import { DLQ_REDACTED_NOTE, redactPayload } from '../../base/util/secret-detect.js';
import type { HippoStore } from '../../store/index.js';
import type { ConnectorDeadLetter, DeadLetterConnector, DeadLetterRows } from '../../store/port.js';
import type { JsonValue } from '../../base/util/json.js';
import { errorMessage } from '../../base/util/log.js';

/** The tenant stored on a row no tenant was resolved for; the column is NOT NULL. */
const UNROUTABLE_TENANT = '__unroutable__';

const DEFAULT_BUCKET = 'parse_error';

/** What a caller hands over to park one payload, whatever the connector. */
export interface ParkOptions<Bucket extends string> {
  /** null when no tenant was resolved for the payload. */
  tenantId: string | null;
  rawPayload: string;
  error: string;
  bucket?: Bucket;
  signature?: string | null;
}

/** The columns every connector's table has, as stored. */
export interface ParkedRow<Bucket extends string> {
  tenantId: string;
  rawPayload: string;
  error: string;
  bucket: Bucket | typeof DEFAULT_BUCKET;
  signature: string | null;
}

/** What one connector supplies: the queue its rows live in and the letter that parks a row there. `Own` is the columns
 * only its table has. */
export interface ConnectorDlq<C extends DeadLetterConnector, Own, Bucket extends string> {
  readonly connector: C;
  readonly letter: (row: ParkedRow<Bucket> & Own) => ConnectorDeadLetter;
}

export async function parkInDlq<Own, Bucket extends string>(
  dlq: ConnectorDlq<DeadLetterConnector, Own, Bucket>,
  store: HippoStore,
  opts: ParkOptions<Bucket> & NoInfer<Own>,
): Promise<number> {
  const rawPayload = redactPayload(opts.rawPayload);
  // A redacted body can never match its signature, so the row keeps none and replay needs --force.
  const redacted = rawPayload !== opts.rawPayload;
  const letter = dlq.letter({
    ...opts,
    tenantId: opts.tenantId ?? UNROUTABLE_TENANT,
    rawPayload,
    error: redacted ? `${opts.error}; ${DLQ_REDACTED_NOTE}` : opts.error,
    bucket: opts.bucket ?? DEFAULT_BUCKET,
    signature: redacted ? null : (opts.signature ?? null),
  });
  return store.connectorEvents.parkDeadLetter(letter);
}

export function listDlq<C extends DeadLetterConnector>(
  dlq: ConnectorDlq<C, never, never>,
  store: HippoStore,
  opts: { tenantId: string; limit?: number },
): Promise<DeadLetterRows[C][]> {
  return store.connectorEvents.deadLetters(dlq.connector, opts.tenantId, opts.limit ?? DEFAULT_LIST_LIMIT);
}

/** Every outcome a replay reports; a connector that re-ingests inline reports the ingest outcome itself. */
export type ReplayStatus =
  | 'not_found'
  | 'sig_missing'
  | 'sig_fail'
  | 'parse_error'
  | 'unhandled'
  | 'unroutable'
  | 'replayed'
  | 'ingested'
  | 'duplicate'
  | 'skipped'
  | 'skipped_duplicate'
  | 'archived';

export interface ReplayResult {
  ok: boolean;
  status: ReplayStatus;
  memoryId: string | null;
  retryCount: number;
  reason?: string;
}

/** A replay that did not go through; `retryCount` is the row's count after any bump made. */
function replayFailed(status: ReplayStatus, retryCount: number, reason: string): ReplayResult {
  return { ok: false, status, memoryId: null, retryCount, reason };
}

/** A replay that failed after the row was read: counts it exactly once, then reports the new count. */
async function failAndBump(
  dlq: ConnectorDlq<DeadLetterConnector, never, never>,
  store: HippoStore,
  row: { id: number; tenantId: string; retryCount: number },
  failure: { status: ReplayStatus; reason: string },
): Promise<ReplayResult> {
  await store.connectorEvents.markDeadLetterRetried(dlq.connector, row.tenantId, row.id);
  return replayFailed(failure.status, row.retryCount + 1, failure.reason);
}

/** The caller's row by id, else an unroutable one: that row belongs to no tenant until a replay routes it. Another
 * tenant's row reads as absent. */
async function replayableRow<C extends DeadLetterConnector>(
  store: HippoStore,
  connector: C,
  tenantId: string,
  id: number,
): Promise<DeadLetterRows[C] | null> {
  const own = await store.connectorEvents.deadLetter(connector, tenantId, id);
  return own ?? store.connectorEvents.deadLetter(connector, UNROUTABLE_TENANT, id);
}

/** A row that cannot pass the signature gate: 'sig_missing' is not counted, since only --force can get it through. */
export interface SignatureRefusal {
  readonly status: 'sig_missing' | 'sig_fail';
  readonly reason: string;
}

/** What a connector's re-ingest of a parsed envelope reports. */
export type Reingest =
  | {
      readonly ok: true;
      readonly status: ReplayStatus;
      readonly memoryId: string | null;
      readonly reason?: string;
    }
  | {
      readonly ok: false;
      readonly status: ReplayStatus;
      readonly reason: string;
    };

/** The parts of a replay only the connector knows. */
export interface ReplaySteps<C extends DeadLetterConnector, Envelope extends JsonValue> {
  readonly dlq: ConnectorDlq<C, never, never>;
  /** Skipped under --force. */
  readonly refuseSignature: (row: DeadLetterRows[C]) => SignatureRefusal | null;
  readonly isEnvelope: (parsed: JsonValue) => parsed is Envelope;
  readonly notEnvelope: string;
  readonly reingest: (row: DeadLetterRows[C], envelope: Envelope) => Promise<Reingest>;
}

/** Re-runs a parked row under today's secret and routing; every attempt past the read is counted once, except a missing
 * signature. */
export async function replayParked<C extends DeadLetterConnector, Envelope extends JsonValue>(
  steps: ReplaySteps<C, Envelope>,
  store: HippoStore,
  tenantId: string,
  id: number,
  force: boolean,
): Promise<ReplayResult> {
  const row = await replayableRow(store, steps.dlq.connector, tenantId, id);
  if (!row) return replayFailed('not_found', 0, `dlq id ${id} not found`);

  const refusal = force ? null : steps.refuseSignature(row);
  if (refusal?.status === 'sig_missing') {
    return replayFailed(refusal.status, row.retryCount, refusal.reason);
  }
  if (refusal) return failAndBump(steps.dlq, store, row, refusal);

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(row.rawPayload);
  } catch (e) {
    return failAndBump(steps.dlq, store, row, {
      status: 'parse_error',
      reason: `still unparseable: ${errorMessage(e)}`,
    });
  }
  if (!steps.isEnvelope(parsed)) {
    return failAndBump(steps.dlq, store, row, { status: 'unhandled', reason: steps.notEnvelope });
  }

  const outcome = await steps.reingest(row, parsed);
  if (!outcome.ok) return failAndBump(steps.dlq, store, row, outcome);
  await store.connectorEvents.markDeadLetterRetried(steps.dlq.connector, row.tenantId, row.id);
  const result: ReplayResult = {
    ok: true,
    status: outcome.status,
    memoryId: outcome.memoryId,
    retryCount: row.retryCount + 1,
  };
  if (outcome.reason !== undefined) result.reason = outcome.reason;
  return result;
}
