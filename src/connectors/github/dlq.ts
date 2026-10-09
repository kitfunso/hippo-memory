import type { Context } from '../../api.js';
import {
  bumpDlqRetry,
  dlqEntry,
  listDlqRows,
  type DlqBucket,
  type DlqItem,
  type GithubDlqWrite,
} from '../../store/connectors/github.js';
import { replayFailed, type ConnectorDlq, type ReplayResult } from '../dlq.js';
import { verifyGitHubSignature } from './signature.js';
import { isGitHubWebhookEnvelope } from './types.js';
import type { JsonValue } from '../../json.js';

export type { DlqBucket, DlqItem };

type GithubOwnColumns = Pick<GithubDlqWrite, 'eventName' | 'deliveryId' | 'installationId' | 'repoFullName'>;

/** GitHub's dead-letter table; the event, delivery, installation and repo columns let an operator triage a row without re-reading the payload. */
export const githubDlq: ConnectorDlq<GithubOwnColumns, DlqBucket, DlqItem> = {
  letter: (row) => ({ connector: 'github', ...row }),
  list: listDlqRows,
};

export interface ReplayDlqOpts {
  /** Current webhook secret. If omitted, signature check is skipped (force-only path). */
  webhookSecret?: string;
  /**
   * Previous webhook secret during rotation.
   * Operators rotating GITHUB_WEBHOOK_SECRET would otherwise be forced into
   * --force on DLQ rows written under the old secret. Plumbed through to
   * verifyGitHubSignature.previousSecret.
   */
  previousSecret?: string;
  /** When true, skip signature verification (used for legacy entries after secret rotation). */
  force?: boolean;
}

/**
 * Hook the webhook route injects to actually re-ingest a row. Decoupling
 * the dispatch keeps this module free of every event-type handler — the
 * route already knows how to route an envelope, so it passes that capability
 * back in.
 *
 * No `idempotencyKey` field: ingest re-derives the key from the parsed event,
 * so a hook trusting a passed-in key would dedupe against a stale one.
 */
export type IngestHook = (
  ctx: Context,
  args: {
    rawPayload: string;
    eventName: string;
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
 *      with memoryId=null. The webhook route wires the real hook.
 *
 * Mirrors Slack's "always use current routing" policy: replays use the
 * deployment state NOW, not at the time of original DLQing.
 */
export async function replayDlqEntry(
  ctx: Context,
  id: number,
  opts: ReplayDlqOpts & { ingestHook?: IngestHook } = {},
): Promise<ReplayResult> {
  const row = dlqEntry(ctx.hippoRoot, id);
  if (!row) return replayFailed('not_found', 0, `dlq id ${id} not found`);

  // Signature verification (current secret, not the one in effect when DLQed).
  if (!opts.force && opts.webhookSecret) {
    const sigFailure = checkReplaySignature(ctx.hippoRoot, id, row, opts.webhookSecret, opts.previousSecret);
    if (sigFailure) return sigFailure;
  }

  const envelopeFailure = checkReplayEnvelope(ctx.hippoRoot, id, row);
  if (envelopeFailure) return envelopeFailure;

  // Without an ingest hook this is a dry-run validation. Bump and report.
  if (!opts.ingestHook) {
    bumpDlqRetry(ctx.hippoRoot, id);
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
  // No idempotencyKey arg: the hook re-derives it from the parsed event (artifact_ref + updated_at).
  const eventName = row.eventName ?? '';
  const deliveryId = row.deliveryId ?? '';
  const { memoryId } = await opts.ingestHook(ctx, {
    rawPayload: row.rawPayload,
    eventName,
    deliveryId,
  });
  bumpDlqRetry(ctx.hippoRoot, id);
  return {
    ok: true,
    status: 'replayed',
    memoryId,
    retryCount: row.retryCount + 1,
  };
}

/** The failure result when the row cannot pass the signature gate, else null. */
function checkReplaySignature(
  hippoRoot: string,
  id: number,
  row: DlqItem,
  webhookSecret: string,
  previousSecret: string | undefined,
): ReplayResult | null {
  if (!row.signature) {
    return replayFailed(
      'sig_missing',
      row.retryCount,
      'row has no signature (legacy, or redacted before storing); pass --force to replay',
    );
  }
  const sigOk = verifyGitHubSignature({
    rawBody: row.rawPayload,
    signature: row.signature,
    webhookSecret,
    previousSecret,
  });
  if (!sigOk) {
    bumpDlqRetry(hippoRoot, id);
    return replayFailed(
      'sig_fail',
      row.retryCount + 1,
      'signature did not verify against current GITHUB_WEBHOOK_SECRET; pass --force to replay anyway',
    );
  }
  return null;
}

/** Parse + envelope guard; the failure result after bumping the count, else null. */
function checkReplayEnvelope(hippoRoot: string, id: number, row: DlqItem): ReplayResult | null {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(row.rawPayload);
  } catch (e) {
    bumpDlqRetry(hippoRoot, id);
    // SAFETY: this is a best-effort error message only; property access on
    // any JS value is safe (undefined if absent), preserving the existing
    // lenient formatting even when something non-Error was thrown.
    const message = (e as Error).message;
    return replayFailed('parse_error', row.retryCount + 1, `still unparseable: ${message}`);
  }
  if (!isGitHubWebhookEnvelope(parsed)) {
    bumpDlqRetry(hippoRoot, id);
    return replayFailed('unhandled', row.retryCount + 1, 'not a GitHub webhook envelope');
  }
  return null;
}
