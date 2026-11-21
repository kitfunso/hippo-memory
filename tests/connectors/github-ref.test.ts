import { describe, expect, it } from 'vitest';
import {
  githubArtifactRef,
  githubRepoKey,
  legacyGitHubRef,
  parseGitHubArtifactRef,
  type GitHubItem,
} from '../../src/surface/connectors/github/ref.js';

const GHES = 'ghes.example.com';
const ISSUE: GitHubItem = { kind: 'issue', number: 42 };
const ISSUE_COMMENT: GitHubItem = { kind: 'issue_comment', number: 42, commentId: 999 };
const PULL: GitHubItem = { kind: 'pull', number: 7 };
const REVIEW_COMMENT: GitHubItem = { kind: 'review_comment', number: 7, commentId: 12345 };
const ITEMS = [ISSUE, ISSUE_COMMENT, PULL, REVIEW_COMMENT];

describe('github.com refs stay as they were', () => {
  it('builds the four forms', () => {
    expect(ITEMS.map((i) => githubArtifactRef('acme/widgets', i, undefined))).toEqual([
      'github://acme/widgets/issue/42',
      'github://acme/widgets/issue/42/comment/999',
      'github://acme/widgets/pull/7',
      'github://acme/widgets/pull/7/review_comment/12345',
    ]);
  });

  it('names an unknown repo unknown/unknown', () => {
    expect(githubArtifactRef(undefined, { kind: 'issue', number: 1 }, undefined)).toBe(
      'github://unknown/unknown/issue/1',
    );
  });

  it('keys the repo by owner/name', () => {
    expect(githubRepoKey('acme/widgets', undefined)).toBe('acme/widgets');
  });
});

describe('GHES refs carry the host first', () => {
  it('builds the four forms', () => {
    expect(ITEMS.map((i) => githubArtifactRef('acme/widgets', i, GHES))).toEqual([
      'github://ghes.example.com/acme/widgets/issue/42',
      'github://ghes.example.com/acme/widgets/issue/42/comment/999',
      'github://ghes.example.com/acme/widgets/pull/7',
      'github://ghes.example.com/acme/widgets/pull/7/review_comment/12345',
    ]);
    expect(githubRepoKey('acme/widgets', GHES)).toBe('ghes.example.com/acme/widgets');
  });

  const hosts = [undefined, GHES, '127.0.0.1', '[fd00::1]'];
  const repos = ['acme/widgets', 'acme/widgets.js', 'acme/issue', 'unknown/unknown'];
  it.each(ITEMS)('round-trips $kind over every host and repo', (item) => {
    for (const host of hosts) {
      for (const repo of repos) {
        expect(parseGitHubArtifactRef(githubArtifactRef(repo, item, host))).toEqual({
          host,
          repoFullName: repo,
          item,
        });
      }
    }
  });

  it('never reads a host as an owner, or an owner as a host', () => {
    const plain = parseGitHubArtifactRef('github://acme/widgets/issue/1');
    expect(plain?.host).toBeUndefined();
    expect(plain?.repoFullName).toBe('acme/widgets');
    const host = parseGitHubArtifactRef('github://ghes.example.com/acme/widgets/issue/1');
    expect(host?.host).toBe('ghes.example.com');
  });

  it.each([
    'slack://T/C/1',
    'github://acme/widgets/issue/x',
    'github://acme/widgets/issue/1/review_comment/2',
    'github://acme/widgets/pull/1/comment/2',
    'github://acme/repo/issue/999/comment/never',
    'github://acme/issue/1',
  ])('rejects %s', (ref) => {
    expect(parseGitHubArtifactRef(ref)).toBeNull();
  });
});

describe('legacyGitHubRef', () => {
  it('gives a GHES ref its github.com-form twin', () => {
    expect(legacyGitHubRef('github://ghes.example.com/acme/w/issue/42/comment/999')).toBe(
      'github://acme/w/issue/42/comment/999',
    );
  });

  it('gives a github.com ref or a non-ref no twin', () => {
    expect(legacyGitHubRef('github://acme/w/issue/42/comment/999')).toBeUndefined();
    expect(legacyGitHubRef('not a ref')).toBeUndefined();
  });
});
