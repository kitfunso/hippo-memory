/** GitHub artifact refs and repo keys, built and parsed in one place. github.com keeps
 * github://<owner>/<name>/...; a GHES host goes first: github://<host>/<owner>/<name>/... */

export const UNKNOWN_REPO = 'unknown/unknown';

/** The issue, pull request or comment a ref names inside its repository. */
export type GitHubItem =
  | { readonly kind: 'issue'; readonly number: number }
  | { readonly kind: 'issue_comment'; readonly number: number; readonly commentId: number }
  | { readonly kind: 'pull'; readonly number: number }
  | { readonly kind: 'review_comment'; readonly number: number; readonly commentId: number };

export interface ParsedGitHubRef {
  /** undefined for a github.com ref. */
  readonly host: string | undefined;
  readonly repoFullName: string;
  readonly item: GitHubItem;
}

function itemPath(item: GitHubItem): string {
  switch (item.kind) {
    case 'issue':
      return `issue/${item.number}`;
    case 'issue_comment':
      return `issue/${item.number}/comment/${item.commentId}`;
    case 'pull':
      return `pull/${item.number}`;
    case 'review_comment':
      return `pull/${item.number}/review_comment/${item.commentId}`;
  }
}

/** The repo as refs, repo: tags, scopes and backfill cursors key it: owner/name, GHES host first. */
export function githubRepoKey(repoFullName: string | undefined, host: string | undefined): string {
  const repo = repoFullName ?? UNKNOWN_REPO;
  return host === undefined ? repo : `${host}/${repo}`;
}

export function githubArtifactRef(
  repoFullName: string | undefined,
  item: GitHubItem,
  host: string | undefined,
): string {
  return `github://${githubRepoKey(repoFullName, host)}/${itemPath(item)}`;
}

/** The ref of a lesson a default-branch commit gives; its sha is the lesson's key on every path. */
export function githubCommitLessonRef(
  repoFullName: string | undefined,
  sha: string,
  lesson: 'revert' | 'codeowners',
  host: string | undefined,
): string {
  return `github://${githubRepoKey(repoFullName, host)}/commit/${sha}/${lesson}`;
}

// Group 1 is the host, a segment with a dot or colon. The anchored tail also keeps a host ref
// (5 or 7 segments) and a github.com ref (4 or 6) from ever fitting each other.
const REF_RE =
  /^github:\/\/(?:([^/]*[.:][^/]*)\/)?([^/]+\/[^/]+)\/(issue|pull)\/(\d+)(?:\/(comment|review_comment)\/(\d+))?$/;

function itemOf(m: RegExpExecArray): GitHubItem | null {
  const parent = m[3];
  const number = Number(m[4]);
  const child: string | undefined = m[5];
  const childId: string | undefined = m[6];
  if (child === undefined || childId === undefined) {
    return parent === 'issue' ? { kind: 'issue', number } : { kind: 'pull', number };
  }
  const commentId = Number(childId);
  if (parent === 'issue' && child === 'comment') {
    return { kind: 'issue_comment', number, commentId };
  }
  if (parent === 'pull' && child === 'review_comment') {
    return { kind: 'review_comment', number, commentId };
  }
  return null;
}

/** The parts of a github:// ref; null for any other string. */
export function parseGitHubArtifactRef(ref: string): ParsedGitHubRef | null {
  const m = REF_RE.exec(ref);
  if (m === null) return null;
  const item = itemOf(m);
  if (item === null) return null;
  const host: string | undefined = m[1];
  return { host, repoFullName: m[2], item };
}

// An Enterprise Managed User login is name_shortcode, so the owner may hold an underscore.
const OWNER_RE = /^[A-Za-z0-9_-]+$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** True for exactly owner/name; the names '.' and '..' are refused because a URL path resolves
 * them away. */
export function isGitHubRepoFullName(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [owner, name] = parts;
  return OWNER_RE.test(owner) && REPO_NAME_RE.test(name) && name !== '.' && name !== '..';
}

/** The github.com-form twin of a GHES ref: the ref a GHES webhook stored before refs carried the
 * host. undefined for a github.com ref or a string that is not a ref. */
export function legacyGitHubRef(ref: string): string | undefined {
  const parsed = parseGitHubArtifactRef(ref);
  if (parsed === null || parsed.host === undefined) return undefined;
  return githubArtifactRef(parsed.repoFullName, parsed.item, undefined);
}
