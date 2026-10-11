import type { Context } from '../../api/index.js';
import {
  githubDlqEntry,
  markGitHubDlqRetried,
  listGitHubDlq,
  type DlqBucket,
  type DlqItem,
  type GitHubDlqInsert,
} from '../../store/connectors/github.js';
import { replayParked, type ConnectorDlq, type ReplayResult, type SignatureRefusal } from '../dlq.js';
import { verifyGitHubSignature } from './signature.js';
import { isGitHubWebhookEnvelope, type GitHubWebhookEnvelope } from './types.js';
import type { JsonValue } from '../../util/json.js';

export type { DlqBucket, DlqItem };

type GitHubOwnColumns = Pick<GitHubDlqInsert, 'eventName' | 'deliveryId' | 'installationId' | 'repoFullName'>;

/** GitHub's dead-letter table; the event, delivery, installation and repo columns let an operator triage a row without re-reading the payload. */
export const githubDlq: ConnectorDlq<GitHubOwnColumns, DlqBucket, DlqItem> = {
  letter: (row) => ({ connector: 'github', ...row }),
  list: listGitHubDlq,
  entry: githubDlqEntry,
  bump: markGitHubDlqRetried,
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
  const { webhookSecret, previousSecret, ingestHook } = opts;
  return replayParked<DlqItem, JsonValue & GitHubWebhookEnvelope>({
    dlq: githubDlq,
    // The secret in effect now, not the one in effect when the row was parked.
    refuseSignature: (row) => (webhookSecret ? refuseSignature(row, webhookSecret, previousSecret) : null),
    isEnvelope: isGitHubWebhookEnvelope,
    notEnvelope: 'not a GitHub webhook envelope',
    reingest: async (row) => {
      if (!ingestHook) return { ok: true, status: 'replayed', memoryId: null, reason: 'dry-run: no ingest hook supplied' };
      // The hook owns routing, idempotency and the memory write, and re-derives the key from the parsed event.
      const { memoryId } = await ingestHook(ctx, {
        rawPayload: row.rawPayload,
        eventName: row.eventName ?? '',
        deliveryId: row.deliveryId ?? '',
      });
      return { ok: true, status: 'replayed', memoryId };
    },
  }, ctx.hippoRoot, id, opts.force === true);
}

function refuseSignature(row: DlqItem, webhookSecret: string, previousSecret: string | undefined): SignatureRefusal | null {
  if (!row.signature) {
    return { status: 'sig_missing', reason: 'row has no signature (legacy, or redacted before storing); pass --force to replay' };
  }
  if (verifyGitHubSignature({ rawBody: row.rawPayload, signature: row.signature, webhookSecret, previousSecret })) return null;
  return {
    status: 'sig_fail',
    reason: 'signature did not verify against current GITHUB_WEBHOOK_SECRET; pass --force to replay anyway',
  };
}
