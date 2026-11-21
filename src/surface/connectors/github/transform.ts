import type { RememberOptions } from '../../../api/index.js';
import { scopeFromRepository } from './scope.js';
import { githubArtifactRef, githubRepoKey, type GitHubItem } from './ref.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
  GitHubRepository,
} from './types.js';

/**
 * Convert GitHub webhook events into RememberOptions; each returns null when the event has no
 * usable body so the caller marks it seen and skips the insert. artifact_ref formats
 * (github://<owner/repo>/issue|pull/<n>[/comment|review_comment/<id>], with the GHES host before the
 * owner) are stable because deletion and dedupe look rows up by them (ref.ts).
 */

interface OptsParts {
  content: string;
  item: GitHubItem;
  event: string;
  login: string;
}

function rememberOpts(
  repository: GitHubRepository | undefined,
  { content, item, event, login }: OptsParts,
  host: string | undefined,
): RememberOptions {
  const repoFull = repository?.full_name;
  return {
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
}

function titleAndBody(item: { title: string | null; body: string | null }): string {
  return [item.title?.trim(), item.body?.trim()].filter(Boolean).join('\n\n');
}

export function issueEventToRememberOpts(
  evt: GitHubIssueEvent,
  host?: string,
): RememberOptions | null {
  const content = titleAndBody(evt.issue);
  if (!content) return null;
  return rememberOpts(
    evt.repository,
    {
      content,
      item: { kind: 'issue', number: evt.issue.number },
      event: `issues.${evt.action}`,
      login: evt.issue.user.login,
    },
    host,
  );
}

export function issueCommentEventToRememberOpts(
  evt: GitHubIssueCommentEvent,
  host?: string,
): RememberOptions | null {
  const content = evt.comment.body?.trim();
  if (!content) return null;
  return rememberOpts(
    evt.repository,
    {
      content,
      item: { kind: 'issue_comment', number: evt.issue.number, commentId: evt.comment.id },
      event: `issue_comment.${evt.action}`,
      login: evt.comment.user.login,
    },
    host,
  );
}

export function pullRequestEventToRememberOpts(
  evt: GitHubPullRequestEvent,
  host?: string,
): RememberOptions | null {
  const content = titleAndBody(evt.pull_request);
  if (!content) return null;
  return rememberOpts(
    evt.repository,
    {
      content,
      item: { kind: 'pull', number: evt.pull_request.number },
      event: `pull_request.${evt.action}`,
      login: evt.pull_request.user.login,
    },
    host,
  );
}

export function prReviewCommentEventToRememberOpts(
  evt: GitHubPullRequestReviewCommentEvent,
  host?: string,
): RememberOptions | null {
  const content = evt.comment.body?.trim();
  if (!content) return null;
  return rememberOpts(
    evt.repository,
    {
      content,
      item: { kind: 'review_comment', number: evt.pull_request.number, commentId: evt.comment.id },
      event: `pull_request_review_comment.${evt.action}`,
      login: evt.comment.user.login,
    },
    host,
  );
}
