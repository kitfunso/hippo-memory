/** Paginated backfill of the GitHub issues, issue-comments and PR-review-comments streams, each with its own high-water mark (HWM).
 *  An HWM is persisted only after its stream fully drains, so a crash in stream 2 leaves stream 1 committed and stream 2 resumes from its prior HWM.
 *  `repository.private` is left undefined (REST lists omit it), so scopeFromRepository falls through to private. */

import type { Context } from '../../api/index.js';
import { readCursors, seedCursors, writeHwm, type HwmColumn } from '../../store/connectors/github.js';
import { ingestEvent, type IngestEvent } from './ingest.js';
import type { GitHubFetcher, GitHubBackfillPage } from './octokit-client.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestReviewCommentEvent,
  GitHubRepository,
  GitHubSender,
} from './types.js';
import { type JsonValue, isJsonObject } from '../../util/json.js';

const API = 'https://api.github.com';

export interface BackfillOpts {
  /** e.g. 'acme/repo'. */
  repoFullName: string;
  fetcher: GitHubFetcher;
  token: string;
  /** Optional cap on items per stream. Useful for tests. */
  maxPerStream?: number;
  /** First-run `--since`; seeds all three HWMs, COALESCE keeps any HWM a stream already saved. */
  sinceIso?: string;
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

/** Build a synthetic `repository` from the known repo full name, because REST list items often omit it.
 *  `private` stays undefined so scopeFromRepository falls through to private. */
function syntheticRepository(repoFullName: string): GitHubRepository {
  const [owner, name] = repoFullName.split('/');
  return {
    full_name: repoFullName,
    name: name ?? repoFullName,
    owner: { login: owner ?? repoFullName },
    // private intentionally omitted — fail-safe to private scope.
  };
}

/** Parse the trailing issue/PR number from a REST API URL, e.g. .../issues/42 -> 42. */
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

function isGitHubUser(x: JsonValue | undefined): x is Record<string, JsonValue> & GitHubSender {
  return isJsonObject(x) && typeof x.login === 'string' && typeof x.id === 'number';
}

function isIssuesItem(x: JsonValue): x is JsonValue & IssuesItem {
  if (!isJsonObject(x)) return false;
  if (typeof x.number !== 'number') return false;
  if (typeof x.title !== 'string') return false;
  return isGitHubUser(x.user);
}

function isCommentItem(x: JsonValue): x is JsonValue & (IssueCommentItem | PrReviewCommentItem) {
  if (!isJsonObject(x)) return false;
  if (typeof x.id !== 'number') return false;
  return isGitHubUser(x.user);
}

/** Drain one stream end-to-end, pausing on rate-limit and throwing on any other fetch error so the caller leaves the HWM unchanged.
 *  Callers MUST NOT advance the HWM when drained=false, or a capped run would skip the unfetched tail. */
interface DrainStreamOptions {
  readonly toIngestEvent: (item: JsonValue) => IngestEvent | null;
  readonly fetcher: GitHubFetcher;
  readonly token: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxItems?: number;
}

async function drainStream(
  ctx: Context,
  url0: string,
  options: DrainStreamOptions,
): Promise<{ ingested: number; pages: number; maxUpdatedAt: string | null; drained: boolean }> {
  const { toIngestEvent, maxItems } = options;
  let url: string | null = url0;
  let ingested = 0;
  let pages = 0;
  let maxUpdatedAt: string | null = null;

  while (url) {
    const page = await fetchPagePastRateLimit(options, url);
    pages++;

    for (const item of page.items) {
      // Track updated_at on EVERY item, before the toIngestEvent filter, so PR-only pages don't loop forever.
      // SAFETY: updated_at is GitHub's ISO-timestamp field on every item shape this stream returns.
      const updatedAt = isJsonObject(item)
        ? ((item.updated_at as string | undefined) ?? null)
        : null;
      if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) {
        maxUpdatedAt = updatedAt;
      }

      const evt = toIngestEvent(item);
      if (!evt) continue;
      const r = await ingestEvent(ctx, {
        event: evt,
        rawBody: JSON.stringify(item),
        deliveryId: `backfill:${ctx.tenantId}:${updatedAt ?? ''}`,
      });
      if (r.status === 'ingested' || r.status === 'skipped') ingested++;

      if (maxItems && ingested >= maxItems) {
        // Capped mid-stream: caller MUST NOT advance the HWM (drained=false).
        return { ingested, pages, maxUpdatedAt, drained: false };
      }
    }

    url = page.next;
  }

