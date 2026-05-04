/**
 * Paginated backfill of three GitHub REST streams with per-stream
 * high-water marks (HWMs):
 *   - /repos/{repo}/issues               -> issues_hwm
 *   - /repos/{repo}/issues/comments      -> issue_comments_hwm
 *   - /repos/{repo}/pulls/comments       -> pr_review_comments_hwm
 *
 * Crash safety (codex P1 #3): each stream's HWM is persisted ONLY after
 * the stream fully drains. If stream 2 throws mid-flight, stream 1's HWM
 * is committed and stream 2's stays NULL (or its prior value). Rerun
 * picks up from stream 1's saved HWM and re-fetches stream 2 from its
 * last committed point.
 *
 * Codex P1 #2: the /issues endpoint returns BOTH issues and PRs (a PR is
 * an issue with a `pull_request` field). We skip PRs here so they don't
 * get ingested under the issues schema. PRs are handled via webhook in
 * V1 (no /pulls backfill stream — review comments cover the discussion
 * surface).
 *
 * Privacy (V1 limitation): the REST list endpoints don't reliably set
 * `repository.private`, and resolving it requires an extra API call per
 * repo. Backfill leaves the field undefined so scopeFromRepository falls
 * through to private. Callers who know the repo is public can re-tag
 * downstream; the fail-safe default protects private orgs.
 */

import type { Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import { ingestEvent, type IngestEvent } from './ingest.js';
import type { GitHubFetcher, GitHubBackfillPage } from './octokit-client.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestReviewCommentEvent,
  GitHubRepository,
  GitHubSender,
} from './types.js';

const API = 'https://api.github.com';

export interface BackfillOpts {
  /** e.g. 'acme/repo'. */
  repoFullName: string;
  fetcher: GitHubFetcher;
  token: string;
  /** Optional cap on items per stream. Useful for tests. */
  maxPerStream?: number;
  /** sleep ms — injectable so tests don't actually wait. */
  sleepMs?: (ms: number) => Promise<void>;
}

export interface BackfillStreamCounts {
  issues: number;
  issueComments: number;
  prReviewComments: number;
}

export interface BackfillResult {
  ingested: BackfillStreamCounts;
  pages: BackfillStreamCounts;
}

type HwmColumn = 'issues_hwm' | 'issue_comments_hwm' | 'pr_review_comments_hwm';

interface StoredCursors {
  issues: string | null;
  issueComments: string | null;
  prReviewComments: string | null;
}

function readCursor(root: string, tenantId: string, repo: string): StoredCursors {
  const db = openHippoDb(root);
  try {
    const row = db
      .prepare(
        `SELECT issues_hwm, issue_comments_hwm, pr_review_comments_hwm
         FROM github_cursors WHERE tenant_id = ? AND repo_full_name = ?`,
      )
      .get(tenantId, repo) as
      | {
          issues_hwm?: string | null;
          issue_comments_hwm?: string | null;
          pr_review_comments_hwm?: string | null;
        }
      | undefined;
    return {
      issues: row?.issues_hwm ?? null,
      issueComments: row?.issue_comments_hwm ?? null,
      prReviewComments: row?.pr_review_comments_hwm ?? null,
    };
  } finally {
    closeHippoDb(db);
  }
}

