/** Revert and CODEOWNERS lessons from backfill: the real strict fetchers against a fake GHES on
 * loopback, and injected fetchers where a case needs a reply the fake cannot make. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../src/base/util/json.js';
import { log } from '../../src/base/util/log.js';
import { backfillLessons } from '../../src/surface/connectors/github/lesson-backfill.js';
import {
  GitHubFetchError,
  noRedirectGitHubFetcher,
  realGitHubCommitFetcher,
  staticTokenSource,
  type GitHubBackfillPage,
  type GitHubCommitReply,
  type GitHubFetcher,
} from '../../src/surface/connectors/github/octokit-client.js';
import { githubCommitLessonRef } from '../../src/surface/connectors/github/ref.js';
import { parseGitHubEnterpriseUrl } from '../../src/surface/connectors/github/site.js';
import type { FullContext } from '../_helpers/api-ctx.js';
import { startFakeGitHub, type FakeCommits, type FakeGitHub } from '../_helpers/fake-github-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { apiCtx } = sessionPerTest();

const REPO = 'acme/demo';
const TENANT = 'default';
const SINCE = '2026-11-01T00:00:00.000Z';
const NONE = { reason: 'none', sleepSeconds: 0 } as const;
const REVERTED_SHA = 'f'.repeat(40);
const R = '1'.repeat(40);
const M = '2'.repeat(40);
const C = '3'.repeat(40);
const F = '4'.repeat(40);
const D = '5'.repeat(40);
const CODEOWNERS_PATCH = '@@ -1 +1 @@\n-/api/ @alice\n+/api/ @acme/api-team';
const NEEDS_CONTENTS_READ =
  "the token needs Contents read on this repository, or GitHub's secondary rate limit refused the request; check the token, then retry later";
const REDIRECT_REFUSED = 'the redirect was refused; if the repository was renamed, pass its new name to --repo';
const PRIMARY = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' } };
// The transport retries a 429 three times on its own, so a limit reaches the lesson pass only when all three are 429.
const SECONDARY = { status: 429, headers: { 'retry-after': '1' } };
const DOCS_PATCH = '@@ -1 +1 @@\n-/docs/ @carol\n+/docs/ @dave';

function commit(sha: string, message: string, parents = 1): JsonValue {
  return {
    sha,
    commit: { message },
    parents: Array.from({ length: parents }, (_, i) => ({ sha: `${i}`.repeat(40) })),
    author: { login: 'alice', id: 1 },
  };
}

const revertR = commit(R, `Revert "Add cache layer"\n\nThis reverts commit ${REVERTED_SHA}.`);
const mergeM = commit(M, 'Revert "Add cache layer" (#13)\n\nReverts acme/demo#12', 2);

describe('backfillLessons against a fake GitHub', () => {
  let root: string;
  let fake: FakeGitHub | undefined;
  let other: FakeGitHub | undefined;

  beforeEach(() => {
    root = makeRoot('gh-lessons-backfill');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fake?.close();
    await other?.close();
    fake = undefined;
    other = undefined;
  });

  const ctx = (): FullContext => apiCtx(root, TENANT, { subject: 'connector:github', role: 'admin' });
  const rows = (event: string) => loadAllEntries(root, TENANT).filter((e) => e.tags.includes(`event:${event}`));

  async function run(commits: FakeCommits, sleepMs?: (ms: number) => Promise<void>) {
    await fake?.close();
    fake = await startFakeGitHub({ commits });
    const site = parseGitHubEnterpriseUrl(fake.url);
    const result = await backfillLessons(ctx(), {
      repoFullName: REPO,
      listFetcher: noRedirectGitHubFetcher,
      commitFetcher: realGitHubCommitFetcher,
      tokenSource: staticTokenSource('tok'),
      sinceIso: SINCE,
      sleepMs,
      site,
    });
    return { result, site };
  }
  const detailRequests = (sha: string) =>
    fake?.requests.filter((r) => r.path.startsWith(`/api/v3/repos/${REPO}/commits/${sha}`)) ?? [];

  it('a revert commit gives one lesson keyed on it, and the merge that repeats it gives none', async () => {
    const { result, site } = await run({ lists: { '|': [mergeM, revertR] } });

    expect(result.reverts).toBe(1);
    const [row, ...rest] = rows('revert');
    expect(rest).toEqual([]);
    expect(row.artifactRef).toBe(githubCommitLessonRef(REPO, R, 'revert', site.host));
    expect(row.content).toContain('Reverted on the default branch of acme/demo: "Add cache layer".');
    expect(row.content).toContain(`Revert: ${fake?.url}/acme/demo/commit/${R}`);
    expect(row.content).toContain(`Original: ${fake?.url}/acme/demo/commit/${REVERTED_SHA}`);
  });

  it('a CODEOWNERS commit gives a lesson with its owner lines, only from the default branch', async () => {
    const { result } = await run({
      lists: {
        '.github/CODEOWNERS|': [commit(C, 'Hand the API to its team')],
        '.github/CODEOWNERS|feature': [commit(F, 'Work on a branch')],
        'CODEOWNERS|': [commit(D, 'Touch a file with no entry')],
      },
      detail: {
        [C]: { files: [{ filename: '.github/CODEOWNERS', patch: CODEOWNERS_PATCH }] },
        [F]: { files: [{ filename: '.github/CODEOWNERS', patch: CODEOWNERS_PATCH }] },
        [D]: { files: [{ filename: 'README.md', patch: '+x' }] },
      },
    });

    expect(result.codeowners).toBe(2);
    const byRef = new Map(rows('codeowners').map((e) => [e.artifactRef, e.content]));
    const host = parseGitHubEnterpriseUrl(fake?.url ?? '').host;
    const forSha = (sha: string) => byRef.get(githubCommitLessonRef(REPO, sha, 'codeowners', host));
    expect(forSha(C)).toContain('Owner lines added:\n+ /api/ @acme/api-team');
    expect(forSha(C)).toContain('Owner lines removed:\n- /api/ @alice');
    expect(forSha(C)).toContain(`Commit: ${fake?.url}/acme/demo/commit/${C}`);
    expect(forSha(D)).toContain('GitHub sent no diff for this file, so the owner lines are not listed.');
    expect(forSha(F)).toBeUndefined();
    expect(fake?.requests.some((r) => r.path.includes(F))).toBe(false);
  });

  it('a second run writes nothing new', async () => {
    const commits = { lists: { '|': [revertR] } };
    await run(commits);
    const again = await run(commits);

    expect(again.result.reverts).toBe(0);
    expect(rows('revert')).toHaveLength(1);
  });

  it('h. a redirect on the commit list is refused and never followed', async () => {
    fake = await startFakeGitHub({ commits: { redirect: 'list' } });
    const err = await failureOf(
      backfillLessons(ctx(), {
        repoFullName: REPO,
        listFetcher: noRedirectGitHubFetcher,
        commitFetcher: realGitHubCommitFetcher,
        tokenSource: staticTokenSource('tok'),
        sinceIso: SINCE,
        site: parseGitHubEnterpriseUrl(fake.url),
      }),
    );

    expect(err).toBeInstanceOf(GitHubFetchError);
    expect(err).toMatchObject({ status: 302, bodyExcerpt: REDIRECT_REFUSED });
    expect(fake.requests.filter((r) => r.path === '/elsewhere')).toHaveLength(0);
  });

  it('h. a redirect on the commit detail is refused and never followed', async () => {
    fake = await startFakeGitHub({
      commits: { redirect: 'detail', lists: { '.github/CODEOWNERS|': [commit(C, 'Move owners')] } },
    });
    const err = await failureOf(
      backfillLessons(ctx(), {
        repoFullName: REPO,
        listFetcher: noRedirectGitHubFetcher,
        commitFetcher: realGitHubCommitFetcher,
        tokenSource: staticTokenSource('tok'),
        sinceIso: SINCE,
        site: parseGitHubEnterpriseUrl(fake.url),
      }),
    );

    expect(err).toMatchObject({ status: 302, bodyExcerpt: REDIRECT_REFUSED });
    expect(fake.requests.filter((r) => r.path === '/elsewhere')).toHaveLength(0);
  });

  it('j. a commit the token cannot read fails with fixed text and none of the reply', async () => {
    fake = await startFakeGitHub({
      commits: { lists: { '.github/CODEOWNERS|': [commit(C, 'Move owners')] } },
    });
    const err = await failureOf(
      backfillLessons(ctx(), {
        repoFullName: REPO,
        listFetcher: noRedirectGitHubFetcher,
        commitFetcher: realGitHubCommitFetcher,
        tokenSource: staticTokenSource('tok'),
        sinceIso: SINCE,
        site: parseGitHubEnterpriseUrl(fake.url),
      }),
    );

    expect(err.message).toBe(`GitHub 404 on ${fake.url}/api/v3/repos/acme/demo/commits/${C}: ${NEEDS_CONTENTS_READ}`);
    expect(err.message).not.toContain('Not Found');
  });

  it('a revert of a revert gives a Reapply lesson with an Undoes link', async () => {
    const reapply = commit(R, `Revert "Revert "Add cache layer""\n\nThis reverts commit ${REVERTED_SHA}.`);
    await run({ lists: { '|': [reapply] } });

    const [row] = rows('revert');
    expect(row.content).toContain('Reapplied on the default branch of acme/demo: "Add cache layer".');
    expect(row.content).toContain(`Reapply: ${fake?.url}/acme/demo/commit/${R}`);
    expect(row.content).toContain(`Undoes: ${fake?.url}/acme/demo/commit/${REVERTED_SHA}`);
  });

  it("a CODEOWNERS entry on the second page of a commit's files gives the owner lines", async () => {
    const { result } = await run({
      lists: { '.github/CODEOWNERS|': [commit(C, 'Hand the API to its team')] },
      detailPages: {
        [C]: [
          { files: [{ filename: 'README.md', patch: '+x' }] },
          { files: [{ filename: '.github/CODEOWNERS', patch: CODEOWNERS_PATCH }] },
        ],
      },
    });

    expect(result.codeowners).toBe(1);
    const [row] = rows('codeowners');
    expect(row.content).toContain('Owner lines added:\n+ /api/ @acme/api-team');
    expect(row.content).not.toContain('GitHub sent no diff');
    expect(detailRequests(C)).toHaveLength(2);
  });

  it('one commit that edits two CODEOWNERS files gives one lesson with both, from one detail read', async () => {
    const both = commit(C, 'Hand the API and the docs over');
    const { result } = await run({
      lists: { '.github/CODEOWNERS|': [both], 'docs/CODEOWNERS|': [both] },
      detail: {
        [C]: {
          files: [
            { filename: 'docs/CODEOWNERS', patch: DOCS_PATCH },
            { filename: '.github/CODEOWNERS', patch: CODEOWNERS_PATCH },
          ],
        },
      },
    });

    expect(result.codeowners).toBe(1);
    const [row, ...rest] = rows('codeowners');
    expect(rest).toEqual([]);
    expect(row.content).toContain('File: .github/CODEOWNERS');
    expect(row.content).toContain('+ /api/ @acme/api-team');
    expect(row.content).toContain('File: docs/CODEOWNERS');
    expect(row.content).toContain('+ /docs/ @dave');
    expect(detailRequests(C)).toHaveLength(1);
  });

  it('a rename between two CODEOWNERS paths gives one file block', async () => {
    const moved = commit(C, 'Move the owners file');
    await run({
      lists: { '.github/CODEOWNERS|': [moved], 'docs/CODEOWNERS|': [moved] },
      detail: {
        [C]: {
          files: [{ filename: 'docs/CODEOWNERS', previous_filename: '.github/CODEOWNERS', patch: CODEOWNERS_PATCH }],
        },
      },
    });

    const [row] = rows('codeowners');
    expect(row.content.match(/^File: /gm)).toHaveLength(1);
    expect(row.content).toContain('Renamed from .github/CODEOWNERS.');
  });

  it('a second run reads no commit detail for a lesson it already holds', async () => {
    const commits = {
      lists: { '.github/CODEOWNERS|': [commit(C, 'Hand the API to its team')] },
      detail: { [C]: { files: [{ filename: '.github/CODEOWNERS', patch: CODEOWNERS_PATCH }] } },
    };
    expect((await run(commits)).result.codeowners).toBe(1);
    expect(detailRequests(C)).toHaveLength(1);

    expect((await run(commits)).result.codeowners).toBe(0);
    expect(detailRequests(C)).toEqual([]);
    expect(rows('codeowners')).toHaveLength(1);
  });

  it.each([
    ['list', 'a 403 with no calls left', PRIMARY, 1],
    ['detail', 'a 403 with no calls left', PRIMARY, 1],
    ['list', 'a 429 with Retry-After', SECONDARY, 3],
    ['detail', 'a 429 with Retry-After', SECONDARY, 3],
  ] as const)('k. the %s answers %s, the pass pauses once and writes the row', async (route, _name, limit, times) => {
    const sleeps: number[] = [];
    const { result } = await run(
      {
        lists:
          route === 'list' ? { '|': [revertR] } : { '.github/CODEOWNERS|': [commit(C, 'Hand the API to its team')] },
        detail: { [C]: { files: [{ filename: '.github/CODEOWNERS', patch: CODEOWNERS_PATCH }] } },
        refuse: { route, ...limit, times },
      },
      (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    );

    expect(sleeps).toEqual([1000]);
    expect(route === 'list' ? result.reverts : result.codeowners).toBe(1);
    expect(rows(route === 'list' ? 'revert' : 'codeowners')).toHaveLength(1);
  });

  it('k. a 403 that is no rate limit fails with the fixed Contents-read text and none of the reply', async () => {
    fake = await startFakeGitHub({
      commits: { lists: { '|': [revertR] }, refuse: { route: 'list', status: 403, times: 1 } },
    });
    const err = await failureOf(
      backfillLessons(ctx(), {
        repoFullName: REPO,
        listFetcher: noRedirectGitHubFetcher,
        commitFetcher: realGitHubCommitFetcher,
        tokenSource: staticTokenSource('tok'),
        sinceIso: SINCE,
        site: parseGitHubEnterpriseUrl(fake.url),
      }),
    );

    expect(err).toBeInstanceOf(GitHubFetchError);
    expect(err).toMatchObject({ status: 403, bodyExcerpt: NEEDS_CONTENTS_READ });
    expect(err.message).not.toContain('secret-reply-text');
  });

  it('k. a next link to another origin is refused and that origin gets no request', async () => {
    other = await startFakeGitHub({});
    fake = await startFakeGitHub({
      commits: { listNext: `${other.url}/api/v3/repos/acme/demo/commits?page=2` },
    });
    const err = await failureOf(
      backfillLessons(ctx(), {
        repoFullName: REPO,
        listFetcher: noRedirectGitHubFetcher,
        commitFetcher: realGitHubCommitFetcher,
        tokenSource: staticTokenSource('tok'),
        sinceIso: SINCE,
        site: parseGitHubEnterpriseUrl(fake.url),
      }),
    );

    expect(err.message).toBe(`GitHub next-page link leaves ${fake.url} for ${other.url}; backfill stopped`);
    expect(other.requests).toEqual([]);
  });

  it('starts the window 30 days before now when no --since is given', async () => {
    fake = await startFakeGitHub({ commits: {} });
    await backfillLessons(ctx(), {
      repoFullName: REPO,
      listFetcher: noRedirectGitHubFetcher,
      commitFetcher: realGitHubCommitFetcher,
      tokenSource: staticTokenSource('tok'),
      site: parseGitHubEnterpriseUrl(fake.url),
      nowMs: Date.parse('2026-11-22T00:00:00Z'),
    });

    const [first] = fake.requests;
    expect(new URL(first.path, fake.url).searchParams.get('since')).toBe('2026-10-23T00:00:00.000Z');
  });
});

describe('backfillLessons with injected fetchers', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('gh-lessons-injected');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctx = (): FullContext => apiCtx(root, TENANT, { subject: 'connector:github', role: 'admin' });
  const page = (items: JsonValue[], next: string | null = null): GitHubBackfillPage => ({
    items,
    next,
    rateLimit: NONE,
  });

  it('j. a rate-limited commit call pauses once, then writes the lesson', async () => {
    const sleeps: number[] = [];
    const replies: GitHubCommitReply[] = [
      { commit: null, next: null, rateLimit: { reason: 'primary', sleepSeconds: 1 } },
      {
        commit: { files: [{ filename: '.github/CODEOWNERS', patch: CODEOWNERS_PATCH }] },
        next: null,
        rateLimit: NONE,
      },
    ];
    let call = 0;
    const listFetcher: GitHubFetcher = ({ url }) =>
      Promise.resolve(page(url.includes('path=.github') ? [commit(C, 'Move owners')] : []));

    const result = await backfillLessons(ctx(), {
      repoFullName: REPO,
      listFetcher,
      commitFetcher: () => Promise.resolve(replies[Math.min(call++, 1)]),
      tokenSource: staticTokenSource('tok'),
      sinceIso: SINCE,
      sleepMs: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    expect(result.codeowners).toBe(1);
    expect(sleeps).toEqual([1000]);
  });

  it('j. a path page with a next link logs the one-page warning for that path', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const listFetcher: GitHubFetcher = ({ url }) =>
      Promise.resolve(url.includes('path=docs') ? page([], 'https://api.github.com/next') : page([]));

    await backfillLessons(ctx(), {
      repoFullName: REPO,
      listFetcher,
      commitFetcher: () => Promise.resolve({ commit: {}, next: null, rateLimit: NONE }),
      tokenSource: staticTokenSource('tok'),
      sinceIso: SINCE,
    });

    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      `github lessons: docs/CODEOWNERS has more than one page of commits since ${SINCE}; older ones were not read`,
    ]);
  });

  it('a commit page whose next link leaves the origin is refused before any request to it', async () => {
    const urls: string[] = [];
    const listFetcher: GitHubFetcher = ({ url }) =>
      Promise.resolve(page(url.includes('path=.github') ? [commit(C, 'Move owners')] : []));

    const err = await failureOf(
      backfillLessons(ctx(), {
        repoFullName: REPO,
        listFetcher,
        commitFetcher: ({ url }) => {
          urls.push(url);
          return Promise.resolve({
            commit: { files: [] },
            next: 'https://evil.example/repos/acme/demo/commits/x?page=2',
            rateLimit: NONE,
          });
        },
        tokenSource: staticTokenSource('tok'),
        sinceIso: SINCE,
      }),
    );

    expect(err.message).toBe(
      'GitHub next-page link leaves https://api.github.com for https://evil.example; backfill stopped',
    );
    expect(urls).toHaveLength(1);
  });

  it("stops a commit's files at 10 pages and says so", async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    let reads = 0;
    const listFetcher: GitHubFetcher = ({ url }) =>
      Promise.resolve(page(url.includes('path=.github') ? [commit(C, 'Move owners')] : []));

    const result = await backfillLessons(ctx(), {
      repoFullName: REPO,
      listFetcher,
      commitFetcher: () => {
        reads++;
        return Promise.resolve({
          commit: { files: [{ filename: 'README.md' }] },
          next: `https://api.github.com/repos/acme/demo/commits/${C}?page=${reads + 1}`,
          rateLimit: NONE,
        });
      },
      tokenSource: staticTokenSource('tok'),
      sinceIso: SINCE,
    });

    expect(reads).toBe(10);
    expect(result.codeowners).toBe(1);
    expect(warn.mock.calls.map((c) => c[0])).toContain(
      `github lessons: read 10 pages of files for commit ${C}; later files were not read`,
    );
  });

  it('stops the revert pass at 10 pages and says so', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    let reads = 0;
    const listFetcher: GitHubFetcher = ({ url }) => {
      if (url.includes('path=')) return Promise.resolve(page([]));
      reads++;
      return Promise.resolve(page([], `https://api.github.com/repos/acme/demo/commits?page=${reads + 1}`));
    };

    const result = await backfillLessons(ctx(), {
      repoFullName: REPO,
      listFetcher,
      commitFetcher: () => Promise.resolve({ commit: {}, next: null, rateLimit: NONE }),
      tokenSource: staticTokenSource('tok'),
      sinceIso: SINCE,
    });

    expect(reads).toBe(10);
    expect(result.pages).toBe(13);
    expect(warn.mock.calls.map((c) => c[0])).toContain(
      `github lessons: read 10 pages of commits since ${SINCE}; older commits were not read`,
    );
  });
});

async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error('the run did not fail');
}
