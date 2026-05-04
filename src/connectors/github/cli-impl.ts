/**
 * Implementation of `hippo github` CLI subcommands. Extracted from the main
 * cli.ts so unit tests can import these functions directly without triggering
 * the cli.ts main() side effects. The cli.ts dispatcher re-exports the
 * top-level cmdGithub.
 *
 * Subcommands mirror the Slack connector shape (cli.ts §Slack subcommands):
 *   - hippo github backfill --repo <owner/name> [--since ISO] [--max <N>]
 *   - hippo github dlq list
 *   - hippo github dlq replay <id> [--force]
 */

import type { Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import { resolveTenantId } from '../../tenant.js';
import { backfillRepo } from './backfill.js';
import { realGitHubFetcher, type GitHubFetcher } from './octokit-client.js';
import { listDlq, replayDlqEntry } from './dlq.js';
import { ingestEvent, type IngestEvent } from './ingest.js';
import { handleCommentDeleted } from './deletion.js';
import { computeDeletionKey } from './signature.js';
import {
  isGitHubIssueEvent,
  isGitHubIssueCommentEvent,
  isGitHubPullRequestEvent,
  isGitHubPullRequestReviewCommentEvent,
} from './types.js';

type Flags = Record<string, string | boolean | string[]>;

/**
 * Map a parsed envelope + eventName header to an IngestEvent discriminated
 * union. Returns null for unknown event types or shapes that don't pass the
 * type guards.
 */
function parsedToIngestEvent(parsed: unknown, eventName: string): IngestEvent | null {
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

export function printGithubBackfillUsage(): void {
  console.log('hippo github backfill --repo <owner/name> [--since ISO] [--max <N>]');
  console.log('  --repo   GitHub repository in owner/name format (required, e.g. acme/widgets)');
  console.log('  --since  Initial high-water-mark for first run (optional, ISO 8601)');
  console.log('  --max    Cap items per stream (optional, integer)');
  console.log('  Requires GITHUB_TOKEN env var with repo read scope.');
}

/**
 * `hippo github backfill`. The fetcher is injectable so tests can drive the
 * code path without hitting the network. Defaults to `realGitHubFetcher`.
 */
export async function cmdGithubBackfill(
  hippoRoot: string,
  flags: Flags,
  fetcher: GitHubFetcher = realGitHubFetcher,
): Promise<void> {
  if (flags['help']) {
    printGithubBackfillUsage();
    return;
  }
  const repo = flags['repo'];
  if (typeof repo !== 'string' || !repo.includes('/')) {
    printGithubBackfillUsage();
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error(
      'GITHUB_TOKEN is not set. Backfill requires a personal access token with repo read scope.',
    );
    process.exit(2);
  }
  const maxRaw = flags['max'];
  let maxPerStream: number | undefined;
  if (typeof maxRaw === 'string' || typeof maxRaw === 'number') {
    const parsed = Number(maxRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxPerStream = Math.floor(parsed);
    }
  }
  const sinceIso = typeof flags['since'] === 'string' ? (flags['since'] as string) : undefined;
  const tenantId = resolveTenantId({});

  // Seed the github_cursors row so all 3 streams use --since on a fresh run.
  // COALESCE preserves any existing HWM (subsequent runs ignore --since for
  // streams that already drained at least once — same idempotency story as
  // Slack's slack_cursors).
  if (sinceIso) {
    const db = openHippoDb(hippoRoot);
    try {
      db.prepare(
        `INSERT INTO github_cursors (tenant_id, repo_full_name, issues_hwm, issue_comments_hwm, pr_review_comments_hwm, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, repo_full_name) DO UPDATE SET
           issues_hwm = COALESCE(github_cursors.issues_hwm, excluded.issues_hwm),
           issue_comments_hwm = COALESCE(github_cursors.issue_comments_hwm, excluded.issue_comments_hwm),
           pr_review_comments_hwm = COALESCE(github_cursors.pr_review_comments_hwm, excluded.pr_review_comments_hwm),
           updated_at = excluded.updated_at`,
      ).run(tenantId, repo, sinceIso, sinceIso, sinceIso, new Date().toISOString());
    } finally {
      closeHippoDb(db);
    }
  }

  const ctx: Context = {
    hippoRoot,
    tenantId,
    actor: 'cli:github-backfill',
  };
  try {
    const result = await backfillRepo(ctx, {
      repoFullName: repo,
      fetcher,
      token: token as string,
      maxPerStream,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('backfill failed:', (e as Error).message);
    process.exit(3);
  }
}

export function cmdGithubDlqList(hippoRoot: string, _flags: Flags): void {
  const db = openHippoDb(hippoRoot);
  try {
    const tenantId = resolveTenantId({});
    const items = listDlq(db, { tenantId });
    if (items.length === 0) {
      console.log('no entries');
      return;
    }
    for (const it of items) {
      console.log(
        `${it.id}\t${it.bucket}\t${it.tenantId}\t${it.eventName ?? '-'}\t${it.receivedAt}\t${it.error}`,
      );
    }
  } finally {
    closeHippoDb(db);
  }
}

export async function cmdGithubDlqReplay(
  hippoRoot: string,
  args: string[],
  flags: Flags,
): Promise<void> {
  const idArg = args[0];
  if (!idArg) {
    console.error('Usage: hippo github dlq replay <id> [--force]');
    process.exit(1);
  }
  const id = Number(idArg);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id < 1) {
    console.error(`replay: invalid id ${idArg}`);
    process.exit(1);
  }
  const force = flags['force'] === true;
  const ctx: Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: 'cli:github-dlq-replay',
  };
  // v1.3.1 hotfix (codex P1): without an ingestHook the v1.3.0 CLI was a
  // dry-run that printed "replay ok" while only bumping retry_count. Wire the
  // real hook so `replay` actually re-runs the ingest path.
  const result = await replayDlqEntry(ctx, id, {
    force,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    previousSecret: process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS,
    ingestHook: async (innerCtx, args) => {
      const parsed = JSON.parse(args.rawPayload);
      const event = parsedToIngestEvent(parsed, args.eventName);
      if (!event) {
        return { memoryId: null };
      }
      // v1.3.2 (codex round 3 P1): a replayed `issue_comment.deleted` or
      // `pull_request_review_comment.deleted` row must route to the deletion
      // handler, NOT to ingestEvent. The v1.3.1 hook unconditionally called
      // ingestEvent and would have written the deleted comment as a NEW raw
      // memory instead of archiving the matching ones.
      if (
        (event.eventName === 'issue_comment' || event.eventName === 'pull_request_review_comment') &&
        event.payload.action === 'deleted'
      ) {
        const repo = event.payload.repository?.full_name ?? '';
        const artifactRef = event.eventName === 'issue_comment'
          ? `github://${repo}/issue/${event.payload.issue.number}/comment/${event.payload.comment.id}`
          : `github://${repo}/pull/${event.payload.pull_request.number}/review_comment/${event.payload.comment.id}`;
        const idempotencyKey = computeDeletionKey(artifactRef, event.payload.comment.updated_at ?? null);
        const r = handleCommentDeleted(innerCtx, {
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
      const r = ingestEvent(innerCtx, {
        event,
        rawBody: args.rawPayload,
        deliveryId: args.deliveryId,
      });
      return { memoryId: r.memoryId };
    },
  });
  if (!result.ok) {
    console.error(
      `replay failed: status=${result.status} retry_count=${result.retryCount}${
        result.reason ? ` reason=${result.reason}` : ''
      }`,
    );
    process.exit(1);
  }
  console.log(
    `replay ok: status=${result.status} memory_id=${result.memoryId ?? '(none)'} retry_count=${result.retryCount}`,
  );
}

export async function cmdGithub(
  hippoRoot: string,
  args: string[],
  flags: Flags,
): Promise<void> {
  const sub = args[0];
  if (sub === 'backfill') {
    await cmdGithubBackfill(hippoRoot, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'list') {
    cmdGithubDlqList(hippoRoot, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'replay') {
    await cmdGithubDlqReplay(hippoRoot, args.slice(2), flags);
    return;
  }
  console.error('Usage: hippo github <backfill|dlq list|dlq replay <id> [--force]> [...]');
  process.exit(1);
}
