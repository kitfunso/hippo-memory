import type { GitHubRepository } from './types.js';

/**
 * Map a GitHub repository to a hippo scope string. Default-private when
 * privacy is undetermined: cost of leaking public into private (recall returns
 * nothing) << cost of leaking private into public (data exposure).
 */
export function scopeFromRepository(repo: GitHubRepository | undefined): string {
  if (!repo) return 'github:private:unknown';
  if (repo.private === false) return `github:public:${repo.full_name}`;
  return `github:private:${repo.full_name}`;
}