  return { ingested, pages, maxUpdatedAt, drained: true };
}

async function fetchPagePastRateLimit(options: DrainStreamOptions, url: string): Promise<GitHubBackfillPage> {
  const { fetcher, token, sleep } = options;
  // Fetch with rate-limit retry loop.
  while (true) {
    const page = await fetcher({ url, token });
    if (page.rateLimit.reason === 'none') return page;
    await sleep(page.rateLimit.sleepSeconds * 1000);
  }
}

function issueItemToEvent(item: JsonValue, repository: GitHubRepository): IngestEvent | null {
  if (!isIssuesItem(item)) return null;
  // /issues returns PRs too; skip them.
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
}

function issueCommentItemToEvent(item: JsonValue, repository: GitHubRepository): IngestEvent | null {
  if (!isCommentItem(item)) return null;
  // SAFETY: this closure only runs against the /issues/comments stream, so every item isCommentItem
  // validates is an IssueCommentItem; a missing issue_url is handled below.
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
}

function prReviewCommentItemToEvent(item: JsonValue, repository: GitHubRepository): IngestEvent | null {
  if (!isCommentItem(item)) return null;
  // SAFETY: this closure only runs against the /pulls/comments stream, so every item isCommentItem
  // validates is a PrReviewCommentItem; a missing pull_request_url is handled below.
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
}

/** Drains one stream, then persists its HWM only when the stream ran to the end. */
async function backfillStream(
  ctx: Context,
  opts: BackfillOpts,
  sleep: (ms: number) => Promise<void>,
  stream: { url: string; column: HwmColumn; toIngestEvent: (item: JsonValue) => IngestEvent | null },
): Promise<{ ingested: number; pages: number }> {
  const res = await drainStream(ctx, stream.url, {
    toIngestEvent: stream.toIngestEvent,
    fetcher: opts.fetcher,
    token: opts.token,
    sleep,
    maxItems: opts.maxPerStream,
  });
  // A capped run (--max) must leave the HWM at its previous value so the next run re-fetches the unprocessed tail.
  if (res.drained && res.maxUpdatedAt) {
    writeHwm(ctx.hippoRoot, ctx.tenantId, opts.repoFullName, stream.column, res.maxUpdatedAt);
  }
  return { ingested: res.ingested, pages: res.pages };
}

export async function backfillRepo(
  ctx: Context,
  opts: BackfillOpts,
): Promise<BackfillResult> {
  const sleep =
    opts.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (opts.sinceIso) seedCursors(ctx.hippoRoot, ctx.tenantId, opts.repoFullName, opts.sinceIso);
  const cursors = readCursors(ctx.hippoRoot, ctx.tenantId, opts.repoFullName);
  const repository = syntheticRepository(opts.repoFullName);

  const result: BackfillResult = {
    ingested: { issues: 0, issueComments: 0, prReviewComments: 0 },
    pages: { issues: 0, issueComments: 0, prReviewComments: 0 },
  };

  const issuesRes = await backfillStream(ctx, opts, sleep, {
    url:
      `${API}/repos/${opts.repoFullName}/issues?state=all&per_page=100` +
      (cursors.issues ? `&since=${encodeURIComponent(cursors.issues)}` : ''),
    column: 'issues_hwm',
    toIngestEvent: (item) => issueItemToEvent(item, repository),
  });
  result.ingested.issues = issuesRes.ingested;
  result.pages.issues = issuesRes.pages;

  const commentsRes = await backfillStream(ctx, opts, sleep, {
    url:
      `${API}/repos/${opts.repoFullName}/issues/comments?per_page=100` +
      (cursors.issueComments ? `&since=${encodeURIComponent(cursors.issueComments)}` : ''),
    column: 'issue_comments_hwm',
    toIngestEvent: (item) => issueCommentItemToEvent(item, repository),
  });
  result.ingested.issueComments = commentsRes.ingested;
  result.pages.issueComments = commentsRes.pages;

  const prCommentsRes = await backfillStream(ctx, opts, sleep, {
    url:
      `${API}/repos/${opts.repoFullName}/pulls/comments?per_page=100` +
      (cursors.prReviewComments ? `&since=${encodeURIComponent(cursors.prReviewComments)}` : ''),
    column: 'pr_review_comments_hwm',
    toIngestEvent: (item) => prReviewCommentItemToEvent(item, repository),
  });
  result.ingested.prReviewComments = prCommentsRes.ingested;
  result.pages.prReviewComments = prCommentsRes.pages;

  return result;
}
