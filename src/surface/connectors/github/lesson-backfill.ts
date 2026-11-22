/** Backfill of revert and CODEOWNERS lessons from the default branch's commits. It has no cursor:
 * each run reads from its own window start, and the commit-keyed lessons dedupe the overlap. */

import type { ConnectorContext } from '../ingest.js';
import { isJsonObject, isJsonString, type JsonValue } from '../../../base/util/json.js';
import { log } from '../../../base/util/log.js';
import { DAY_MS } from '../../../base/util/time.js';
import { fetchPastRateLimit, sameOriginNext, syntheticRepository } from './backfill.js';
import {
  CODEOWNERS_PATHS,
  SHA_RE,
  codeownersLessonOpts,
  codeownersPatch,
  ingestLesson,
  lessonSeen,
  parseRevertMessage,
  revertLessonOpts,
  type LessonCommit,
  type LessonOpts,
} from './lessons.js';
import type { GitHubCommitFetcher, GitHubFetcher, GitHubTokenSource } from './octokit-client.js';
import { githubCommitLessonRef } from './ref.js';
import { GITHUB_COM, type GitHubSite } from './site.js';

export interface LessonBackfillOptions {
  /** e.g. 'acme/repo'. */
  repoFullName: string;
  /** Lists commits; must not follow a redirect (noRedirectGitHubFetcher). */
  listFetcher: GitHubFetcher;
  /** Reads one commit object, for the diff of a CODEOWNERS change. */
  commitFetcher: GitHubCommitFetcher;
  tokenSource: GitHubTokenSource;
  /** Window start; 30 days before now when absent. */
  sinceIso?: string;
  sleepMs?: (ms: number) => Promise<void>;
  site?: GitHubSite;
  nowMs?: number;
}

export interface LessonBackfillResult {
  reverts: number;
  codeowners: number;
  pages: number;
}

const WINDOW_DAYS = 30;
const MAX_REVERT_PAGES = 10;

interface LessonRun {
  readonly ctx: ConnectorContext;
  readonly opts: LessonBackfillOptions;
  readonly site: GitHubSite;
  readonly since: string;
  readonly tokenSource: GitHubTokenSource;
  readonly sleep: (ms: number) => Promise<void>;
}

interface CommitItem {
  readonly sha: string;
  readonly message: string;
  readonly parents: number;
  readonly authorLogin: string | null;
}

function commitItem(item: JsonValue): CommitItem | null {
  if (!isJsonObject(item) || !isJsonString(item.sha) || !SHA_RE.test(item.sha)) return null;
  const { commit, parents, author } = item;
  if (!isJsonObject(commit) || !isJsonString(commit.message)) return null;
  const login = isJsonObject(author) ? author.login : undefined;
  return {
    sha: item.sha,
    message: commit.message,
    parents: Array.isArray(parents) ? parents.length : 0,
    authorLogin: isJsonString(login) ? login : null,
  };
}

function lessonCommit(run: LessonRun, item: CommitItem): LessonCommit {
  return {
    repository: syntheticRepository(run.opts.repoFullName),
    sha: item.sha,
    authorLogin: item.authorLogin,
    site: run.site,
  };
}

async function writeLesson(run: LessonRun, item: CommitItem, lesson: LessonOpts): Promise<boolean> {
  const result = await ingestLesson(run.ctx, lesson, {
    deliveryId: `backfill:${run.ctx.tenantId}:${item.sha}`,
    eventName: 'commit',
  });
  return result.status === 'ingested';
}

function commitsUrl(run: LessonRun, query: string): string {
  const since = encodeURIComponent(run.since);
  const base = `${run.site.apiBase}/repos/${run.opts.repoFullName}/commits`;
  return `${base}?${query}per_page=100&since=${since}`;
}

async function revertsOnPage(run: LessonRun, items: readonly JsonValue[]): Promise<number> {
  let written = 0;
  for (const raw of items) {
    const item = commitItem(raw);
    // A merge commit repeats the revert its branch holds; the branch's own commit is the key.
    if (item === null || item.parents > 1) continue;
    const parts = parseRevertMessage(item.message);
    if (parts === null) continue;
    const lesson = revertLessonOpts(lessonCommit(run, item), parts);
    if (await writeLesson(run, item, lesson)) written++;
  }
  return written;
}

async function revertPass(run: LessonRun): Promise<{ written: number; pages: number }> {
  let url: string | null = commitsUrl(run, '');
  const origin = new URL(url).origin;
  let written = 0;
  let pages = 0;
  while (url !== null && pages < MAX_REVERT_PAGES) {
    const pageUrl: string = url;
    const page = await fetchPastRateLimit(
      (token) => run.opts.listFetcher({ url: pageUrl, token }),
      run,
    );
    pages++;
    written += await revertsOnPage(run, page.items);
    url = sameOriginNext(page.next, origin);
  }
  if (url !== null) {
    log.warn(
      `github lessons: read ${MAX_REVERT_PAGES} pages of commits since ${run.since}; older commits were not read`,
    );
  }
  return { written, pages };
}

async function codeownersLesson(run: LessonRun, path: string, item: CommitItem): Promise<boolean> {
  const { repoFullName } = run.opts;
  const ref = githubCommitLessonRef(repoFullName, item.sha, 'codeowners', run.site.host);
  if (await lessonSeen(run.ctx, ref)) return false;
  const url = `${run.site.apiBase}/repos/${repoFullName}/commits/${item.sha}`;
  const reply = await fetchPastRateLimit((token) => run.opts.commitFetcher({ url, token }), run);
  if (reply.commit === null) throw new Error(`GitHub sent no commit object for ${item.sha}`);
  const entry = codeownersPatch(reply.commit.files, path);
  const change = {
    path: entry?.filename ?? path,
    subject: item.message.split(/\r?\n/, 1)[0].trim(),
    entry,
  };
  return writeLesson(run, item, codeownersLessonOpts(lessonCommit(run, item), change));
}

async function codeownersPass(run: LessonRun): Promise<{ written: number; pages: number }> {
  let written = 0;
  let pages = 0;
  for (const path of CODEOWNERS_PATHS) {
    const url = commitsUrl(run, `path=${encodeURIComponent(path)}&`);
    const page = await fetchPastRateLimit((token) => run.opts.listFetcher({ url, token }), run);
    pages++;
    if (page.next !== null) {
      log.warn(
        `github lessons: ${path} has more than one page of commits since ${run.since}; older ones were not read`,
      );
    }
    for (const raw of page.items) {
      const item = commitItem(raw);
      if (item !== null && (await codeownersLesson(run, path, item))) written++;
    }
  }
  return { written, pages };
}

/** Writes a lesson for each revert and each CODEOWNERS change on the default branch in the window. */
export async function backfillLessons(
  ctx: ConnectorContext,
  opts: LessonBackfillOptions,
): Promise<LessonBackfillResult> {
  const startMs = (opts.nowMs ?? Date.now()) - WINDOW_DAYS * DAY_MS;
  const run: LessonRun = {
    ctx,
    opts,
    site: opts.site ?? GITHUB_COM,
    since: opts.sinceIso ?? new Date(startMs).toISOString(),
    tokenSource: opts.tokenSource,
    sleep: opts.sleepMs ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const reverts = await revertPass(run);
  const owners = await codeownersPass(run);
  return {
    reverts: reverts.written,
    codeowners: owners.written,
    pages: reverts.pages + owners.pages,
  };
}