function writeOneHwm(
  root: string,
  tenantId: string,
  repo: string,
  column: HwmColumn,
  value: string,
): void {
  const db = openHippoDb(root);
  try {
    db.prepare(
      `INSERT INTO github_cursors (tenant_id, repo_full_name, ${column}, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, repo_full_name)
       DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`,
    ).run(tenantId, repo, value, new Date().toISOString());
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Build a synthetic `repository` object from the known repo full name.
 * REST list endpoints often omit the full repository object on each item;
 * we already know the repo since the caller passed it. `private` left
 * undefined so scopeFromRepository falls through to private.
 */
function syntheticRepository(repoFullName: string): GitHubRepository {
  const [owner, name] = repoFullName.split('/');
  return {
    full_name: repoFullName,
    name: name ?? repoFullName,
    owner: { login: owner ?? repoFullName },
    // private intentionally omitted — fail-safe to private scope.
  };
}

/**
 * Parse the trailing issue/PR number from a REST API URL.
 * e.g. https://api.github.com/repos/o/r/issues/42 -> 42
 *      https://api.github.com/repos/o/r/pulls/7   -> 7
 */
function parseTrailingNumber(url: string | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/(\d+)(?:\?.*)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

interface IssuesItem {
  number: number;
  title: string;
  body: string | null;
  user: GitHubSender;
  updated_at?: string;
  pull_request?: unknown;
}

interface IssueCommentItem {
  id: number;
  body: string | null;
  user: GitHubSender;
  updated_at?: string;
  issue_url?: string;
}

interface PrReviewCommentItem {
  id: number;
  body: string | null;
  user: GitHubSender;
  updated_at?: string;
  pull_request_url?: string;
}

function isIssuesItem(x: unknown): x is IssuesItem {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.number !== 'number') return false;
  if (typeof o.title !== 'string') return false;
  const u = o.user as { login?: unknown; id?: unknown } | undefined;
  if (!u || typeof u.login !== 'string' || typeof u.id !== 'number') return false;
  return true;
}

function isCommentItem(x: unknown): x is IssueCommentItem | PrReviewCommentItem {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'number') return false;
  const u = o.user as { login?: unknown; id?: unknown } | undefined;
  if (!u || typeof u.login !== 'string' || typeof u.id !== 'number') return false;
  return true;
}

/**
 * Drain one stream end-to-end. Pauses and retries on rate-limit. Throws
 * on any other fetch error so the caller leaves the HWM unchanged
 * (codex P1 #3 crash safety). Returns max(updated_at) seen so the caller
 * can advance the HWM only if the whole stream drained.
 */
async function drainStream(
  ctx: Context,
  url0: string,
  toIngestEvent: (item: unknown) => IngestEvent | null,
  fetcher: GitHubFetcher,
  token: string,
  sleep: (ms: number) => Promise<void>,
  maxItems?: number,
): Promise<{ ingested: number; pages: number; maxUpdatedAt: string | null }> {
  let url: string | null = url0;
  let ingested = 0;
  let pages = 0;
  let maxUpdatedAt: string | null = null;

  while (url) {
    // Fetch with rate-limit retry loop.
    let page: GitHubBackfillPage;
    while (true) {
      page = await fetcher({ url, token });
      if (page.rateLimit.reason !== 'none') {
        await sleep(page.rateLimit.sleepSeconds * 1000);
        continue;
      }
      break;
    }
    pages++;

    for (const item of page.items) {
      const evt = toIngestEvent(item);
      if (!evt) continue; // PRs returned by /issues, malformed shape, etc.
      const updatedAt =
        item && typeof item === 'object'
          ? ((item as { updated_at?: string }).updated_at ?? null)
          : null;
      const r = ingestEvent(ctx, {
        event: evt,
        rawBody: JSON.stringify(item),
        deliveryId: `backfill:${ctx.tenantId}:${updatedAt ?? ''}`,
      });
      // Count anything we successfully processed (new ingest OR known dup).
      if (r.status === 'ingested' || r.status === 'skipped') ingested++;
      if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) {
        maxUpdatedAt = updatedAt;
      }
      if (maxItems && ingested >= maxItems) {
        return { ingested, pages, maxUpdatedAt };
      }
    }

    url = page.next;
  }

  return { ingested, pages, maxUpdatedAt };
}

