import { describe, it, expect } from 'vitest';
import { scopeFromRepository } from '../src/connectors/github/scope.js';
import type { GitHubRepository } from '../src/connectors/github/types.js';

describe('scopeFromRepository', () => {
  it('public repo → github:public:<full_name>', () => {
    const repo: GitHubRepository = {
      full_name: 'acme/open',
      private: false,
      owner: { login: 'acme' },
      name: 'open',
    };
    expect(scopeFromRepository(repo)).toBe('github:public:acme/open');
  });

  it('private repo → github:private:<full_name>', () => {
    const repo: GitHubRepository = {
      full_name: 'acme/secret',
      private: true,
      owner: { login: 'acme' },
      name: 'secret',
    };
    expect(scopeFromRepository(repo)).toBe('github:private:acme/secret');
  });

  it('missing repo (undefined) → github:private:unknown', () => {
    expect(scopeFromRepository(undefined)).toBe('github:private:unknown');
  });

  it('private undefined (legacy/partial payload) → falls through to private (fail-safe)', () => {
    const repo: GitHubRepository = {
      full_name: 'acme/legacy',
      owner: { login: 'acme' },
      name: 'legacy',
    };
    expect(scopeFromRepository(repo)).toBe('github:private:acme/legacy');
  });
});
