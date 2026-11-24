/** `hippo github` subcommands, split out of cli.ts so tests can import them without triggering
 * main(); the verb table in verbs/health.ts dispatches to handleGitHub. */

import { envGitHubToken, envGitHubWebhookSecret } from '../../base/util/env.js';
import { adminActor } from '../../api/index.js';
import { backfillRepo } from '../connectors/github/backfill.js';
import { realGitHubFetcher } from '../connectors/github/octokit-client.js';
import { listDlq } from '../connectors/dlq.js';
import { githubDlq, replayGithubDlqEntry, type IngestHook } from '../connectors/github/dlq.js';
import { ingestEvent, githubEventRef, type IngestEvent } from '../connectors/github/ingest.js';
import { NO_TRUSTED_USER_IDS } from '../connectors/github/transform.js';
import { handleCommentDeleted } from '../connectors/github/deletion.js';
import { computeDeletionKey } from '../connectors/github/signature.js';
import {
  githubPreviousSecret,
  githubSiteFromEnv,
  githubTrustedUserIds,
} from '../connectors/github/webhook.js';
import { isGitHubRepoFullName } from '../connectors/github/ref.js';
import { payloadFromSite, payloadHost, type GitHubSite } from '../connectors/github/site.js';
import {
  isGitHubIssueEvent,
  isGitHubIssueCommentEvent,
  isGitHubPullRequestEvent,
  isGitHubPullRequestReviewCommentEvent,
} from '../connectors/github/types.js';
import type { JsonValue } from '../../base/util/json.js';
import { type CliFlags, type CommandContext, stringFlag } from './flag-values.js';
import { runDlqReplay } from './dlq-replay.js';
import { cliApiContext, cliStore } from './api-context.js';
import { CliExit } from './exit.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';

/** Map a parsed envelope + eventName header to an IngestEvent; null for unknown event types or
 * shapes failing the type guards. */
function parsedToIngestEvent(parsed: JsonValue, eventName: string): IngestEvent | null {
  if (eventName === 'issues' && isGitHubIssueEvent(parsed, eventName)) {
    return { eventName: 'issues', payload: parsed };
  }
  if (eventName === 'issue_comment' && isGitHubIssueCommentEvent(parsed, eventName)) {
    return { eventName: 'issue_comment', payload: parsed };
  }
  if (eventName === 'pull_request' && isGitHubPullRequestEvent(parsed, eventName)) {
    return { eventName: 'pull_request', payload: parsed };
  }
  if (
    eventName === 'pull_request_review_comment' &&
    isGitHubPullRequestReviewCommentEvent(parsed, eventName)
  ) {
    return { eventName: 'pull_request_review_comment', payload: parsed };
  }
  return null;
}

// Console lines below are the `hippo github` command's printed result and usage text, so they stay
// off the logger.
export function printGitHubBackfillUsage(): void {
  console.log('hippo github backfill --repo <owner/name> [--since ISO] [--max <N>]');
  console.log('  --repo   GitHub repository in owner/name format (required, e.g. acme/widgets)');
  console.log('  --since  Initial high-water-mark for first run (optional, ISO 8601)');
  console.log('  --max    Cap items per stream (optional, integer)');
  console.log('  Requires GITHUB_TOKEN env var with repo read scope.');
  console.log(
    '  Set GITHUB_ENTERPRISE_URL=https://<host> to backfill from GitHub Enterprise Server.',
  );
  console.log(
    '  Also set GITHUB_ENTERPRISE_BARE_REFS_HOST=<host> only if the store took webhooks from that server\n' +
      '  before you set the URL and never took github.com ones.',
  );
}

