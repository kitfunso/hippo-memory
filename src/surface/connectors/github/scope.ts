import type { GitHubRepository } from './types.js';
import { githubRepoKey } from './ref.js';

/** Map a GitHub repository to a hippo scope string; a GHES host goes before owner/name. Default-private when privacy
 *  is undetermined: cost of leaking public into private (recall returns nothing) << cost of leaking private into public. */
export function scopeFromRepository(repo: GitHubRepository | undefined, host?: string): string {
  if (!repo) return 'github:private:unknown';
  const key = githubRepoKey(repo.full_name, host);
  if (repo.private === false) return `github:public:${key}`;
  return `github:private:${key}`;
}
