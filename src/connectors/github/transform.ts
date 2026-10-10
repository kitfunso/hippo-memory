import type { RememberOpts } from '../../api/index.js';
import { scopeFromRepository } from './scope.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
} from './types.js';

/** Convert GitHub webhook events into RememberOpts; each returns null when the event has no usable body so the caller marks it seen and skips the insert.
 *  artifact_ref formats (github://<owner/repo>/issue|pull/<n>[/comment|review_comment/<id>]) are stable because deletion looks rows up by them. */

const UNKNOWN_REPO = 'unknown/unknown';

export function issueEventToRememberOpts(
  evt: GitHubIssueEvent,
): RememberOpts | null {
  const body = evt.issue.body?.trim();
  const title = evt.issue.title?.trim();
  const text = [title, body].filter(Boolean).join('\n\n');
  if (!text) return null;
  const repoFull = evt.repository?.full_name ?? UNKNOWN_REPO;
  const login = evt.issue.user.login;
  return {
    content: text,
    kind: 'raw',
    scope: scopeFromRepository(evt.repository),
    artifactRef: `github://${repoFull}/issue/${evt.issue.number}`,
    owner: `user:github:${login}`,
    tags: [
      'source:github',
      `repo:${repoFull}`,
      `event:issues.${evt.action}`,
      `user:github:${login}`,
    ],
  };
}

export function issueCommentEventToRememberOpts(
  evt: GitHubIssueCommentEvent,
): RememberOpts | null {
  const text = evt.comment.body?.trim();
  if (!text) return null;
  const repoFull = evt.repository?.full_name ?? UNKNOWN_REPO;
  const login = evt.comment.user.login;
  return {
    content: text,
    kind: 'raw',
    scope: scopeFromRepository(evt.repository),
    artifactRef: `github://${repoFull}/issue/${evt.issue.number}/comment/${evt.comment.id}`,
    owner: `user:github:${login}`,
    tags: [
      'source:github',
      `repo:${repoFull}`,
      `event:issue_comment.${evt.action}`,
      `user:github:${login}`,
    ],
  };
}

export function pullRequestEventToRememberOpts(
  evt: GitHubPullRequestEvent,
): RememberOpts | null {
  const body = evt.pull_request.body?.trim();
  const title = evt.pull_request.title?.trim();
  const text = [title, body].filter(Boolean).join('\n\n');
  if (!text) return null;
  const repoFull = evt.repository?.full_name ?? UNKNOWN_REPO;
  const login = evt.pull_request.user.login;
  return {
    content: text,
    kind: 'raw',
    scope: scopeFromRepository(evt.repository),
    artifactRef: `github://${repoFull}/pull/${evt.pull_request.number}`,
    owner: `user:github:${login}`,
    tags: [
      'source:github',
      `repo:${repoFull}`,
      `event:pull_request.${evt.action}`,
      `user:github:${login}`,
    ],
  };
}

export function prReviewCommentEventToRememberOpts(
  evt: GitHubPullRequestReviewCommentEvent,
): RememberOpts | null {
  const text = evt.comment.body?.trim();
  if (!text) return null;
  const repoFull = evt.repository?.full_name ?? UNKNOWN_REPO;
  const login = evt.comment.user.login;
  return {
    content: text,
    kind: 'raw',
    scope: scopeFromRepository(evt.repository),
    artifactRef: `github://${repoFull}/pull/${evt.pull_request.number}/review_comment/${evt.comment.id}`,
    owner: `user:github:${login}`,
    tags: [
      'source:github',
      `repo:${repoFull}`,
      `event:pull_request_review_comment.${evt.action}`,
      `user:github:${login}`,
    ],
  };
}