/** `--max` as a whole positive count; undefined (no cap) when absent or not one. */
function maxPerStreamFlag(flags: CliFlags): number | undefined {
  const maxRaw = stringFlag(flags, 'max');
  if (maxRaw === undefined) return undefined;
  const parsed = Number(maxRaw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

/** GITHUB_ENTERPRISE_URL's site; a bad value exits 2 with its reason, as a missing token does. */
function githubSiteOrExit(): GitHubSite {
  try {
    return githubSiteFromEnv();
  } catch (e) {
    console.error(errorMessage(e));
    throw new CliExit(2);
  }
}

async function backfillGitHub(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const repo = stringFlag(flags, 'repo');
  if (repo === undefined || !isGitHubRepoFullName(repo)) {
    printGitHubBackfillUsage();
    throw new CliExit(2);
  }
  const token = envGitHubToken();
  if (!token) {
    console.error(
      'GITHUB_TOKEN is not set. Backfill requires a personal access token with repo read scope.',
    );
    throw new CliExit(2);
  }
  const site = githubSiteOrExit();
  const maxPerStream = maxPerStreamFlag(flags);
  const sinceIso = stringFlag(flags, 'since');
  // Backfill fetches from site.apiBase, so every item is from the configured site.
  const trustedUserIds = githubTrustedUserIds();

  const ctx = { ...cliApiContext(hippoRoot, tenantId), actor: adminActor('cli:github-backfill') };
  try {
    const result = await backfillRepo(ctx, {
      repoFullName: repo,
      fetcher: realGitHubFetcher,
      token,
      maxPerStream,
      sinceIso,
      site,
      trustedUserIds,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('backfill failed:', errorMessage(e));
    log.warn(`github backfill failed: ${errorMessage(e)}`, errorFields(e));
    throw new CliExit(3);
  }
}

export async function listGitHubDlq(
  hippoRoot: string,
  tenantId: string,
  _flags: CliFlags,
): Promise<void> {
  const items = await listDlq(githubDlq, cliStore(hippoRoot), { tenantId });
  if (items.length === 0) {
    console.log('no entries');
    return;
  }
  for (const it of items) {
    console.log(
      `${it.id}\t${it.bucket}\t${it.tenantId}\t${it.eventName ?? '-'}\t${it.receivedAt}\t${it.error}`,
    );
  }
}

const PAYLOAD_PREVIEW_CHARS = 200;

/** A parked payload that is not JSON, naming the command and the start of the text so the
 * operator can find the row. */
export class GitHubPayloadParseError extends Error {
  constructor(command: string, rawPayload: string, cause: unknown) {
    const start = JSON.stringify(rawPayload.slice(0, PAYLOAD_PREVIEW_CHARS));
    super(`${command}: payload is not valid JSON (${errorMessage(cause)}); starts with ${start}`, {
      cause,
    });
    this.name = 'GitHubPayloadParseError';
  }
}

export function parseParkedPayload(rawPayload: string): JsonValue {
  try {
    return JSON.parse(rawPayload);
  } catch (err) {
    throw new GitHubPayloadParseError('hippo github dlq replay', rawPayload, err);
  }
}

function reingestParkedDelivery(site: GitHubSite, trustedUserIds: ReadonlySet<number>): IngestHook {
  const { host, ownsBareRefs } = site;
  return async (innerCtx, args) => {
    const parsed = parseParkedPayload(args.rawPayload);
    const event = parsedToIngestEvent(parsed, args.eventName);
    if (!event) {
      return { memoryId: null };
    }
    // A replayed comment `.deleted` row must route to the deletion handler, NOT to ingestEvent, which
    // would write the deleted comment as a NEW raw memory instead of archiving the matching ones.
    if (
      (event.eventName === 'issue_comment' || event.eventName === 'pull_request_review_comment') &&
      event.payload.action === 'deleted'
    ) {
      const artifactRef = githubEventRef(event, host);
      const idempotencyKey = computeDeletionKey(
        artifactRef,
        event.payload.comment.updated_at ?? null,
      );
      const r = await handleCommentDeleted(innerCtx, {
        artifactRef,
        idempotencyKey,
        deliveryId: args.deliveryId,
        eventName: event.eventName,
        ownsBareRefs,
      });
      // archivedCount maps to memoryId only loosely (the archive can affect multiple rows), so return
      // null; the replay audit trail is github_dlq.retry_count + retried_at.
      return { memoryId: r.archivedCount > 0 ? 'archived' : null };
    }
    const r = await ingestEvent(innerCtx, {
      event,
      rawBody: args.rawPayload,
      deliveryId: args.deliveryId,
      host,
      ownsBareRefs,
      // The parked row keeps no header, so the payload's repository host alone says the server.
      trustedUserIds: payloadFromSite(host, payloadHost(parsed))
        ? trustedUserIds
        : NO_TRUSTED_USER_IDS,
    });
    return { memoryId: r.memoryId };
  };
}

export async function replayGitHubDlq(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const site = githubSiteOrExit();
  // A bad entry throws here, before any row is touched, as it refuses serve and backfill.
  const trustedUserIds = githubTrustedUserIds();
  const ctx = { ...cliApiContext(hippoRoot, tenantId), actor: adminActor('cli:github-dlq-replay') };
  // Without an ingestHook replay only bumps retry_count while printing "replay ok"; the real hook
  // re-runs ingest.
  await runDlqReplay('github', args[0], flags, (id, force) =>
    replayGithubDlqEntry(ctx, id, {
      force,
      webhookSecret: envGitHubWebhookSecret(),
      previousSecret: githubPreviousSecret(),
      ingestHook: reingestParkedDelivery(site, trustedUserIds),
      site,
    }),
  );
}

export async function handleGitHub({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const sub = args[0];
  if (sub === 'backfill') {
    await backfillGitHub(hippoRoot, tenantId, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'list') {
    await listGitHubDlq(hippoRoot, tenantId, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'replay') {
    await replayGitHubDlq(hippoRoot, tenantId, args.slice(2), flags);
    return;
  }
  console.error('Usage: hippo github <backfill|dlq list|dlq replay <id> [--force]> [...]');
  throw new CliExit(1);
}
