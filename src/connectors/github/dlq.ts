import type { Context } from '../../api/index.js';
import {
  bumpGitHubDlqRetryCount,
  githubDlqEntry,
  listGitHubDlq,
  type DlqBucket,
  type DlqItem,
  type GitHubDlqInsert,
} from '../../store/connectors/github.js';
import { replayFailed, type ConnectorDlq, type ReplayResult } from '../dlq.js';
import { verifyGitHubSignature } from './signature.js';
import { isGitHubWebhookEnvelope } from './types.js';
import type { JsonValue } from '../../util/json.js';

export type { DlqBucket, DlqItem };

type GitHubOwnColumns = Pick<GitHubDlqInsert, 'eventName' | 'deliveryId' | 'installationId' | 'repoFullName'>;

/** GitHub's dead-letter table; the event, delivery, installation and repo columns let an operator triage a row without re-reading the payload. */
export const githubDlq: ConnectorDlq<GitHubOwnColumns, DlqBucket, DlqItem> = {
  letter: (row) => ({ connector: 'github', ...row }),
  list: listGitHubDlq,
};

export interface ReplayDlqOpts {
  /** Current webhook secret. If omitted, signature check is skipped (force-only path). */
  webhookSecret?: string;
  /** Previous webhook secret during rotation, passed to verifyGitHubSignature.previousSecret so old-secret DLQ rows need no --force. */
  previousSecret?: string;
  /** When true, skip signature verification (used for legacy entries after secret rotation). */
  force?: boolean;
}

/** Hook the webhook route injects to re-ingest a row, which keeps this module free of every event-type handler.
 *  No `idempotencyKey` field: ingest re-derives it from the parsed event, and a passed-in key could be stale. */
export type IngestHook = (
  ctx: Context,
  args: {
    rawPayload: string;
    eventName: string;
    deliveryId: string;
  },
) => Promise<{ memoryId: string | null }>;

/** Replay a DLQ row through the normal ingest path; a failed signature, parse or envelope check bumps retry_count.
 *  Without an `ingestHook` (dry-run) it bumps retry_count and returns `replayed` with memoryId=null; replays use today's routing, not the original's. */
export async function replayDlqEntry(
  ctx: Context,
  id: number,
  opts: ReplayDlqOpts & { ingestHook?: IngestHook } = {},
): Promise<ReplayResult> {
  const row = githubDlqEntry(ctx.hippoRoot, id);
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
    bumpGitHubDlqRetryCount(ctx.hippoRoot, id);
    return {
      ok: true,
      status: 'replayed',
      memoryId: null,
      retryCount: row.retryCount + 1,
      reason: 'dry-run: no ingest hook supplied',
    };
  }

  // Real replay path: the route's IngestHook owns routing, idempotency and the memory write; this module only validates and bumps the retry counter.
  // No idempotencyKey arg: the hook re-derives it from the parsed event (artifact_ref + updated_at).
  const eventName = row.eventName ?? '';
  const deliveryId = row.deliveryId ?? '';
  const { memoryId } = await opts.ingestHook(ctx, {
    rawPayload: row.rawPayload,
    eventName,
    deliveryId,
  });
  bumpGitHubDlqRetryCount(ctx.hippoRoot, id);
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
    bumpGitHubDlqRetryCount(hippoRoot, id);
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
    bumpGitHubDlqRetryCount(hippoRoot, id);
    // SAFETY: best-effort error message only; property access on any JS value is safe, even for a non-Error throw.
    const message = (e as Error).message;
    return replayFailed('parse_error', row.retryCount + 1, `still unparseable: ${message}`);
  }
  if (!isGitHubWebhookEnvelope(parsed)) {
    bumpGitHubDlqRetryCount(hippoRoot, id);
    return replayFailed('unhandled', row.retryCount + 1, 'not a GitHub webhook envelope');
  }
  return null;
}
