import type { DatabaseSyncLike } from '../../db.js';
import type { Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import { verifyGitHubSignature } from './signature.js';
import { isGitHubWebhookEnvelope } from './types.js';

/**
 * GitHub webhook DLQ. Mirrors the Slack DLQ shape (src/connectors/slack/dlq.ts)
 * but carries GitHub-specific metadata: event_name, delivery_id, signature,
 * installation_id, repo_full_name. Codex P1 #5 mandates this rich context
 * so a `hippo gh dlq replay` operator can triage without re-deriving anything
 * from the raw payload.
 *
 * Buckets:
 *   - parse_error     — raw_payload was not valid JSON
 *   - unroutable      — no tenant resolved for installation_id / repo_full_name
 *   - signature_failed — HMAC did not verify against the active webhook secret
 *   - unhandled       — parsed but no handler matched the event
 */
export type DlqBucket = 'parse_error' | 'unroutable' | 'signature_failed' | 'unhandled';

export interface DlqItem {
  id: number;
  tenantId: string;
  rawPayload: string;
  error: string;
  eventName: string | null;
  deliveryId: string | null;
  signature: string | null;
  installationId: string | null;
  repoFullName: string | null;
  retryCount: number;
  receivedAt: string;
  retriedAt: string | null;
  bucket: DlqBucket | string;
}

/**
 * `tenantId: null` means the connector could not resolve a tenant for the
 * envelope (unroutable installation/repo). Stored as the sentinel
 * `'__unroutable__'` so the NOT NULL column is honored — same convention as
 * Slack DLQ.
 */
export interface WriteDlqOpts {
  tenantId: string | null;
  rawPayload: string;
  error: string;
  bucket?: DlqBucket;
  eventName?: string | null;
  deliveryId?: string | null;
  signature?: string | null;
  installationId?: string | null;
  repoFullName?: string | null;
}

export function writeToDlq(db: DatabaseSyncLike, opts: WriteDlqOpts): number {
  const result = db
    .prepare(
      `INSERT INTO github_dlq
        (tenant_id, raw_payload, error, event_name, delivery_id, signature,
         installation_id, repo_full_name, received_at, bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.tenantId ?? '__unroutable__',
      opts.rawPayload,
      opts.error,
      opts.eventName ?? null,
      opts.deliveryId ?? null,
      opts.signature ?? null,
      opts.installationId ?? null,
      opts.repoFullName ?? null,
      new Date().toISOString(),
      opts.bucket ?? 'parse_error',
    );
  return Number(result.lastInsertRowid);
}

const SELECT_COLUMNS = `id, tenant_id, raw_payload, error, event_name, delivery_id,
            signature, installation_id, repo_full_name, retry_count,
            received_at, retried_at, bucket`;

export function listDlq(
  db: DatabaseSyncLike,
  opts: { tenantId: string; limit?: number },
): DlqItem[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM github_dlq
        WHERE tenant_id = ?
        ORDER BY received_at ASC
        LIMIT ?`,
    )
    .all(opts.tenantId, opts.limit ?? 100) as Array<Record<string, unknown>>;
  return rows.map(rowToItem);
}

export function getDlqEntry(db: DatabaseSyncLike, id: number): DlqItem | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM github_dlq
        WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToItem(row);
}

function rowToItem(r: Record<string, unknown>): DlqItem {
  return {
    id: Number(r.id),
    tenantId: String(r.tenant_id),
    rawPayload: String(r.raw_payload),
    error: String(r.error),
    eventName: r.event_name == null ? null : String(r.event_name),
    deliveryId: r.delivery_id == null ? null : String(r.delivery_id),
    signature: r.signature == null ? null : String(r.signature),
    installationId: r.installation_id == null ? null : String(r.installation_id),
    repoFullName: r.repo_full_name == null ? null : String(r.repo_full_name),
    retryCount: Number(r.retry_count ?? 0),
    receivedAt: String(r.received_at),
    retriedAt: r.retried_at == null ? null : String(r.retried_at),
    bucket: r.bucket == null ? 'parse_error' : String(r.bucket),
  };
}

function bumpRetryCount(hippoRoot: string, id: number): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(
      `UPDATE github_dlq
          SET retry_count = retry_count + 1,
              retried_at = ?
        WHERE id = ?`,
    ).run(new Date().toISOString(), id);
  } finally {
    closeHippoDb(db);
  }
}

export interface ReplayDlqOpts {
  /** Current webhook secret. If omitted, signature check is skipped (force-only path). */
  webhookSecret?: string;
  /** When true, skip signature verification (used for legacy entries after secret rotation). */
  force?: boolean;
}

