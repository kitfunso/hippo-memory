import type { ConnectorContext } from '../ingest.js';
import {
  replayParked,
  type ConnectorDlq,
  type Reingest,
  type ReplayResult,
  type SignatureRefusal,
} from '../dlq.js';
import { resolveTenant } from '../tenant-route.js';
import { routingOf } from './routing.js';
import { verifyGitHubSignature } from './signature.js';
import {
  GITHUB_COM,
  hostMismatch,
  mismatchSender,
  payloadHost,
  payloadHostRefusal,
  type GitHubSite,
} from './site.js';
import { isGitHubWebhookEnvelope, type GitHubWebhookEnvelope } from './types.js';
import { tryParseJson, type JsonValue } from '../../../base/util/json.js';
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
  /** Today's GITHUB_ENTERPRISE_URL site. A row replays only when the server its signed payload
   * names is the site's, and a host_mismatch row also when the webhook's header check would take
   * its sender now; --force skips neither. */
  site?: GitHubSite;
  /** The GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK escape hatch, as the CLI read it. */
  allowUnknownInstallationFallback?: boolean;
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

/** Why a row may not replay under today's setting: for a host_mismatch row the webhook's header
 * check on the sender the park recorded, then for every row the server its signed payload names. */
function hostRefusal(row: DlqItem, site: GitHubSite): string | null {
  if (row.bucket === 'host_mismatch') {
    const parked = mismatchSender(row.error);
    if (parked === null) return 'host_mismatch row names no sender, so it cannot be replayed';
    const still = hostMismatch(parked.sent, site);
    if (still !== null) {
      return `${still}; set GITHUB_ENTERPRISE_URL to the sending server, then replay`;
    }
  }
  return payloadHostRefusal(payloadHost(tryParseJson(row.rawPayload)), site);
}

/** Replay a DLQ row through the normal ingest path; a failed signature, parse or envelope check
 * bumps retry_count. No `ingestHook` (dry-run): bumps retry_count, returns `replayed` with
 * memoryId=null. Replays use today's routing. */
export async function replayGithubDlqEntry(
  ctx: ConnectorContext,
  id: number,
  opts: ReplayDlqOptions & { ingestHook?: IngestHook } = {},
): Promise<ReplayResult> {
  const { webhookSecret, previousSecret } = opts;
  return replayParked<'github', JsonValue & GitHubWebhookEnvelope>(
    {
      dlq: githubDlq,
      refuseSignature: (row) =>
        webhookSecret ? refuseSignature(row, webhookSecret, previousSecret) : null,
      isEnvelope: isGitHubWebhookEnvelope,
      notEnvelope: 'not a GitHub webhook envelope',
      reingest: (row, envelope) => reingest(ctx, row, envelope, opts),
    },
    ctx.store,
    { tenantId: ctx.tenantId, id, force: opts.force === true },
  );
}

async function reingest(
  ctx: ConnectorContext,
  row: DlqItem,
  envelope: JsonValue & GitHubWebhookEnvelope,
  opts: ReplayDlqOptions & { ingestHook?: IngestHook },
): Promise<Reingest> {
  const refused = hostRefusal(row, opts.site ?? GITHUB_COM);
  if (refused !== null) return { ok: false, status: 'unroutable', reason: refused };
  const routing = routingOf(envelope);
  const tenantId = await resolveTenant(
    ctx.store,
    { connector: 'github', ...routing },
    { hostTenant: ctx.tenantId, allowUnknown: opts.allowUnknownInstallationFallback === true },
  );
  if (tenantId === null) {
    const where = `installation ${routing.installationId ?? 'none'} (repo ${routing.repoFullName ?? 'none'})`;
    return { ok: false, status: 'unroutable', reason: `${where} still unroutable` };
  }
  if (!opts.ingestHook) {
    return {
      ok: true,
      status: 'replayed',
      memoryId: null,
      reason: 'dry-run: no ingest hook supplied',
    };
  }
  const { memoryId } = await opts.ingestHook(
    { ...ctx, tenantId },
    {
      rawPayload: row.rawPayload,
      eventName: row.eventName ?? '',
      deliveryId: row.deliveryId ?? '',
    },
  );
  return { ok: true, status: 'replayed', memoryId };
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
