/** `hippo github` subcommands, split out of cli.ts so tests can import them without triggering main(); the verb table
 * in verbs/health.ts dispatches to handleGitHub. */

import { envGitHubToken, envGitHubWebhookSecret, envGitHubWebhookSecretPrevious } from '../../base/util/env.js';
import { adminActor, type Context } from '../../api/index.js';
import { backfillRepo } from '../connectors/github/backfill.js';
import { realGitHubFetcher } from '../connectors/github/octokit-client.js';
import { listDlq } from '../connectors/dlq.js';
import { githubDlq, replayDlqEntry, type IngestHook } from '../connectors/github/dlq.js';
import { ingestEvent, type IngestEvent } from '../connectors/github/ingest.js';
import { handleCommentDeleted } from '../connectors/github/deletion.js';
import { computeDeletionKey } from '../connectors/github/signature.js';
import {
  isGitHubIssueEvent,
  isGitHubIssueCommentEvent,
  isGitHubPullRequestEvent,
  isGitHubPullRequestReviewCommentEvent,
} from '../connectors/github/types.js';
import type { JsonValue } from '../../base/util/json.js';
import { isStringFlag, type CliFlags, type CommandContext } from './flag-values.js';
import { runDlqReplay } from './dlq-replay.js';
import { cliApiContext, cliStore } from './api-context.js';
import { CliExit } from './exit.js';
import { errorMessage } from '../../base/util/log.js';

/** Map a parsed envelope + eventName header to an IngestEvent; null for unknown event types or shapes failing the type
 * guards. */
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
  if (eventName === 'pull_request_review_comment' && isGitHubPullRequestReviewCommentEvent(parsed, eventName)) {
    return { eventName: 'pull_request_review_comment', payload: parsed };
  }
  return null;
}

// Console lines below are the `hippo github` command's printed result and usage text, so they stay off the logger.
export function printGitHubBackfillUsage(): void {
  console.log('hippo github backfill --repo <owner/name> [--since ISO] [--max <N>]');
  console.log('  --repo   GitHub repository in owner/name format (required, e.g. acme/widgets)');
  console.log('  --since  Initial high-water-mark for first run (optional, ISO 8601)');
  console.log('  --max    Cap items per stream (optional, integer)');
  console.log('  Requires GITHUB_TOKEN env var with repo read scope.');
}

/** `--max` as a whole positive count; undefined (no cap) when absent or not one. */
function maxPerStreamFlag(maxRaw: CliFlags[string] | undefined): number | undefined {
  if (!isStringFlag(maxRaw)) return undefined;
  const parsed = Number(maxRaw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

async function cmdGitHubBackfill(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const repo = flags['repo'];
  if (!isStringFlag(repo) || !repo.includes('/')) {
    printGitHubBackfillUsage();
    throw new CliExit(2);
  }
  const token = envGitHubToken();
  if (!token) {
    console.error('GITHUB_TOKEN is not set. Backfill requires a personal access token with repo read scope.');
    throw new CliExit(2);
  }
  const maxPerStream = maxPerStreamFlag(flags['max']);
  const sinceFlag = flags['since'];
  const sinceIso = isStringFlag(sinceFlag) ? sinceFlag : undefined;

  const ctx: Context = { ...cliApiContext(hippoRoot, tenantId), actor: adminActor('cli:github-backfill') };
  try {
    const result = await backfillRepo(ctx, {
      repoFullName: repo,
      fetcher: realGitHubFetcher,
      token,
      maxPerStream,
      sinceIso,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('backfill failed:', errorMessage(e));
    throw new CliExit(3);
  }
}

export async function cmdGitHubDlqList(hippoRoot: string, tenantId: string, _flags: CliFlags): Promise<void> {
  const items = await listDlq(githubDlq, cliStore(hippoRoot), { tenantId });
  if (items.length === 0) {
    console.log('no entries');
    return;
  }
  for (const it of items) {
    console.log(`${it.id}\t${it.bucket}\t${it.tenantId}\t${it.eventName ?? '-'}\t${it.receivedAt}\t${it.error}`);
  }
}

const PAYLOAD_PREVIEW_CHARS = 200;

/** A parked payload that is not JSON, naming the command and the start of the text so the operator can find the row. */
export class GitHubPayloadParseError extends Error {
  constructor(command: string, rawPayload: string, cause: unknown) {
    const start = JSON.stringify(rawPayload.slice(0, PAYLOAD_PREVIEW_CHARS));
    super(`${command}: payload is not valid JSON (${errorMessage(cause)}); starts with ${start}`, { cause });
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

const reingestParkedDelivery: IngestHook = async (innerCtx, args) => {
  const parsed = parseParkedPayload(args.rawPayload);
  const event = parsedToIngestEvent(parsed, args.eventName);
  if (!event) {
    return { memoryId: null };
  }
  // A replayed comment `.deleted` row must route to the deletion handler, NOT to ingestEvent, which would write the
  // deleted comment as a NEW raw memory instead of archiving the matching ones.
  if (
    (event.eventName === 'issue_comment' || event.eventName === 'pull_request_review_comment') &&
    event.payload.action === 'deleted'
  ) {
    const repo = event.payload.repository?.full_name ?? '';
    const artifactRef =
      event.eventName === 'issue_comment'
        ? `github://${repo}/issue/${event.payload.issue.number}/comment/${event.payload.comment.id}`
        : `github://${repo}/pull/${event.payload.pull_request.number}/review_comment/${event.payload.comment.id}`;
    const idempotencyKey = computeDeletionKey(artifactRef, event.payload.comment.updated_at ?? null);
    const r = await handleCommentDeleted(innerCtx, {
      artifactRef,
      idempotencyKey,
      deliveryId: args.deliveryId,
      eventName: event.eventName,
    });
    // archivedCount maps to memoryId only loosely (the archive can affect multiple rows), so return null; the replay
    // audit trail is github_dlq.retry_count + retried_at.
    return { memoryId: r.archivedCount > 0 ? 'archived' : null };
  }
  const r = await ingestEvent(innerCtx, {
    event,
    rawBody: args.rawPayload,
    deliveryId: args.deliveryId,
  });
  return { memoryId: r.memoryId };
};

export async function cmdGitHubDlqReplay(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const ctx: Context = { ...cliApiContext(hippoRoot, tenantId), actor: adminActor('cli:github-dlq-replay') };
  // Without an ingestHook replay only bumps retry_count while printing "replay ok"; the real hook re-runs ingest.
  await runDlqReplay('github', args[0], flags, (id, force) =>
    replayDlqEntry(ctx, id, {
      force,
      webhookSecret: envGitHubWebhookSecret(),
      previousSecret: envGitHubWebhookSecretPrevious(),
      ingestHook: reingestParkedDelivery,
    }),
  );
}

export async function handleGitHub({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const sub = args[0];
  if (sub === 'backfill') {
    await cmdGitHubBackfill(hippoRoot, tenantId, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'list') {
    await cmdGitHubDlqList(hippoRoot, tenantId, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'replay') {
    await cmdGitHubDlqReplay(hippoRoot, tenantId, args.slice(2), flags);
    return;
  }
  console.error('Usage: hippo github <backfill|dlq list|dlq replay <id> [--force]> [...]');
  throw new CliExit(1);
}