export type ReplayStatus =
  | 'replayed'
  | 'parse_error'
  | 'sig_fail'
  | 'sig_missing'
  | 'unhandled'
  | 'not_found';

export interface ReplayResult {
  ok: boolean;
  status: ReplayStatus;
  memoryId: string | null;
  retryCount: number;
  reason?: string;
}

/**
 * Hook the webhook route injects to actually re-ingest a row. Decoupling
 * the dispatch keeps this module free of every event-type handler — the
 * route already knows how to route an envelope, so it passes that capability
 * back in.
 */
export type IngestHook = (
  ctx: Context,
  args: {
    rawPayload: string;
    eventName: string;
    idempotencyKey: string;
    deliveryId: string;
  },
) => Promise<{ memoryId: string | null }>;

/**
 * Replay a DLQ row through the normal ingest path. Behavior:
 *   1. Fetch row by id. Not found → `not_found`.
 *   2. If !force and webhookSecret provided, verify signature with the
 *      current secret. Fail → bump retry_count, `sig_fail`.
 *      Missing signature on the row → `sig_missing` (no bump; --force required).
 *   3. JSON.parse the raw payload. Fail → bump, `parse_error`.
 *   4. Type-guard the envelope. Fail → bump, `unhandled`.
 *   5. If an `ingestHook` is supplied, call it and return its memoryId.
 *      If not (dry-run path), bump retry_count and return status `replayed`
 *      with memoryId=null. The webhook route wires the real hook in Task 14.
 *
 * Mirrors Slack's "always use current routing" policy: replays use the
 * deployment state NOW, not at the time of original DLQing.
 */
export async function replayDlqEntry(
  ctx: Context,
  id: number,
  opts: ReplayDlqOpts & { ingestHook?: IngestHook } = {},
): Promise<ReplayResult> {
  const db = openHippoDb(ctx.hippoRoot);
  let row: DlqItem | null;
  try {
    row = getDlqEntry(db, id);
  } finally {
    closeHippoDb(db);
  }
  if (!row) {
    return {
      ok: false,
      status: 'not_found',
      memoryId: null,
      retryCount: 0,
      reason: `dlq id ${id} not found`,
    };
  }

  // Signature verification (current secret, not the one in effect when DLQed).
  if (!opts.force && opts.webhookSecret) {
    if (!row.signature) {
      return {
        ok: false,
        status: 'sig_missing',
        memoryId: null,
        retryCount: row.retryCount,
        reason: 'legacy row without signature; pass --force to replay',
      };
    }
    const sigOk = verifyGitHubSignature({
      rawBody: row.rawPayload,
      signature: row.signature,
      webhookSecret: opts.webhookSecret,
    });
    if (!sigOk) {
      bumpRetryCount(ctx.hippoRoot, id);
      return {
        ok: false,
        status: 'sig_fail',
        memoryId: null,
        retryCount: row.retryCount + 1,
        reason:
          'signature did not verify against current GITHUB_WEBHOOK_SECRET; pass --force to replay anyway',
      };
    }
  }

  // Parse + envelope guard.
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.rawPayload);
  } catch (e) {
    bumpRetryCount(ctx.hippoRoot, id);
    return {
      ok: false,
      status: 'parse_error',
      memoryId: null,
      retryCount: row.retryCount + 1,
      reason: `still unparseable: ${(e as Error).message}`,
    };
  }
  if (!isGitHubWebhookEnvelope(parsed)) {
    bumpRetryCount(ctx.hippoRoot, id);
    return {
      ok: false,
      status: 'unhandled',
      memoryId: null,
      retryCount: row.retryCount + 1,
      reason: 'not a GitHub webhook envelope',
    };
  }

  // Without an ingest hook this is a dry-run validation. Bump and report.
  if (!opts.ingestHook) {
    bumpRetryCount(ctx.hippoRoot, id);
    return {
      ok: true,
      status: 'replayed',
      memoryId: null,
      retryCount: row.retryCount + 1,
      reason: 'dry-run: no ingest hook supplied',
    };
  }

  // Real replay path. The route's IngestHook is responsible for routing,
  // idempotency, and writing the memory. The DLQ module only validates the
  // surface and bumps the retry counter.
  const eventName = row.eventName ?? '';
  const deliveryId = row.deliveryId ?? '';
  const idempotencyKey = (await import('./signature.js')).computeIdempotencyKey(
    eventName,
    row.rawPayload,
  );
  const { memoryId } = await opts.ingestHook(ctx, {
    rawPayload: row.rawPayload,
    eventName,
    idempotencyKey,
    deliveryId,
  });
  bumpRetryCount(ctx.hippoRoot, id);
  return {
    ok: true,
    status: 'replayed',
    memoryId,
    retryCount: row.retryCount + 1,
  };
}
