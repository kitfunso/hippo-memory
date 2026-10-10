/**
 * Implementation of `hippo github` CLI subcommands. Extracted from the main
 * cli.ts so unit tests can import these functions directly without triggering
 * the cli.ts main() side effects. The cli.ts dispatcher re-exports the
 * top-level handleGitHub.
 *
 * Subcommands mirror the Slack connector shape (cli.ts §Slack subcommands):
 *   - hippo github backfill --repo <owner/name> [--since ISO] [--max <N>]
 *   - hippo github dlq list
 *   - hippo github dlq replay <id> [--force]
 */

import { envGitHubToken, envGitHubWebhookSecret, envGitHubWebhookSecretPrevious } from '../util/env.js';
import { type Context, adminActor } from '../api/index.js';
import { backfillRepo } from '../connectors/github/backfill.js';
import { realGitHubFetcher, type GitHubFetcher } from '../connectors/github/octokit-client.js';
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
import type { JsonValue } from '../util/json.js';
import type { CommandContext } from './flag-values.js';
import { CliExit } from './exit.js';
import { errorMessage } from '../util/log.js';

type FlagValue = string | boolean | string[];
type Flags = Record<string, FlagValue>;

function isFlagString(value: FlagValue): value is string {
  return typeof value === 'string';
}

// FlagValue never includes `number` (see its declaration above), so a
// `value is number` predicate directly on FlagValue would not type-check —
// the generic wrapper narrows a value of any type T instead.
function isNumberLike<T>(value: T): value is T & number {
  return typeof value === 'number';
}

function isFlagValueNumberLike(value: FlagValue): boolean {
  return isNumberLike(value);
}

/**
 * Map a parsed envelope + eventName header to an IngestEvent discriminated
 * union. Returns null for unknown event types or shapes that don't pass the
 * type guards.
 */
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

// Console lines below are the `hippo github` command's printed result and usage text, so they stay off the logger.
export function printGitHubBackfillUsage(): void {
  console.log('hippo github backfill --repo <owner/name> [--since ISO] [--max <N>]');
  console.log('  --repo   GitHub repository in owner/name format (required, e.g. acme/widgets)');
  console.log('  --since  Initial high-water-mark for first run (optional, ISO 8601)');
  console.log('  --max    Cap items per stream (optional, integer)');
  console.log('  Requires GITHUB_TOKEN env var with repo read scope.');
}

/** `--max` as a whole positive count; undefined (no cap) when absent or not one. */
function maxPerStreamFlag(maxRaw: FlagValue): number | undefined {
  if (isFlagString(maxRaw) || isFlagValueNumberLike(maxRaw)) {
    const parsed = Number(maxRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

/**
 * `hippo github backfill`. The fetcher is injectable so tests can drive the
 * code path without hitting the network. Defaults to `realGitHubFetcher`.
 */
export async function cmdGitHubBackfill(
  hippoRoot: string,
  tenantId: string,
  flags: Flags,
  fetcher: GitHubFetcher = realGitHubFetcher,
): Promise<void> {
  const repo = flags['repo'];
  if (!isFlagString(repo) || !repo.includes('/')) {
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
  const maxPerStream = maxPerStreamFlag(flags['max']);
  const sinceFlag = flags['since'];
  const sinceIso = isFlagString(sinceFlag) ? sinceFlag : undefined;

  const ctx: Context = {
    hippoRoot,
    tenantId,
    actor: adminActor('cli:github-backfill'),
  };
  try {
    const result = await backfillRepo(ctx, {
      repoFullName: repo,
      fetcher,
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

export function cmdGitHubDlqList(hippoRoot: string, tenantId: string, _flags: Flags): void {
  const items = listDlq(githubDlq, hippoRoot, { tenantId });
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

const reingestParkedDelivery: IngestHook = async (innerCtx, args) => {
  const parsed = JSON.parse(args.rawPayload);
  const event = parsedToIngestEvent(parsed, args.eventName);
  if (!event) {
    return { memoryId: null };
  }
  // A replayed comment `.deleted` row must route to the deletion handler, NOT to ingestEvent,
  // which would write the deleted comment as a NEW raw memory instead of archiving the matching ones.
  if (
    (event.eventName === 'issue_comment' || event.eventName === 'pull_request_review_comment') &&
    event.payload.action === 'deleted'
  ) {
    const repo = event.payload.repository?.full_name ?? '';
    const artifactRef = event.eventName === 'issue_comment'
      ? `github://${repo}/issue/${event.payload.issue.number}/comment/${event.payload.comment.id}`
      : `github://${repo}/pull/${event.payload.pull_request.number}/review_comment/${event.payload.comment.id}`;
    const idempotencyKey = computeDeletionKey(artifactRef, event.payload.comment.updated_at ?? null);
    const r = await handleCommentDeleted(innerCtx, {
      artifactRef,
      idempotencyKey,
      deliveryId: args.deliveryId,
      eventName: event.eventName,
    });
    // archivedCount maps to memoryId only loosely — return null since the
    // archive operation can affect multiple rows. The replay-result audit
    // trail is in github_dlq.retry_count + retried_at.
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
  flags: Flags,
): Promise<void> {
  const idArg = args[0];
  if (!idArg) {
    console.error('Usage: hippo github dlq replay <id> [--force]');
    throw new CliExit(1);
  }
  const id = Number(idArg);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id < 1) {
    console.error(`replay: invalid id ${idArg}`);
    throw new CliExit(1);
  }
  const force = flags['force'] === true;
  const ctx: Context = {
    hippoRoot,
    tenantId,
    actor: adminActor('cli:github-dlq-replay'),
  };
  // Without an ingestHook replay only bumps retry_count while printing "replay ok"; the real hook re-runs ingest.
  const result = await replayDlqEntry(ctx, id, {
    force,
    webhookSecret: envGitHubWebhookSecret(),
    previousSecret: envGitHubWebhookSecretPrevious(),
    ingestHook: reingestParkedDelivery,
  });
  if (!result.ok) {
    console.error(
      `replay failed: status=${result.status} retry_count=${result.retryCount}${
        result.reason ? ` reason=${result.reason}` : ''
      }`,
    );
    throw new CliExit(1);
  }
  console.log(
    `replay ok: status=${result.status} memory_id=${result.memoryId ?? '(none)'} retry_count=${result.retryCount}`,
  );
}

export async function handleGitHub({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const sub = args[0];
  if (sub === 'backfill') {
    await cmdGitHubBackfill(hippoRoot, tenantId, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'list') {
    cmdGitHubDlqList(hippoRoot, tenantId, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'replay') {
    await cmdGitHubDlqReplay(hippoRoot, tenantId, args.slice(2), flags);
    return;
  }
  console.error('Usage: hippo github <backfill|dlq list|dlq replay <id> [--force]> [...]');
  throw new CliExit(1);
}
