/**
 * Tests for the paginated GitHub backfill (Task 11).
 *
 * Strategy: real DB + real ingestEvent + a fake `GitHubFetcher`. Network is
 * the boundary, so HTTP mocking is fine; everything below the fetcher is
 * exercised end-to-end.
 *
 * Crash-safety case (test 5) is the load-bearing one: stream 2 throws
 * after stream 1 drained. We assert stream 1's HWM is written and stream
 * 2's HWM stays NULL — so a rerun resumes correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore, loadAllEntries } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { backfillRepo } from '../src/connectors/github/backfill.js';
import {
  GitHubFetchError,
  type GitHubFetcher,
  type GitHubBackfillPage,
} from '../src/connectors/github/octokit-client.js';

const REPO = 'acme/demo';
const TENANT = 'default';

const ctx = (root: string) => ({
  hippoRoot: root,
  tenantId: TENANT,
  actor: 'connector:github',
});

interface CursorRow {
  issues_hwm: string | null;
  issue_comments_hwm: string | null;
  pr_review_comments_hwm: string | null;
}

function readCursorRow(root: string): CursorRow | undefined {
  const db = openHippoDb(root);
  try {
    return db
      .prepare(
        `SELECT issues_hwm, issue_comments_hwm, pr_review_comments_hwm
         FROM github_cursors WHERE tenant_id = ? AND repo_full_name = ?`,
      )
      .get(TENANT, REPO) as CursorRow | undefined;
  } finally {
    closeHippoDb(db);
  }
}

const NO_RATE = { sleepSeconds: 0, reason: 'none' as const };

/** Build an empty terminal page (no items, no next link). */
function emptyPage(): GitHubBackfillPage {
  return { items: [], next: null, rateLimit: NO_RATE };
}

interface FakePlan {
  /** map from "stream tag" to ordered pages. Stream is matched by URL prefix. */
  issues?: GitHubBackfillPage[];
  issueComments?: GitHubBackfillPage[];
  prReviewComments?: GitHubBackfillPage[];
}

interface CallCapture {
  calls: Array<{ url: string }>;
}

function streamOf(url: string): keyof FakePlan {
  if (url.includes('/issues/comments')) return 'issueComments';
  if (url.includes('/pulls/comments')) return 'prReviewComments';
  return 'issues';
}

/**
 * A fake `GitHubFetcher` that returns canned pages keyed by stream. Each
 * stream walks its array of pages in order; if exhausted, returns an
 * empty terminal page. This lets tests express "stream 1 has these 2
 * pages, stream 2 throws, stream 3 is empty" cleanly.
 */
function makeFakeFetcher(plan: FakePlan, capture?: CallCapture): GitHubFetcher {
  const cursors: Record<keyof FakePlan, number> = {
    issues: 0,
    issueComments: 0,
    prReviewComments: 0,
  };
  return async ({ url }) => {
    capture?.calls.push({ url });
    const stream = streamOf(url);
    const pages = plan[stream] ?? [];
    const idx = cursors[stream]++;
    if (idx < pages.length) return pages[idx];
    return emptyPage();
  };
}

/** Build a stream-1 (issues) item. */
function issueItem(
  number: number,
  updatedAt: string,
  isPr = false,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    number,
    title: `issue ${number}`,
    body: `body for ${number}`,
    user: { login: 'alice', id: 1 },
    updated_at: updatedAt,
  };
  if (isPr) item.pull_request = { url: `https://api.github.com/repos/${REPO}/pulls/${number}` };
  return item;
}

function issueCommentItem(
  id: number,
  issueNumber: number,
  updatedAt: string,
): Record<string, unknown> {
  return {
    id,
    body: `comment ${id}`,
    user: { login: 'bob', id: 2 },
    updated_at: updatedAt,
    issue_url: `https://api.github.com/repos/${REPO}/issues/${issueNumber}`,
  };
}

function prReviewCommentItem(
  id: number,
  prNumber: number,
  updatedAt: string,
): Record<string, unknown> {
  return {
    id,
    body: `review comment ${id}`,
    user: { login: 'carol', id: 3 },
    updated_at: updatedAt,
    pull_request_url: `https://api.github.com/repos/${REPO}/pulls/${prNumber}`,
  };
}

// -- Tests -----------------------------------------------------------------

