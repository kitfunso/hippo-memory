import type { ConnectorContext } from '../ingest.js';
import {
  replayParked,
  type ConnectorDlq,
  type ReplayResult,
  type SignatureRefusal,
} from '../dlq.js';
import { verifyGitHubSignature } from './signature.js';
import { GITHUB_COM, hostMismatch, mismatchSender, type GitHubSite } from './site.js';
import { isGitHubWebhookEnvelope, type GitHubWebhookEnvelope } from './types.js';
import type { JsonValue } from '../../../base/util/json.js';
import type {
  GitHubDlqBucket as DlqBucket,
  GitHubDlqItem as DlqItem,
  GitHubDlqInsert,
} from '../../../base/ports/store/connectors.js';

export type { DlqBucket, DlqItem };

type GitHubOwnColumns = Pick<
  GitHubDlqInsert,
  'eventName' | 'deliveryId' | 'installationId' | 'repoFullName'
>;

/** GitHub's dead-letter table; the event, delivery, installation and repo columns let an
 * operator triage a row without re-reading the payload. */
export const githubDlq: ConnectorDlq<'github', GitHubOwnColumns, DlqBucket> = {
  connector: 'github',
  letter: (row) => ({ connector: 'github', ...row }),
};

export interface ReplayDlqOptions {
  /** Current webhook secret. If omitted, signature check is skipped (force-only path). */
  webhookSecret?: string;
  /** Previous webhook secret during rotation, passed to verifyGitHubSignature.previousSecret so
   * old-secret DLQ rows need no --force. */
  previousSecret?: string;
  /** When true, skip signature verification (used for legacy entries after secret rotation). */
  force?: boolean;
  /** Today's GITHUB_ENTERPRISE_URL site. A host_mismatch row replays only when the webhook's host
   * check would take its sender now; --force does not skip this. */
  site?: GitHubSite;
}

/** Hook the webhook route injects to re-ingest a row, which keeps this module free of every event-type handler.
 *  No `idempotencyKey` field: ingest re-derives it from the parsed event, and a passed-in key could be stale. */
export type IngestHook = (
  ctx: ConnectorContext,
  args: {
    rawPayload: string;
    eventName: string;
    deliveryId: string;
  },
) => Promise<{ memoryId: string | null }>;

/** Why a host_mismatch row may not replay under today's setting: the webhook's own host check,
 * run on the sender the park recorded. */
function hostRefusal(row: DlqItem, site: GitHubSite): string | null {
  if (row.bucket !== 'host_mismatch') return null;
  const parked = mismatchSender(row.error);
  if (parked === null) return 'host_mismatch row names no sender, so it cannot be replayed';
  const still = hostMismatch(parked.sent, site);
  return still === null ? null : `${still}; set GITHUB_ENTERPRISE_URL to the sending server, then replay`;
}

/** Replay a DLQ row through the normal ingest path; a failed signature, parse or envelope check
 * bumps retry_count. No `ingestHook` (dry-run): bumps retry_count, returns `replayed` with
 * memoryId=null. Replays use today's routing. */
export async function replayGithubDlqEntry(
  ctx: ConnectorContext,
  id: number,
  opts: ReplayDlqOptions & { ingestHook?: IngestHook } = {},
): Promise<ReplayResult> {
  const { webhookSecret, previousSecret, ingestHook, site } = opts;
  return replayParked<'github', JsonValue & GitHubWebhookEnvelope>(
    {
      dlq: githubDlq,
      // The secret in effect now, not the one in effect when the row was parked.
      refuseSignature: (row) =>
        webhookSecret ? refuseSignature(row, webhookSecret, previousSecret) : null,
      isEnvelope: isGitHubWebhookEnvelope,
      notEnvelope: 'not a GitHub webhook envelope',
      reingest: async (row) => {
        const refused = hostRefusal(row, site ?? GITHUB_COM);
        if (refused !== null) return { ok: false, status: 'unroutable', reason: refused };
        if (!ingestHook) {
          return {
            ok: true,
            status: 'replayed',
            memoryId: null,
            reason: 'dry-run: no ingest hook supplied',
          };
        }
        // The hook owns routing, idempotency and the memory write, and re-derives the key from the
        // parsed event.
        const { memoryId } = await ingestHook(ctx, {
          rawPayload: row.rawPayload,
          eventName: row.eventName ?? '',
          deliveryId: row.deliveryId ?? '',
        });
        return { ok: true, status: 'replayed', memoryId };
      },
    },
    ctx.store,
    { tenantId: ctx.tenantId, id, force: opts.force === true },
  );
}

function refuseSignature(
  row: DlqItem,
  webhookSecret: string,
  previousSecret: string | undefined,
): SignatureRefusal | null {
  if (!row.signature) {
    return {
      status: 'sig_missing',
      reason: 'row has no signature (legacy, or redacted before storing); pass --force to replay',
    };
  }
  if (
    verifyGitHubSignature({
      rawBody: row.rawPayload,
      signature: row.signature,
      webhookSecret,
      previousSecret,
    })
  ) {
    return null;
  }
  return {
    status: 'sig_fail',
    reason:
      'signature did not verify against current GITHUB_WEBHOOK_SECRET; pass --force to replay anyway',
  };
}
