import type { ConnectorRememberOptions } from '../../../api/index.js';
import { isStringValue } from '../../../base/session/capture-contract.js';
import { scopeFromRepository } from './scope.js';
import { githubArtifactRef, githubRepoKey, type GitHubItem } from './ref.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
  GitHubRepository,
} from './types.js';

const INSIDE_AUTHORS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const ASSOCIATION_NAME = /^[A-Z_]{1,40}$/;

/** No author vouched for; ingest passes GITHUB_TRUSTED_USER_IDS in its place where a reader set it. */
export const NO_TRUSTED_USER_IDS: ReadonlySet<number> = new Set();

/** Any other author, a missing association included, is held by rule unless the operator lists its user id: the
 * id, not the login, since GitHub lets anyone claim a freed login. The instruction check runs either way. */
function outsideAuthorHold(
  association: string | undefined,
  authorId: number,
  trusted: ReadonlySet<number>,
): ConnectorRememberOptions['hold'] {
  if (isStringValue(association) && INSIDE_AUTHORS.has(association)) return undefined;
  if (trusted.has(authorId)) return undefined;
  const named =
    isStringValue(association) && ASSOCIATION_NAME.test(association) ? association : 'unknown';
  return { reason: `outside-author:${named}` };
}

interface OptsParts {
  content: string;
  item: GitHubItem;
  event: string;
  login: string;
  association: string | undefined;
  authorId: number;
  trusted: ReadonlySet<number>;
}

function rememberOpts(
  repository: GitHubRepository | undefined,
  { content, item, event, login, association, authorId, trusted }: OptsParts,
  host: string | undefined,
): ConnectorRememberOptions {
  const repoFull = repository?.full_name;
  const hold = outsideAuthorHold(association, authorId, trusted);
  const opts: ConnectorRememberOptions = {
    content,
    kind: 'raw',
    scope: scopeFromRepository(repository, host),
    artifactRef: githubArtifactRef(repoFull, item, host),
    owner: `user:github:${login}`,
    tags: [
      'source:github',
      `repo:${githubRepoKey(repoFull, host)}`,
      `event:${event}`,
      `user:github:${login}`,
    ],
  };
  if (hold) opts.hold = hold;
  return opts;
}

function titleAndBody(item: { title: string | null; body: string | null }): string {
  return [item.title?.trim(), item.body?.trim()].filter(Boolean).join('\n\n');
}

export function issueEventToRememberOpts(
  evt: GitHubIssueEvent,
  host?: string,
  trusted: ReadonlySet<number> = NO_TRUSTED_USER_IDS,
): ConnectorRememberOptions | null {
  const content = titleAndBody(evt.issue);
  if (!content) return null;
  return rememberOpts(
    evt.repository,
    {
      content,
      item: { kind: 'issue', number: evt.issue.number },
      event: `issues.${evt.action}`,
      login: evt.issue.user.login,
      authorId: evt.issue.user.id,
      association: evt.issue.author_association,
      trusted,
    },
    host,
  );
}

export function issueCommentEventToRememberOpts(
  evt: GitHubIssueCommentEvent,
  host?: string,
  trusted: ReadonlySet<number> = NO_TRUSTED_USER_IDS,
): ConnectorRememberOptions | null {
  const content = evt.comment.body?.trim();
  if (!content) return null;
  return rememberOpts(
    evt.repository,
    {
      content,
      item: { kind: 'issue_comment', number: evt.issue.number, commentId: evt.comment.id },
      event: `issue_comment.${evt.action}`,
      login: evt.comment.user.login,
      authorId: evt.comment.user.id,
      association: evt.comment.author_association,
      trusted,
    },
    host,
  );
}

export function pullRequestEventToRememberOpts(
  evt: GitHubPullRequestEvent,
  host?: string,
  trusted: ReadonlySet<number> = NO_TRUSTED_USER_IDS,
): ConnectorRememberOptions | null {
  const content = titleAndBody(evt.pull_request);
  if (!content) return null;
  return rememberOpts(
    evt.repository,
    {
      content,
      item: { kind: 'pull', number: evt.pull_request.number },
      event: `pull_request.${evt.action}`,
      login: evt.pull_request.user.login,
      authorId: evt.pull_request.user.id,
      association: evt.pull_request.author_association,
      trusted,
    },
    host,
  );
}

export function prReviewCommentEventToRememberOpts(
  evt: GitHubPullRequestReviewCommentEvent,
  host?: string,
  trusted: ReadonlySet<number> = NO_TRUSTED_USER_IDS,
): ConnectorRememberOptions | null {
  const content = evt.comment.body?.trim();
  if (!content) return null;
  return rememberOpts(
    evt.repository,
    {
      content,
      item: { kind: 'review_comment', number: evt.pull_request.number, commentId: evt.comment.id },
      event: `pull_request_review_comment.${evt.action}`,
      login: evt.comment.user.login,
      authorId: evt.comment.user.id,
      association: evt.comment.author_association,
      trusted,
    },
    host,
  );
}