export async function backfillRepo(
  ctx: Context,
  opts: BackfillOpts,
): Promise<BackfillResult> {
  const sleep =
    opts.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cursors = readCursor(ctx.hippoRoot, ctx.tenantId, opts.repoFullName);
  const repository = syntheticRepository(opts.repoFullName);

  const result: BackfillResult = {
    ingested: { issues: 0, issueComments: 0, prReviewComments: 0 },
    pages: { issues: 0, issueComments: 0, prReviewComments: 0 },
  };

  // ---------- Stream 1: issues (skip PRs) ----------
  const issuesUrl =
    `${API}/repos/${opts.repoFullName}/issues?state=all&per_page=100` +
    (cursors.issues ? `&since=${encodeURIComponent(cursors.issues)}` : '');
  const issuesRes = await drainStream(
    ctx,
    issuesUrl,
    (item) => {
      if (!isIssuesItem(item)) return null;
      // Codex P1 #2: /issues returns PRs too — skip them.
      if (item.pull_request) return null;
      const payload: GitHubIssueEvent = {
        action: 'opened',
        repository,
        issue: {
          number: item.number,
          title: item.title,
          body: item.body ?? null,
          user: { login: item.user.login, id: item.user.id },
          updated_at: item.updated_at,
        },
      };
      return { eventName: 'issues', payload };
    },
    opts.fetcher,
    opts.token,
    sleep,
    opts.maxPerStream,
  );
  result.ingested.issues = issuesRes.ingested;
  result.pages.issues = issuesRes.pages;
  if (issuesRes.maxUpdatedAt) {
    writeOneHwm(
      ctx.hippoRoot,
      ctx.tenantId,
      opts.repoFullName,
      'issues_hwm',
      issuesRes.maxUpdatedAt,
    );
  }

  // ---------- Stream 2: repo-level issue comments ----------
  const commentsUrl =
    `${API}/repos/${opts.repoFullName}/issues/comments?per_page=100` +
    (cursors.issueComments
      ? `&since=${encodeURIComponent(cursors.issueComments)}`
      : '');
  const commentsRes = await drainStream(
    ctx,
    commentsUrl,
    (item) => {
      if (!isCommentItem(item)) return null;
      const c = item as IssueCommentItem;
      const issueNumber = parseTrailingNumber(c.issue_url);
      if (issueNumber === null) return null;
      const payload: GitHubIssueCommentEvent = {
        action: 'created',
        repository,
        issue: { number: issueNumber },
        comment: {
          id: c.id,
          body: c.body ?? null,
          user: { login: c.user.login, id: c.user.id },
          updated_at: c.updated_at,
        },
      };
      return { eventName: 'issue_comment', payload };
    },
    opts.fetcher,
    opts.token,
    sleep,
    opts.maxPerStream,
  );
  result.ingested.issueComments = commentsRes.ingested;
  result.pages.issueComments = commentsRes.pages;
  if (commentsRes.maxUpdatedAt) {
    writeOneHwm(
      ctx.hippoRoot,
      ctx.tenantId,
      opts.repoFullName,
      'issue_comments_hwm',
      commentsRes.maxUpdatedAt,
    );
  }

  // ---------- Stream 3: repo-level PR review comments ----------
  const prCommentsUrl =
    `${API}/repos/${opts.repoFullName}/pulls/comments?per_page=100` +
    (cursors.prReviewComments
      ? `&since=${encodeURIComponent(cursors.prReviewComments)}`
      : '');
  const prCommentsRes = await drainStream(
    ctx,
    prCommentsUrl,
    (item) => {
      if (!isCommentItem(item)) return null;
      const c = item as PrReviewCommentItem;
      const prNumber = parseTrailingNumber(c.pull_request_url);
      if (prNumber === null) return null;
      const payload: GitHubPullRequestReviewCommentEvent = {
        action: 'created',
        repository,
        pull_request: { number: prNumber },
        comment: {
          id: c.id,
          body: c.body ?? null,
          user: { login: c.user.login, id: c.user.id },
          updated_at: c.updated_at,
        },
      };
      return { eventName: 'pull_request_review_comment', payload };
    },
    opts.fetcher,
    opts.token,
    sleep,
    opts.maxPerStream,
  );
  result.ingested.prReviewComments = prCommentsRes.ingested;
  result.pages.prReviewComments = prCommentsRes.pages;
  if (prCommentsRes.maxUpdatedAt) {
    writeOneHwm(
      ctx.hippoRoot,
      ctx.tenantId,
      opts.repoFullName,
      'pr_review_comments_hwm',
      prCommentsRes.maxUpdatedAt,
    );
  }

  return result;
}