describe('backfillRepo', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-gh-bf-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('1. fresh backfill ingests all three streams and advances all HWMs', async () => {
    const plan: FakePlan = {
      issues: [
        {
          items: [
            issueItem(1, '2026-05-01T10:00:00Z'),
            issueItem(2, '2026-05-02T10:00:00Z'),
            issueItem(3, '2026-05-03T10:00:00Z'),
          ],
          next: null,
          rateLimit: NO_RATE,
        },
      ],
      issueComments: [
        {
          items: [
            issueCommentItem(101, 1, '2026-05-01T11:00:00Z'),
            issueCommentItem(102, 2, '2026-05-02T11:00:00Z'),
          ],
          next: null,
          rateLimit: NO_RATE,
        },
      ],
      prReviewComments: [
        {
          items: [prReviewCommentItem(201, 7, '2026-05-04T09:00:00Z')],
          next: null,
          rateLimit: NO_RATE,
        },
      ],
    };
    const fetcher = makeFakeFetcher(plan);

    const r = await backfillRepo(ctx(root), {
      repoFullName: REPO,
      fetcher,
      token: 't',
    });

    expect(r.ingested.issues).toBe(3);
    expect(r.ingested.issueComments).toBe(2);
    expect(r.ingested.prReviewComments).toBe(1);

    const entries = loadAllEntries(root).filter((e) =>
      e.tags.includes('source:github'),
    );
    expect(entries).toHaveLength(6);

    const row = readCursorRow(root);
    expect(row?.issues_hwm).toBe('2026-05-03T10:00:00Z');
    expect(row?.issue_comments_hwm).toBe('2026-05-02T11:00:00Z');
    expect(row?.pr_review_comments_hwm).toBe('2026-05-04T09:00:00Z');
  });

  it('2. rerunning the backfill is idempotent (no duplicate memories)', async () => {
    const buildPlan = (): FakePlan => ({
      issues: [
        {
          items: [issueItem(1, '2026-05-01T10:00:00Z')],
          next: null,
          rateLimit: NO_RATE,
        },
      ],
      issueComments: [
        {
          items: [issueCommentItem(101, 1, '2026-05-01T11:00:00Z')],
          next: null,
          rateLimit: NO_RATE,
        },
      ],
      prReviewComments: [
        {
          items: [prReviewCommentItem(201, 7, '2026-05-04T09:00:00Z')],
          next: null,
          rateLimit: NO_RATE,
        },
      ],
    });

    await backfillRepo(ctx(root), {
      repoFullName: REPO,
      fetcher: makeFakeFetcher(buildPlan()),
      token: 't',
    });
    const r2 = await backfillRepo(ctx(root), {
      repoFullName: REPO,
      fetcher: makeFakeFetcher(buildPlan()),
      token: 't',
    });

    // Second run sees zero new memories — every event already in
    // github_event_log returns 'duplicate' from ingestEvent and is NOT
    // counted in `ingested`.
    expect(r2.ingested.issues).toBe(0);
    expect(r2.ingested.issueComments).toBe(0);
    expect(r2.ingested.prReviewComments).toBe(0);

    const entries = loadAllEntries(root).filter((e) =>
      e.tags.includes('source:github'),
    );
    expect(entries).toHaveLength(3);
  });

  it('3. /issues PRs are skipped (codex P1 #2)', async () => {
    const plan: FakePlan = {
      issues: [
        {
          items: [
            issueItem(1, '2026-05-01T10:00:00Z'),
            issueItem(2, '2026-05-02T10:00:00Z', /* isPr */ true),
            issueItem(3, '2026-05-03T10:00:00Z'),
            issueItem(4, '2026-05-04T10:00:00Z', /* isPr */ true),
            issueItem(5, '2026-05-05T10:00:00Z'),
          ],
          next: null,
          rateLimit: NO_RATE,
        },
      ],
    };
    const fetcher = makeFakeFetcher(plan);

    const r = await backfillRepo(ctx(root), {
      repoFullName: REPO,
      fetcher,
      token: 't',
    });

    expect(r.ingested.issues).toBe(3);
    const entries = loadAllEntries(root).filter((e) =>
      e.tags.includes('source:github'),
    );
    // Only the 3 non-PR items should have produced memories.
    expect(entries).toHaveLength(3);
    const refs = entries.map((e) => e.artifact_ref).sort();
    expect(refs).toEqual([
      `github://${REPO}/issue/1`,
      `github://${REPO}/issue/3`,
      `github://${REPO}/issue/5`,
    ]);
  });

  it('4. rate-limit pause: sleeps and retries the same URL', async () => {
    let pageCallCount = 0;
    const fetcher: GitHubFetcher = async ({ url }) => {
      // Only the issues stream uses rate-limit theatrics; the others go empty.
      if (!url.includes('/issues') || url.includes('/issues/comments')) {
        return emptyPage();
      }
      pageCallCount++;
      if (pageCallCount === 1) {
        return {
          items: [],
          next: null,
          rateLimit: { sleepSeconds: 1, reason: 'secondary' },
        };
      }
      return {
        items: [issueItem(1, '2026-05-01T10:00:00Z')],
        next: null,
        rateLimit: NO_RATE,
      };
    };

    const sleeps: number[] = [];
    const r = await backfillRepo(ctx(root), {
      repoFullName: REPO,
      fetcher,
      token: 't',
      sleepMs: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([1000]);
    expect(r.ingested.issues).toBe(1);
    const row = readCursorRow(root);
    expect(row?.issues_hwm).toBe('2026-05-01T10:00:00Z');
  });

  it('5. crash mid-stream-2 leaves stream-2 HWM unchanged but stream-1 advances', async () => {
    const fetcher: GitHubFetcher = async ({ url }) => {
      if (url.includes('/issues/comments')) {
        // Mid-stream-2 server error. Throws BEFORE returning. The drain
        // loop propagates this; stream 2 never reaches the writeOneHwm
        // call, so its HWM stays NULL while stream 1's is committed.
        throw new GitHubFetchError(500, 'boom', url);
      }
      if (url.includes('/pulls/comments')) {
        return emptyPage();
      }
      // Issues stream
      return {
        items: [issueItem(1, '2026-05-01T10:00:00Z')],
        next: null,
        rateLimit: NO_RATE,
      };
    };

    await expect(
      backfillRepo(ctx(root), {
        repoFullName: REPO,
        fetcher,
        token: 't',
      }),
    ).rejects.toThrow(GitHubFetchError);

    const row = readCursorRow(root);
    // Stream 1 fully drained -> HWM advanced.
    expect(row?.issues_hwm).toBe('2026-05-01T10:00:00Z');
    // Stream 2 errored -> HWM never written.
    expect(row?.issue_comments_hwm).toBeNull();
    // Stream 3 never reached.
    expect(row?.pr_review_comments_hwm).toBeNull();
  });

  it('6. maxPerStream caps the issues stream at the limit', async () => {
    const items = [];
    for (let i = 1; i <= 100; i++) {
      items.push(issueItem(i, `2026-05-${String(i).padStart(2, '0')}T10:00:00Z`));
    }
    const plan: FakePlan = {
      issues: [{ items, next: null, rateLimit: NO_RATE }],
    };
    const fetcher = makeFakeFetcher(plan);

    const r = await backfillRepo(ctx(root), {
      repoFullName: REPO,
      fetcher,
      token: 't',
      maxPerStream: 5,
    });

    expect(r.ingested.issues).toBe(5);
    const entries = loadAllEntries(root).filter((e) =>
      e.tags.includes('source:github'),
    );
    expect(entries).toHaveLength(5);
  });

  it('7. resume: existing HWM appears as ?since= in the issues URL', async () => {
    // Seed an existing HWM.
    const seed = openHippoDb(root);
    try {
      seed
        .prepare(
          `INSERT INTO github_cursors (tenant_id, repo_full_name, issues_hwm, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(TENANT, REPO, '2026-01-01T00:00:00Z', new Date().toISOString());
    } finally {
      closeHippoDb(seed);
    }

    const capture: CallCapture = { calls: [] };
    const fetcher = makeFakeFetcher({}, capture);

    await backfillRepo(ctx(root), {
      repoFullName: REPO,
      fetcher,
      token: 't',
    });

    const issuesCall = capture.calls.find(
      (c) => c.url.includes('/issues?') && !c.url.includes('/issues/comments'),
    );
    expect(issuesCall).toBeDefined();
    expect(issuesCall?.url).toContain(
      `since=${encodeURIComponent('2026-01-01T00:00:00Z')}`,
    );
  });

  it('8. empty repo: zero ingests across all streams, HWMs stay NULL', async () => {
    const fetcher = makeFakeFetcher({});

    const r = await backfillRepo(ctx(root), {
      repoFullName: REPO,
      fetcher,
      token: 't',
    });

    expect(r.ingested.issues).toBe(0);
    expect(r.ingested.issueComments).toBe(0);
    expect(r.ingested.prReviewComments).toBe(0);

    const row = readCursorRow(root);
    // No row at all (or all-null). Either is acceptable since nothing was
    // written; the HWMs stay effectively null.
    if (row) {
      expect(row.issues_hwm).toBeNull();
      expect(row.issue_comments_hwm).toBeNull();
      expect(row.pr_review_comments_hwm).toBeNull();
    }
  });
});
