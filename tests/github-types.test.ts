import { describe, it, expect } from 'vitest';
import {
  isGitHubWebhookEnvelope,
  isGitHubIssueEvent,
  isGitHubIssueCommentEvent,
  isGitHubPullRequestEvent,
  isGitHubPullRequestReviewCommentEvent,
  type GitHubIssueEvent,
  type GitHubIssueCommentEvent,
  type GitHubPullRequestEvent,
  type GitHubPullRequestReviewCommentEvent,
} from '../src/connectors/github/types.js';

const repo = {
  full_name: 'octo/hello',
  private: false,
  owner: { login: 'octo' },
  name: 'hello',
  id: 1296269,
};
const sender = { login: 'octo', id: 1 };

describe('github envelope', () => {
  it('accepts a payload with action + repository', () => {
    expect(isGitHubWebhookEnvelope({ action: 'opened', repository: repo, sender })).toBe(true);
  });

  it('rejects null and primitives', () => {
    expect(isGitHubWebhookEnvelope(null)).toBe(false);
    expect(isGitHubWebhookEnvelope('opened')).toBe(false);
    expect(isGitHubWebhookEnvelope({})).toBe(false);
  });
});

describe('isGitHubIssueEvent', () => {
  const fixture: GitHubIssueEvent = {
    action: 'opened',
    repository: repo,
    sender,
    issue: {
      number: 42,
      title: 'Spelling typo',
      body: 'There is a typo in README.',
      user: sender,
      updated_at: '2026-05-04T10:00:00Z',
    },
  };

  it('accepts a valid issues payload', () => {
    expect(isGitHubIssueEvent(fixture, 'issues')).toBe(true);
  });

  it('rejects a malformed shape (missing issue.user)', () => {
    const bad = { ...fixture, issue: { number: 42, title: 't', body: null } };
    expect(isGitHubIssueEvent(bad, 'issues')).toBe(false);
  });

  it('rejects with the wrong X-GitHub-Event header', () => {
    expect(isGitHubIssueEvent(fixture, 'pull_request')).toBe(false);
  });

  it('rejects when issue.number is missing', () => {
    const bad = { ...fixture, issue: { title: 't', body: null, user: sender } };
    expect(isGitHubIssueEvent(bad, 'issues')).toBe(false);
  });
});

describe('isGitHubIssueCommentEvent', () => {
  const fixture: GitHubIssueCommentEvent = {
    action: 'created',
    repository: repo,
    sender,
    issue: { number: 42 },
    comment: {
      id: 99001,
      body: 'Looks good to me.',
      user: sender,
      updated_at: '2026-05-04T10:01:00Z',
    },
  };

  it('accepts a valid issue_comment payload', () => {
    expect(isGitHubIssueCommentEvent(fixture, 'issue_comment')).toBe(true);
  });

  it('rejects a malformed shape (comment.id not a number)', () => {
    const bad = { ...fixture, comment: { ...fixture.comment, id: 'nope' as unknown as number } };
    expect(isGitHubIssueCommentEvent(bad, 'issue_comment')).toBe(false);
  });

  it('rejects with the wrong X-GitHub-Event header', () => {
    expect(isGitHubIssueCommentEvent(fixture, 'issues')).toBe(false);
  });

  it('rejects when comment.user is missing', () => {
    const bad = { ...fixture, comment: { id: 99001, body: 'x' } };
    expect(isGitHubIssueCommentEvent(bad, 'issue_comment')).toBe(false);
  });
});

describe('isGitHubPullRequestEvent', () => {
  const fixture: GitHubPullRequestEvent = {
    action: 'opened',
    repository: repo,
    sender,
    pull_request: {
      number: 7,
      title: 'Add feature',
      body: 'Implements the new endpoint.',
      user: sender,
      updated_at: '2026-05-04T10:02:00Z',
    },
  };

  it('accepts a valid pull_request payload', () => {
    expect(isGitHubPullRequestEvent(fixture, 'pull_request')).toBe(true);
  });

  it('rejects a malformed shape (pull_request.number missing)', () => {
    const bad = { ...fixture, pull_request: { title: 't', body: null, user: sender } };
    expect(isGitHubPullRequestEvent(bad, 'pull_request')).toBe(false);
  });

  it('rejects with the wrong X-GitHub-Event header', () => {
    expect(isGitHubPullRequestEvent(fixture, 'issues')).toBe(false);
  });

  it('rejects when pull_request.user is missing', () => {
    const bad = { ...fixture, pull_request: { number: 7, title: 't', body: null } };
    expect(isGitHubPullRequestEvent(bad, 'pull_request')).toBe(false);
  });
});

describe('isGitHubPullRequestReviewCommentEvent', () => {
  const fixture: GitHubPullRequestReviewCommentEvent = {
    action: 'created',
    repository: repo,
    sender,
    pull_request: { number: 7 },
    comment: {
      id: 88001,
      body: 'nit: rename this var',
      user: sender,
      updated_at: '2026-05-04T10:03:00Z',
    },
  };

  it('accepts a valid pull_request_review_comment payload', () => {
    expect(isGitHubPullRequestReviewCommentEvent(fixture, 'pull_request_review_comment')).toBe(true);
  });

  it('rejects a malformed shape (comment missing user)', () => {
    const bad = { ...fixture, comment: { id: 88001, body: 'x' } };
    expect(isGitHubPullRequestReviewCommentEvent(bad, 'pull_request_review_comment')).toBe(false);
  });

  it('rejects with the wrong X-GitHub-Event header', () => {
    expect(isGitHubPullRequestReviewCommentEvent(fixture, 'pull_request')).toBe(false);
  });

  it('rejects when pull_request.number is missing', () => {
    const bad = { ...fixture, pull_request: {} };
    expect(isGitHubPullRequestReviewCommentEvent(bad, 'pull_request_review_comment')).toBe(false);
  });
});
