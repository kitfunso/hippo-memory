// The dead-letter queue every webhook connector parks into: one redaction, one unroutable sentinel, one set of defaults, one replay result.

import { DLQ_REDACTED_NOTE, redactPayload } from '../secret-detect.js';

/** The tenant stored on a row no tenant was resolved for; the column is NOT NULL. */
const UNROUTABLE_TENANT = '__unroutable__';

const DEFAULT_BUCKET = 'parse_error';
const DEFAULT_LIST_LIMIT = 100;

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

/** What one connector supplies: its table functions. `Own` is the columns only its table has. */
export interface ConnectorDlq<Own, Bucket extends string, Item> {
  readonly insert: (hippoRoot: string, row: ParkedRow<Bucket> & Own) => number;
  readonly list: (hippoRoot: string, tenantId: string, limit: number) => Item[];
}

export function parkInDlq<Own, Bucket extends string>(
  dlq: ConnectorDlq<Own, Bucket, unknown>,
  hippoRoot: string,
  opts: ParkOpts<Bucket> & NoInfer<Own>,
): number {
  const rawPayload = redactPayload(opts.rawPayload);
  // A redacted body can never match its signature, so the row keeps none and replay needs --force.
  const redacted = rawPayload !== opts.rawPayload;
  return dlq.insert(hippoRoot, {
    ...opts,
    tenantId: opts.tenantId ?? UNROUTABLE_TENANT,
    rawPayload,
    error: redacted ? `${opts.error}; ${DLQ_REDACTED_NOTE}` : opts.error,
    bucket: opts.bucket ?? DEFAULT_BUCKET,
    signature: redacted ? null : opts.signature ?? null,
  });
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

/** A replay that did not go through; `retryCount` is the row's count after any bump the caller made. */
export function replayFailed(status: ReplayStatus, retryCount: number, reason: string): ReplayResult {
  return { ok: false, status, memoryId: null, retryCount, reason };
}
