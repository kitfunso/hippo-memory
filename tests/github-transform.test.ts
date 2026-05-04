import { describe, it, expect } from 'vitest';
import {
  issueEventToRememberOpts,
  issueCommentEventToRememberOpts,
  pullRequestEventToRememberOpts,
  prReviewCommentEventToRememberOpts,
} from '../src/connectors/github/transform.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
  GitHubRepository,
} from '../src/connectors/github/types.js';

const publicRepo: GitHubRepository = {
  full_name: 'acme/widgets',
  private: false,
  owner: { login: 'acme' },
  name: 'widgets',
};

const privateRepo: GitHubRepository = {
  full_name: 'acme/secrets',
  private: true,
  owner: { login: 'acme' },
  name: 'secrets',
};

describe('issueEventToRememberOpts', () => {
  it('produces kind=raw + github:// artifact_ref + scope from repo privacy', () => {
    const evt: GitHubIssueEvent = {
      action: 'opened',
      repository: publicRepo,
      issue: {
        number: 42,
        title: 'Bug: thing broken',
        body: 'Steps to reproduce: 1. ...',
        user: { login: 'octocat', id: 1 },
      },
    };
    const opts = issueEventToRememberOpts(evt);
    expect(opts).not.toBeNull();
    expect(opts!.kind).toBe('raw');
    expect(opts!.scope).toBe('github:public:acme/widgets');
    expect(opts!.artifactRef).toBe('github://acme/widgets/issue/42');
    expect(opts!.content).toBe('Bug: thing broken\n\nSteps to reproduce: 1. ...');
    expect(opts!.owner).toBe('user:github:octocat');
    expect(opts!.tags).toEqual(
      expect.arrayContaining([
        'source:github',
        'repo:acme/widgets',
        'event:issues.opened',
        'user:github:octocat',
      ]),
    );
  });

  it('returns null when title and body are both empty', () => {
    const evt: GitHubIssueEvent = {
      action: 'edited',
      repository: publicRepo,
      issue: {
        number: 7,
        title: '',
        body: null,
        user: { login: 'octocat', id: 1 },
      },
    };
    expect(issueEventToRememberOpts(evt)).toBeNull();
  });

  it('private repo maps scope to github:private:<full_name>', () => {
    const evt: GitHubIssueEvent = {
      action: 'opened',
      repository: privateRepo,
      issue: {
        number: 1,
        title: 'internal',
        body: null,
        user: { login: 'octocat', id: 1 },
      },
    };
    const opts = issueEventToRememberOpts(evt);
    expect(opts!.scope.startsWith('github:private:')).toBe(true);
    expect(opts!.scope).toBe('github:private:acme/secrets');
  });
});

describe('issueCommentEventToRememberOpts', () => {
  it('produces opts with comment artifact_ref and correct scope/owner/tags', () => {
    const evt: GitHubIssueCommentEvent = {
      action: 'created',
      repository: publicRepo,
      issue: { number: 42 },
      comment: {
        id: 999,
        body: 'looks good to me',
        user: { login: 'reviewer1', id: 2 },
      },
    };
    const opts = issueCommentEventToRememberOpts(evt);
    expect(opts).not.toBeNull();
    expect(opts!.kind).toBe('raw');
    expect(opts!.scope).toBe('github:public:acme/widgets');
    expect(opts!.artifactRef).toBe('github://acme/widgets/issue/42/comment/999');
    expect(opts!.content).toBe('looks good to me');
    expect(opts!.owner).toBe('user:github:reviewer1');
    expect(opts!.tags).toEqual(
      expect.arrayContaining([
        'source:github',
        'repo:acme/widgets',
        'event:issue_comment.created',
        'user:github:reviewer1',
      ]),
    );
  });

  it('returns null when comment body is null', () => {
    const evt: GitHubIssueCommentEvent = {
      action: 'edited',
      repository: publicRepo,
      issue: { number: 42 },
      comment: {
        id: 999,
        body: null,
        user: { login: 'reviewer1', id: 2 },
      },
    };
    expect(issueCommentEventToRememberOpts(evt)).toBeNull();
  });

  it('private repo scope starts with github:private:', () => {
    const evt: GitHubIssueCommentEvent = {
      action: 'created',
      repository: privateRepo,
      issue: { number: 5 },
      comment: {
        id: 100,
        body: 'private comment',
        user: { login: 'reviewer1', id: 2 },
      },
    };
    const opts = issueCommentEventToRememberOpts(evt);
    expect(opts!.scope.startsWith('github:private:')).toBe(true);
    expect(opts!.scope).toBe('github:private:acme/secrets');
  });
});

