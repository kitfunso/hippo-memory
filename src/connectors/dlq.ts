// The dead-letter queue every webhook connector parks into: one redaction, one unroutable sentinel, one set of defaults, one replay result.

import { DEFAULT_LIST_LIMIT } from '../util/limits.js';
import { DLQ_REDACTED_NOTE, redactPayload } from '../util/secret-detect.js';
import { requireGroup, storeFor, type HippoStore } from '../store/index.js';
import type { ConnectorDeadLetter } from '../store/port.js';
import type { JsonValue } from '../util/json.js';
import { errorMessage } from '../util/log.js';

/** The tenant stored on a row no tenant was resolved for; the column is NOT NULL. */
const UNROUTABLE_TENANT = '__unroutable__';

const DEFAULT_BUCKET = 'parse_error';

/** What a caller hands over to park one payload, whatever the connector. */
export interface ParkOpts<Bucket extends string> {
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

/** What one connector supplies: the tag that names its table to the store, its list, its one-row read and its retry bump.
 * `Own` is the columns only its table has. */
export interface ConnectorDlq<Own, Bucket extends string, Item> {
  readonly letter: (row: ParkedRow<Bucket> & Own) => ConnectorDeadLetter;
  readonly list: (hippoRoot: string, tenantId: string, limit: number) => Item[];
  readonly entry: (hippoRoot: string, id: number) => Item | null;
  /** Adds one to `retry_count` and stamps `retried_at`. */
  readonly bump: (hippoRoot: string, id: number) => void;
}

/** Parks on `store`, else on hippo.db under `hippoRoot`. */
export async function parkInDlq<Own, Bucket extends string>(
  dlq: ConnectorDlq<Own, Bucket, unknown>,
  hippoRoot: string,
  opts: ParkOpts<Bucket> & NoInfer<Own>,
  store?: HippoStore,
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
    signature: redacted ? null : opts.signature ?? null,
  });
  return requireGroup(storeFor({ hippoRoot, store }), 'connectorEvents').parkDeadLetter(letter);
}

export function listDlq<Item>(
  dlq: ConnectorDlq<never, never, Item>,
  hippoRoot: string,
  opts: { tenantId: string; limit?: number },
): Item[] {
  return dlq.list(hippoRoot, opts.tenantId, opts.limit ?? DEFAULT_LIST_LIMIT);
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

/** The columns a replay reads from any connector's row. */
interface ParkedEntry {
  readonly id: number;
  readonly retryCount: number;
  readonly rawPayload: string;
}

/** A replay that did not go through; `retryCount` is the row's count after any bump made. */
function replayFailed(status: ReplayStatus, retryCount: number, reason: string): ReplayResult {
  return { ok: false, status, memoryId: null, retryCount, reason };
}

/** A replay that failed after the row was read: counts it exactly once, then reports the new count. */
function failAndBump(
  dlq: ConnectorDlq<never, never, unknown>,
  hippoRoot: string,
  row: { id: number; retryCount: number },
  status: ReplayStatus,
  reason: string,
): ReplayResult {
  dlq.bump(hippoRoot, row.id);
  return replayFailed(status, row.retryCount + 1, reason);
}

/** A row that cannot pass the signature gate: 'sig_missing' is not counted, since only --force can get it through. */
export interface SignatureRefusal {
  readonly status: 'sig_missing' | 'sig_fail';
  readonly reason: string;
}

/** What a connector's re-ingest of a parsed envelope reports. */
export type Reingest =
  | { readonly ok: true; readonly status: ReplayStatus; readonly memoryId: string | null; readonly reason?: string }
  | { readonly ok: false; readonly status: ReplayStatus; readonly reason: string };

/** The parts of a replay only the connector knows. */
export interface ReplaySteps<Item, Envelope extends JsonValue> {
  readonly dlq: ConnectorDlq<never, never, Item>;
  /** Skipped under --force. */
  readonly refuseSignature: (row: Item) => SignatureRefusal | null;
  readonly isEnvelope: (parsed: JsonValue) => parsed is Envelope;
  readonly notEnvelope: string;
  readonly reingest: (row: Item, envelope: Envelope) => Promise<Reingest>;
}

/** Re-runs a parked row under today's secret and routing; every attempt past the read is counted once, except a missing signature. */
export async function replayParked<Item extends ParkedEntry, Envelope extends JsonValue>(
  steps: ReplaySteps<Item, Envelope>,
  hippoRoot: string,
  id: number,
  force: boolean,
): Promise<ReplayResult> {
  const row = steps.dlq.entry(hippoRoot, id);
  if (!row) return replayFailed('not_found', 0, `dlq id ${id} not found`);

  const refusal = force ? null : steps.refuseSignature(row);
  if (refusal?.status === 'sig_missing') return replayFailed(refusal.status, row.retryCount, refusal.reason);
  if (refusal) return failAndBump(steps.dlq, hippoRoot, row, refusal.status, refusal.reason);

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(row.rawPayload);
  } catch (e) {
    return failAndBump(steps.dlq, hippoRoot, row, 'parse_error', `still unparseable: ${errorMessage(e)}`);
  }
  if (!steps.isEnvelope(parsed)) return failAndBump(steps.dlq, hippoRoot, row, 'unhandled', steps.notEnvelope);

  const outcome = await steps.reingest(row, parsed);
  if (!outcome.ok) return failAndBump(steps.dlq, hippoRoot, row, outcome.status, outcome.reason);
  steps.dlq.bump(hippoRoot, row.id);
  const result: ReplayResult = { ok: true, status: outcome.status, memoryId: outcome.memoryId, retryCount: row.retryCount + 1 };
  if (outcome.reason !== undefined) result.reason = outcome.reason;
  return result;
}
