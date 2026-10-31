import type { RememberOpts } from '../../api/index.js';
import { scopeFromRepository } from './scope.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
  GitHubRepository,
} from './types.js';

/**
 * Convert GitHub webhook events into RememberOpts; each returns null when the event has no usable body so the caller
 * marks it seen and skips the insert.
 * artifact_ref formats (github://<owner/repo>/issue|pull/<n>[/comment|review_comment/<id>]) are stable because deletion
 * looks rows up by them.
 */

const UNKNOWN_REPO = 'unknown/unknown';

interface OptsParts {
  content: string;
  refPath: string;
  event: string;
  login: string;
}

function rememberOpts(
  repository: GitHubRepository | undefined,
  { content, refPath, event, login }: OptsParts,
): RememberOpts {
  const repoFull = repository?.full_name ?? UNKNOWN_REPO;
  return {
    content,
    kind: 'raw',
    scope: scopeFromRepository(repository),
    artifactRef: `github://${repoFull}/${refPath}`,
    owner: `user:github:${login}`,
    tags: [
      'source:github',
      `repo:${repoFull}`,
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
): RememberOpts | null {
  const content = titleAndBody(evt.issue);
  if (!content) return null;
  return rememberOpts(evt.repository, {
    content,
    refPath: `issue/${evt.issue.number}`,
    event: `issues.${evt.action}`,
    login: evt.issue.user.login,
  });
}

export function issueCommentEventToRememberOpts(
  evt: GitHubIssueCommentEvent,
): RememberOpts | null {
  const content = evt.comment.body?.trim();
  if (!content) return null;
  return rememberOpts(evt.repository, {
    content,
    refPath: `issue/${evt.issue.number}/comment/${evt.comment.id}`,
    event: `issue_comment.${evt.action}`,
    login: evt.comment.user.login,
  });
}

export function pullRequestEventToRememberOpts(
  evt: GitHubPullRequestEvent,
): RememberOpts | null {
  const content = titleAndBody(evt.pull_request);
  if (!content) return null;
  return rememberOpts(evt.repository, {
    content,
    refPath: `pull/${evt.pull_request.number}`,
    event: `pull_request.${evt.action}`,
    login: evt.pull_request.user.login,
  });
}

export function prReviewCommentEventToRememberOpts(
  evt: GitHubPullRequestReviewCommentEvent,
): RememberOpts | null {
  const content = evt.comment.body?.trim();
  if (!content) return null;
  return rememberOpts(evt.repository, {
    content,
    refPath: `pull/${evt.pull_request.number}/review_comment/${evt.comment.id}`,
    event: `pull_request_review_comment.${evt.action}`,
    login: evt.comment.user.login,
  });
}