describe('pullRequestEventToRememberOpts', () => {
  it('produces opts with pull artifact_ref and joins title+body', () => {
    const evt: GitHubPullRequestEvent = {
      action: 'opened',
      repository: publicRepo,
      pull_request: {
        number: 17,
        title: 'Add feature X',
        body: 'This PR adds feature X.',
        user: { login: 'contrib', id: 3 },
      },
    };
    const opts = pullRequestEventToRememberOpts(evt);
    expect(opts).not.toBeNull();
    expect(opts!.kind).toBe('raw');
    expect(opts!.scope).toBe('github:public:acme/widgets');
    expect(opts!.artifactRef).toBe('github://acme/widgets/pull/17');
    expect(opts!.content).toBe('Add feature X\n\nThis PR adds feature X.');
    expect(opts!.owner).toBe('user:github:contrib');
    expect(opts!.tags).toEqual(
      expect.arrayContaining([
        'source:github',
        'repo:acme/widgets',
        'event:pull_request.opened',
        'user:github:contrib',
      ]),
    );
  });

  it('returns null when title and body are both empty', () => {
    const evt: GitHubPullRequestEvent = {
      action: 'synchronize',
      repository: publicRepo,
      pull_request: {
        number: 17,
        title: '',
        body: null,
        user: { login: 'contrib', id: 3 },
      },
    };
    expect(pullRequestEventToRememberOpts(evt)).toBeNull();
  });

  it('private repo scope starts with github:private:', () => {
    const evt: GitHubPullRequestEvent = {
      action: 'opened',
      repository: privateRepo,
      pull_request: {
        number: 17,
        title: 'private PR',
        body: null,
        user: { login: 'contrib', id: 3 },
      },
    };
    const opts = pullRequestEventToRememberOpts(evt);
    expect(opts!.scope.startsWith('github:private:')).toBe(true);
    expect(opts!.scope).toBe('github:private:acme/secrets');
  });
});

describe('prReviewCommentEventToRememberOpts', () => {
  it('produces opts with review_comment artifact_ref and correct tags', () => {
    const evt: GitHubPullRequestReviewCommentEvent = {
      action: 'created',
      repository: publicRepo,
      pull_request: { number: 17 },
      comment: {
        id: 555,
        body: 'nit: rename this',
        user: { login: 'reviewer2', id: 4 },
      },
    };
    const opts = prReviewCommentEventToRememberOpts(evt);
    expect(opts).not.toBeNull();
    expect(opts!.kind).toBe('raw');
    expect(opts!.scope).toBe('github:public:acme/widgets');
    expect(opts!.artifactRef).toBe(
      'github://acme/widgets/pull/17/review_comment/555',
    );
    expect(opts!.content).toBe('nit: rename this');
    expect(opts!.owner).toBe('user:github:reviewer2');
    expect(opts!.tags).toEqual(
      expect.arrayContaining([
        'source:github',
        'repo:acme/widgets',
        'event:pull_request_review_comment.created',
        'user:github:reviewer2',
      ]),
    );
  });

  it('returns null when comment body is null', () => {
    const evt: GitHubPullRequestReviewCommentEvent = {
      action: 'edited',
      repository: publicRepo,
      pull_request: { number: 17 },
      comment: {
        id: 555,
        body: null,
        user: { login: 'reviewer2', id: 4 },
      },
    };
    expect(prReviewCommentEventToRememberOpts(evt)).toBeNull();
  });

  it('private repo scope starts with github:private:', () => {
    const evt: GitHubPullRequestReviewCommentEvent = {
      action: 'created',
      repository: privateRepo,
      pull_request: { number: 17 },
      comment: {
        id: 555,
        body: 'private review',
        user: { login: 'reviewer2', id: 4 },
      },
    };
    const opts = prReviewCommentEventToRememberOpts(evt);
    expect(opts!.scope.startsWith('github:private:')).toBe(true);
    expect(opts!.scope).toBe('github:private:acme/secrets');
  });
});
